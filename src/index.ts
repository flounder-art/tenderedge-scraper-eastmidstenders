import { createClient } from '@supabase/supabase-js';
import { chromium, Page } from 'playwright';
import { tagTender } from './cpv_registry.js';
import pLimit from 'p-limit';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// === CONFIG ===
const BASE_URL = 'https://www.eastmidstenders.org';
const LIST_URL = `${BASE_URL}/procontract/supplier.nsf/frm_opportunity_search_results?openform&sort=opportunity.publish_date&searchfilter=Status:Open`;
const CONCURRENCY = 3;
const TIMEOUT = 30000;

// === HELPERS ===
function parseDate(dateStr: string): string | null {
  if (!dateStr) return null;
  const cleaned = dateStr.replace(/at.*|st|nd|rd|th/g, '').trim();
  const d = new Date(cleaned);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function extractValue(text: string): number | null {
  if (!text) return null;
  const m = text.match(/£\s?([\d,]+(?:\.\d+)?)\s?(m|million)?|([\d,]+)\s?GBP/i);
  if (!m) return null;
  let num = parseFloat((m[1] || m[3]).replace(/,/g, ''));
  if (m[2]) num *= 1_000_000;
  return Math.round(num);
}

function extractCPV(text: string): string[] {
  const matches = text.match(/\b\d{8}\b/g);
  return matches ? [...new Set(matches)] : [];
}

function extractEmail(text: string): string | null {
  const match = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  return match ? match[0] : null;
}

async function safeGoto(page: Page, url: string) {
  for (let i = 0; i < 3; i++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
      return;
    } catch (e) {
      if (i === 2) throw e;
      await page.waitForTimeout(1000 * (i + 1));
    }
  }
}

// === MAIN ===
async function scrapeEastMidsTenders() {
  const start = Date.now();
  console.log('=== EMT SCRAPER START ===', new Date().toISOString());

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (compatible; TenderEdgeBot/1.0; +https://tenderedge.ai)'
  });
  const page = await context.newPage();

  await safeGoto(page, LIST_URL);
  await page.waitForSelector('.opportunity-row, .searchresult', { timeout: 15000 }).catch(() => {});

  const listResults = await page.$$eval('.opportunity-row, .searchresult', nodes =>
    nodes.map(n => {
      const titleEl = n.querySelector('.opportunity-title a, .title a') as HTMLAnchorElement;
      const orgEl = n.querySelector('.opportunity-organisation, .organisation');
      const descEl = n.querySelector('.opportunity-description, .description');
      const deadlineEl = n.querySelector('.opportunity-deadline, .deadline');
      const valueEl = n.querySelector('.opportunity-value, .value');

      return {
        title: titleEl?.textContent?.trim() || '',
        url: titleEl?.href || '',
        buyer: orgEl?.textContent?.trim() || '',
        description: descEl?.textContent?.trim() || '',
        deadline_raw: deadlineEl?.textContent?.trim() || '',
        value_raw: valueEl?.textContent?.trim() || '',
        source: 'eastmidstenders',
        status: 'open',
        scraped_at: new Date().toISOString()
      };
    })
  ).catch(() => []);

  console.log(`EMT List results: ${listResults.length}`);
  if (!listResults.length) {
    await browser.close();
    console.log('PIPELINE STOPPED: No rows found');
    return;
  }

  const limit = pLimit(CONCURRENCY);
  const detailPage = await context.newPage();

  const enriched = await Promise.all(
    listResults.filter(r => r.url).map(r =>
      limit(async () => {
        try {
          await safeGoto(detailPage, r.url);
          const detailData = await detailPage.evaluate(() => {
            const getText = (sel: string) =>
              document.querySelector(sel)?.textContent?.trim() || '';
            const tableText = Array.from(document.querySelectorAll('table tr'))
              .map(tr => tr.textContent)
              .join('\n');
            return {
              full_text: document.body.innerText,
              value: getText('td:has-text("Value") + td, td:has-text("Estimated") + td'),
              cpv: getText('td:has-text("CPV") + td, td:has-text("Common Procurement") + td'),
              contact: getText('td:has-text("Contact") + td, td:has-text("Email") + td'),
              procedure: getText('td:has-text("Procedure") + td'),
              table_text: tableText
            };
          });

          return {
            ...r,
            description: r.description || detailData.full_text.slice(0, 2000),
            value_raw: r.value_raw || detailData.value,
            cpv_raw: detailData.cpv,
            contact_email: extractEmail(detailData.contact || detailData.table_text),
            procedure_type: detailData.procedure
          };
        } catch (e: any) {
          console.log('Detail fail:', r.url, e.message);
          return r;
        }
      })
    )
  );

  await browser.close();

  const cleaned = enriched
    .filter(r => r.title && r.url)
    .map(r => ({
      ...r,
      deadline: parseDate(r.deadline_raw),
      value: extractValue(r.value_raw),
      cpv_codes: extractCPV(r.cpv_raw || ''),
      source: 'eastmidstenders',
      status: 'open'
    }))
    .map(r => tagTender(r));

  console.log(`EMT Cleaned records: ${cleaned.length}`);

  if (cleaned.length) {
    const { error } = await supabase
      .from('tenders')
      .upsert(cleaned, { onConflict: 'url' });
    if (error) console.error('Supabase upsert error:', error.message);
    else console.log(`EMT Upserted ${cleaned.length} records`);
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`=== EMT SCRAPER DONE in ${elapsed}s ===`);
}

scrapeEastMidsTenders().catch(err => {
  console.error('EMT scraper fatal error:', err);
  process.exit(1);
});

