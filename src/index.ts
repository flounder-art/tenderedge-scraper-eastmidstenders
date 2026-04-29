import { createClient } from '@supabase/supabase-js';
import { chromium } from 'playwright';
import { tagTender } from './cpv_registry.js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

function parseDate(dateStr: string): string | null {
  if (!dateStr) return null;
  // Handles "23/05/2026 12:00" or "23 May 2026"
  const cleaned = dateStr.replace(/at.*/, '').trim();
  const d = new Date(cleaned);
  return isNaN(d.getTime())? null : d.toISOString();
}

function extractValue(text: string): number | null {
  const match = text.match(/£\s?([\d,]+)/);
  if (!match) return null;
  return parseInt(match[1].replace(/,/g, ''));
}

async function scrapeEastMidsTenders() {
  console.log('=== EAST MIDS SCRAPER START ===');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  // Open tenders only, sorted newest
  const url = 'https://www.eastmidstenders.org/procontract/supplier.nsf/frm_opportunity_search_results?openform&sort=opportunity.publish_date&searchfilter=Status:Open';
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // ProContract uses.opportunity-row
  await page.waitForSelector('.opportunity-row', { timeout: 15000 }).catch(() => {});

  const results = await page.$$eval('.opportunity-row', nodes => nodes.map(n => {
    const titleEl = n.querySelector('.opportunity-title a') as HTMLAnchorElement;
    const orgEl = n.querySelector('.opportunity-organisation');
    const descEl = n.querySelector('.opportunity-description');
    const deadlineEl = n.querySelector('.opportunity-deadline');
    const valueEl = n.querySelector('.opportunity-value');

    return {
      title: titleEl?.textContent?.trim() || '',
      url: titleEl?.href || '',
      buyer: orgEl?.textContent?.trim() || '',
      description: descEl?.textContent?.trim() || '',
      deadline_raw: deadlineEl?.textContent?.trim() || '',
      value_raw: valueEl?.textContent?.trim() || '',
      source: 'eastmidstenders',
      status: 'open'
    };
  }));

  await browser.close();
  console.log('EMT Raw results:', results.length);

  const cleaned = results
   .filter(r => r.title && r.url)
   .map(r => ({
     ...r,
      deadline: parseDate(r.deadline_raw),
      value_gbp: extractValue(r.value_raw || r.description),
      cpv_codes: [] // ProContract doesn't expose CPV in list view
    }))
   .map(tagTender); // adds is_em_tagged, is_la_tagged, vertical, etc

  console.log('After tag:', cleaned.length);
  if (cleaned[0]) console.log('Sample:', JSON.stringify(cleaned[0], null, 2));

  if (cleaned.length === 0) {
    console.log('PIPELINE STOPPED: No tenders');
    return;
  }

  // Drop raw fields before upsert
  const payload = cleaned.map(({ deadline_raw, value_raw,...rest }) => rest);

  const { data, error } = await supabase
   .from('tenders')
   .upsert(payload, { onConflict: 'url' })
   .select();

  if (error) console.error('Upsert failed:', error);
  else console.log(`Upsert ok: ${data?.length?? 0}`);
}

scrapeEastMidsTenders().catch(e => {
  console.error('Scraper crashed:', e);
  process.exit(1);
});

86 lines hidden
