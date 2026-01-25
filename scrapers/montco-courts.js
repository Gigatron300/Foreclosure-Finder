// Montgomery County Courts scraper for pre-foreclosure pipeline
// Uses lightweight HTTP requests instead of Puppeteer to save memory

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const CONFIG = {
  requestDelay: 300,
  batchSize: 10,
  batchPause: 2000,
  resultsPerPage: 100,
  
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

// Parse HTML table rows from search results
function parseSearchResults(html) {
  const cases = [];
  
  // Find table rows - look for rows with case data
  // Pattern: <tr>...<td>Select</td><td>Case#</td>...
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
  const linkRegex = /<a[^>]*href="([^"]*\/detail\/Case\/(\d+))"[^>]*>Select<\/a>/i;
  
  let rowMatch;
  while ((rowMatch = rowRegex.exec(html)) !== null) {
    const rowHtml = rowMatch[1];
    
    // Check if this row has a Select link (data row, not header)
    const linkMatch = rowHtml.match(linkRegex);
    if (!linkMatch) continue;
    
    const detailUrl = CONFIG.baseUrl + linkMatch[1];
    const caseId = linkMatch[2];
    
    // Extract all cell contents
    const cells = [];
    let cellMatch;
    const cellRegexLocal = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    while ((cellMatch = cellRegexLocal.exec(rowHtml)) !== null) {
      // Strip HTML tags from cell content
      const content = cellMatch[1].replace(/<[^>]*>/g, '').trim();
      cells.push(content);
    }
    
    if (cells.length >= 10) {
      // Cells: 0=Select, 1=Case#, 2=Commenced, 3=Type, 4=Plaintiff, 5=Defendant, 6=Parcel, 7=Judgement, 8=LisPendens, 9=Status
      cases.push({
        caseId,
        caseNumber: cells[1] || '',
        commencedDate: cells[2] || '',
        caseType: cells[3] || '',
        plaintiff: cells[4] || '',
        defendant: cells[5] || '',
        parcelNumber: cells[6] || '',
        hasJudgement: (cells[7] || '').toLowerCase() === 'yes',
        hasLisPendens: (cells[8] || '').toLowerCase() === 'yes',
        status: cells[9] || '',
        detailUrl
      });
    }
  }
  
  return cases;
}

