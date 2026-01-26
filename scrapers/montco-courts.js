// Montgomery County Courts scraper - CSV-based with improved matching
const puppeteer = require('puppeteer');
const fs = require('fs').promises;

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const CONFIG = {
  requestDelay: 500,
  batchSize: 10,
  batchPause: 2000,
  maxCasesToProcess: 100,
  minDaysOld: 45,
  maxDaysOld: 270,
  baseUrl: 'https://courtsapp.montcopa.org',
  csvPath: './data/montco-cases.csv',
  distressKeywords: {
    high: ['default judgment', 'motion for default', 'judgment entered', 'writ of execution', 'sheriff sale', 'praecipe for writ'],
    medium: ['conciliation', 'mediation', 'service accepted', 'answer filed'],
    positive: ['motion to dismiss', 'answer and new matter', 'counterclaim', 'attorney appearance', 'counsel appearance']
  }
};

async function parseCSV(csvPath) {
  const content = await fs.readFile(csvPath, 'utf8');
  const lines = content.split(/\r?\n/).filter(line => line.trim());
  if (lines.length < 2) throw new Error('CSV file is empty');
  
  const header = parseCSVLine(lines[0]);
  const col = {
    caseNumber: header.findIndex(h => h.toLowerCase().includes('casenumber')),
    commenced: header.findIndex(h => h.toLowerCase().includes('commenced')),
    caseType: header.findIndex(h => h.toLowerCase().includes('casetype')),
    plaintiff: header.findIndex(h => h.toLowerCase().includes('plaintiff')),
    defendant: header.findIndex(h => h.toLowerCase().includes('defendant')),
    parcel: header.findIndex(h => h.toLowerCase().includes('parcel')),
    judgement: header.findIndex(h => h.toLowerCase().includes('judgement')),
    lisPendens: header.findIndex(h => h.toLowerCase().includes('lispendens')),
    status: header.findIndex(h => h.toLowerCase().includes('status'))
  };
  
  const cases = [];
  for (let i = 1; i < lines.length; i++) {
    const v = parseCSVLine(lines[i]);
    if (v.length < 5 || !v[col.caseNumber]) continue;
    cases.push({
      caseNumber: v[col.caseNumber],
      commencedDate: v[col.commenced] || '',
      caseType: v[col.caseType] || '',
      plaintiff: v[col.plaintiff] || '',
      defendant: v[col.defendant] || '',
      parcelNumber: v[col.parcel] || '',
      hasJudgement: (v[col.judgement] || '').toLowerCase() === 'yes',
      hasLisPendens: (v[col.lisPendens] || '').toLowerCase() === 'yes',
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
  const m = dateStr.trim().match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : null;
}

function daysSince(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? null : Math.ceil(Math.abs(new Date() - d) / 86400000);
}

function analyzeDocket(entries) {
  const a = {
    totalEntries: entries.length, lastActivityDate: null, daysSinceLastActivity: null,
    hasDefaultMotion: false, hasDefaultJudgment: false, hasDefendantAttorney: false,
    hasDefendantResponse: false, hasConciliation: false, conciliationStatus: null,
    hasWritOfExecution: false, serviceAttempts: 0, failedServiceAttempts: 0,
    distressSignals: [], positiveSignals: [], recentActivity: []
  };
  if (!entries.length) return a;
  
  const sorted = [...entries].sort((x, y) => new Date(parseDate(y.date) || 0) - new Date(parseDate(x.date) || 0));
  if (sorted[0]?.date) {
    a.lastActivityDate = parseDate(sorted[0].date);
    a.daysSinceLastActivity = daysSince(a.lastActivityDate);
  }
  a.recentActivity = sorted.slice(0, 5).map(e => ({ date: parseDate(e.date), description: e.description }));
  
  for (const e of entries) {
    const desc = (e.description || '').toLowerCase();
    for (const kw of CONFIG.distressKeywords.high) {
      if (desc.includes(kw)) {
        a.distressSignals.push({ type: 'high', keyword: kw, date: parseDate(e.date) });
        if (kw.includes('default judgment') || kw.includes('judgment entered')) a.hasDefaultJudgment = true;
        if (kw.includes('motion for default')) a.hasDefaultMotion = true;
        if (kw.includes('writ') || kw.includes('praecipe')) a.hasWritOfExecution = true;
      }
    }
    for (const kw of CONFIG.distressKeywords.medium) {
      if (desc.includes(kw)) {
        a.distressSignals.push({ type: 'medium', keyword: kw, date: parseDate(e.date) });
        if (kw.includes('conciliation') || kw.includes('mediation')) {
          a.hasConciliation = true;
          if (desc.includes('failed') || desc.includes('no show')) a.conciliationStatus = 'failed';
          else if (desc.includes('scheduled')) a.conciliationStatus = 'scheduled';
        }
      }
    }
    for (const kw of CONFIG.distressKeywords.positive) {
      if (desc.includes(kw)) {
        a.positiveSignals.push({ keyword: kw, date: parseDate(e.date) });
        if (kw.includes('attorney') || kw.includes('counsel')) a.hasDefendantAttorney = true;
        if (kw.includes('answer') || kw.includes('counterclaim')) a.hasDefendantResponse = true;
      }
    }
    if (desc.includes('served')) {
      a.serviceAttempts++;
      if (desc.includes('not found')) a.failedServiceAttempts++;
    }
  }
  return a;
}

function calculateLeadScore(caseData, docket) {
  let score = 50;
  const factors = [];
  const hasDocket = docket.totalEntries > 0;
  const days = caseData.daysOpen || 0;
  
  if (days >= 60 && days <= 120) { score += 15; factors.push({ factor: 'Ideal age (60-120d)', points: 15 }); }
  else if (days >= 30 && days < 60) { score += 10; factors.push({ factor: 'Early (30-60d)', points: 10 }); }
  else if (days > 120 && days <= 180) { score += 10; factors.push({ factor: 'Good (120-180d)', points: 10 }); }
  else if (days > 270 && days <= 365) { score -= 10; factors.push({ factor: 'Old (270-365d)', points: -10 }); }
  else if (days > 365) { score -= 20; factors.push({ factor: 'Very old (365+d)', points: -20 }); }
  
  if (!caseData.hasJudgement) { score += 20; factors.push({ factor: 'No judgment', points: 20 }); }
  else { score -= 15; factors.push({ factor: 'Has judgment', points: -15 }); }
  
  if (hasDocket) {
    if (!docket.hasDefendantAttorney) { score += 10; factors.push({ factor: 'No attorney', points: 10 }); }
    if (!docket.hasDefendantResponse && days > 45) { score += 15; factors.push({ factor: 'No response', points: 15 }); }
    if (docket.hasDefaultMotion && !docket.hasDefaultJudgment) { score += 10; factors.push({ factor: 'Default pending', points: 10 }); }
    if (docket.failedServiceAttempts >= 2) { score += 5; factors.push({ factor: 'Service issues', points: 5 }); }
    if (docket.conciliationStatus === 'failed') { score += 10; factors.push({ factor: 'Mediation failed', points: 10 }); }
    if (docket.hasDefendantAttorney) { score -= 10; factors.push({ factor: 'Has attorney', points: -10 }); }
    if (docket.hasDefendantResponse) { score -= 5; factors.push({ factor: 'Responding', points: -5 }); }
    if (docket.hasWritOfExecution) { score -= 20; factors.push({ factor: 'Writ filed', points: -20 }); }
  }
  
  score = Math.max(0, Math.min(100, score));
  const grade = score >= 80 ? 'A' : score >= 65 ? 'B' : score >= 50 ? 'C' : score >= 35 ? 'D' : 'F';
  return { score, grade, factors };
}

function generateRemarks(c, d, ls) {
  const r = [];
  if (ls.grade === 'A') r.push('🔥 HOT LEAD');
  else if (ls.grade === 'B') r.push('⭐ Good lead');
  if (!c.hasJudgement && c.daysOpen >= 60) r.push('Early stage');
  if (d.totalEntries > 0) {
    if (!d.hasDefendantAttorney && !d.hasDefendantResponse) r.push('Not responding');
    if (d.hasDefaultMotion) r.push('Default motion');
    if (d.hasDefendantAttorney) r.push('⚠️ Has attorney');
    if (d.hasWritOfExecution) r.push('⚠️ Writ filed');
  }
  return r.join(' | ');
}

async function scrapeMontgomeryCourts(options = {}) {
  const csvPath = options.csvPath || CONFIG.csvPath;
  console.log('\n🏛️ Montgomery County Courts Scraper (CSV-based)');
  console.log('================================================');
  
  let allCases;
  try {
    console.log(`\n📄 Loading CSV from ${csvPath}...`);
    allCases = await parseCSV(csvPath);
    console.log(`   Found ${allCases.length} cases in CSV`);
  } catch (err) {
    console.error(`   Error: ${err.message}`);
    return [];
  }
  
  // Filter OPEN + no judgment
  let targets = allCases.filter(c => c.status.toUpperCase().includes('OPEN') && !c.hasJudgement);
  console.log(`   ${targets.length} are OPEN with NO Judgement`);
  
  // Calculate days and filter
  const now = new Date();
  targets = targets.map(c => {
    const m = c.commencedDate.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    c.daysOpen = m ? Math.ceil((now - new Date(m[3], m[1] - 1, m[2])) / 86400000) : 0;
    return c;
  }).filter(c => c.daysOpen >= CONFIG.minDaysOld && c.daysOpen <= CONFIG.maxDaysOld);
  console.log(`   ${targets.length} in target range (${CONFIG.minDaysOld}-${CONFIG.maxDaysOld} days)`);
  
  // Sort by ideal age
  targets.sort((a, b) => {
    const score = d => (d >= 60 && d <= 180) ? 100 : (d < 60) ? 80 : 50;
    return score(b.daysOpen) - score(a.daysOpen);
  });
  
  if (targets.length > CONFIG.maxCasesToProcess) {
    console.log(`   Limiting to ${CONFIG.maxCasesToProcess} cases`);
    targets = targets.slice(0, CONFIG.maxCasesToProcess);
  }
  
  console.log(`\n🌐 Fetching details for ${targets.length} cases...`);
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  });
  const page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on('request', r => ['image', 'stylesheet', 'font'].includes(r.resourceType()) ? r.abort() : r.continue());
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
  
  const results = [];
  
  try {
    for (let i = 0; i < targets.length; i++) {
      const c = targets[i];
      if (i > 0 && i % CONFIG.batchSize === 0) { console.log('   ⏸ Pause...'); await delay(CONFIG.batchPause); }
      
      try {
        await delay(CONFIG.requestDelay);
        
        // Search for case - use exact case number
        const searchUrl = `${CONFIG.baseUrl}/psi/v/search/case?Q=${encodeURIComponent(c.caseNumber)}&Grid=true`;
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await delay(800);
        
        // Find the EXACT case number match and get its detail URL
        const detailUrl = await page.evaluate((targetCaseNum) => {
          const rows = document.querySelectorAll('tr');
          for (const row of rows) {
            const cells = row.querySelectorAll('td');
            for (const cell of cells) {
              const text = cell.textContent?.trim();
              // Exact match on case number
              if (text === targetCaseNum) {
                const link = row.querySelector('a[href*="/detail/Case/"]');
                return link?.href || null;
              }
            }
          }
          return null;
        }, c.caseNumber);
        
        if (!detailUrl) { 
          console.log(`   ${i + 1}/${targets.length} ~ ${c.caseNumber} (not found)`); 
          continue; 
        }
        
        // Go to detail page
        await page.goto(detailUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await delay(800);
        
        // Extract all data from detail page
        const details = await page.evaluate(() => {
          const result = {
            propertyAddress: '',
            propertyCity: '',
            propertyState: 'PA',
            propertyZip: '',
            judge: '',
            docketEntries: []
          };
          
          // Get judge from the case info table
          const pageText = document.body.innerText;
          const judgeMatch = pageText.match(/Judge[:\s]+([A-Z][A-Z\.\s]+[A-Z])/);
          if (judgeMatch) result.judge = judgeMatch[1].trim();
          
          // Find the Defendants section and extract address
          // Look for the heading "Defendants" then find the grid below it
          const allText = document.body.innerHTML;
          const defendantsMatch = allText.match(/Defendants[\s\S]*?<table[\s\S]*?<\/table>/i);
          
          // Alternative: find all tables and look for one with Address column
          const tables = document.querySelectorAll('table');
          for (const table of tables) {
            const headerRow = table.querySelector('tr');
            if (!headerRow) continue;
            
            const headers = Array.from(headerRow.querySelectorAll('th, td')).map(h => h.textContent?.trim().toLowerCase() || '');
            const addressIdx = headers.findIndex(h => h === 'address');
            
            if (addressIdx === -1) continue;
            
            // Found a table with Address column - get first data row
            const rows = table.querySelectorAll('tr');
            for (let ri = 1; ri < rows.length; ri++) {
              const cells = rows[ri].querySelectorAll('td');
              if (cells.length > addressIdx) {
                const addrCell = cells[addressIdx];
                const addrText = addrCell?.textContent?.trim() || '';
                
                // Check if this looks like a PA/NJ address
                if (addrText.match(/(PA|NJ)\s*\d{5}/i)) {
                  // Parse the address
                  let addr = addrText.replace(/UNITED STATES/gi, '').trim();
                  
                  // Extract state and zip
                  const szMatch = addr.match(/,?\s*(PA|NJ)\s*(\d{5})(-\d{4})?/i);
                  if (szMatch) {
                    result.propertyState = szMatch[1].toUpperCase();
                    result.propertyZip = szMatch[2];
                    
                    // Everything before state/zip
                    const beforeSZ = addr.substring(0, addr.indexOf(szMatch[0])).trim();
                    
                    // Try to split street and city
                    // Common pattern: "123 MAIN STREETCITYNAME" or "123 MAIN STREET CITYNAME"
                    const streetSuffixes = /(.*(?:ROAD|RD|STREET|ST|AVENUE|AVE|DRIVE|DR|LANE|LN|COURT|CT|CIRCLE|CIR|BOULEVARD|BLVD|PLACE|PL|WAY|TERRACE|TER|PIKE|TRAIL|TRL|HIGHWAY|HWY|PARKWAY|PKWY))\s*(.*)$/i;
                    const streetMatch = beforeSZ.match(streetSuffixes);
                    
                    if (streetMatch) {
                      result.propertyAddress = streetMatch[1].trim();
                      result.propertyCity = streetMatch[2].trim();
                    } else {
                      // Try case-change split: "123 Main StCityName"
                      const caseMatch = beforeSZ.match(/^(.+[a-z])([A-Z][A-Za-z\s]+)$/);
                      if (caseMatch) {
                        result.propertyAddress = caseMatch[1].trim();
                        result.propertyCity = caseMatch[2].trim();
                      } else {
                        result.propertyAddress = beforeSZ;
                      }
                    }
                  }
                  break;
                }
              }
            }
            
            // If we found an address, stop searching tables
            if (result.propertyAddress) break;
          }
          
          // Get docket entries
          for (const table of tables) {
            const headerRow = table.querySelector('tr');
            if (!headerRow) continue;
            
            const headerText = headerRow.textContent?.toLowerCase() || '';
            if (!headerText.includes('filing date') && !headerText.includes('docket')) continue;
            
            const rows = table.querySelectorAll('tr');
            for (let ri = 1; ri < rows.length; ri++) {
              const cells = rows[ri].querySelectorAll('td');
              if (cells.length < 3) continue;
              
              // Find date cell and description
              let dateText = '', descText = '';
              for (const cell of cells) {
                const t = cell.textContent?.trim() || '';
                if (!dateText && t.match(/^\d{1,2}\/\d{1,2}\/\d{4}$/)) {
                  dateText = t;
                } else if (dateText && t.length > 5 && !t.match(/^\d+$/) && !descText) {
                  descText = t;
                } else if (dateText && descText && t.length > 5) {
                  descText += ' - ' + t;
                  break;
                }
              }
              
              if (dateText) {
                result.docketEntries.push({ date: dateText, description: descText });
              }
            }
            
            if (result.docketEntries.length > 0) break;
          }
          
          return result;
        });
        
        // Analyze docket
        const docket = analyzeDocket(details.docketEntries);
        c.propertyAddress = details.propertyAddress;
        c.propertyCity = details.propertyCity;
        c.propertyState = details.propertyState;
        c.propertyZip = details.propertyZip;
        c.judge = details.judge;
        c.detailUrl = detailUrl;
        
        const ls = calculateLeadScore(c, docket);
        results.push({
          caseNumber: c.caseNumber, caseType: c.caseType, commencedDate: parseDate(c.commencedDate),
          daysOpen: c.daysOpen, lastFilingDate: docket.lastActivityDate, daysSinceLastActivity: docket.daysSinceLastActivity,
          plaintiff: c.plaintiff, defendant: c.defendant,
          propertyAddress: c.propertyAddress, propertyCity: c.propertyCity, propertyState: c.propertyState, propertyZip: c.propertyZip,
          parcelNumber: c.parcelNumber, hasJudgement: c.hasJudgement, hasLisPendens: c.hasLisPendens, status: c.status, judge: c.judge,
          leadScore: ls.score, leadGrade: ls.grade, scoreFactors: ls.factors,
          docketSummary: {
            totalEntries: docket.totalEntries, hasDefaultMotion: docket.hasDefaultMotion, hasDefaultJudgment: docket.hasDefaultJudgment,
            hasDefendantAttorney: docket.hasDefendantAttorney, hasDefendantResponse: docket.hasDefendantResponse,
            hasConciliation: docket.hasConciliation, conciliationStatus: docket.conciliationStatus, hasWritOfExecution: docket.hasWritOfExecution,
            serviceAttempts: docket.serviceAttempts, failedServiceAttempts: docket.failedServiceAttempts
          },
          distressSignals: docket.distressSignals, positiveSignals: docket.positiveSignals, recentActivity: docket.recentActivity,
          remarks: generateRemarks(c, docket, ls), detailUrl, county: 'Montgomery', state: 'PA'
        });
        
        const addr = c.propertyAddress ? `${c.propertyAddress}, ${c.propertyCity}` : 'No addr';
        console.log(`   ${i + 1}/${targets.length} ✓ ${c.caseNumber} [${ls.grade}:${ls.score}] - ${addr}`);
      } catch (err) {
        console.log(`   ${i + 1}/${targets.length} ~ ${c.caseNumber} (${err.message})`);
      }
    }
  } finally { await browser.close(); }
  
  results.sort((a, b) => b.leadScore - a.leadScore);
  const grades = { A: 0, B: 0, C: 0, D: 0, F: 0 };
  results.forEach(c => grades[c.leadGrade]++);
  console.log(`\n✅ Done: ${results.length} cases | A=${grades.A} B=${grades.B} C=${grades.C} D=${grades.D} F=${grades.F}`);
  return results;
}

module.exports = { scrapeMontgomeryCourts, parseCSV, CONFIG };
