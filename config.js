// Configuration for the foreclosure scraper

const CONFIG = {
  outputDir: './data',
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
      searchUrl: 'https://salesweb.civilview.com/Sales/SalesSearch?countyId=1'
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
