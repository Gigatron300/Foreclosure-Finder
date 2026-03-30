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
    
    allProperties.sort((a, b) => a.debtAmount - b.debtAmount);
    
    const outputPath = path.join(CONFIG.outputDir, CONFIG.outputFile);
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
