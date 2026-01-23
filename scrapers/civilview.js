// CivilView scraper - works for any county using the CivilView platform

const CONFIG = require('../config');

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const parseDebtAmount = (text) => {
  if (!text) return 0;
  const cleaned = text.replace(/[$,]/g, '').trim();
  return parseFloat(cleaned) || 0;
};

// Known cities/townships for address parsing
const KNOWN_CITIES = [
  // NJ
  'CAMDEN', 'CHERRY HILL', 'VOORHEES', 'SICKLERVILLE', 'HADDONFIELD', 
  'BLACKWOOD', 'LINDENWOLD', 'GLOUCESTER', 'PENNSAUKEN', 'COLLINGSWOOD',
  'CLEMENTON', 'ATCO', 'BERLIN', 'MAGNOLIA', 'AUDUBON', 'RUNNEMEDE',
  'BELLMAWR', 'HADDON', 'WINSLOW', 'PINE HILL', 'GLENDORA', 'ERIAL',
  'WATERFORD', 'MERCHANTVILLE', 'LAWNSIDE', 'BARRINGTON', 'SOMERDALE',
  'OAKLYN', 'WOODLYNNE', 'STRATFORD', 'LAUREL SPRINGS', 'CHESILHURST',
  'MOUNT EPHRAIM', 'BROOKLAWN', 'HADDON HEIGHTS', 'HADDON TOWNSHIP',
  'GLOUCESTER CITY', 'GLOUCESTER TWP', 'WINSLOW TOWNSHIP', 'HAMMONTON',
  // PA - Montgomery County
  'NORRISTOWN', 'KING OF PRUSSIA', 'LANSDALE', 'POTTSTOWN', 'AMBLER',
  'CONSHOHOCKEN', 'JENKINTOWN', 'HATBORO', 'COLLEGEVILLE', 'ROYERSFORD',
  'TRAPPE', 'SCHWENKSVILLE', 'PENNSBURG', 'SOUDERTON', 'TELFORD', 
  'HATFIELD', 'NORTH WALES', 'ABINGTON', 'CHELTENHAM', 'UPPER MERION',
  'LOWER MERION', 'UPPER DUBLIN', 'HORSHAM', 'WILLOW GROVE', 'BLUE BELL',
  'LIMERICK', 'LIMERICK TOWNSHIP', 'PERKIOMEN TOWNSHIP', 'SPRINGFIELD',
  'ARDMORE', 'BRYN MAWR', 'GLADWYNE', 'ELKINS PARK', 'GLENSIDE',
  'BRIDGEPORT', 'EAST NORRITON', 'WEST NORRITON', 'PLYMOUTH MEETING',
  'WHITEMARSH', 'FLOURTOWN', 'FORT WASHINGTON', 'DRESHER', 'MAPLE GLEN',
  'HARLEYSVILLE', 'SKIPPACK', 'WORCESTER', 'FRANCONIA', 'SALFORD',
  'LOWER SALFORD', 'UPPER SALFORD', 'MARLBOROUGH', 'GREEN LANE',
  'RED HILL', 'EAST GREENVILLE', 'UPPER HANOVER', 'LOWER FREDERICK',
  'UPPER FREDERICK', 'NEW HANOVER', 'DOUGLASS', 'UPPER POTTSGROVE',
  'LOWER POTTSGROVE', 'WEST POTTSGROVE', 'LOWER PROVIDENCE', 
  'UPPER PROVIDENCE', 'TOWAMENCIN', 'MONTGOMERY', 'UPPER GWYNEDD',
  'LOWER GWYNEDD', 'WHITPAIN', 'UPPER MORELAND', 'LOWER MORELAND',
  'ABINGTON TOWNSHIP', 'BRYN ATHYN', 'ROCKLEDGE', 'WEST CONSHOHOCKEN'
];

