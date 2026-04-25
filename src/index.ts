import { createClient } from '@supabase/supabase-js';
import * as cheerio from 'cheerio';

const CF_URL = 'https://www.contractsfinder.service.gov.uk/Search/Results';
const FT_URL = 'https://www.find-tender.service.gov.uk/Search/Results';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Keywords used to classify tenders into tagging fields
const VEGAN_KEYWORDS = ['vegan', 'plant-based', 'plant based', 'cruelty-free'];
const LA_KEYWORDS = ['local authority', 'council', 'borough', 'district council', 'county council', 'unitary authority'];
const EM_KEYWORDS = ['east midlands', 'leicester', 'nottingham', 'derby', 'lincoln', 'northampton'];
const SOCIAL_CARE_KEYWORDS = ['social care', 'adult care', 'children\'s care', 'domiciliary', 'residential care', 'care home', 'safeguarding'];
const LGR_KEYWORDS = ['local government', 'local government reorganisation', 'lgr', 'devolution'];

// CPV prefix → vertical mapping
const CPV_VERTICAL: Record<string, string> = {
  '72': 'Technology',
  '48': 'Technology',
  '79': 'Professional Services',
  '80': 'Education',
  '85': 'Health & Social Care',
  '45': 'Construction',
  '30': 'Office Supplies',
};

function matchesAny(text: string, keywords: string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.some(kw => lower.includes(kw));
}

function deriveVertical(cpvCodes: string[]): string | null {
  for (const code of cpvCodes) {
    const prefix = code.substring(0, 2);
    if (CPV_VERTICAL[prefix]) return CPV_VERTICAL[prefix];
  }
  return null;
}

function parseDeadline(raw: string | null): string | null {
  if (!raw) return null;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

interface TenderRecord {
  source: string;
  title: string;
  buyer: string;
  description: string;
  url: string;
  deadline: string | null;
  cpv_codes: string[];
  status: string;
  is_vegan: boolean;
  is_la_tagged: boolean;
  is_em_tagged: boolean;
  is_social_care_tagged: boolean;
  is_lgr_tagged: boolean;
  vertical: string | null;
}

function tagTender(tender: Omit<TenderRecord, 'is_vegan' | 'is_la_tagged' | 'is_em_tagged' | 'is_social_care_tagged' | 'is_lgr_tagged' | 'vertical'>): TenderRecord {
  const searchText = `${tender.title} ${tender.buyer} ${tender.description}`;
  return {
    ...tender,
    is_vegan: matchesAny(searchText, VEGAN_KEYWORDS),
    is_la_tagged: matchesAny(searchText, LA_KEYWORDS),
    is_em_tagged: matchesAny(searchText, EM_KEYWORDS),
    is_social_care_tagged: matchesAny(searchText, SOCIAL_CARE_KEYWORDS),
    is_lgr_tagged: matchesAny(searchText, LGR_KEYWORDS),
    vertical: deriveVertical(tender.cpv_codes),
  };
}

async function scrapeContractsFinder() {
  const results: TenderRecord[] = [];
  let pageNum = 1;

  while (pageNum <= 20) {
    const url = `${CF_URL}?page=${pageNum}&status=Open`;
    console.log(`CF Page ${pageNum}`);

    const res = await fetch(url);
    const html = await res.text();
    const $ = cheerio.load(html);

    $('.search-result').each((i, el) => {
      const title = $(el).find('h2 a').text().trim();
      const href = $(el).find('h2 a').attr('href');
      const buyer = $(el).find('.search-result-sub-header').text().trim();
      const description = $(el).find('.wrap-text').first().text().trim();

      let deadlineRaw: string | null = null;
      $(el).find('.search-result-entry').each((j, entry) => {
        const text = $(entry).text();
        if (text.includes('Closing')) deadlineRaw = text.replace('Closing', '').trim();
      });

      if (href) {
        results.push(tagTender({
          source: 'CF',
          title,
          buyer,
          description,
          url: href.startsWith('http') ? href : `https://www.contractsfinder.service.gov.uk${href}`,
          deadline: parseDeadline(deadlineRaw),
          cpv_codes: ['85300000'],
          status: 'open',
        }));
      }
    });

    console.log(`CF Page ${pageNum}: ${$('.search-result').length} results`);
    if ($('.search-result').length === 0) break;
    pageNum++;
    await new Promise(r => setTimeout(r, 1000));
  }
  return results;
}

async function scrapeFindTender() {
  const res = await fetch(`${FT_URL}?status=Open`);
  const html = await res.text();
  const $ = cheerio.load(html);
  const results: TenderRecord[] = [];

  $('.search-result').each((i, el) => {
    const title = $(el).find('h2 a').text().trim();
    const href = $(el).find('h2 a').attr('href');
    const buyer = $(el).find('.search-result-sub-header').text().trim();

    if (href) {
      results.push(tagTender({
        source: 'FTN',
        title,
        buyer,
        description: '',
        url: href.startsWith('http') ? href : `https://www.find-tender.service.gov.uk${href}`,
        deadline: null,
        cpv_codes: ['85300000'],
        status: 'open',
      }));
    }
  });
  console.log(`FT: ${results.length} results`);
  return results;
}

async function main() {
  console.log('Starting scrape...');
  const cf = await scrapeContractsFinder();
  const ft = await scrapeFindTender();
  const all = [...cf, ...ft];

  console.log(`Total: ${all.length}. CF: ${cf.length}, FT: ${ft.length}`);

  let upserted = 0, errors = 0;
  for (const t of all) {
    const { error } = await supabase.from('tenders').upsert(t, { onConflict: 'url' });
    if (error) {
      console.error(`Upsert error [${t.title}]:`, error.message);
      errors++;
    } else {
      upserted++;
    }
  }
  console.log(`Scrape complete. Upserted: ${upserted}, Errors: ${errors}, Total: ${all.length}`);
}

main();
