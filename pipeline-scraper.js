// Pipeline scraper - scrapes pre-foreclosure cases from court records
// Uses lightweight HTTP requests - no browser needed

const fs = require('fs').promises;
const path = require('path');
const { scrapeMontgomeryCourts } = require('./scrapers/montco-courts');

const OUTPUT_DIR = './data';
const OUTPUT_FILE = 'pipeline.json';

async function runPipelineScraper() {
  console.log('🏛️ Pre-Foreclosure Pipeline Scraper');
  console.log('====================================');
  console.log(`Started at: ${new Date().toLocaleString()}`);
  console.log('Using lightweight HTTP requests (no browser)\n');
  
  let allCases = [];
  
  try {
    // Scrape Montgomery County Courts (no browser needed)
    const montcoCases = await scrapeMontgomeryCourts();
    allCases.push(...montcoCases);
    
    // Can add more court sources here in the future
    
  } catch (error) {
    console.error('Scraper error:', error);
  }
  
  // Sort by days open (oldest first - most urgent)
  allCases.sort((a, b) => (b.daysOpen || 0) - (a.daysOpen || 0));
  
  // Save results
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  
  const outputData = {
    lastUpdated: new Date().toISOString(),
    totalCases: allCases.length,
    sources: {
      'Montgomery County Courts': allCases.filter(c => c.county === 'Montgomery').length
    },
    cases: allCases
  };
  
  await fs.writeFile(
    path.join(OUTPUT_DIR, OUTPUT_FILE),
    JSON.stringify(outputData, null, 2)
  );
  
  console.log(`\n💾 Saved ${allCases.length} pre-foreclosure cases`);
  console.log(`Completed at: ${new Date().toLocaleString()}`);
  
  return allCases;
}

// Export for use by server
module.exports = { runPipelineScraper, OUTPUT_DIR, OUTPUT_FILE };

// Run if called directly
if (require.main === module) {
  runPipelineScraper().catch(console.error);
}
