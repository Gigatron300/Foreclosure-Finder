// Montgomery County Courts scraper for pre-foreclosure pipeline
// Scrapes Complaint in Mortgage Foreclosure and Lis Pendens cases

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const CONFIG = {
  requestDelay: 500,
  batchSize: 10,
  batchPause: 3000,
  pageTimeout: 60000,
  resultsPerPage: 100, // Request more results per page
  
  // Case types to scrape
  caseTypes: [
    { id: 58, name: 'Complaint In Mortgage Foreclosure' },
  ],
  
  baseUrl: 'https://courtsapp.montcopa.org',
  searchUrl: 'https://courtsapp.montcopa.org/psi/v/search/case'
};

// Parse date from various formats
function parseDate(dateStr) {
  if (!dateStr) return null;
  const cleaned = dateStr.trim();
  if (!cleaned) return null;
  
  // Try to parse MM/DD/YYYY format
  const match = cleaned.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (match) {
    return `${match[3]}-${match[1].padStart(2, '0')}-${match[2].padStart(2, '0')}`;
  }
  return cleaned;
}

// Calculate days since a date
function daysSince(dateStr) {
  if (!dateStr) return null;
  try {
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) return null;
    const now = new Date();
    const diffTime = Math.abs(now - date);
    return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  } catch (e) {
    return null;
  }
}