function parseAddress(fullAddress, defaultState = 'NJ') {
  if (!fullAddress) return { address: '', city: '', state: defaultState, zipCode: '' };
  
  // Normalize whitespace
  fullAddress = fullAddress.replace(/\s+/g, ' ').trim();
  
  // Extract zip code
  const zipMatch = fullAddress.match(/(\d{5})(-\d{4})?/);
  const zipCode = zipMatch ? zipMatch[1] : '';
  
  // Extract state
  const stateMatch = fullAddress.match(/\b(NJ|PA)\b/i);
  const state = stateMatch ? stateMatch[1].toUpperCase() : defaultState;
  
  let city = '';
  let address = fullAddress;
  
  // Handle A/K/A addresses
  if (fullAddress.includes('A/K/A')) {
    fullAddress = fullAddress.split('A/K/A')[0].trim();
    address = fullAddress;
  }
  
  // Try to find city - check for concatenated city names (no space before city)
  const upperAddress = fullAddress.toUpperCase();
  
  // Sort cities by length (longest first) to match "LOWER MERION" before "MERION"
  const sortedCities = [...KNOWN_CITIES].sort((a, b) => b.length - a.length);
  
  for (const knownCity of sortedCities) {
    // Look for the city name, possibly concatenated with previous word
    const cityRegex = new RegExp(`(.+?)\\s*${knownCity}`, 'i');
    const match = upperAddress.match(cityRegex);
    
    if (match) {
      city = knownCity;
      // Extract just the street address part
      address = fullAddress.substring(0, match[1].length).trim();
      
      // Clean up - remove trailing punctuation and extra spaces
      address = address.replace(/[,\s]+$/, '').trim();
      
      // If address ends with a word that looks like start of city name concatenated
      // e.g., "10 Fraley Street" from "10 Fraley StreetBridgeport"
      // Check if last word is incomplete (city was concatenated)
      const lastWord = address.split(' ').pop();
      if (lastWord && !lastWord.match(/^\d/) && lastWord.length > 2) {
        // Check if this might be a street type
        const streetTypes = ['STREET', 'ST', 'AVENUE', 'AVE', 'ROAD', 'RD', 'DRIVE', 'DR', 
                            'LANE', 'LN', 'COURT', 'CT', 'PLACE', 'PL', 'CIRCLE', 'CIR',
                            'BOULEVARD', 'BLVD', 'WAY', 'TERRACE', 'TER', 'PIKE', 'TRAIL'];
        const isStreetType = streetTypes.some(t => lastWord.toUpperCase() === t);
        if (!isStreetType) {
          // Last word might be partial - try to clean it
          // This handles cases like "StreetBridgeport" -> we already captured "Street"
        }
      }
      break;
    }
  }
  
  // If no city found via known cities, try to parse from format: "123 Main St, City, ST 12345"
  if (!city && fullAddress.includes(',')) {
    const parts = fullAddress.split(',');
    if (parts.length >= 2) {
      address = parts[0].trim();
      // Second part might be "City ST 12345" or just "City"
      const cityPart = parts[1].trim();
      const cityMatch = cityPart.match(/^([A-Za-z\s]+?)(?:\s+(?:NJ|PA)\s*\d{5})?$/i);
      if (cityMatch) {
        city = cityMatch[1].trim().toUpperCase();
      }
    }
  }
  
  // Remove state and zip from address if still present
  address = address.replace(/\s*(NJ|PA)\s*\d{5}(-\d{4})?\s*$/i, '').trim();
  address = address.replace(/,\s*$/, '').trim();
  
  return { address, city, state, zipCode };
}

