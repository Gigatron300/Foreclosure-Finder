// Montgomery County Courts scraper - WAIT FOR FULL PAGE LOAD
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
  requestDelay: 1200,        // Slightly slower to be safe with more cases
  pageLoadWait: 3000,        // Wait for dynamic content
  batchSize: 15,             // Restart browser every 15 cases
  batchPause: 4000,          // Pause between batches
  maxCasesToProcess: 0,      // 0 = no limit, process ALL cases
  testModeLimit: 10,         // When test mode enabled, only process this many
  // Date ranges in MONTHS (calculated dynamically from today)
  minMonthsOld: 6,           // Only cases at least 6 months old
  maxMonthsOld: 24,          // Only cases up to 24 months old
  sweetSpotMinMonths: 9,     // Sweet spot starts at 9 months
  sweetSpotMaxMonths: 18,    // Sweet spot ends at 18 months
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
  const testMode = options.testMode || false;
  
  console.log('\n🏛️ Montgomery County Scraper');
  if (testMode) {
    console.log('⚡ TEST MODE - Limited to ' + CONFIG.testModeLimit + ' cases');
  }
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
  
  // Calculate date range in days from month config
  const minDaysOld = CONFIG.minMonthsOld * 30;  // ~6 months = 180 days
  const maxDaysOld = CONFIG.maxMonthsOld * 30;  // ~24 months = 720 days
  const sweetSpotMinDays = CONFIG.sweetSpotMinMonths * 30;  // ~9 months = 270 days
  const sweetSpotMaxDays = CONFIG.sweetSpotMaxMonths * 30;  // ~18 months = 540 days
  
  console.log(`   Date range: ${CONFIG.minMonthsOld}-${CONFIG.maxMonthsOld} months old`);
  console.log(`   Sweet spot: ${CONFIG.sweetSpotMinMonths}-${CONFIG.sweetSpotMaxMonths} months old`);
  
  let targets = allCases
    .filter(c => c.status.toUpperCase().includes('OPEN') && !c.hasJudgement)
    .map(c => {
      const m = c.commencedDate.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
      c.daysOpen = m ? Math.ceil((now - new Date(m[3], m[1] - 1, m[2])) / 86400000) : 0;
      c.monthsOpen = Math.round(c.daysOpen / 30);
      // Mark if in sweet spot (9-18 months)
      c.inSweetSpot = c.daysOpen >= sweetSpotMinDays && c.daysOpen <= sweetSpotMaxDays;
      return c;
    })
    .filter(c => c.daysOpen >= minDaysOld && c.daysOpen <= maxDaysOld);
  
  const sweetSpotCount = targets.filter(c => c.inSweetSpot).length;
  console.log(`   ${targets.length} OPEN cases in range (${sweetSpotCount} in sweet spot 🎯)`);
  
  // Sort: sweet spot cases first, then by age within each group
  targets.sort((a, b) => {
    // Sweet spot cases come first
    if (a.inSweetSpot && !b.inSweetSpot) return -1;
    if (!a.inSweetSpot && b.inSweetSpot) return 1;
    // Within same group, sort by days (older first within sweet spot is better)
    return b.daysOpen - a.daysOpen;
  });
  
  // Apply limits: test mode takes priority, then maxCasesToProcess
  if (testMode) {
    targets = targets.slice(0, CONFIG.testModeLimit);
    console.log(`   ⚡ TEST MODE: Limited to ${CONFIG.testModeLimit} cases`);
  } else if (CONFIG.maxCasesToProcess > 0 && targets.length > CONFIG.maxCasesToProcess) {
    targets = targets.slice(0, CONFIG.maxCasesToProcess);
    console.log(`   Limited to ${CONFIG.maxCasesToProcess} cases`);
  } else {
    console.log(`   Processing ALL ${targets.length} cases`);
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
      
      // DON'T block resources - we need JS to run!
      // Remove request interception that was blocking things
      
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
    }
    
    const c = targets[i];
    
    try {
      await delay(CONFIG.requestDelay);
      
      // Navigate to search page and wait for full load
      await page.goto(CONFIG.searchUrl, { waitUntil: 'networkidle2', timeout: 30000 });
      await delay(1000);
      
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
      
      // Wait for navigation to detail page with FULL load
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {});
      
      // Extra wait for dynamic content (Defendants table)
      await delay(CONFIG.pageLoadWait);
      
      const currentUrl = page.url();
      if (!currentUrl.includes('/detail/Case/')) {
        console.log(`   ${i + 1}/${targets.length} ~ ${c.caseNumber} (no detail)`);
        continue;
      }
      
      // Wait for Defendants section to appear
      try {
        await page.waitForFunction(() => {
          const text = document.body.innerText;
          return text.includes('Defendants') && text.includes('Address');
        }, { timeout: 5000 });
      } catch (e) {
        // Continue anyway, maybe it loaded
      }
      
      // Extract addresses
      const data = await page.evaluate((montcoTowns) => {
        const addresses = [];
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
            
            // Check for "PA " in text
            const paIdx = text.indexOf('PA ');
            if (paIdx === -1) continue;
            
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
            
            if (zip.length !== 5) continue;
            
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
        monthsOpen: c.monthsOpen,
        inSweetSpot: c.inSweetSpot,
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
        remarks: c.inSweetSpot ? '🎯 Sweet Spot' : '',
        detailUrl: c.detailUrl,
        county: 'Montgomery',
        state: 'PA'
      });
      
      const sweetSpotIndicator = c.inSweetSpot ? ' 🎯' : '';
      const addrStr = c.propertyAddress ? 
        `${c.propertyAddress}, ${c.propertyCity}${c.inMontgomeryCounty ? ' ✓' : ''}` : 
        'No addr';
      console.log(`   ${i + 1}/${targets.length} ✓ ${c.caseNumber} [${c.monthsOpen}mo${sweetSpotIndicator}] - ${addrStr}`);
      
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
