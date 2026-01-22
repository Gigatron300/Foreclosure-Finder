const puppeteer = require('puppeteer');
const fs = require('fs').promises;
const path = require('path');

// Configuration
const CONFIG = {
  outputDir: './data',
  outputFile: 'properties.json',
  civilview: {
    baseUrl: 'https://salesweb.civilview.com',
    searchUrl: 'https://salesweb.civilview.com/Sales/SalesSearch?countyId=1',
    county: 'Camden',
    state: 'NJ'
  },
  requestDelay: 300,        // Base delay between requests (ms)
  maxRetries: 1,            // Only 1 retry - we have fallback data anyway
  batchSize: 50,            // Pause after this many properties
  batchPause: 2000,         // Pause duration (ms) between batches
  pageTimeout: 10000        // Timeout for page loads (ms) - fail fast
};

// Utility functions
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const parseDebtAmount = (text) => {
  if (!text) return 0;
  const cleaned = text.replace(/[$,]/g, '').trim();
  return parseFloat(cleaned) || 0;
};

// Parse address into components
const parseAddress = (fullAddress) => {
  if (!fullAddress) return { address: '', city: '', state: 'NJ', zipCode: '' };
  
  // Clean up address - remove extra whitespace and newlines
  fullAddress = fullAddress.replace(/\s+/g, ' ').trim();
  
  // Extract zip code
  const zipMatch = fullAddress.match(/(\d{5})(-\d{4})?/);
  const zipCode = zipMatch ? zipMatch[1] : '';
  
  // Extract state
  const stateMatch = fullAddress.match(/\b(NJ|PA)\b/i);
  const state = stateMatch ? stateMatch[1].toUpperCase() : 'NJ';
  
  // Known cities in Camden County and surrounding areas
  const knownCities = [
    'CAMDEN', 'CHERRY HILL', 'VOORHEES', 'SICKLERVILLE', 'HADDONFIELD', 
    'BLACKWOOD', 'LINDENWOLD', 'GLOUCESTER', 'PENNSAUKEN', 'COLLINGSWOOD',
    'CLEMENTON', 'ATCO', 'BERLIN', 'MAGNOLIA', 'AUDUBON', 'RUNNEMEDE',
    'BELLMAWR', 'HADDON', 'WINSLOW', 'PINE HILL', 'GLENDORA', 'ERIAL',
    'WATERFORD', 'MERCHANTVILLE', 'LAWNSIDE', 'BARRINGTON', 'SOMERDALE',
    'OAKLYN', 'WOODLYNNE', 'STRATFORD', 'LAUREL SPRINGS', 'CHESILHURST',
    'MOUNT EPHRAIM', 'BROOKLAWN', 'HADDON HEIGHTS', 'HADDON TOWNSHIP',
    'GLOUCESTER CITY', 'GLOUCESTER TWP', 'GLOUCESTER TOWNSHIP',
    'CHERRY HILL TOWNSHIP', 'WINSLOW TOWNSHIP', 'WATERFORD TOWNSHIP',
    'PINE VALLEY', 'TAVISTOCK', 'HI-NELLA', 'GIBBSBORO', 'BERLIN BOROUGH',
    'BERLIN TOWNSHIP', 'HAMMONTON'
  ];
  
  let city = '';
  let address = fullAddress;
  
  // Handle A/K/A addresses - take the first one
  if (fullAddress.includes('A/K/A')) {
    const parts = fullAddress.split('A/K/A');
    fullAddress = parts[0].trim();
  }
  
  // Try to find a known city
  const upperAddress = fullAddress.toUpperCase();
  for (const knownCity of knownCities) {
    const cityIndex = upperAddress.indexOf(knownCity);
    if (cityIndex !== -1) {
      city = knownCity;
      address = fullAddress.substring(0, cityIndex).trim();
      address = address.replace(/,\s*$/, '');
      break;
    }
  }
  
  // If no known city found, try to extract based on pattern
  if (!city) {
    const match = fullAddress.match(/^(.+?)\s+([A-Z\s]+?)\s+(NJ|PA)\s+\d{5}/i);
    if (match) {
      address = match[1].trim();
      city = match[2].trim();
    }
  }
  
  address = address.replace(/,\s*$/, '').trim();
  
  return { address, city, state, zipCode };
};