// Main scraper function for a single county
async function scrapeCounty(browser, county) {
  console.log(`\n🔍 Scraping ${county.name} County, ${county.state}...`);
  const properties = [];
  const page = await browser.newPage();
  
  try {
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
    await page.setViewport({ width: 1920, height: 1080 });
    
    // Load search page
    console.log('  Loading listings...');
    await page.goto(county.searchUrl, { waitUntil: 'networkidle2', timeout: 90000 });
    await page.waitForSelector('a[href*="SaleDetails"]', { timeout: 30000 });
    await delay(3000);
    
    // Scroll to load all
    await page.evaluate(async () => {
      await new Promise((resolve) => {
        let totalHeight = 0;
        const distance = 500;
        const timer = setInterval(() => {
          window.scrollBy(0, distance);
          totalHeight += distance;
          if (totalHeight >= document.body.scrollHeight) {
            clearInterval(timer);
            resolve();
          }
        }, 100);
      });
    });
    await page.evaluate(() => window.scrollTo(0, 0));
    await delay(2000);
    
    // Get all listing links and basic data
    const listings = await page.evaluate(() => {
      const results = [];
      const tables = document.querySelectorAll('table');
      let dataTable = Array.from(tables).find(t => t.querySelectorAll('tr').length > 5);
      if (!dataTable) return results;
      
      const rows = dataTable.querySelectorAll('tr');
      const headers = Array.from(rows[0].querySelectorAll('td, th')).map(h => h.textContent.trim().toLowerCase());
      
      const col = {
        sheriff: headers.findIndex(h => h.includes('sheriff')),
        township: headers.findIndex(h => h.includes('township')),
        salesDate: headers.findIndex(h => h.includes('sales') && h.includes('date')),
        plaintiff: headers.findIndex(h => h.includes('plaintiff')),
        defendant: headers.findIndex(h => h.includes('defendant')),
        address: headers.findIndex(h => h.includes('address'))
      };
      
      for (let i = 1; i < rows.length; i++) {
        const cells = rows[i].querySelectorAll('td');
        const link = rows[i].querySelector('a[href*="SaleDetails"]');
        if (link && cells.length >= 5) {
          results.push({
            url: link.href,
            sheriff: col.sheriff >= 0 ? cells[col.sheriff]?.textContent?.trim() : '',
            township: col.township >= 0 ? cells[col.township]?.textContent?.trim() : '',
            salesDate: col.salesDate >= 0 ? cells[col.salesDate]?.textContent?.trim() : '',
            plaintiff: col.plaintiff >= 0 ? cells[col.plaintiff]?.textContent?.trim() : '',
            defendant: col.defendant >= 0 ? cells[col.defendant]?.textContent?.trim() : '',
            address: col.address >= 0 ? cells[col.address]?.textContent?.trim() : ''
          });
        }
      }
      return results;
    });
    
    console.log(`  Found ${listings.length} properties`);
    
    // Scrape each detail page
    for (let i = 0; i < listings.length; i++) {
      if (i > 0 && i % CONFIG.batchSize === 0) {
        console.log(`  ⏸ Batch pause...`);
        await delay(CONFIG.batchPause);
      }
      
      const listing = listings[i];
      
      try {
        await page.goto(listing.url, { waitUntil: 'networkidle2', timeout: CONFIG.pageTimeout });
        await delay(500);
        
        // Extract detail page data
        const data = await page.evaluate(() => {
          const getField = (label) => {
            const items = document.querySelectorAll('.sale-detail-item');
            for (const item of items) {
              const l = item.querySelector('.sale-detail-label');
              const v = item.querySelector('.sale-detail-value');
              if (l && v && l.textContent.toLowerCase().includes(label.toLowerCase())) {
                return v.textContent.trim().replace(/\s+/g, ' ');
              }
            }
            return '';
          };
          
          const getStatusHistory = () => {
            const history = [];
            document.querySelectorAll('table').forEach(table => {
              const header = table.querySelector('tr');
              if (header?.textContent.includes('Status') && header?.textContent.includes('Date')) {
                table.querySelectorAll('tr').forEach((row, i) => {
                  if (i > 0) {
                    const cells = row.querySelectorAll('td');
                    if (cells.length >= 2) {
                      history.push({ status: cells[0].textContent.trim(), date: cells[1].textContent.trim() });
                    }
                  }
                });
              }
            });
            return history;
          };
          
          const statusHistory = getStatusHistory();
          
          return {
            sheriff: getField('sheriff'),
            courtCase: getField('court case'),
            salesDate: getField('sales date'),
            plaintiff: getField('plaintiff'),
            defendant: getField('defendant'),
            address: getField('address'),
            debt: getField('debt amount') || getField('approx') || getField('upset'),
            attorney: getField('attorney'),
            attorneyPhone: getField('attorney phone'),
            parcel: getField('parcel'),
            township: getField('township'),
            description: getField('description'),
            status: statusHistory.length > 0 ? statusHistory[statusHistory.length - 1].status : 'Scheduled',
            statusHistory
          };
        });
        
        const addr = parseAddress(data.address || listing.address, county.state);
        
        properties.push({
          source: 'CivilView',
          propertyId: `CV-${county.name}-${data.sheriff || listing.sheriff || i}`,
          sheriffNumber: data.sheriff || listing.sheriff,
          courtCase: data.courtCase,
          salesDate: data.salesDate || listing.salesDate,
          plaintiff: data.plaintiff || listing.plaintiff,
          defendant: data.defendant || listing.defendant,
          address: addr.address || data.address || listing.address,
          city: addr.city,
          state: addr.state,
          zipCode: addr.zipCode,
          debtAmount: parseDebtAmount(data.debt),
          attorney: data.attorney,
          attorneyPhone: data.attorneyPhone,
          parcelNumber: data.parcel,
          description: data.description,
          status: data.status,
          statusHistory: data.statusHistory,
          county: county.name,
          township: data.township || listing.township || addr.city,
          detailUrl: listing.url
        });
        
        const debt = parseDebtAmount(data.debt);
        console.log(`  ${i + 1}/${listings.length} ✓ ${addr.address || 'Property'} - ${debt > 0 ? '$' + debt.toLocaleString() : 'N/A'}`);
        
      } catch (err) {
        // Use listing data as fallback
        const addr = parseAddress(listing.address, county.state);
        properties.push({
          source: 'CivilView',
          propertyId: `CV-${county.name}-${listing.sheriff || i}`,
          sheriffNumber: listing.sheriff,
          courtCase: '',
          salesDate: listing.salesDate,
          plaintiff: listing.plaintiff,
          defendant: listing.defendant,
          address: addr.address || listing.address,
          city: addr.city,
          state: addr.state,
          zipCode: addr.zipCode,
          debtAmount: 0,
          attorney: '',
          attorneyPhone: '',
          parcelNumber: '',
          description: '',
          status: 'Unknown',
          statusHistory: [],
          county: county.name,
          township: listing.township || addr.city,
          detailUrl: listing.url
        });
        console.log(`  ${i + 1}/${listings.length} ~ ${addr.address || listing.sheriff} (fallback)`);
      }
    }
    
  } catch (error) {
    console.error(`  Error: ${error.message}`);
  } finally {
    await page.close();
  }
  
  console.log(`  ✅ ${county.name}: ${properties.length} properties`);
  return properties;
}

module.exports = { scrapeCounty };
