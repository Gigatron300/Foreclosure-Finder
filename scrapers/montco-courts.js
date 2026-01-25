// Montgomery County Courts scraper for pre-foreclosure pipeline
// Uses Puppeteer (required for session cookies) with memory optimizations

const puppeteer = require('puppeteer');

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const CONFIG = {
  requestDelay: 500,
  batchSize: 5,
  batchPause: 2000,
  resultsPerPage: 200, // Get more results to include recent cases
  maxCasesToProcess: 30, // Limit cases to stay under memory
  maxDaysOld: 730, // Include cases up to 2 years old
  
  caseTypes: [
    { id: 58, name: 'Complaint In Mortgage Foreclosure' },
  ],
  
  baseUrl: 'https://courtsapp.montcopa.org',
  searchUrl: 'https://courtsapp.montcopa.org/psi/v/search/case'
};

// Parse date from MM/DD/YYYY to YYYY-MM-DD
function parseDate(dateStr) {
  if (!dateStr) return null;
  const match = dateStr.trim().match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (match) {
    return `${match[3]}-${match[1].padStart(2, '0')}-${match[2].padStart(2, '0')}`;
  }
  return dateStr.trim() || null;
}

// Calculate days since a date
function daysSince(dateStr) {
  if (!dateStr) return null;
  try {
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) return null;
    const now = new Date();
    return Math.ceil(Math.abs(now - date) / (1000 * 60 * 60 * 24));
  } catch (e) {
    return null;
  }
}

