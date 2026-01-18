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
  requestDelay: 1000, // ms between requests to be respectful
  maxRetries: 3
};

// Utility functions
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const parseDebtAmount = (text) => {
  if (!text) return 0;
  const cleaned = text.replace(/[^0-9.]/g, '');
  return parseFloat(cleaned) || 0;
};

const cleanText = (text) => {
  if (!text) return '';
  return text.replace(/\s+/g, ' ').trim();
};

// CivilView Scraper (Camden County, NJ)
async function scrapeCivilView(browser) {
  console.log('\n📍 Starting CivilView scraper (Camden County, NJ)...');
  const properties = [];
  const page = await browser.newPage();
  
  try {
    // Set a realistic user agent
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    // Go to the search page
    console.log('  Loading search page...');
    await page.goto(CONFIG.civilview.searchUrl, { waitUntil: 'networkidle2', timeout: 60000 });
    
    // Wait for the table to load
    await page.waitForSelector('table', { timeout: 30000 }).catch(() => {});
    
    // Get all sale dates available (they often have a dropdown)
    // First, let's see what's on the page
    const pageContent = await page.content();
    
    // Find all property links on the page
    let propertyLinks = await page.evaluate(() => {
      const links = [];
      // Look for links that go to property details
      document.querySelectorAll('a[href*="SaleDetails"], a[href*="PropertyId"]').forEach(link => {
        links.push(link.href);
      });
      return [...new Set(links)]; // Remove duplicates
    });
    
    console.log(`  Found ${propertyLinks.length} properties on first page`);
    
    // Check for pagination or "show all" option
    const hasMorePages = await page.evaluate(() => {
      // Look for pagination elements
      const pagination = document.querySelector('.pagination, [class*="pager"], nav[aria-label*="page"]');
      const showAll = document.querySelector('a[href*="pageSize"], select[name*="pageSize"], [class*="show-all"]');
      return { pagination: !!pagination, showAll: !!showAll };
    });
    
    // Try to show all results if possible
    const showAllClicked = await page.evaluate(() => {
      const showAllLink = document.querySelector('a[href*="pageSize=All"], a[href*="pageSize=1000"], option[value="All"], option[value="1000"]');
      if (showAllLink) {
        if (showAllLink.tagName === 'OPTION') {
          showAllLink.selected = true;
          showAllLink.parentElement.dispatchEvent(new Event('change'));
        } else {
          showAllLink.click();
        }
        return true;
      }
      return false;
    });
    
    if (showAllClicked) {
      await delay(3000);
      await page.waitForSelector('table', { timeout: 30000 }).catch(() => {});
    }
    
    // Now get all property links again
    propertyLinks = await page.evaluate(() => {
      const links = [];
      document.querySelectorAll('a[href*="SaleDetails"], a[href*="PropertyId"]').forEach(link => {
        links.push(link.href);
      });
      return [...new Set(links)];
    });
    
    // If we still don't have many links, try pagination
    if (propertyLinks.length < 50) {
      let pageNum = 1;
      let hasMore = true;
      
      while (hasMore && pageNum < 20) { // Safety limit
        const nextButton = await page.$('a[href*="page"]:has-text("Next"), .pagination a:last-child, [aria-label="Next"]');
        if (nextButton) {
          await nextButton.click();
          await delay(2000);
          
          const newLinks = await page.evaluate(() => {
            const links = [];
            document.querySelectorAll('a[href*="SaleDetails"], a[href*="PropertyId"]').forEach(link => {
              links.push(link.href);
            });
            return links;
          });
          
          const beforeCount = propertyLinks.length;
          newLinks.forEach(link => {
            if (!propertyLinks.includes(link)) {
              propertyLinks.push(link);
            }
          });
          
          if (propertyLinks.length === beforeCount) {
            hasMore = false;
          }
          pageNum++;
        } else {
          hasMore = false;
        }
      }
    }
    
    console.log(`  Total unique property links found: ${propertyLinks.length}`);
    
    // Visit each property detail page
    for (let i = 0; i < propertyLinks.length; i++) {
      const link = propertyLinks[i];
      console.log(`  Scraping property ${i + 1}/${propertyLinks.length}...`);
      
      try {
        await page.goto(link, { waitUntil: 'networkidle2', timeout: 30000 });
        await delay(CONFIG.requestDelay);
        
        const propertyData = await page.evaluate(() => {
          const getText = (selector) => {
            const el = document.querySelector(selector);
            return el ? el.textContent.trim() : '';
          };
          
          const getTextByLabel = (label) => {
            const rows = document.querySelectorAll('tr, .row, .detail-row, dl dt, .field');
            for (const row of rows) {
              if (row.textContent.toLowerCase().includes(label.toLowerCase())) {
                const value = row.querySelector('td:last-child, dd, .value, span:last-child');
                if (value) return value.textContent.trim();
                // Try getting text after the label
                const text = row.textContent;
                const parts = text.split(/:\s*/);
                if (parts.length > 1) return parts.slice(1).join(':').trim();
              }
            }
            return '';
          };
          
          // Try multiple methods to find data
          const data = {
            sheriffNumber: getTextByLabel('sheriff') || getTextByLabel('sale number') || getTextByLabel('writ'),
            courtCase: getTextByLabel('court') || getTextByLabel('docket') || getTextByLabel('case'),
            salesDate: getTextByLabel('sale date') || getTextByLabel('auction date'),
            plaintiff: getTextByLabel('plaintiff'),
            defendant: getTextByLabel('defendant'),
            address: getTextByLabel('address') || getTextByLabel('property address') || getTextByLabel('premises'),
            city: getTextByLabel('city') || getTextByLabel('municipality'),
            zipCode: getTextByLabel('zip'),
            debtAmount: getTextByLabel('debt') || getTextByLabel('amount') || getTextByLabel('judgment'),
            attorney: getTextByLabel('attorney') || getTextByLabel('firm'),
            attorneyPhone: getTextByLabel('phone'),
            parcelNumber: getTextByLabel('parcel') || getTextByLabel('block') || getTextByLabel('lot'),
            status: getTextByLabel('status'),
            township: getTextByLabel('township') || getTextByLabel('municipality'),
          };
          
          // Also try to find address in common header locations
          const header = document.querySelector('h1, h2, .property-header, .address-header');
          if (header && !data.address) {
            data.address = header.textContent.trim();
          }
          
          return data;
        });
        
        if (propertyData.address || propertyData.sheriffNumber) {
          // Parse the address to extract city/state/zip if combined
          let address = propertyData.address;
          let city = propertyData.city;
          let state = 'NJ';
          let zipCode = propertyData.zipCode;
          
          // Try to parse "123 Main St, City, NJ 08000" format
          const addressMatch = address.match(/^(.+?),\s*([^,]+),\s*([A-Z]{2})\s*(\d{5})?/);
          if (addressMatch) {
            address = addressMatch[1];
            city = addressMatch[2];
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
            city: city || '',
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
        }
        
      } catch (err) {
        console.log(`    Error scraping property: ${err.message}`);
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
    
    console.log('  Loading auction listing...');
    await page.goto(CONFIG.bid4assets.searchUrl, { waitUntil: 'networkidle2', timeout: 60000 });
    
    // Wait for listings to load
    await delay(3000);
    
    // Scroll to load all items (they might use infinite scroll)
    let previousHeight = 0;
    let scrollAttempts = 0;
    while (scrollAttempts < 10) {
      const currentHeight = await page.evaluate(() => document.body.scrollHeight);
      if (currentHeight === previousHeight) break;
      previousHeight = currentHeight;
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await delay(1500);
      scrollAttempts++;
    }
    
    // Get all auction item links
    let auctionLinks = await page.evaluate(() => {
      const links = [];
      // Bid4Assets typically uses these patterns
      document.querySelectorAll('a[href*="/auction/index/"], a[href*="/auction/item/"], .auction-item a, .listing-item a').forEach(link => {
        if (link.href && !links.includes(link.href)) {
          links.push(link.href);
        }
      });
      return links;
    });
    
    console.log(`  Found ${auctionLinks.length} auction items`);
    
    // Check for pagination
    let pageNum = 1;
    let hasMore = true;
    
    while (hasMore && pageNum < 30) {
      const nextLink = await page.evaluate(() => {
        const next = document.querySelector('a[rel="next"], .pagination .next a, a:has-text("Next"), [aria-label="Next page"]');
        return next ? next.href : null;
      });
      
      if (nextLink) {
        await page.goto(nextLink, { waitUntil: 'networkidle2', timeout: 30000 });
        await delay(2000);
        
        const newLinks = await page.evaluate(() => {
          const links = [];
          document.querySelectorAll('a[href*="/auction/index/"], a[href*="/auction/item/"], .auction-item a, .listing-item a').forEach(link => {
            if (link.href) links.push(link.href);
          });
          return links;
        });
        
        const beforeCount = auctionLinks.length;
        newLinks.forEach(link => {
          if (!auctionLinks.includes(link)) {
            auctionLinks.push(link);
          }
        });
        
        console.log(`    Page ${pageNum + 1}: Found ${newLinks.length} items, total: ${auctionLinks.length}`);
        
        if (auctionLinks.length === beforeCount) {
          hasMore = false;
        }
        pageNum++;
      } else {
        hasMore = false;
      }
    }
    
    console.log(`  Total auction links: ${auctionLinks.length}`);
    
    // Visit each auction detail page
    for (let i = 0; i < auctionLinks.length; i++) {
      const link = auctionLinks[i];
      console.log(`  Scraping auction ${i + 1}/${auctionLinks.length}...`);
      
      try {
        await page.goto(link, { waitUntil: 'networkidle2', timeout: 30000 });
        await delay(CONFIG.requestDelay);
        
        const auctionData = await page.evaluate(() => {
          const getText = (selector) => {
            const el = document.querySelector(selector);
            return el ? el.textContent.trim() : '';
          };
          
          const getTextByLabel = (label) => {
            // Try various table/list structures
            const allText = document.body.innerText;
            const regex = new RegExp(label + '[:\\s]+([^\\n]+)', 'i');
            const match = allText.match(regex);
            if (match) return match[1].trim();
            
            // Try finding in tables
            const cells = document.querySelectorAll('td, th, dd, .value');
            for (let i = 0; i < cells.length; i++) {
              const cell = cells[i];
              const prev = cells[i - 1];
              if (prev && prev.textContent.toLowerCase().includes(label.toLowerCase())) {
                return cell.textContent.trim();
              }
            }
            return '';
          };
          
          // Get the title/address which is usually prominent
          const title = document.querySelector('h1, .auction-title, .property-title')?.textContent?.trim() || '';
          
          return {
            title: title,
            sheriffNumber: getTextByLabel('sheriff') || getTextByLabel('sale number'),
            courtCase: getTextByLabel('case') || getTextByLabel('docket'),
            salesDate: getTextByLabel('sale date') || getTextByLabel('auction date') || getTextByLabel('auction ends'),
            plaintiff: getTextByLabel('plaintiff'),
            defendant: getTextByLabel('defendant') || getTextByLabel('owner'),
            address: getTextByLabel('address') || getTextByLabel('property'),
            city: getTextByLabel('city'),
            zipCode: getTextByLabel('zip'),
            debtAmount: getTextByLabel('judgment') || getTextByLabel('debt') || getTextByLabel('upset'),
            attorney: getTextByLabel('attorney'),
            parcelNumber: getTextByLabel('parcel') || getTextByLabel('tax id'),
            status: getTextByLabel('status'),
            currentBid: getTextByLabel('current bid') || getTextByLabel('high bid'),
            township: getTextByLabel('township') || getTextByLabel('municipality'),
          };
        });
        
        // Parse address from title if needed
        let address = auctionData.address || auctionData.title;
        let city = auctionData.city;
        let zipCode = auctionData.zipCode;
        let state = 'PA';
        
        // Try to parse combined address
        const addressMatch = address.match(/^(.+?),\s*([^,]+),\s*([A-Z]{2})\s*(\d{5})?/);
        if (addressMatch) {
          address = addressMatch[1];
          city = addressMatch[2];
          state = addressMatch[3];
          zipCode = addressMatch[4] || zipCode;
        }
        
        if (address) {
          properties.push({
            source: 'Bid4Assets',
            propertyId: `B4A-${link.split('/').pop()}`,
            sheriffNumber: auctionData.sheriffNumber,
            courtCase: auctionData.courtCase,
            salesDate: auctionData.salesDate,
            plaintiff: auctionData.plaintiff,
            defendant: auctionData.defendant,
            address: address,
            city: city || '',
            state: state,
            zipCode: zipCode || '',
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
        }
        
      } catch (err) {
        console.log(`    Error scraping auction: ${err.message}`);
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
  
  // Ensure output directory exists
  await fs.mkdir(CONFIG.outputDir, { recursive: true });
  
  // Launch browser
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu',
      '--window-size=1920,1080'
    ]
  });
  
  let allProperties = [];
  
  try {
    // Scrape both sources
    const civilViewProperties = await scrapeCivilView(browser);
    const bid4AssetsProperties = await scrapeBid4Assets(browser);
    
    allProperties = [...civilViewProperties, ...bid4AssetsProperties];
    
    // Sort by debt amount
    allProperties.sort((a, b) => a.debtAmount - b.debtAmount);
    
    // Save to JSON
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

// Export for use as module or run directly
module.exports = { runScraper, CONFIG };

if (require.main === module) {
  runScraper().catch(console.error);
}
