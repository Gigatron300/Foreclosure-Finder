// Montgomery County Courts scraper - NO REGEX in page.evaluate
const puppeteer = require('puppeteer');
const fs = require('fs').promises;

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Montgomery County townships/boroughs
const MONTCO_TOWNS = [
  'ABINGTON', 'AMBLER', 'BRIDGEPORT', 'BRYN ATHYN', 'CHELTENHAM', 'COLLEGEVILLE',
  'CONSHOHOCKEN', 'DOUGLASS', 'EAST GREENVILLE', 'EAST NORRITON', 'FRANCONIA',
  'GREEN LANE', 'HATBORO', 'HATFIELD', 'HORSHAM', 'JENKINTOWN', 'LANSDALE',
  'LIMERICK', 'LOWER FREDERICK', 'LOWER GWYNEDD', 'LOWER MERION', 'LOWER MORELAND',
  'LOWER POTTSGROVE', 'LOWER PROVIDENCE', 'LOWER SALFORD', 'MARLBOROUGH',
  'MONTGOMERY', 'NARBERTH', 'NEW HANOVER', 'NORRISTOWN', 'NORTH WALES', 'PENNSBURG',
  'PERKIOMEN', 'PLYMOUTH', 'POTTSTOWN', 'RED HILL', 'ROCKLEDGE', 'ROYERSFORD',
  'SALFORD', 'SCHWENKSVILLE', 'SKIPPACK', 'SOUDERTON', 'SPRINGFIELD', 'TELFORD',
  'TOWAMENCIN', 'TRAPPE', 'UPPER DUBLIN', 'UPPER FREDERICK', 'UPPER GWYNEDD',
  'UPPER HANOVER', 'UPPER MERION', 'UPPER MORELAND', 'UPPER POTTSGROVE',
  'UPPER PROVIDENCE', 'UPPER SALFORD', 'WEST CONSHOHOCKEN', 'WEST NORRITON',
  'WEST POTTSGROVE', 'WHITEMARSH', 'WHITPAIN', 'WORCESTER',
  'GLENSIDE', 'ARDMORE', 'WILLOW GROVE', 'KING OF PRUSSIA', 'BLUE BELL',
  'FORT WASHINGTON', 'FLOURTOWN', 'ORELAND', 'WYNDMOOR', 'ELKINS PARK',
  'GLADWYNE', 'BALA CYNWYD', 'MERION', 'WYNNEWOOD', 'HAVERFORD'
];

const CONFIG = {
  requestDelay: 800,
  batchSize: 20,
  batchPause: 3000,
  maxCasesToProcess: 75,
  minDaysOld: 45,
  maxDaysOld: 270,
  searchUrl: 'https://courtsapp.montcopa.org/psi/v/search/case?fromAdv=1',
  csvPath: './data/montco-cases.csv'
};

async function launchBrowser() {
  return puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-gpu', '--disable-extensions', '--disable-background-networking',
      '--js-flags=--max-old-space-size=256'
    ]
  });
}

async function parseCSV(csvPath) {
  const content = await fs.readFile(csvPath, 'utf8');
  const lines = content.split(/\r?\n/).filter(line => line.trim());
  if (lines.length < 2) throw new Error('CSV empty');
  
  const header = parseCSVLine(lines[0]);
  const col = {
    caseNumber: header.findIndex(h => h.toLowerCase().includes('casenumber')),
    commenced: header.findIndex(h => h.toLowerCase().includes('commenced')),
    plaintiff: header.findIndex(h => h.toLowerCase().includes('plaintiff')),
    defendant: header.findIndex(h => h.toLowerCase().includes('defendant')),
    judgement: header.findIndex(h => h.toLowerCase().includes('judgement')),
    status: header.findIndex(h => h.toLowerCase().includes('status'))
  };
  
  const cases = [];
  for (let i = 1; i < lines.length; i++) {
    const v = parseCSVLine(lines[i]);
    if (!v[col.caseNumber]) continue;
    cases.push({
      caseNumber: v[col.caseNumber],
      commencedDate: v[col.commenced] || '',
      plaintiff: v[col.plaintiff] || '',
      defendant: v[col.defendant] || '',
      hasJudgement: (v[col.judgement] || '').toLowerCase() === 'yes',
      status: v[col.status] || ''
    });
  }
  return cases;
}

function parseCSVLine(line) {
  const values = [];
  let current = '', inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (c === ',' && !inQuotes) { values.push(current.trim()); current = ''; }
    else current += c;
  }
  values.push(current.trim());
  return values;
}