// Main scraper function
async function scrapeMontgomeryCourts() {
  console.log('\n🏛️ Scraping Montgomery County Courts...');
  console.log('   (Using Puppeteer for session handling)\n');
  
  const allCases = [];
  
  // Launch browser with minimal memory settings
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-default-apps',
      '--disable-sync',
      '--disable-translate',
      '--hide-scrollbars',
      '--metrics-recording-only',
      '--mute-audio',
      '--no-first-run',
      '--safebrowsing-disable-auto-update',
      '--js-flags=--max-old-space-size=256'
    ]
  });
  
  const page = await browser.newPage();
  
  // Disable images and CSS to save memory
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const resourceType = req.resourceType();
    if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
      req.abort();
    } else {
      req.continue();
    }
  });
  
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
  
  try {
    for (const caseType of CONFIG.caseTypes) {
      console.log(`📋 Scraping: ${caseType.name}`);
      
      // Build search URL with date filter for recent cases
      // Get date from 1 year ago
      const oneYearAgo = new Date();
      oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
      const fromDate = `${oneYearAgo.getMonth() + 1}/${oneYearAgo.getDate()}/${oneYearAgo.getFullYear()}`;
      
      const searchUrl = `${CONFIG.searchUrl}?Q=&IncludeSoundsLike=false&Count=${CONFIG.resultsPerPage}&fromAdv=1&CaseType=${caseType.id}&DateCommencedFrom=${encodeURIComponent(fromDate)}&Court=C&Court=F&Grid=true`;
      
      console.log(`   Searching for cases since ${fromDate}...`);
      
      console.log('   Loading search page...');
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await delay(2000);
      
      // Extract cases from results table
      console.log('   Extracting case data...');
      const pageCases = await page.evaluate(() => {
        const cases = [];
        const rows = document.querySelectorAll('table tr');
        
        for (let i = 1; i < rows.length; i++) {
          const cells = rows[i].querySelectorAll('td');
          if (cells.length < 9) continue;
          
          const selectLink = cells[0]?.querySelector('a[href*="/detail/Case/"]');
          const detailUrl = selectLink ? selectLink.href : '';
          const caseIdMatch = detailUrl.match(/\/detail\/Case\/(\d+)/);
          const caseId = caseIdMatch ? caseIdMatch[1] : '';
          
          cases.push({
            caseId,
            caseNumber: cells[1]?.textContent?.trim() || '',
            commencedDate: cells[2]?.textContent?.trim() || '',
            caseType: cells[3]?.textContent?.trim() || '',
            plaintiff: cells[4]?.textContent?.trim() || '',
            defendant: cells[5]?.textContent?.trim() || '',
            parcelNumber: cells[6]?.textContent?.trim() || '',
            hasJudgement: (cells[7]?.textContent?.trim() || '').toLowerCase() === 'yes',
            hasLisPendens: (cells[8]?.textContent?.trim() || '').toLowerCase() === 'yes',
            status: cells[9]?.textContent?.trim() || '',
            detailUrl
          });
        }
        return cases;
      });
      
      console.log(`   Found ${pageCases.length} total cases`);
      
      // Filter for OPEN cases only
      let openCases = pageCases.filter(c => c.status.toUpperCase().includes('OPEN'));
      console.log(`   ${openCases.length} are OPEN`);
      
      // Sort by date (newest first)
      openCases.sort((a, b) => {
        const parseDate = (dateStr) => {
          if (!dateStr) return new Date(0);
          const match = dateStr.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
          if (match) return new Date(match[3], match[1] - 1, match[2]);
          return new Date(0);
        };
        return parseDate(b.commencedDate) - parseDate(a.commencedDate);
      });
      console.log(`   Sorted by date (newest first)`);
      
      // Limit to save memory
      if (openCases.length > CONFIG.maxCasesToProcess) {
        console.log(`   Limiting to ${CONFIG.maxCasesToProcess} cases to save memory`);
        openCases = openCases.slice(0, CONFIG.maxCasesToProcess);
      }
      
      // Fetch details for each open case
      console.log(`\n📍 Fetching addresses for ${openCases.length} cases...`);
      
      for (let i = 0; i < openCases.length; i++) {
        const caseData = openCases[i];
        
        if (i > 0 && i % CONFIG.batchSize === 0) {
          console.log('   ⏸ Batch pause...');
          await delay(CONFIG.batchPause);
        }
        
        try {
          await delay(CONFIG.requestDelay);
          await page.goto(caseData.detailUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
          
          const details = await page.evaluate(() => {
            const result = {
              propertyAddress: '',
              propertyCity: '',
              propertyState: 'PA',
              propertyZip: '',
              daysOpen: null
            };
            
            // Get Days Open
            const allTds = document.querySelectorAll('td');
            for (const td of allTds) {
              if (td.textContent.trim() === 'Days Open' && td.nextElementSibling) {
                result.daysOpen = parseInt(td.nextElementSibling.textContent.trim()) || null;
                break;
              }
            }
            
            // Get address from Defendants table (it's the 3rd table, index 2)
            // Tables on page: 0=Case Info, 1=Plaintiffs, 2=Defendants, 3=Docket, 4=Judgements
            const tables = document.querySelectorAll('table');
            if (tables.length >= 3) {
              const defTable = tables[2];
              const rows = defTable.querySelectorAll('tr');
              if (rows.length >= 2) {
                const cells = rows[1].querySelectorAll('td');
                // Cell 2 is Address (0=Select, 1=Name, 2=Address, 3=Country...)
                if (cells[2]) {
                  const fullAddress = cells[2].textContent.trim();
                  
                  // Format is: "25 ASPEN WAYSCHWENKSVILLE, PA 19473 UNITED STATES"
                  // Street and city are concatenated without space
                  // Look for ", PA" or ", NJ" followed by zip code
                  const stateZipMatch = fullAddress.match(/,\s*(PA|NJ)\s*(\d{5})/i);
                  
                  if (stateZipMatch) {
                    result.propertyState = stateZipMatch[1].toUpperCase();
                    result.propertyZip = stateZipMatch[2];
                    
                    // Everything before ", PA 19XXX" is street + city
                    const beforeStateZip = fullAddress.substring(0, fullAddress.indexOf(stateZipMatch[0]));
                    
                    // Find where city starts - look for common PA city names or patterns
                    // Cities often start with capital letter after lowercase or number
                    // Pattern: "25 ASPEN WAYSCHWENKSVILLE" -> split at last uppercase sequence before comma
                    
                    // Try to find street type (WAY, ST, AVE, etc) to split
                    const streetTypeMatch = beforeStateZip.match(/^(.+(?:WAY|STREET|ST|AVENUE|AVE|ROAD|RD|DRIVE|DR|LANE|LN|COURT|CT|CIRCLE|CIR|BOULEVARD|BLVD|PLACE|PL|TERRACE|TER|PIKE|TRAIL|TRL))\s*(.*)$/i);
                    
                    if (streetTypeMatch) {
                      result.propertyAddress = streetTypeMatch[1].trim();
                      result.propertyCity = streetTypeMatch[2].trim();
                    } else {
                      // Fallback: find where numbers end and try to split
                      // "123 MAIN STCITYNAME" - look for double capital pattern
                      const doubleCapMatch = beforeStateZip.match(/^(.+[a-z])([A-Z][A-Za-z\s]+)$/);
                      if (doubleCapMatch) {
                        result.propertyAddress = doubleCapMatch[1].trim();
                        result.propertyCity = doubleCapMatch[2].trim();
                      } else {
                        // Last resort: just use everything before state as address
                        result.propertyAddress = beforeStateZip.trim();
                      }
                    }
                  } else {
                    // No state/zip found, just clean up
                    result.propertyAddress = fullAddress.replace(/UNITED STATES/i, '').trim();
                  }
                }
              }
            }
            
            return result;
          });
          
          caseData.propertyAddress = details.propertyAddress;
          caseData.propertyCity = details.propertyCity;
          caseData.propertyState = details.propertyState;
          caseData.propertyZip = details.propertyZip;
          caseData.daysOpen = details.daysOpen || daysSince(parseDate(caseData.commencedDate));
          
          const addr = details.propertyAddress || 'No address';
          console.log(`   ${i + 1}/${openCases.length} ✓ ${caseData.caseNumber} - ${addr}`);
          
        } catch (err) {
          console.log(`   ${i + 1}/${openCases.length} ~ ${caseData.caseNumber} (${err.message})`);
          caseData.daysOpen = daysSince(parseDate(caseData.commencedDate));
        }
      }
      
      allCases.push(...openCases);
    }
  } catch (error) {
    console.error(`Error: ${error.message}`);
  } finally {
    await browser.close();
  }
  
  // Format final data
  const formattedCases = allCases.map(c => ({
    caseId: c.caseId,
    caseNumber: c.caseNumber,
    caseType: c.caseType,
    commencedDate: parseDate(c.commencedDate),
    daysOpen: c.daysOpen || daysSince(parseDate(c.commencedDate)),
    lastFilingDate: null,
    plaintiff: c.plaintiff,
    defendant: c.defendant,
    propertyAddress: c.propertyAddress || '',
    propertyCity: c.propertyCity || '',
    propertyState: c.propertyState || 'PA',
    propertyZip: c.propertyZip || '',
    parcelNumber: c.parcelNumber || '',
    hasJudgement: c.hasJudgement,
    hasLisPendens: c.hasLisPendens,
    status: c.status,
    judge: '',
    remarks: '',
    detailUrl: c.detailUrl,
    county: 'Montgomery',
    state: 'PA'
  }));
  
  console.log(`\n✅ Montgomery County Courts: ${formattedCases.length} OPEN pre-foreclosure cases`);
  
  return formattedCases;
}

module.exports = { scrapeMontgomeryCourts, CONFIG };
