// Montgomery County Courts scraper for pre-foreclosure pipeline
// Scrapes Complaint in Mortgage Foreclosure and Lis Pendens cases

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const CONFIG = {
  requestDelay: 500,
  batchSize: 20,
  batchPause: 3000,
  pageTimeout: 30000,
  maxPages: 100, // Safety limit - 100 pages * 20 results = 2000 cases max
  
  // Case types to scrape
  caseTypes: [
    { id: 58, name: 'Complaint In Mortgage Foreclosure' },
    // { id: XX, name: 'Lis Pendens' } // Can add later if needed
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
  const date = new Date(dateStr);
  const now = new Date();
  const diffTime = Math.abs(now - date);
  return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
}

// Main scraper function
async function scrapeMontgomeryCourts(browser) {
  console.log('\n🏛️ Scraping Montgomery County Courts...');
  console.log('   Looking for pre-foreclosure cases (OPEN only)\n');
  
  const allCases = [];
  const page = await browser.newPage();
  
  try {
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
    await page.setViewport({ width: 1920, height: 1080 });
    
    for (const caseType of CONFIG.caseTypes) {
      console.log(`\n📋 Scraping: ${caseType.name}`);
      
      // Build search URL with case type filter
      const searchParams = new URLSearchParams({
        Q: '',
        IncludeSoundsLike: 'false',
        Count: '20',
        fromAdv: '1',
        CaseNumber: '',
        ParcelNumber: '',
        CaseType: caseType.id.toString(),
        DateCommencedFrom: '',
        DateCommencedTo: '',
        IncludeInitialFilings: 'false',
        IncludeInitialEFilings: 'false',
        FilingType: '',
        FilingDateFrom: '',
        FilingDateTo: '',
        IncludeSubsequentFilings: 'false',
        IncludeSubsequentEFilings: 'false',
        Court: 'C',
        JudgeID: '',
        Attorney: '',
        AttorneyID: '',
        Grid: 'true'
      });
      
      // Add second Court parameter (the site uses multiple)
      const searchUrl = `${CONFIG.searchUrl}?${searchParams.toString()}&Court=F`;
      
      await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: CONFIG.pageTimeout });
      await delay(2000);
      
      // Get all cases from search results (paginated)
      let pageNum = 1;
      let hasMorePages = true;
      let casesFromType = [];
      
      while (hasMorePages && pageNum <= CONFIG.maxPages) {
        console.log(`   Page ${pageNum}...`);
        
        // Extract cases from current page
        const pageCases = await page.evaluate(() => {
          const cases = [];
          const rows = document.querySelectorAll('table tr');
          
          for (let i = 1; i < rows.length; i++) { // Skip header row
            const cells = rows[i].querySelectorAll('td');
            if (cells.length < 8) continue;
            
            // Get the detail link
            const selectLink = rows[i].querySelector('a[href*="/detail/Case/"]');
            const detailUrl = selectLink ? selectLink.href : '';
            
            // Extract case ID from URL
            const caseIdMatch = detailUrl.match(/\/detail\/Case\/(\d+)/);
            const caseId = caseIdMatch ? caseIdMatch[1] : '';
            
            const caseData = {
              caseId,
              caseNumber: cells[1]?.textContent?.trim() || '',
              commencedDate: cells[2]?.textContent?.trim() || '',
              caseType: cells[3]?.textContent?.trim() || '',
              plaintiff: cells[4]?.textContent?.trim() || '',
              defendant: cells[5]?.textContent?.trim() || '',
              parcelNumber: cells[6]?.textContent?.trim() || '',
              hasJudgement: cells[7]?.textContent?.trim()?.toLowerCase() === 'yes',
              hasLisPendens: cells[8]?.textContent?.trim()?.toLowerCase() === 'yes',
              status: cells[9]?.textContent?.trim() || '',
              detailUrl
            };
            
            cases.push(caseData);
          }
          
          return cases;
        });
        
        // Filter for OPEN cases only
        const openCases = pageCases.filter(c => c.status.toUpperCase().includes('OPEN'));
        console.log(`   Found ${pageCases.length} cases, ${openCases.length} are OPEN`);
        
        casesFromType.push(...openCases);
        
        // Check if there's a next page
        const nextPageExists = await page.evaluate(() => {
          // Look for pagination - this site uses "Next" or page numbers
          const paginationLinks = document.querySelectorAll('a');
          for (const link of paginationLinks) {
            if (link.textContent.includes('Next') || link.textContent.includes('›')) {
              return true;
            }
          }
          // Also check if we're at max results indicator
          const displayText = document.body.textContent;
          if (displayText.includes('more than 1000')) {
            return true;
          }
          return false;
        });
        
        // Try to go to next page
        if (nextPageExists && pageNum < CONFIG.maxPages) {
          const clicked = await page.evaluate(() => {
            const links = document.querySelectorAll('a');
            for (const link of links) {
              if (link.textContent.trim() === 'Next' || link.textContent.trim() === '›') {
                link.click();
                return true;
              }
            }
            // Try clicking page number
            const nextNum = document.querySelector(`a[href*="Page=${pageNum + 1}"]`);
            if (nextNum) {
              nextNum.click();
              return true;
            }
            return false;
          });
          
          if (clicked) {
            await delay(2000);
            pageNum++;
          } else {
            hasMorePages = false;
          }
        } else {
          hasMorePages = false;
        }
        
        // Safety check - if no cases found on this page, stop
        if (pageCases.length === 0) {
          hasMorePages = false;
        }
      }
      
      console.log(`   Total OPEN ${caseType.name} cases: ${casesFromType.length}`);
      allCases.push(...casesFromType);
    }
    
    // Now fetch property addresses from detail pages for OPEN cases
    console.log(`\n📍 Fetching property addresses for ${allCases.length} OPEN cases...`);
    
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
