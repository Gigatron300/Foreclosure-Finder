// Montgomery County Courts scraper - Fixed regex for Puppeteer context
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
  const upperCity = city.toUpperCase().replace(/\s+/g, ' ').trim();
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
  console.log('\n🏛️ Montgomery County Scraper (Regex Fixed)');
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
      
      // Type case number
      await page.evaluate((caseNum) => {
        const inputs = document.querySelectorAll('input[type="text"]');
        for (const input of inputs) {
          const label = input.closest('div')?.querySelector('label') || 
                        input.previousElementSibling ||
                        document.querySelector(`label[for="${input.id}"]`);
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
      
      // Extract addresses - FIXED: use [0-9] instead of \d, and literal space instead of \s
      const data = await page.evaluate((montcoTowns) => {
        const addresses = [];
        const tables = document.querySelectorAll('table');
        
        for (const table of tables) {
          const headerRow = table.querySelector('tr');
          if (!headerRow) continue;
          
          const headers = Array.from(headerRow.querySelectorAll('th, td'))
            .map(h => h.textContent?.trim().toLowerCase() || '');
          const addrIdx = headers.indexOf('address');
          
          if (addrIdx === -1) continue;
          
          const rows = table.querySelectorAll('tr');
          for (let ri = 1; ri < rows.length; ri++) {
            const cells = rows[ri].querySelectorAll('td');
            if (cells.length <= addrIdx) continue;
            
            const addrCell = cells[addrIdx];
            const html = addrCell?.innerHTML || '';
            const text = addrCell?.textContent?.trim() || '';
            
            // FIXED: Use [0-9] instead of \d, use . instead of \s
            // Check for PA followed by space and 5 digits
            if (!text.includes('PA ')) continue;
            
            // Find zip code using indexOf instead of regex
            const paIdx = text.indexOf('PA ');
            if (paIdx === -1) continue;
            
            const afterPA = text.substring(paIdx + 3);
            const zipMatch = afterPA.match(/^([0-9]{5})/);
            if (!zipMatch) continue;
            
            const zip = zipMatch[1];
            
            // Split by <br> to get street vs city
            const parts = html.split(/<br\s*\/?>/i).map(p => 
              p.replace(/<[^>]+>/g, '').trim()
            ).filter(p => p);
            
            let street = '';
            let city = '';
            
            if (parts.length >= 2) {
              // First part is street, rest contains city
              street = parts[0];
              // Find city from the part containing PA
              for (const part of parts.slice(1)) {
                if (part.includes('PA ')) {
                  // Extract city - everything before "PA"
                  const cityMatch = part.match(/^([A-Za-z\s]+),?\s*PA/i);
                  if (cityMatch) {
                    city = cityMatch[1].trim();
                  }
                  break;
                }
              }
            } else {
              // Single line - need to split street from city
              // Format: "STREET SUFFIXCITY, PA ZIP"
              const beforePA = text.substring(0, paIdx);
              const commaIdx = beforePA.lastIndexOf(',');
              if (commaIdx > 0) {
                street = beforePA.substring(0, commaIdx).trim();
                city = beforePA.substring(commaIdx + 1).trim();
              } else {
                // No comma - try to find city by looking for suffix
                const suffixMatch = beforePA.match(/^(.+?)(ROAD|RD|STREET|ST|AVENUE|AVE|DRIVE|DR|LANE|LN|COURT|CT|CIRCLE|CIR|BOULEVARD|BLVD|PLACE|PL|WAY|TERRACE|TER|PIKE|TRAIL|TRL|HIGHWAY|HWY|PARKWAY|PKWY)(.*)$/i);
                if (suffixMatch) {
                  street = (suffixMatch[1] + suffixMatch[2]).trim();
                  city = suffixMatch[3].trim();
                } else {
                  street = beforePA.trim();
                }
              }
            }
            
            // Clean up city
            city = city.replace(/,/g, '').replace(/\s+/g, ' ').trim();
            
            // Check if in Montgomery County
            const upperCity = city.toUpperCase();
            const inMontCo = montcoTowns.some(town => upperCity.includes(town));
            
            addresses.push({ street, city, state: 'PA', zip, inMontCo });
          }
        }
        
        return addresses;
      }, MONTCO_TOWNS);
      
      // Pick best address: prefer Montgomery County
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
