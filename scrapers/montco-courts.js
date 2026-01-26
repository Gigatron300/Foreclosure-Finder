// Montgomery County Courts scraper - Memory optimized for free tier
const puppeteer = require('puppeteer');
const fs = require('fs').promises;

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const CONFIG = {
  requestDelay: 600,
  batchSize: 20,        // Restart browser every 20 cases
  batchPause: 3000,
  maxCasesToProcess: 75, // Reduced for memory
  minDaysOld: 45,
  maxDaysOld: 270,
  baseUrl: 'https://courtsapp.montcopa.org',
  csvPath: './data/montco-cases.csv'
};

// Lightweight browser launch
async function launchBrowser() {
  return puppeteer.launch({
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
  
  // Bonus if we found an address
  if (c.propertyAddress) { score += 5; factors.push('Has address'); }
  
  score = Math.max(0, Math.min(100, score));
  const grade = score >= 80 ? 'A' : score >= 65 ? 'B' : score >= 50 ? 'C' : score >= 35 ? 'D' : 'F';
  return { score, grade, factors };
}

async function scrapeMontgomeryCourts(options = {}) {
  const csvPath = options.csvPath || CONFIG.csvPath;
  console.log('\n🏛️ Montgomery County Scraper (Memory Optimized)');
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
  
  // Filter
  const now = new Date();
  let targets = allCases
    .filter(c => c.status.toUpperCase().includes('OPEN') && !c.hasJudgement)
    .map(c => {
      const m = c.commencedDate.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
      c.daysOpen = m ? Math.ceil((now - new Date(m[3], m[1] - 1, m[2])) / 86400000) : 0;
      return c;
    })
    .filter(c => c.daysOpen >= CONFIG.minDaysOld && c.daysOpen <= CONFIG.maxDaysOld);
  
  console.log(`   ${targets.length} OPEN cases in range (${CONFIG.minDaysOld}-${CONFIG.maxDaysOld}d)`);
  
  // Sort by ideal age first
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
  
  console.log(`\n🌐 Scraping ${targets.length} cases (recycling browser every ${CONFIG.batchSize})...`);
  
  for (let i = 0; i < targets.length; i++) {
    // Start/restart browser every batch
    if (i % CONFIG.batchSize === 0) {
      if (browser) {
        await browser.close();
        await delay(1000);
        // Force garbage collection hint
        if (global.gc) global.gc();
      }
      console.log(`   🔄 Starting browser (batch ${Math.floor(i / CONFIG.batchSize) + 1})...`);
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
      
      // Go directly to search with case number
      await page.goto(
        `${CONFIG.baseUrl}/psi/v/search/case?Q=${encodeURIComponent(c.caseNumber)}&Grid=true`,
        { waitUntil: 'domcontentloaded', timeout: 25000 }
      );
      
      // Find exact case match and get detail URL
      const detailUrl = await page.evaluate((targetNum) => {
        for (const row of document.querySelectorAll('tr')) {
          const text = row.textContent || '';
          // Must contain exact case number
          if (text.includes(targetNum)) {
            const link = row.querySelector('a[href*="/detail/Case/"]');
            if (link) {
              // Verify this row has the exact case number
              for (const cell of row.querySelectorAll('td')) {
                if (cell.textContent?.trim() === targetNum) return link.href;
              }
            }
          }
        }
        return null;
      }, c.caseNumber);
      
      if (!detailUrl) {
        console.log(`   ${i + 1}/${targets.length} ~ ${c.caseNumber} (not found)`);
        continue;
      }
      
      // Navigate to detail page
      await page.goto(detailUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
      
      // Extract just the address - minimal parsing
      const address = await page.evaluate(() => {
        // Look for PA/NJ address pattern in defendant rows
        const tables = document.querySelectorAll('table');
        for (const table of tables) {
          const headerText = table.querySelector('tr')?.textContent?.toLowerCase() || '';
          if (!headerText.includes('address')) continue;
          
          for (const cell of table.querySelectorAll('td')) {
            const t = cell.textContent?.trim() || '';
            if (t.match(/\b(PA|NJ)\s+\d{5}\b/i) && t.length < 150) {
              // Parse address
              let addr = t.replace(/UNITED STATES/gi, '').trim();
              const m = addr.match(/(.+?)(PA|NJ)\s*(\d{5})/i);
              if (m) {
                const beforeState = m[1].replace(/,?\s*$/, '').trim();
                // Try to split street/city
                const suffixMatch = beforeState.match(/(.+(?:RD|ST|AVE|DR|LN|CT|CIR|BLVD|PL|WAY|TER|PIKE|TRL|HWY))\s*(.*)$/i);
                if (suffixMatch) {
                  return {
                    street: suffixMatch[1].trim(),
                    city: suffixMatch[2].trim(),
                    state: m[2].toUpperCase(),
                    zip: m[3]
                  };
                }
                return { street: beforeState, city: '', state: m[2].toUpperCase(), zip: m[3] };
              }
            }
          }
        }
        return null;
      });
      
      // Update case with address
      c.propertyAddress = address?.street || '';
      c.propertyCity = address?.city || '';
      c.propertyState = address?.state || 'PA';
      c.propertyZip = address?.zip || '';
      c.detailUrl = detailUrl;
      
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
        hasJudgement: c.hasJudgement,
        status: c.status,
        leadScore: ls.score,
        leadGrade: ls.grade,
        scoreFactors: ls.factors,
        docketSummary: { totalEntries: 0 },
        remarks: ls.grade === 'A' ? '🔥 HOT LEAD' : ls.grade === 'B' ? '⭐ Good lead' : '',
        detailUrl,
        county: 'Montgomery',
        state: 'PA'
      });
      
      const addrStr = c.propertyAddress ? `${c.propertyAddress}, ${c.propertyCity}` : 'No addr';
      console.log(`   ${i + 1}/${targets.length} ✓ ${c.caseNumber} [${ls.grade}:${ls.score}] - ${addrStr}`);
      
    } catch (err) {
      console.log(`   ${i + 1}/${targets.length} ~ ${c.caseNumber} (${err.message.slice(0, 30)})`);
    }
  }
  
  if (browser) await browser.close();
  
  results.sort((a, b) => b.leadScore - a.leadScore);
  
  const grades = { A: 0, B: 0, C: 0, D: 0, F: 0 };
  results.forEach(c => grades[c.leadGrade]++);
  
  console.log(`\n✅ Done: ${results.length} cases`);
  console.log(`   Grades: A=${grades.A} B=${grades.B} C=${grades.C} D=${grades.D} F=${grades.F}`);
  
  return results;
}

module.exports = { scrapeMontgomeryCourts, parseCSV, CONFIG };