// Parse case detail page to get address
function parseDetailPage(html) {
  const result = {
    propertyAddress: '',
    propertyCity: '',
    propertyState: 'PA',
    propertyZip: '',
    daysOpen: null,
    lastFilingDate: '',
    judge: '',
    remarks: ''
  };
  
  // Get Days Open - look for pattern like: Days Open</td><td>500
  const daysMatch = html.match(/Days\s*Open<\/t[dh]>\s*<td[^>]*>\s*(\d+)/i);
  if (daysMatch) {
    result.daysOpen = parseInt(daysMatch[1]);
  }
  
  // Get Last Filing Date
  const lastFilingMatch = html.match(/Last\s*Filing\s*Date<\/t[dh]>\s*<td[^>]*>\s*([^<]+)/i);
  if (lastFilingMatch) {
    result.lastFilingDate = lastFilingMatch[1].trim();
  }
  
  // Get Judge
  const judgeMatch = html.match(/<t[dh][^>]*>\s*Judge\s*<\/t[dh]>\s*<td[^>]*>\s*([^<]+)/i);
  if (judgeMatch) {
    result.judge = judgeMatch[1].trim();
  }
  
  // Get Remarks
  const remarksMatch = html.match(/<t[dh][^>]*>\s*Remarks\s*<\/t[dh]>\s*<td[^>]*>\s*([^<]+)/i);
  if (remarksMatch) {
    result.remarks = remarksMatch[1].trim();
  }
  
  // Find Defendants section - it has id="table_Defendants"
  // The address is in the 3rd column (index 2) of the first data row
  const defendantsSectionMatch = html.match(/id="table_Defendants"[\s\S]*?<table[^>]*>([\s\S]*?)<\/table>/i);
  
  if (defendantsSectionMatch) {
    const tableHtml = defendantsSectionMatch[1];
    
    // Find data rows (skip header row)
    const rowMatches = tableHtml.match(/<tr[^>]*>([\s\S]*?)<\/tr>/gi);
    
    if (rowMatches && rowMatches.length >= 2) {
      // Second row is first data row
      const dataRowHtml = rowMatches[1];
      
      // Extract all td cells
      const cells = [];
      const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
      let cellMatch;
      while ((cellMatch = cellRegex.exec(dataRowHtml)) !== null) {
        // Strip HTML and clean up whitespace
        const content = cellMatch[1]
          .replace(/<[^>]*>/g, ' ')
          .replace(/&nbsp;/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        cells.push(content);
      }
      
      // Address is in column 2 (0-indexed) based on: Select, Name, Address, Country, Counsel, Notify, Sequence, Status
      if (cells[2]) {
        const fullAddress = cells[2];
        
        // Parse address format: "25 ASPEN WAYSCHWENKSVILLE, PA 19473 UNITED STATES"
        // or "123 MAIN ST CITY, PA 19XXX UNITED STATES"
        // The address and city often run together without space
        
        // Try to find city, state, zip pattern
        const cityStateZipMatch = fullAddress.match(/([A-Z][A-Z\s]*),\s*(PA|NJ)\s*(\d{5})/i);
        
        if (cityStateZipMatch) {
          const cityPart = cityStateZipMatch[1].trim();
          result.propertyState = cityStateZipMatch[2].toUpperCase();
          result.propertyZip = cityStateZipMatch[3];
          
          // Find where city starts in the address
          const cityIndex = fullAddress.indexOf(cityPart);
          if (cityIndex > 0) {
            // Everything before city is the street address
            let street = fullAddress.substring(0, cityIndex).trim();
            
            // Sometimes street and city run together, try to split on common patterns
            // Look for house number + street name pattern
            const streetMatch = street.match(/^(\d+\s+[\w\s]+(?:ST|STREET|AVE|AVENUE|RD|ROAD|DR|DRIVE|LN|LANE|WAY|CT|COURT|BLVD|PL|PLACE|CIR|CIRCLE))\s*/i);
            if (streetMatch) {
              result.propertyAddress = streetMatch[1].trim();
            } else {
              result.propertyAddress = street;
            }
            
            result.propertyCity = cityPart;
          }
        } else {
          // Fallback: just clean up the address
          result.propertyAddress = fullAddress
            .replace(/UNITED STATES/i, '')
            .replace(/\s+/g, ' ')
            .trim();
        }
      }
    }
  }
  
  return result;
}

// Main scraper function - uses simple HTTP requests
async function scrapeMontgomeryCourts() {
  console.log('\n🏛️ Scraping Montgomery County Courts...');
  console.log('   Using lightweight HTTP requests (no browser)\n');
  
  const allCases = [];
  
  try {
    for (const caseType of CONFIG.caseTypes) {
      console.log(`📋 Scraping: ${caseType.name}`);
      
      // Build search URL
      const searchUrl = `${CONFIG.searchUrl}?Q=&IncludeSoundsLike=false&Count=${CONFIG.resultsPerPage}&fromAdv=1&CaseType=${caseType.id}&Court=C&Court=F&Grid=true`;
      
      console.log('   Fetching search results...');
      const searchResponse = await fetch(searchUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'text/html,application/xhtml+xml'
        }
      });
      
      if (!searchResponse.ok) {
        console.log(`   Error: HTTP ${searchResponse.status}`);
        continue;
      }
      
      const searchHtml = await searchResponse.text();
      console.log(`   Got ${searchHtml.length} bytes of HTML`);
      
      // Parse search results
      const pageCases = parseSearchResults(searchHtml);
      console.log(`   Found ${pageCases.length} total cases`);
      
      // Filter for OPEN cases only
      const openCases = pageCases.filter(c => c.status.toUpperCase().includes('OPEN'));
      console.log(`   ${openCases.length} are OPEN (active foreclosures)\n`);
      
      // Fetch details for each open case
      console.log(`📍 Fetching addresses for ${openCases.length} cases...`);
      
      for (let i = 0; i < openCases.length; i++) {
        const caseData = openCases[i];
        
        if (i > 0 && i % CONFIG.batchSize === 0) {
          console.log('   ⏸ Batch pause...');
          await delay(CONFIG.batchPause);
        }
        
        try {
          await delay(CONFIG.requestDelay);
          
          const detailResponse = await fetch(caseData.detailUrl, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
              'Accept': 'text/html,application/xhtml+xml'
            }
          });
          
          if (detailResponse.ok) {
            const detailHtml = await detailResponse.text();
            const details = parseDetailPage(detailHtml);
            
            caseData.propertyAddress = details.propertyAddress;
            caseData.propertyCity = details.propertyCity;
            caseData.propertyState = details.propertyState;
            caseData.propertyZip = details.propertyZip;
            caseData.daysOpen = details.daysOpen || daysSince(parseDate(caseData.commencedDate));
            caseData.lastFilingDate = details.lastFilingDate;
            caseData.judge = details.judge;
            caseData.remarks = details.remarks;
            
            const addr = details.propertyAddress || 'No address found';
            console.log(`   ${i + 1}/${openCases.length} ✓ ${caseData.caseNumber} - ${addr}`);
          } else {
            console.log(`   ${i + 1}/${openCases.length} ~ ${caseData.caseNumber} (HTTP ${detailResponse.status})`);
          }
        } catch (err) {
          console.log(`   ${i + 1}/${openCases.length} ~ ${caseData.caseNumber} (${err.message})`);
        }
      }
      
      allCases.push(...openCases);
    }
  } catch (error) {
    console.error(`Error: ${error.message}`);
  }
  
  // Format final data
  const formattedCases = allCases.map(c => ({
    caseId: c.caseId,
    caseNumber: c.caseNumber,
    caseType: c.caseType,
    commencedDate: parseDate(c.commencedDate),
    daysOpen: c.daysOpen || daysSince(parseDate(c.commencedDate)),
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