// Main scraper function
async function scrapeMontgomeryCourts(browser) {
  console.log('\n🏛️ Scraping Montgomery County Courts...');
  console.log('   Looking for pre-foreclosure cases (OPEN only)\n');
  
  const allCases = [];
  const page = await browser.newPage();
  
  try {
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1920, height: 1080 });
    
    for (const caseType of CONFIG.caseTypes) {
      console.log(`\n📋 Scraping: ${caseType.name}`);
      
      // Build search URL - request 100 results per page
      const searchUrl = `${CONFIG.searchUrl}?Q=&IncludeSoundsLike=false&Count=${CONFIG.resultsPerPage}&fromAdv=1&CaseNumber=&ParcelNumber=&CaseType=${caseType.id}&DateCommencedFrom=&DateCommencedTo=&IncludeInitialFilings=false&IncludeInitialEFilings=false&FilingType=&FilingDateFrom=&FilingDateTo=&IncludeSubsequentFilings=false&IncludeSubsequentEFilings=false&Court=C&Court=F&JudgeID=&Attorney=&AttorneyID=&Grid=true`;
      
      console.log('   Loading search results...');
      await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: CONFIG.pageTimeout });
      await delay(3000);
      
      // Extract cases from results table
      console.log('   Extracting case data...');
      const pageCases = await page.evaluate(() => {
        const cases = [];
        const rows = document.querySelectorAll('table tr');
        
        console.log('Found ' + rows.length + ' table rows');
        
        for (let i = 1; i < rows.length; i++) { // Skip header row
          const cells = rows[i].querySelectorAll('td');
          if (cells.length < 9) continue;
          
          // Get the detail link from first cell
          const selectLink = cells[0]?.querySelector('a[href*="/detail/Case/"]');
          const detailUrl = selectLink ? selectLink.href : '';
          
          // Extract case ID from URL
          const caseIdMatch = detailUrl.match(/\/detail\/Case\/(\d+)/);
          const caseId = caseIdMatch ? caseIdMatch[1] : '';
          
          // Cell indices: 0=Select, 1=Case#, 2=Commenced, 3=Type, 4=Plaintiff, 5=Defendant, 6=Parcel, 7=Judgement, 8=LisPendens, 9=Status
          const caseData = {
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
          };
          
          cases.push(caseData);
        }
        
        return cases;
      });
      
      console.log(`   Found ${pageCases.length} total cases on page`);
      
      // Filter for OPEN cases only
      const openCases = pageCases.filter(c => c.status.toUpperCase().includes('OPEN'));
      console.log(`   ${openCases.length} are OPEN (active foreclosures)`);
      
      allCases.push(...openCases);
    }
    
    // Now fetch property addresses from detail pages for OPEN cases
    console.log(`\n📍 Fetching property addresses for ${allCases.length} OPEN cases...`);
    console.log('   (This will take a few minutes)\n');
    
    for (let i = 0; i < allCases.length; i++) {
      const caseData = allCases[i];
      
      if (i > 0 && i % CONFIG.batchSize === 0) {
        console.log(`   ⏸ Batch pause...`);
        await delay(CONFIG.batchPause);
      }
      
      try {
        if (!caseData.detailUrl) {
          console.log(`   ${i + 1}/${allCases.length} ~ ${caseData.caseNumber} (no detail URL)`);
          continue;
        }
        
        await page.goto(caseData.detailUrl, { waitUntil: 'networkidle2', timeout: CONFIG.pageTimeout });
        await delay(CONFIG.requestDelay);
        
        // Extract address from Defendants section
        const details = await page.evaluate(() => {
          const result = {
            propertyAddress: '',
            propertyCity: '',
            propertyState: '',
            propertyZip: '',
            daysOpen: '',
            lastFilingDate: '',
            judge: '',
            remarks: ''
          };
          
          // Get Days Open
          const daysOpenEl = Array.from(document.querySelectorAll('td')).find(
            td => td.textContent.trim() === 'Days Open'
          );
          if (daysOpenEl && daysOpenEl.nextElementSibling) {
            result.daysOpen = daysOpenEl.nextElementSibling.textContent.trim();
          }
          
          // Get Last Filing Date
          const lastFilingEl = Array.from(document.querySelectorAll('td')).find(
            td => td.textContent.trim() === 'Last Filing Date'
          );
          if (lastFilingEl && lastFilingEl.nextElementSibling) {
            result.lastFilingDate = lastFilingEl.nextElementSibling.textContent.trim();
          }
          
          // Get Judge
          const judgeEl = Array.from(document.querySelectorAll('td')).find(
            td => td.textContent.trim() === 'Judge'
          );
          if (judgeEl && judgeEl.nextElementSibling) {
            result.judge = judgeEl.nextElementSibling.textContent.trim();
          }
          
          // Get Remarks (often has mortgage book/page info)
          const remarksEl = Array.from(document.querySelectorAll('td')).find(
            td => td.textContent.trim() === 'Remarks'
          );
          if (remarksEl && remarksEl.nextElementSibling) {
            result.remarks = remarksEl.nextElementSibling.textContent.trim();
          }
          
          // Find Defendants section and get address
          const defendantsHeader = Array.from(document.querySelectorAll('span, h2, h3, strong')).find(
            el => el.textContent.includes('Defendants')
          );
          
          if (defendantsHeader) {
            // Find the table after Defendants header
            let table = defendantsHeader.closest('table');
            if (!table) {
              // Look for next table
              let sibling = defendantsHeader.parentElement;
              while (sibling && !table) {
                sibling = sibling.nextElementSibling;
                if (sibling && sibling.tagName === 'TABLE') {
                  table = sibling;
                }
              }
            }
            
            if (table) {
              const rows = table.querySelectorAll('tr');
              // Find Address column
              const headerRow = rows[0];
              if (headerRow) {
                const headers = Array.from(headerRow.querySelectorAll('th, td')).map(h => h.textContent.trim().toLowerCase());
                const addressIdx = headers.findIndex(h => h.includes('address'));
                
                // Get first defendant's address (usually the property)
                if (rows.length > 1 && addressIdx >= 0) {
                  const firstDefendantRow = rows[1];
                  const cells = firstDefendantRow.querySelectorAll('td');
                  if (cells[addressIdx]) {
                    const fullAddress = cells[addressIdx].textContent.trim();
                    result.propertyAddress = fullAddress;
                    
                    // Try to parse city, state, zip
                    // Format is usually: "123 MAIN ST\nCITY, PA 19XXX UNITED STATES"
                    const lines = fullAddress.split('\n').map(l => l.trim()).filter(l => l);
                    if (lines.length >= 2) {
                      result.propertyAddress = lines[0];
                      const cityLine = lines[1];
                      // Parse "CITY, PA 19XXX" or "CITY, PA 19XXX UNITED STATES"
                      const cityMatch = cityLine.match(/^([^,]+),\s*([A-Z]{2})\s*(\d{5})?/);
                      if (cityMatch) {
                        result.propertyCity = cityMatch[1].trim();
                        result.propertyState = cityMatch[2];
                        result.propertyZip = cityMatch[3] || '';
                      }
                    }
                  }
                }
              }
            }
          }
          
          return result;
        });
        
        // Update case with property details
        caseData.propertyAddress = details.propertyAddress;
        caseData.propertyCity = details.propertyCity;
        caseData.propertyState = details.propertyState || 'PA';
        caseData.propertyZip = details.propertyZip;
        caseData.daysOpen = parseInt(details.daysOpen) || daysSince(caseData.commencedDate);
        caseData.lastFilingDate = details.lastFilingDate;
        caseData.judge = details.judge;
        caseData.remarks = details.remarks;
        
        const addr = details.propertyAddress || 'No address';
        console.log(`   ${i + 1}/${allCases.length} ✓ ${caseData.caseNumber} - ${addr}`);
        
      } catch (err) {
        console.log(`   ${i + 1}/${allCases.length} ~ ${caseData.caseNumber} (error: ${err.message})`);
      }
    }
    
  } catch (error) {
    console.error(`   Error: ${error.message}`);
  } finally {
    await page.close();
  }
  
  // Format final data
  const formattedCases = allCases.map(c => ({
    caseId: c.caseId,
    caseNumber: c.caseNumber,
    caseType: c.caseType,
    commencedDate: parseDate(c.commencedDate),
    daysOpen: c.daysOpen || daysSince(c.commencedDate),
    lastFilingDate: parseDate(c.lastFilingDate),
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
    judge: c.judge || '',
    remarks: c.remarks || '',
    detailUrl: c.detailUrl,
    county: 'Montgomery',
    state: 'PA'
  }));
  
  console.log(`\n✅ Montgomery County Courts: ${formattedCases.length} OPEN pre-foreclosure cases`);
  
  return formattedCases;
}

module.exports = { scrapeMontgomeryCourts, CONFIG };
