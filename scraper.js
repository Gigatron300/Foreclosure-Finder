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
  bid4assets: {
    baseUrl: 'https://www.bid4assets.com',
    searchUrl: 'https://www.bid4assets.com/auction/Montgomery-County-Pennsylvania-Sheriff-Sale/3702',
    county: 'Montgomery',
    state: 'PA'
  },
  requestDelay: 1500,
  maxRetries: 3
};

// Utility functions
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const parseDebtAmount = (text) => {
  if (!text) return 0;
  const cleaned = text.replace(/[^0-9.]/g, '');
  return parseFloat(cleaned) || 0;
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
    
    // Wait for content
    await delay(3000);
    
    // Get all property links
    let propertyLinks = await page.evaluate(() => {
      const links = [];
      document.querySelectorAll('a[href*="SaleDetails"], a[href*="PropertyId"]').forEach(link => {
        if (link.href && !links.includes(link.href)) {
          links.push(link.href);
        }
      });
      return links;
    });
    
    console.log(`  Found ${propertyLinks.length} property links on main page`);
    
    // Check for pagination
    let hasNextPage = true;
    let pageNum = 1;
    
    while (hasNextPage && pageNum < 15) {
      const nextButton = await page.evaluate(() => {
        const next = document.querySelector('a[href*="page"]:not([href*="page=1"]), .pagination .next a, [aria-label="Next"]');
        if (next && !next.classList.contains('disabled')) {
          return next.href || null;
        }
        return null;
      });
      
      if (nextButton) {
        console.log(`  Navigating to page ${pageNum + 1}...`);
        await page.goto(nextButton, { waitUntil: 'networkidle2', timeout: 30000 });
        await delay(2000);
        
        const newLinks = await page.evaluate(() => {
          const links = [];
          document.querySelectorAll('a[href*="SaleDetails"], a[href*="PropertyId"]').forEach(link => {
            if (link.href) links.push(link.href);
          });
          return links;
        });
        
        const beforeCount = propertyLinks.length;
        newLinks.forEach(link => {
          if (!propertyLinks.includes(link)) {
            propertyLinks.push(link);
          }
        });
        
        console.log(`    Found ${newLinks.length} links, total unique: ${propertyLinks.length}`);
        
        if (propertyLinks.length === beforeCount) {
          hasNextPage = false;
        }
        pageNum++;
      } else {
        hasNextPage = false;
      }
    }
    
    console.log(`  Total property links to scrape: ${propertyLinks.length}`);
    
    // Visit each property detail page
    for (let i = 0; i < propertyLinks.length; i++) {
      const link = propertyLinks[i];
      console.log(`  Scraping property ${i + 1}/${propertyLinks.length}...`);
      
      try {
        await page.goto(link, { waitUntil: 'networkidle2', timeout: 30000 });
        await delay(CONFIG.requestDelay);
        
        const propertyData = await page.evaluate(() => {
          const getTextByLabel = (labels) => {
            const searchLabels = Array.isArray(labels) ? labels : [labels];
            
            // Method 1: Look in table rows
            const rows = document.querySelectorAll('tr');
            for (const row of rows) {
              const cells = row.querySelectorAll('td, th');
              for (let i = 0; i < cells.length - 1; i++) {
                const cellText = cells[i].textContent.toLowerCase().trim();
                for (const label of searchLabels) {
                  if (cellText.includes(label.toLowerCase())) {
                    return cells[i + 1]?.textContent?.trim() || '';
                  }
                }
              }
            }
            
            // Method 2: Look for label/value patterns
            const allElements = document.querySelectorAll('*');
            for (const el of allElements) {
              const text = el.textContent || '';
              for (const label of searchLabels) {
                const regex = new RegExp(label + '[:\\s]+([^\\n]+)', 'i');
                const match = text.match(regex);
                if (match && match[1].trim().length < 500) {
                  return match[1].trim();
                }
              }
            }
            
            return '';
          };
          
          return {
            sheriffNumber: getTextByLabel(['sheriff', 'writ', 'sale number', 'sale #']),
            courtCase: getTextByLabel(['court case', 'docket', 'case number', 'case #']),
            salesDate: getTextByLabel(['sale date', 'auction date', 'date of sale']),
            plaintiff: getTextByLabel(['plaintiff']),
            defendant: getTextByLabel(['defendant']),
            address: getTextByLabel(['address', 'property address', 'premises', 'location']),
            city: getTextByLabel(['city', 'municipality', 'town']),
            zipCode: getTextByLabel(['zip', 'postal']),
            debtAmount: getTextByLabel(['debt', 'judgment', 'amount due', 'total due', 'upset']),
            attorney: getTextByLabel(['attorney', 'firm', 'counsel']),
            attorneyPhone: getTextByLabel(['phone', 'telephone']),
            parcelNumber: getTextByLabel(['parcel', 'tax id', 'block', 'lot', 'account']),
            status: getTextByLabel(['status']),
            township: getTextByLabel(['township', 'municipality', 'borough']),
          };
        });
        
        if (propertyData.address || propertyData.defendant || propertyData.sheriffNumber) {
          let address = propertyData.address || '';
          let city = propertyData.city || '';
          let state = 'NJ';
          let zipCode = propertyData.zipCode || '';
          
          const addressMatch = address.match(/^(.+?),\s*([^,]+),\s*([A-Z]{2})\s*(\d{5})?/);
          if (addressMatch) {
            address = addressMatch[1].trim();
            city = addressMatch[2].trim();
            state = addressMatch[3];
            zipCode = addressMatch[4] || zipCode;
          }
          
          properties.push({
            source: 'CivilView',
            propertyId: `CV-${Date.now()}-${i}`,
            sheriffNumber: propertyData.sheriffNumber,
            courtCase: propertyData.courtCase,
            salesDate: propertyData.salesDate,
            plaintiff: propertyData.plaintiff,
            defendant: propertyData.defendant,
            address: address,
            city: city,
            state: state,
            zipCode: zipCode,
            debtAmount: parseDebtAmount(propertyData.debtAmount),
            attorney: propertyData.attorney,
            attorneyPhone: propertyData.attorneyPhone,
            parcelNumber: propertyData.parcelNumber,
            status: propertyData.status || 'Scheduled',
            currentBid: '',
            township: propertyData.township,
            county: CONFIG.civilview.county,
            detailUrl: link
          });
          
          console.log(`    ✓ Scraped: ${address || propertyData.defendant || 'Property ' + (i+1)}`);
        }
        
      } catch (err) {
        console.log(`    ✗ Error: ${err.message}`);
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

// Bid4Assets Scraper (Montgomery County, PA)
async function scrapeBid4Assets(browser) {
  console.log('\n📍 Starting Bid4Assets scraper (Montgomery County, PA)...');
  const properties = [];
  const page = await browser.newPage();
  
  try {
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1920, height: 1080 });
    
    console.log('  Loading auction listing...');
    await page.goto(CONFIG.bid4assets.searchUrl, { waitUntil: 'networkidle2', timeout: 60000 });
    
    await delay(3000);
    
    // Scroll to load lazy content
    for (let i = 0; i < 5; i++) {
      await page.evaluate(() => window.scrollBy(0, 1000));
      await delay(1000);
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    
    // Get auction item links
    let auctionLinks = await page.evaluate(() => {
      const links = [];
      document.querySelectorAll('a[href*="/auction/"]').forEach(link => {
        const href = link.href;
        if (href && href.includes('/auction/') && !href.includes('/auction/Montgomery') && !links.includes(href)) {
          links.push(href);
        }
      });
      return links;
    });
    
    console.log(`  Found ${auctionLinks.length} auction items on first page`);
    
    // Check for pagination
    let pageNum = 1;
    let hasMore = true;
    
    while (hasMore && pageNum < 20) {
      const nextPageUrl = await page.evaluate(() => {
        const nextLink = document.querySelector('a[rel="next"], .pagination a.next');
        return nextLink ? nextLink.href : null;
      });
      
      if (nextPageUrl) {
        console.log(`  Loading page ${pageNum + 1}...`);
        await page.goto(nextPageUrl, { waitUntil: 'networkidle2', timeout: 30000 });
        await delay(2000);
        
        const newLinks = await page.evaluate(() => {
          const links = [];
          document.querySelectorAll('a[href*="/auction/"]').forEach(link => {
            const href = link.href;
            if (href && href.includes('/auction/') && !href.includes('/auction/Montgomery')) {
              links.push(href);
            }
          });
          return links;
        });
        
        const beforeCount = auctionLinks.length;
        newLinks.forEach(link => {
          if (!auctionLinks.includes(link)) {
            auctionLinks.push(link);
          }
        });
        
        console.log(`    Found ${newLinks.length} items, total: ${auctionLinks.length}`);
        
        if (auctionLinks.length === beforeCount) {
          hasMore = false;
        }
        pageNum++;
      } else {
        hasMore = false;
      }
    }
    
    console.log(`  Total auction links to scrape: ${auctionLinks.length}`);
    
    // Visit each auction page
    for (let i = 0; i < auctionLinks.length; i++) {
      const link = auctionLinks[i];
      console.log(`  Scraping auction ${i + 1}/${auctionLinks.length}...`);
      
      try {
        await page.goto(link, { waitUntil: 'networkidle2', timeout: 30000 });
        await delay(CONFIG.requestDelay);
        
        const auctionData = await page.evaluate(() => {
          const getTextByLabel = (labels) => {
            const searchLabels = Array.isArray(labels) ? labels : [labels];
            const bodyText = document.body.innerText;
            
            for (const label of searchLabels) {
              const regex = new RegExp(label + '[:\\s]+([^\\n]+)', 'i');
              const match = bodyText.match(regex);
              if (match) {
                return match[1].trim();
              }
            }
            return '';
          };
          
          const title = document.querySelector('h1, .auction-title, .property-title')?.textContent?.trim() || '';
          
          return {
            title: title,
            sheriffNumber: getTextByLabel(['sheriff', 'sale number', 'writ']),
            courtCase: getTextByLabel(['case', 'docket']),
            salesDate: getTextByLabel(['sale date', 'auction date', 'auction ends', 'end date']),
            plaintiff: getTextByLabel(['plaintiff']),
            defendant: getTextByLabel(['defendant', 'owner', 'debtor']),
            address: getTextByLabel(['address', 'property address', 'location']),
            city: getTextByLabel(['city']),
            zipCode: getTextByLabel(['zip']),
            debtAmount: getTextByLabel(['judgment', 'debt', 'upset', 'amount', 'opening bid']),
            attorney: getTextByLabel(['attorney']),
            parcelNumber: getTextByLabel(['parcel', 'tax id', 'folio']),
            status: getTextByLabel(['status']),
            currentBid: getTextByLabel(['current bid', 'high bid', 'winning bid']),
            township: getTextByLabel(['township', 'municipality']),
          };
        });
        
        let address = auctionData.address || auctionData.title || '';
        let city = auctionData.city || '';
        let zipCode = auctionData.zipCode || '';
        let state = 'PA';
        
        const addressMatch = address.match(/^(.+?),\s*([^,]+),\s*([A-Z]{2})\s*(\d{5})?/);
        if (addressMatch) {
          address = addressMatch[1].trim();
          city = addressMatch[2].trim();
          state = addressMatch[3];
          zipCode = addressMatch[4] || zipCode;
        }
        
        if (address && address.length > 3) {
          const propertyId = link.match(/\/(\d+)/)?.[1] || `${Date.now()}-${i}`;
          
          properties.push({
            source: 'Bid4Assets',
            propertyId: `B4A-${propertyId}`,
            sheriffNumber: auctionData.sheriffNumber,
            courtCase: auctionData.courtCase,
            salesDate: auctionData.salesDate,
            plaintiff: auctionData.plaintiff,
            defendant: auctionData.defendant,
            address: address,
            city: city,
            state: state,
            zipCode: zipCode,
            debtAmount: parseDebtAmount(auctionData.debtAmount),
            attorney: auctionData.attorney,
            attorneyPhone: '',
            parcelNumber: auctionData.parcelNumber,
            status: auctionData.status || 'Active',
            currentBid: auctionData.currentBid,
            township: auctionData.township,
            county: CONFIG.bid4assets.county,
            detailUrl: link
          });
          
          console.log(`    ✓ Scraped: ${address}`);
        }
        
      } catch (err) {
        console.log(`    ✗ Error: ${err.message}`);
      }
    }
    
  } catch (error) {
    console.error('  Bid4Assets scraper error:', error.message);
  } finally {
    await page.close();
  }
  
  console.log(`  ✅ Bid4Assets complete: ${properties.length} properties scraped`);
  return properties;
}

// Main scraper function
async function runScraper() {
  console.log('🏠 Foreclosure Property Scraper');
  console.log('================================');
  console.log(`Started at: ${new Date().toLocaleString()}`);
  
  await fs.mkdir(CONFIG.outputDir, { recursive: true });
  
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu',
      '--window-size=1920,1080',
      '--single-process',
      '--no-zygote'
    ]
  });
  
  let allProperties = [];
  
  try {
    const civilViewProperties = await scrapeCivilView(browser);
    const bid4AssetsProperties = await scrapeBid4Assets(browser);
    
    allProperties = [...civilViewProperties, ...bid4AssetsProperties];
    allProperties.sort((a, b) => a.debtAmount - b.debtAmount);
    
    const outputPath = path.join(CONFIG.outputDir, CONFIG.outputFile);
    const outputData = {
      lastUpdated: new Date().toISOString(),
      totalProperties: allProperties.length,
      sources: {
        civilView: civilViewProperties.length,
        bid4Assets: bid4AssetsProperties.length
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