// CivilView Scraper (Camden County, NJ)
async function scrapeCivilView(browser) {
  console.log('\n🔍 Starting CivilView scraper (Camden County, NJ)...');
  const properties = [];
  const page = await browser.newPage();
  
  try {
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1920, height: 1080 });
    
    console.log('  Loading search page...');
    await page.goto(CONFIG.civilview.searchUrl, { waitUntil: 'networkidle2', timeout: 90000 });
    
    // Wait for the table to appear
    console.log('  Waiting for table to load...');
    await page.waitForSelector('a[href*="SaleDetails"]', { timeout: 30000 });
    
    // Give extra time for all rows to render
    await delay(3000);
    
    // Scroll down the page to trigger any lazy loading
    console.log('  Scrolling to load all results...');
    await page.evaluate(async () => {
      await new Promise((resolve) => {
        let totalHeight = 0;
        const distance = 500;
        const timer = setInterval(() => {
          const scrollHeight = document.body.scrollHeight;
          window.scrollBy(0, distance);
          totalHeight += distance;
          if (totalHeight >= scrollHeight) {
            clearInterval(timer);
            resolve();
          }
        }, 100);
      });
    });
    
    // Scroll back to top and wait
    await page.evaluate(() => window.scrollTo(0, 0));
    await delay(2000);
    
    // Get all property data directly from the listing table (as backup)
    // AND get the detail links
    const listingData = await page.evaluate(() => {
      const results = [];
      const table = document.querySelectorAll('table')[1]; // Main data table
      if (!table) return results;
      
      const rows = table.querySelectorAll('tr');
      for (let i = 1; i < rows.length; i++) { // Skip header
        const cells = rows[i].querySelectorAll('td');
        const link = rows[i].querySelector('a[href*="SaleDetails"]');
        
        if (cells.length >= 6 && link) {
          results.push({
            detailUrl: link.href,
            // Backup data from listing table
            listingSheriff: cells[1]?.textContent?.trim() || '',
            listingSalesDate: cells[2]?.textContent?.trim() || '',
            listingPlaintiff: cells[3]?.textContent?.trim() || '',
            listingDefendant: cells[4]?.textContent?.trim() || '',
            listingAddress: cells[5]?.textContent?.trim() || ''
          });
        }
      }
      return results;
    });
    
    console.log(`  Found ${listingData.length} properties to scrape`);
    
    for (let i = 0; i < listingData.length; i++) {
      // Smart throttling: pause every batch to avoid rate limiting
      if (i > 0 && i % CONFIG.batchSize === 0) {
        console.log(`  ⏸ Pausing briefly to avoid rate limiting...`);
        await delay(CONFIG.batchPause);
      }
      
      const listing = listingData[i];
      console.log(`  Scraping property ${i + 1}/${listingData.length}...`);
      
      let retries = 0;
      let success = false;
      
      while (retries < CONFIG.maxRetries && !success) {
        try {
          await page.goto(listing.detailUrl, { waitUntil: 'domcontentloaded', timeout: CONFIG.pageTimeout });
          await delay(CONFIG.requestDelay);
          
          // Try to extract data - use multiple strategies
          const propertyData = await page.evaluate((backupData) => {
            // Strategy 1: Look for .sale-detail-item elements (standard detail page)
            const getFieldFromDetailItems = (labelText) => {
              const items = document.querySelectorAll('.sale-detail-item');
              for (const item of items) {
                const label = item.querySelector('.sale-detail-label');
                const value = item.querySelector('.sale-detail-value');
                if (label && value) {
                  const labelContent = label.textContent.trim().toLowerCase();
                  if (labelContent.includes(labelText.toLowerCase())) {
                    return value.textContent.trim().replace(/\s+/g, ' ');
                  }
                }
              }
              return '';
            };
            
            // Strategy 2: Look for table rows with label/value pattern
            const getFieldFromTableRows = (labelText) => {
              const rows = document.querySelectorAll('tr');
              for (const row of rows) {
                const cells = row.querySelectorAll('td');
                if (cells.length >= 2) {
                  const label = cells[0].textContent.trim().toLowerCase();
                  if (label.includes(labelText.toLowerCase())) {
                    return cells[1].textContent.trim().replace(/\s+/g, ' ');
                  }
                }
              }
              return '';
            };
            
            // Strategy 3: Look for any element containing label text followed by value
            const getFieldFromAnyElement = (labelText) => {
              const allText = document.body.innerText;
              const regex = new RegExp(labelText + '[:\\s]*([^\\n]+)', 'i');
              const match = allText.match(regex);
              return match ? match[1].trim() : '';
            };
            
            // Combined getter - tries all strategies
            const getField = (labelText) => {
              return getFieldFromDetailItems(labelText) 
                  || getFieldFromTableRows(labelText) 
                  || getFieldFromAnyElement(labelText)
                  || '';
            };
            
            // Get status history from table
            const getStatusHistory = () => {
              const history = [];
              const tables = document.querySelectorAll('table');
              for (const table of tables) {
                const headerRow = table.querySelector('tr');
                if (headerRow && headerRow.textContent.includes('Status') && headerRow.textContent.includes('Date')) {
                  const rows = table.querySelectorAll('tr');
                  for (let i = 1; i < rows.length; i++) {
                    const cells = rows[i].querySelectorAll('td');
                    if (cells.length >= 2) {
                      history.push({
                        status: cells[0].textContent.trim(),
                        date: cells[1].textContent.trim()
                      });
                    }
                  }
                }
              }
              return history;
            };
            
            // Check if page has any content we expect
            const hasDetailContent = document.querySelector('.sale-detail-item') !== null 
                                  || document.body.innerText.includes('Sheriff')
                                  || document.body.innerText.includes('Plaintiff');
            
            // Get data with fallbacks to listing data
            const sheriffNumber = getField('sheriff') || backupData.listingSheriff;
            const salesDate = getField('sales date') || backupData.listingSalesDate;
            const plaintiff = getField('plaintiff') || backupData.listingPlaintiff;
            const defendant = getField('defendant') || backupData.listingDefendant;
            const fullAddress = getField('address') || backupData.listingAddress;
            const approxUpset = getField('approx') || getField('upset');
            
            const statusHistory = getStatusHistory();
            const currentStatus = statusHistory.length > 0 
              ? statusHistory[statusHistory.length - 1].status 
              : 'Scheduled';
            
            return {
              sheriffNumber,
              courtCase: getField('court case'),
              salesDate,
              plaintiff,
              defendant,
              fullAddress,
              approxUpset,
              attorney: getField('attorney'),
              attorneyPhone: getField('attorney phone') || getField('phone'),
              parcelNumber: getField('parcel'),
              propertyNote: getField('property note') || getField('note'),
              currentStatus,
              statusHistory,
              hasDetailContent,
              pageTitle: document.title
            };
          }, listing);
          
          const parsedAddress = parseAddress(propertyData.fullAddress);
          
          // Accept the property if we have at least some identifying data
          if (propertyData.sheriffNumber || propertyData.defendant || parsedAddress.address) {
            const property = {
              source: 'CivilView',
              propertyId: `CV-${propertyData.sheriffNumber || Date.now()}-${i}`,
              sheriffNumber: propertyData.sheriffNumber,
              courtCase: propertyData.courtCase,
              salesDate: propertyData.salesDate,
              plaintiff: propertyData.plaintiff,
              defendant: propertyData.defendant,
              address: parsedAddress.address || propertyData.fullAddress,
              city: parsedAddress.city,
              state: parsedAddress.state,
              zipCode: parsedAddress.zipCode,
              debtAmount: parseDebtAmount(propertyData.approxUpset),
              approxUpset: propertyData.approxUpset,
              attorney: propertyData.attorney,
              attorneyPhone: propertyData.attorneyPhone,
              parcelNumber: propertyData.parcelNumber,
              propertyNote: propertyData.propertyNote,
              status: propertyData.currentStatus || 'Scheduled',
              statusHistory: propertyData.statusHistory,
              county: CONFIG.civilview.county,
              township: parsedAddress.city,
              detailUrl: listing.detailUrl
            };
            
            properties.push(property);
            const debtDisplay = property.debtAmount > 0 ? `$${property.debtAmount.toLocaleString()}` : 'N/A';
            console.log(`    ✓ ${parsedAddress.address || propertyData.sheriffNumber || 'Property'} - ${debtDisplay}`);
          } else {
            // Log what we found for debugging
            console.log(`    ⚠ No data extracted (page: ${propertyData.pageTitle}, hasContent: ${propertyData.hasDetailContent})`);
          }
          
          success = true;
          
        } catch (err) {
          retries++;
          if (retries < CONFIG.maxRetries) {
            console.log(`    ⚠ Retry ${retries}/${CONFIG.maxRetries}...`);
            await delay(500);
          } else {
            // Even on error, try to use the listing data as fallback
            const parsedAddress = parseAddress(listing.listingAddress);
            if (listing.listingSheriff || listing.listingDefendant || parsedAddress.address) {
              const property = {
                source: 'CivilView',
                propertyId: `CV-${listing.listingSheriff || Date.now()}-${i}`,
                sheriffNumber: listing.listingSheriff,
                courtCase: '',
                salesDate: listing.listingSalesDate,
                plaintiff: listing.listingPlaintiff,
                defendant: listing.listingDefendant,
                address: parsedAddress.address || listing.listingAddress,
                city: parsedAddress.city,
                state: parsedAddress.state,
                zipCode: parsedAddress.zipCode,
                debtAmount: 0,
                approxUpset: '',
                attorney: '',
                attorneyPhone: '',
                parcelNumber: '',
                propertyNote: '',
                status: 'Unknown',
                statusHistory: [],
                county: CONFIG.civilview.county,
                township: parsedAddress.city,
                detailUrl: listing.detailUrl
              };
              properties.push(property);
              console.log(`    ~ ${parsedAddress.address || listing.listingSheriff} (from listing, detail failed: ${err.message.substring(0, 50)})`);
            } else {
              console.log(`    ✗ Failed: ${err.message.substring(0, 60)}`);
            }
            success = true; // Move on even if failed
          }
        }
      }
    }
    
  } catch (error) {
    console.error('  CivilView scraper error:', error.message);
  } finally {
    await page.close();
  }
  
  console.log(`  ✅ CivilView complete: ${properties.length} properties scraped`);
  return properties;
}

