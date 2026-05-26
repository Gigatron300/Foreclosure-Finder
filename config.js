// Configuration for the foreclosure scraper

const DATA_DIR = process.env.DATA_DIR || './data';

const CONFIG = {
  outputDir: DATA_DIR,
  outputFile: 'properties.json',
  
  // Timing settings
  requestDelay: 400,
  maxRetries: 1,
  batchSize: 30,
  batchPause: 3000,
  pageTimeout: 15000,
  countyPause: 10000,
  
  // Counties to scrape (all use CivilView)
  counties: [
    {
      id: 1,
      name: 'Camden',
      state: 'NJ',
      searchUrl: 'https://salesweb.civilview.com/Sales/SalesSearch?countyId=1',
      // Camden's CivilView walls our Render IP after 24–120 detail fetches.
      // Other counties on the same platform (e.g. Montgomery, 223 listings)
      // run cleanly, so the budget is Camden-specific not platform-wide.
      // Skip detail fetches for listings we already have data for — the
      // merge logic in scraper.js restores prior detail-page fields, and
      // the cron stays under the daily ceiling.
      skipKnownDetailFetches: true
    },
    {
      id: 23,
      name: 'Montgomery',
      state: 'PA',
      searchUrl: 'https://salesweb.civilview.com/Sales/SalesSearch?countyId=23'
    }
  ]
};

module.exports = CONFIG;