function parseDate(dateStr) {
  if (!dateStr) return null;
  const m = dateStr.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : null;
}

function isInMontgomeryCounty(city) {
  if (!city) return false;
  const upperCity = city.toUpperCase().replace(/  +/g, ' ').trim();
  return MONTCO_TOWNS.some(town => upperCity.includes(town));
}

function calculateScore(c) {
  let score = 50;
  const factors = [];
  const days = c.daysOpen || 0;
  
  if (days >= 60 && days <= 120) { score += 15; factors.push('Ideal age'); }
  else if (days > 120 && days <= 180) { score += 10; factors.push('Good age'); }
  else if (days > 270) { score -= 15; factors.push('Old case'); }
  
  if (!c.hasJudgement) { score += 20; factors.push('No judgment'); }
  else { score -= 15; factors.push('Has judgment'); }
  
  if (c.propertyAddress) { score += 5; factors.push('Has address'); }
  if (c.inMontgomeryCounty) { score += 5; factors.push('In MontCo'); }
  
  score = Math.max(0, Math.min(100, score));
  const grade = score >= 80 ? 'A' : score >= 65 ? 'B' : score >= 50 ? 'C' : score >= 35 ? 'D' : 'F';
  return { score, grade, factors };
}

async function scrapeMontgomeryCourts(options = {}) {
  const csvPath = options.csvPath || CONFIG.csvPath;
  console.log('\n🏛️ Montgomery County Scraper (No Regex)');
  console.log('='.repeat(50));
  
  let allCases;
  try {
    console.log(`📄 Loading CSV...`);
    allCases = await parseCSV(csvPath);
    console.log(`   ${allCases.length} cases in CSV`);
  } catch (err) {
    console.error(`   Error: ${err.message}`);
    return [];
  }
  
  const now = new Date();
  let targets = allCases
    .filter(c => c.status.toUpperCase().includes('OPEN') && !c.hasJudgement)
    .map(c => {
      const m = c.commencedDate.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
      c.daysOpen = m ? Math.ceil((now - new Date(m[3], m[1] - 1, m[2])) / 86400000) : 0;
      return c;
    })
    .filter(c => c.daysOpen >= CONFIG.minDaysOld && c.daysOpen <= CONFIG.maxDaysOld);
  
  console.log(`   ${targets.length} OPEN cases in range`);
  
  targets.sort((a, b) => {
    const score = d => (d >= 60 && d <= 180) ? 100 : 50;
    return score(b.daysOpen) - score(a.daysOpen);
  });
  
  if (targets.length > CONFIG.maxCasesToProcess) {
    targets = targets.slice(0, CONFIG.maxCasesToProcess);
    console.log(`   Limited to ${CONFIG.maxCasesToProcess} cases`);
  }
  
  const results = [];
  let browser = null;
  let page = null;
  
  console.log(`\n🌐 Scraping ${targets.length} cases...`);
  
  for (let i = 0; i < targets.length; i++) {
    if (i % CONFIG.batchSize === 0) {
      if (browser) {
        await browser.close();
        await delay(1500);
      }
      console.log(`   🔄 Browser restart (batch ${Math.floor(i / CONFIG.batchSize) + 1})...`);
      browser = await launchBrowser();
      page = await browser.newPage();
      await page.setRequestInterception(true);
      page.on('request', r => {
        if (['image', 'stylesheet', 'font', 'media'].includes(r.resourceType())) r.abort();
        else r.continue();
      });
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
    }
    
    const c = targets[i];
    
    try {
      await delay(CONFIG.requestDelay);
      
      await page.goto(CONFIG.searchUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
      await delay(500);
      
      // Type case number into Case # field
      await page.evaluate((caseNum) => {
        const inputs = document.querySelectorAll('input[type="text"]');
        for (const input of inputs) {
          const label = input.closest('div')?.querySelector('label') || 
                        input.previousElementSibling ||
                        document.querySelector('label[for="' + input.id + '"]');
          if (label?.textContent?.includes('Case #')) {
            input.value = caseNum;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            return;
          }
        }
      }, c.caseNumber);
      
      // Click search
      await page.evaluate(() => {
        const btns = document.querySelectorAll('button, input[type="submit"]');
        for (const btn of btns) {
          if (btn.textContent?.toLowerCase().includes('search') || 
              btn.value?.toLowerCase().includes('search')) {
            btn.click();
            return;
          }
        }
      });
      
      await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
      await delay(800);
      
      const currentUrl = page.url();
      if (!currentUrl.includes('/detail/Case/')) {
        console.log(`   ${i + 1}/${targets.length} ~ ${c.caseNumber} (no detail)`);
        continue;
      }
      
      // Extract addresses - NO REGEX AT ALL - pure string methods only
      const data = await page.evaluate((montcoTowns) => {
        // Helper: check if char is digit
        function isDigit(c) {
          return c === '0' || c === '1' || c === '2' || c === '3' || c === '4' ||
                 c === '5' || c === '6' || c === '7' || c === '8' || c === '9';
        }
        
        // Helper: check if string starts with 5 digits
        function startsWithZip(s) {
          if (!s || s.length < 5) return false;
          for (var i = 0; i < 5; i++) {
            if (!isDigit(s.charAt(i))) return false;
          }
          return true;
        }
        
        // Helper: extract 5 digit zip
        function extractZip(s) {
          if (!startsWithZip(s)) return null;
          return s.substring(0, 5);
        }
        
        // Helper: simple split by substring (case insensitive)
        function splitByBr(html) {
          var result = [];
          var lower = html.toLowerCase();
          var lastIdx = 0;
          var brIdx = lower.indexOf('<br');
          
          while (brIdx !== -1) {
            // Add part before <br
            var part = html.substring(lastIdx, brIdx).trim();
            if (part.length > 0) {
              // Remove any remaining HTML tags
              part = part.split('<')[0].trim();
              if (part.length > 0) result.push(part);
            }
            
            // Find end of br tag
            var endBr = html.indexOf('>', brIdx);
            lastIdx = endBr + 1;
            brIdx = lower.indexOf('<br', lastIdx);
          }
          
          // Add remaining part
          if (lastIdx < html.length) {
            var remaining = html.substring(lastIdx).trim();
            // Remove HTML tags
            var tagStart = remaining.indexOf('<');
            if (tagStart > 0) remaining = remaining.substring(0, tagStart).trim();
            if (remaining.length > 0) result.push(remaining);
          }
          
          return result;
        }
        
        // Helper: extract city before "PA "
        function extractCity(part) {
          var paIdx = part.indexOf('PA ');
          if (paIdx === -1) paIdx = part.indexOf('Pa ');
          if (paIdx === -1) paIdx = part.indexOf('pa ');
          if (paIdx === -1) return '';
          
          var beforePA = part.substring(0, paIdx);
          // Remove trailing comma and spaces
          while (beforePA.length > 0) {
            var last = beforePA.charAt(beforePA.length - 1);
            if (last === ',' || last === ' ') {
              beforePA = beforePA.substring(0, beforePA.length - 1);
            } else {
              break;
            }
          }
          return beforePA;
        }
        
        var addresses = [];
        var tables = document.querySelectorAll('table');
        
        for (var ti = 0; ti < tables.length; ti++) {
          var table = tables[ti];
          var headerRow = table.querySelector('tr');
          if (!headerRow) continue;
          
          var headerCells = headerRow.querySelectorAll('th, td');
          var addrIdx = -1;
          for (var hi = 0; hi < headerCells.length; hi++) {
            var hText = headerCells[hi].textContent || '';
            if (hText.toLowerCase().trim() === 'address') {
              addrIdx = hi;
              break;
            }
          }
          
          if (addrIdx === -1) continue;
          
          var rows = table.querySelectorAll('tr');
          for (var ri = 1; ri < rows.length; ri++) {
            var cells = rows[ri].querySelectorAll('td');
            if (cells.length <= addrIdx) continue;
            
            var addrCell = cells[addrIdx];
            var html = addrCell ? addrCell.innerHTML : '';
            var text = addrCell ? addrCell.textContent : '';
            if (!text) continue;
            text = text.trim();
            
            // Check for PA followed by space
            var paIdx = text.indexOf('PA ');
            if (paIdx === -1) paIdx = text.indexOf('Pa ');
            if (paIdx === -1) continue;
            
            var afterPA = text.substring(paIdx + 3);
            var zip = extractZip(afterPA);
            if (!zip) continue;
            
            // Split HTML by <br> tags
            var parts = splitByBr(html);
            
            var street = '';
            var city = '';
            
            if (parts.length >= 2) {
              street = parts[0];
              // Find the part with PA and extract city
              for (var pi = 1; pi < parts.length; pi++) {
                if (parts[pi].indexOf('PA ') !== -1 || parts[pi].indexOf('Pa ') !== -1) {
                  city = extractCity(parts[pi]);
                  break;
                }
              }
            } else if (parts.length === 1) {
              // Single line - street is before city
              var beforePA = text.substring(0, paIdx);
              // Find last comma
              var commaIdx = beforePA.lastIndexOf(',');
              if (commaIdx > 0) {
                street = beforePA.substring(0, commaIdx).trim();
                city = beforePA.substring(commaIdx + 1).trim();
              } else {
                // Try common street suffixes
                var suffixes = ['ROAD', 'RD', 'STREET', 'ST', 'AVENUE', 'AVE', 'DRIVE', 'DR', 
                               'LANE', 'LN', 'COURT', 'CT', 'WAY', 'PIKE', 'TRAIL', 'TRL'];
                var upperBefore = beforePA.toUpperCase();
                var foundSuffix = false;
                for (var si = 0; si < suffixes.length; si++) {
                  var suffixIdx = upperBefore.lastIndexOf(suffixes[si]);
                  if (suffixIdx > 0) {
                    street = beforePA.substring(0, suffixIdx + suffixes[si].length).trim();
                    city = beforePA.substring(suffixIdx + suffixes[si].length).trim();
                    foundSuffix = true;
                    break;
                  }
                }
                if (!foundSuffix) {
                  street = beforePA.trim();
                }
              }
            }
            
            // Clean up
            city = city.replace(/,/g, '').trim();
            while (city.indexOf('  ') !== -1) {
              city = city.split('  ').join(' ');
            }
            
            // Check Montgomery County
            var upperCity = city.toUpperCase();
            var inMontCo = false;
            for (var mi = 0; mi < montcoTowns.length; mi++) {
              if (upperCity.indexOf(montcoTowns[mi]) !== -1) {
                inMontCo = true;
                break;
              }
            }
            
            addresses.push({ 
              street: street, 
              city: city, 
              state: 'PA', 
              zip: zip, 
              inMontCo: inMontCo 
            });
          }
        }
        
        return addresses;
      }, MONTCO_TOWNS);
      
      // Pick best address
      let bestAddr = data.find(a => a.inMontCo) || data[0] || null;
      
      c.propertyAddress = bestAddr?.street || '';
      c.propertyCity = bestAddr?.city || '';
      c.propertyState = bestAddr?.state || 'PA';
      c.propertyZip = bestAddr?.zip || '';
      c.inMontgomeryCounty = bestAddr?.inMontCo || false;
      c.detailUrl = currentUrl;
      
      const ls = calculateScore(c);
      
      results.push({
        caseNumber: c.caseNumber,
        commencedDate: parseDate(c.commencedDate),
        daysOpen: c.daysOpen,
        plaintiff: c.plaintiff,
        defendant: c.defendant,
        propertyAddress: c.propertyAddress,
        propertyCity: c.propertyCity,
        propertyState: c.propertyState,
        propertyZip: c.propertyZip,
        inMontgomeryCounty: c.inMontgomeryCounty,
        hasJudgement: c.hasJudgement,
        status: c.status,
        leadScore: ls.score,
        leadGrade: ls.grade,
        scoreFactors: ls.factors,
        docketSummary: { totalEntries: 0 },
        remarks: ls.grade === 'A' ? '🔥 HOT LEAD' : ls.grade === 'B' ? '⭐ Good lead' : '',
        detailUrl: c.detailUrl,
        county: 'Montgomery',
        state: 'PA'
      });
      
      const addrStr = c.propertyAddress ? 
        `${c.propertyAddress}, ${c.propertyCity}${c.inMontgomeryCounty ? ' ✓' : ''}` : 
        'No PA addr';
      console.log(`   ${i + 1}/${targets.length} ✓ ${c.caseNumber} [${ls.grade}:${ls.score}] - ${addrStr}`);
      
    } catch (err) {
      console.log(`   ${i + 1}/${targets.length} ~ ${c.caseNumber} (${err.message.slice(0, 40)})`);
    }
  }
  
  if (browser) await browser.close();
  
  results.sort((a, b) => b.leadScore - a.leadScore);
  
  const grades = { A: 0, B: 0, C: 0, D: 0, F: 0 };
  results.forEach(c => grades[c.leadGrade]++);
  
  const withAddr = results.filter(r => r.propertyAddress).length;
  const inMontCo = results.filter(r => r.inMontgomeryCounty).length;
  
  console.log(`\n✅ Done: ${results.length} cases`);
  console.log(`   ${withAddr} with addresses (${inMontCo} in Montgomery County)`);
  console.log(`   Grades: A=${grades.A} B=${grades.B} C=${grades.C} D=${grades.D} F=${grades.F}`);
  
  return results;
}

module.exports = { scrapeMontgomeryCourts, parseCSV, CONFIG, MONTCO_TOWNS };