// Main scraper function
async function runScraper() {
  console.log('🏠 Foreclosure Property Scraper');
  console.log('================================');
  console.log(`Started at: ${new Date().toLocaleString()}`);
  
  await fs.mkdir(CONFIG.outputDir, { recursive: true });
  
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || null;
  console.log(`Using Chrome at: ${executablePath || 'Puppeteer default'}`);
  
  const launchOptions = {
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu',
      '--single-process',
      '--no-zygote'
    ]
  };
  
  if (executablePath) {
    launchOptions.executablePath = executablePath;
  }
  
  const browser = await puppeteer.launch(launchOptions);
  
  let allProperties = [];
  
  try {
    const civilViewProperties = await scrapeCivilView(browser);
    
    allProperties = civilViewProperties;
    allProperties.sort((a, b) => a.debtAmount - b.debtAmount);
    
    const outputPath = path.join(CONFIG.outputDir, CONFIG.outputFile);
    const outputData = {
      lastUpdated: new Date().toISOString(),
      totalProperties: allProperties.length,
      sources: {
        civilView: civilViewProperties.length
      },
      properties: allProperties
    };
    
    await fs.writeFile(outputPath, JSON.stringify(outputData, null, 2));
    console.log(`\n💾 Saved ${allProperties.length} properties to ${outputPath}`);
    
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
