import { createClient } from '@supabase/supabase-js';
import { chromium } from 'playwright';
import { tagTender } from './cpv_registry.js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

function parseUKDate(dateStr: string): string | null {
  if (!dateStr) return null;
  // Handle '30/04/2026 12:00' or '30-Apr-2026' or '30 April 2026'
  const cleaned = dateStr.replace(/(\d{2})\/(\d{2})\/(\d{4})/, '$3-$2-$1');
  const d = new Date(cleaned);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

async function scrapeEastMidsTenders() {
  console.log('Starting EastMidsTenders scrape...');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  await page.goto('https://www.eastmidstenders.org/procontract/supplier.nsf/frm_opportunity_search_results', { 
    waitUntil: 'networkidle' 
  });

  // Filter to Open tenders only
  await page.selectOption('select[name="oppStatus"]', 'Open').catch(() => {});
  await page.click('input[value="Search"]').catch(() => {});
  await page.waitForLoadState('networkidle');
  await page.waitForSelector('table.rgMasterTable tr, .opportunity', { timeout: 10000 }).catch(() => {});

  let pageNum = 1;
  const allResults: any[] = [];

  while (true) {
    console.log(`EMT Page ${pageNum}`);
    
    // ProContract uses RadGrid tables. Try both table rows and div cards
    const results = await page.$$eval('tr.rgRow, tr.rgAltRow, .opportunity', nodes => 
      nodes.map(n => {
        const getText = (sel: string) => n.querySelector(sel)?.textContent?.trim() || '';
        
        // Table layout selectors
        const titleEl = n.querySelector('td a[href*="opportunity"]') || n.querySelector('.opp-title a');
        const buyer = getText('td[data-label="Organisation"]') || getText('.opp-organisation');
        const deadline = getText('td[data-label="Closing Date"]') || getText('.opp-deadline');
        const description = getText('td[data-label="Description"]') || getText('.opp-description');
        
        return {
          title: titleEl?.textContent?.trim() || '',
          url: (titleEl as HTMLAnchorElement)?.href || '',
          buyer,
          description,
          deadline,
          source: 'eastmidstenders',
          status: 'open'
        };
      }).filter(r => r.title && r.url)
    );

    console.log(`EMT Page ${pageNum}: ${results.length} results`);
    if (results.length === 0) break;
    allResults.push(...results);

    // ProContract pagination - look for next button
    const nextButton = await page.$('a.rgPageNext, a:has-text("Next")');
    if (!nextButton) break;
    
    const isDisabled = await nextButton.evaluate(el => el.classList.contains('rgPageNextDisabled'));
    if (isDisabled) break;

    await Promise.all([
      page.waitForResponse(res => res.url().includes('procontract') && res.status() === 200),
      nextButton.click()
    ]);
    pageNum++;
  }

  await browser.close();
  return allResults;
}

async function run() {
  const raw = await scrapeEastMidsTenders();
  console.log(`Total: ${raw.length}. EMT: ${raw.length}, FT: 0`);
  
  const tagged = raw.map(tagTender);
  const tenders = tagged.map(t => ({
    ...t,
    deadline: parseUKDate(t.deadline)
  }));

  if (tenders.length === 0) {
    console.log('FT: 0 results');
    console.log('Scrape complete. Upserted: 0, Errors: 0, Total: 0');
    return;
  }

  const { data, error } = await supabase
    .from('tenders')
    .upsert(tenders, { onConflict: 'url' })
    .select();
    
  if (error) console.error('Upsert failed:', error);
  else console.log(`Scrape complete. Upserted: ${data?.length ?? 0}, Errors: 0, Total: ${data?.length ?? 0}`);
}

run().catch(e => {
  console.error('Scraper crashed:', e);
  process.exit(1);
});
