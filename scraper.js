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
  requestDelay: 1000,
  maxRetries: 3
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
      // Everything before the city is the street address
      address = fullAddress.substring(0, cityIndex).trim();
      // Clean up trailing commas
      address = address.replace(/,\s*$/, '');
      break;
    }
  }
  
  // If no known city found, try to extract based on pattern
  if (!city) {
    // Look for pattern like "123 MAIN ST SOMECITY NJ 08XXX"
    const match = fullAddress.match(/^(.+?)\s+([A-Z\s]+?)\s+(NJ|PA)\s+\d{5}/i);
    if (match) {
      address = match[1].trim();
      city = match[2].trim();
    }
  }
  
  // Clean up address
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
    await page.goto(CONFIG.civilview.searchUrl, { waitUntil: 'networkidle2', timeout: 60000 });
    await delay(2000);
    
    // Get all property links from the listing table
    // The table has columns: View Details | Sheriff # | Sales Date | Plaintiff | Defendant | Address
    const propertyLinks = await page.evaluate(() => {
      const links = [];
      // Find all "View Details" links - these go to the detail pages
      const detailLinks = document.querySelectorAll('a[href*="SaleDetails"]');
      detailLinks.forEach(link => {
        const href = link.href;
        if (href && !links.includes(href)) {
          links.push(href);
        }
      });
      return links;
    });
    
    console.log(`  Found ${propertyLinks.length} properties to scrape`);
    
    for (let i = 0; i < propertyLinks.length; i++) {
      const link = propertyLinks[i];
      console.log(`  Scraping property ${i + 1}/${propertyLinks.length}...`);
      
      try {
        await page.goto(link, { waitUntil: 'networkidle2', timeout: 30000 });
        await delay(CONFIG.requestDelay);
        
        // Extract data using the CORRECT selectors for CivilView
        // The page uses: .sale-detail-item > .sale-detail-label + .sale-detail-value
        const propertyData = await page.evaluate(() => {
          // Helper to get field value by label text
          const getFieldValue = (labelText) => {
            const items = document.querySelectorAll('.sale-detail-item');
            for (const item of items) {
              const label = item.querySelector('.sale-detail-label');
              const value = item.querySelector('.sale-detail-value');
              if (label && value) {
                const labelContent = label.textContent.trim().toLowerCase();
                if (labelContent.includes(labelText.toLowerCase())) {
                  // Clean up the value - remove extra whitespace and newlines
                  return value.textContent.trim().replace(/\s+/g, ' ');
                }
              }
            }
            return '';
          };
          
          // Get status history from the table (if present)
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
          
          // Get the current status (most recent from history, or look for current status indicator)
          const getCurrentStatus = () => {
            const history = getStatusHistory();
            if (history.length > 0) {
              return history[history.length - 1].status;
            }
            return 'Scheduled';
          };
          
          return {
            sheriffNumber: getFieldValue('sheriff'),
            courtCase: getFieldValue('court case'),
            salesDate: getFieldValue('sales date'),
            plaintiff: getFieldValue('plaintiff'),
            defendant: getFieldValue('defendant'),
            fullAddress: getFieldValue('address'),
            approxUpset: getFieldValue('approx'),
            attorney: getFieldValue('attorney:') || getFieldValue('attorney'),
            attorneyPhone: getFieldValue('attorney phone'),
            parcelNumber: getFieldValue('parcel'),
            propertyNote: getFieldValue('property note'),
            currentStatus: getCurrentStatus(),
            statusHistory: getStatusHistory()
          };
        });
        
        const parsedAddress = parseAddress(propertyData.fullAddress);
        
        // Only add if we have meaningful data
        if (parsedAddress.address || propertyData.defendant || propertyData.sheriffNumber) {
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
            township: parsedAddress.city, // Use city as township for filtering
            detailUrl: link
          };
          
          properties.push(property);
          console.log(`    ✓ ${parsedAddress.address || 'Property'} - $${property.debtAmount.toLocaleString()}`);
        }
        
      } catch (err) {
        console.log(`    ✗ Error scraping property: ${err.message}`);
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
  
  // Use system Chromium if available, otherwise let Puppeteer find its own
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
