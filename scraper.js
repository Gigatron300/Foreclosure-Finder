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
  requestDelay: 800,
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
  
  const zipMatch = fullAddress.match(/(\d{5})(-\d{4})?/);
  const zipCode = zipMatch ? zipMatch[1] : '';
  
  const stateMatch = fullAddress.match(/\b(NJ|PA)\b/i);
  const state = stateMatch ? stateMatch[1].toUpperCase() : 'NJ';
  
  let city = '';
  let address = fullAddress;
  
  const parts = fullAddress.split(/\s+/);
  const stateIndex = parts.findIndex(p => /^(NJ|PA)$/i.test(p));
  
  if (stateIndex > 0) {
    const beforeState = parts.slice(0, stateIndex);
    
    const knownCities = ['CAMDEN', 'CHERRY HILL', 'VOORHEES', 'SICKLERVILLE', 'HADDONFIELD', 
                         'BLACKWOOD', 'LINDENWOLD', 'GLOUCESTER', 'PENNSAUKEN', 'COLLINGSWOOD',
                         'CLEMENTON', 'ATCO', 'BERLIN', 'MAGNOLIA', 'AUDUBON', 'RUNNEMEDE',
                         'BELLMAWR', 'HADDON', 'WINSLOW', 'PINE HILL', 'GLENDORA', 'ERIAL',
                         'WATERFORD', 'MERCHANTVILLE', 'LAWNSIDE', 'BARRINGTON', 'SOMERDALE',
                         'OAKLYN', 'WOODLYNNE', 'STRATFORD', 'LAUREL SPRINGS', 'CHESILHURST',
                         'MOUNT EPHRAIM', 'BROOKLAWN', 'HADDON HEIGHTS', 'HADDON TOWNSHIP'];
    
    const upperAddress = fullAddress.toUpperCase();
    for (const knownCity of knownCities) {
      if (upperAddress.includes(knownCity)) {
        city = knownCity;
        break;
      }
    }
    
    if (!city && beforeState.length > 2) {
      city = beforeState[beforeState.length - 1];
    }
  }
  
  if (city) {
    const cityIndex = fullAddress.toUpperCase().indexOf(city.toUpperCase());
    if (cityIndex > 0) {
      address = fullAddress.substring(0, cityIndex).trim();
      address = address.replace(/,\s*$/, '');
    }
  }
  
  if (address.includes('A/K/A')) {
    address = address.split('A/K/A')[0].trim();
  }
  
  return { address, city, state, zipCode };
};

// CivilView Scraper (Camden County, NJ)
async function scrapeCivilView(browser) {
  console.log('\n📍 Starting CivilView scraper (Camden County, NJ)...');
  const properties = [];
  const page = await browser.newPage();
  
  try {
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1920, height: 1080 });
    
    console.log('  Loading search page...');
    await page.goto(CONFIG.civilview.searchUrl, { waitUntil: 'networkidle2', timeout: 60000 });
    await delay(2000);
    
    const propertyLinks = await page.evaluate(() => {
      const links = [];
      document.querySelectorAll('a[href*="SaleDetails"]').forEach(link => {
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
        
        const propertyData = await page.evaluate(() => {
          const getFieldValue = (labelText) => {
            const rows = document.querySelectorAll('tr');
            for (const row of rows) {
              const cells = row.querySelectorAll('td');
              if (cells.length >= 2) {
                const label = cells[0].textContent.trim().toLowerCase();
                if (label.includes(labelText.toLowerCase())) {
                  return cells[1].textContent.trim();
                }
              }
            }
            return '';
          };
          
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
          
          const getCurrentStatus = () => {
            const statusHeader = document.body.textContent.match(/Current Status[:\s]*([^-\n]+)/i);
            if (statusHeader) {
              return statusHeader[1].trim();
            }
            return '';
          };
          
          return {
            sheriffNumber: getFieldValue('sheriff'),
            courtCase: getFieldValue('court case'),
            salesDate: getFieldValue('sales date'),
            plaintiff: getFieldValue('plaintiff'),
            defendant: getFieldValue('defendant'),
            fullAddress: getFieldValue('address'),
            approxUpset: getFieldValue('approx. upset') || getFieldValue('approx upset') || getFieldValue('upset'),
            attorney: getFieldValue('attorney:') || getFieldValue('attorney'),
            attorneyPhone: getFieldValue('attorney phone'),
            parcelNumber: getFieldValue('parcel'),
            propertyNote: getFieldValue('property note'),
            currentStatus: getCurrentStatus(),
            statusHistory: getStatusHistory()
          };
        });
        
        const parsedAddress = parseAddress(propertyData.fullAddress);
        
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
