const puppeteer = require('puppeteer');
const fs = require('fs').promises;
const path = require('path');
const CONFIG = require('./config');
const { scrapeCounty } = require('./scrapers/civilview');

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function runScraper() {
  console.log('🏠 Foreclosure Property Scraper');
  console.log('================================');
  console.log(`Started at: ${new Date().toLocaleString()}`);
  
  await fs.mkdir(CONFIG.outputDir, { recursive: true });
  
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || null;
  console.log(`Using Chrome at: ${executablePath || 'Puppeteer default'}`);
  
  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--single-process',
      '--no-zygote',
      '--js-flags=--max-old-space-size=256',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-default-apps',
      '--disable-sync',
      '--disable-translate',
      '--hide-scrollbars',
      '--metrics-recording-only',
      '--mute-audio',
      '--no-first-run',
      '--safebrowsing-disable-auto-update'
    ]
  });
  
  let allProperties = [];
  const sourceCounts = {};
  
  try {
    for (let i = 0; i < CONFIG.counties.length; i++) {
      const county = CONFIG.counties[i];
      
      if (i > 0) {
        console.log(`\n⏸ Pausing ${CONFIG.countyPause / 1000}s before next county...`);
        await delay(CONFIG.countyPause);
      }
      
      const properties = await scrapeCounty(browser, county);
      allProperties = allProperties.concat(properties);
      sourceCounts[county.name] = properties.length;
    }
    
    const outputPath = path.join(CONFIG.outputDir, CONFIG.outputFile);

    // Merge with previous run so a transient failure (CivilView timeout, parse miss)
    // can't blank out a known-good debt amount or other detail-page fields.
    let existingByPropertyId = new Map();
    try {
      const prev = JSON.parse(await fs.readFile(outputPath, 'utf8'));
      for (const p of (prev.properties || [])) {
        if (p.propertyId) existingByPropertyId.set(p.propertyId, p);
      }
    } catch (e) { /* no previous file — fresh run */ }

    let preservedCount = 0;
    for (const prop of allProperties) {
      const existing = existingByPropertyId.get(prop.propertyId);
      if (!existing) continue;

      if (prop.status === 'Unknown') {
        // Detail-page fetch failed; preserve everything we already knew.
        if (existing.debtAmount > 0) prop.debtAmount = existing.debtAmount;
        prop.courtCase = prop.courtCase || existing.courtCase || '';
        prop.attorney = prop.attorney || existing.attorney || '';
        prop.attorneyPhone = prop.attorneyPhone || existing.attorneyPhone || '';
        prop.parcelNumber = prop.parcelNumber || existing.parcelNumber || '';
        prop.description = prop.description || existing.description || '';
        if ((!prop.statusHistory || prop.statusHistory.length === 0) && existing.statusHistory?.length) {
          prop.statusHistory = existing.statusHistory;
        }
        if (existing.status && existing.status !== 'Unknown') prop.status = existing.status;
        preservedCount++;
      } else if (prop.debtAmount === 0 && existing.debtAmount > 0) {
        // Detail page loaded but debt label/value was empty this time.
        prop.debtAmount = existing.debtAmount;
        preservedCount++;
      }
    }
    if (preservedCount > 0) console.log(`🛡  Preserved fields from prior run for ${preservedCount} properties`);

    allProperties.sort((a, b) => a.debtAmount - b.debtAmount);

    await fs.writeFile(outputPath, JSON.stringify({
      lastUpdated: new Date().toISOString(),
      totalProperties: allProperties.length,
      sources: sourceCounts,
      properties: allProperties
    }, null, 2));
    
    console.log(`\n💾 Saved ${allProperties.length} properties`);
    console.log('\n📊 Summary:');
    Object.entries(sourceCounts).forEach(([county, count]) => {
      console.log(`   ${county}: ${count} properties`);
    });
    
  } catch (error) {
    console.error('Scraper error:', error);
  } finally {
    await browser.close();
  }
  
  console.log(`\nCompleted at: ${new Date().toLocaleString()}`);
  return allProperties;
}

module.exports = { runScraper, CONFIG };

if (require.main === module) {
  runScraper().catch(console.error);
}
