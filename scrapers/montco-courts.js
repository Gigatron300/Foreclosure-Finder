// Montgomery County Courts scraper - DEBUG VERSION
const puppeteer = require('puppeteer');
const fs = require('fs').promises;

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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
  maxCasesToProcess: 10, // Reduced for debugging
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
  console.log('\n🏛️ Montgomery County Scraper (DEBUG VERSION)');
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
    console.log(`   Limited to ${CONFIG.maxCasesToProcess} cases (DEBUG)`);
  }
  
  const results = [];
  let browser = null;
  let page = null;
  
  console.log(`\n🌐 Scraping ${targets.length} cases with DEBUG output...`);
  
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
      
      // Type case number
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
      console.log(`      DEBUG URL: ${currentUrl}`);
      
      if (!currentUrl.includes('/detail/Case/')) {
        console.log(`   ${i + 1}/${targets.length} ~ ${c.caseNumber} (no detail page)`);
        continue;
      }
      
      // DEBUG: Get raw page content
      const debugInfo = await page.evaluate(() => {
        const result = {
          tableCount: document.querySelectorAll('table').length,
          tables: []
        };
        
        const tables = document.querySelectorAll('table');
        for (let ti = 0; ti < tables.length && ti < 5; ti++) {
          const table = tables[ti];
          const headerRow = table.querySelector('tr');
          const headers = [];
          if (headerRow) {
            const cells = headerRow.querySelectorAll('th, td');
            for (let ci = 0; ci < cells.length; ci++) {
              headers.push(cells[ci].textContent?.trim()?.substring(0, 20) || '');
            }
          }
          
          const tableInfo = {
            index: ti,
            headers: headers,
            hasAddressHeader: headers.some(h => h.toLowerCase() === 'address'),
            rowCount: table.querySelectorAll('tr').length
          };
          
          // If has address header, get cell contents
          if (tableInfo.hasAddressHeader) {
            const addrIdx = headers.findIndex(h => h.toLowerCase() === 'address');
            const rows = table.querySelectorAll('tr');
            tableInfo.addressCells = [];
            for (let ri = 1; ri < rows.length && ri < 4; ri++) {
              const cells = rows[ri].querySelectorAll('td');
              if (cells.length > addrIdx && cells[addrIdx]) {
                tableInfo.addressCells.push({
                  text: cells[addrIdx].textContent?.substring(0, 80) || 'EMPTY',
                  html: cells[addrIdx].innerHTML?.substring(0, 100) || 'EMPTY'
                });
              }
            }
          }
          
          result.tables.push(tableInfo);
        }
        
        return result;
      });
      
      console.log(`      DEBUG: ${debugInfo.tableCount} tables found`);
      for (const t of debugInfo.tables) {
        console.log(`      Table ${t.index}: headers=[${t.headers.join(', ')}] hasAddr=${t.hasAddressHeader}`);
        if (t.addressCells) {
          for (const cell of t.addressCells) {
            console.log(`        Cell text: "${cell.text}"`);
          }
        }
      }
      
      // Now try to extract addresses
      const data = await page.evaluate((montcoTowns) => {
        const addresses = [];
        const debug = [];
        const tables = document.querySelectorAll('table');
        
        for (let ti = 0; ti < tables.length; ti++) {
          const table = tables[ti];
          const headerRow = table.querySelector('tr');
          if (!headerRow) continue;
          
          const headerCells = headerRow.querySelectorAll('th, td');
          let addrIdx = -1;
          for (let hi = 0; hi < headerCells.length; hi++) {
            const hText = (headerCells[hi].textContent || '').trim().toLowerCase();
            if (hText === 'address') {
              addrIdx = hi;
              break;
            }
          }
          
          if (addrIdx === -1) continue;
          
          const rows = table.querySelectorAll('tr');
          for (let ri = 1; ri < rows.length; ri++) {
            const cells = rows[ri].querySelectorAll('td');
            if (cells.length <= addrIdx) continue;
            
            const addrCell = cells[addrIdx];
            const text = (addrCell.textContent || '').trim();
            const html = addrCell.innerHTML || '';
            
            debug.push('Processing: ' + text.substring(0, 50));
            
            // Check for "PA " in text
            const paIdx = text.indexOf('PA ');
            if (paIdx === -1) {
              debug.push('  -> No "PA " found');
              continue;
            }
            
            debug.push('  -> Found PA at index ' + paIdx);
            
            // Get zip (5 digits after "PA ")
            const afterPA = text.substring(paIdx + 3);
            let zip = '';
            for (let di = 0; di < 5 && di < afterPA.length; di++) {
              const ch = afterPA.charAt(di);
              if (ch >= '0' && ch <= '9') {
                zip += ch;
              } else {
                break;
              }
            }
            
            if (zip.length !== 5) {
              debug.push('  -> Zip not 5 digits: "' + zip + '"');
              continue;
            }
            
            debug.push('  -> Zip: ' + zip);
            
            // Get street and city from HTML (split by <br>)
            let street = '';
            let city = '';
            
            const brIdx = html.toLowerCase().indexOf('<br');
            if (brIdx > 0) {
              street = html.substring(0, brIdx).replace(/<[^>]*>/g, '').trim();
              const afterBr = html.substring(brIdx);
              const gtIdx = afterBr.indexOf('>');
              if (gtIdx > 0) {
                const cityPart = afterBr.substring(gtIdx + 1).replace(/<[^>]*>/g, '').trim();
                const cityPaIdx = cityPart.indexOf('PA ');
                if (cityPaIdx > 0) {
                  city = cityPart.substring(0, cityPaIdx).replace(/,/g, '').trim();
                }
              }
            }
            
            debug.push('  -> Street: "' + street + '", City: "' + city + '"');
            
            // Check Montgomery County
            const upperCity = city.toUpperCase();
            let inMontCo = false;
            for (let mi = 0; mi < montcoTowns.length; mi++) {
              if (upperCity.indexOf(montcoTowns[mi]) !== -1) {
                inMontCo = true;
                break;
              }
            }
            
            addresses.push({ street, city, state: 'PA', zip, inMontCo });
          }
        }
        
        return { addresses, debug };
      }, MONTCO_TOWNS);
      
      // Print debug info
      for (const d of data.debug) {
        console.log(`      ${d}`);
      }
      console.log(`      Found ${data.addresses.length} addresses`);
      
      // Pick best address
      let bestAddr = data.addresses.find(a => a.inMontCo) || data.addresses[0] || null;
      
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
