// Montgomery County Courts scraper for pre-foreclosure pipeline
// CSV-based version - upload the CSV export from the court website
// Then scrapes individual case pages for addresses and docket analysis

const puppeteer = require('puppeteer');
const fs = require('fs').promises;
const path = require('path');

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
    high: ['default judgment', 'motion for default', 'judgment entered', 'writ of execution', 'sheriff sale', 'praecipe for writ', 'rule to show cause', 'failure to appear'],
    medium: ['conciliation', 'mediation', 'service accepted', 'answer filed', 'motion to dismiss denied', 'discovery'],
    positive: ['motion to dismiss', 'answer and new matter', 'counterclaim', 'preliminary objections', 'counsel appearance', 'attorney appearance']
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
    if (desc.includes('service') || desc.includes('served')) {
      a.serviceAttempts++;
      if (desc.includes('fail') || desc.includes('not found')) a.failedServiceAttempts++;
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
    console.log('   Export CSV from court website and save to:', csvPath);
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
        const searchUrl = `${CONFIG.baseUrl}/psi/v/search/case?Q=${encodeURIComponent(c.caseNumber)}&Grid=true`;
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await delay(500);
        
        const detailUrl = await page.evaluate(cn => {
          const links = document.querySelectorAll('a[href*="/detail/Case/"]');
          for (const l of links) if (l.closest('tr')?.textContent.includes(cn)) return l.href;
          return links[0]?.href || null;
        }, c.caseNumber);
        
        if (!detailUrl) { console.log(`   ${i + 1}/${targets.length} ~ ${c.caseNumber} (not found)`); continue; }
        
        await page.goto(detailUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await delay(500);
        
        const details = await page.evaluate(() => {
          const r = { propertyAddress: '', propertyCity: '', propertyState: 'PA', propertyZip: '', judge: '', docketEntries: [] };
          const parseAddr = addr => {
            if (!addr) return { address: '', city: '', state: 'PA', zip: '' };
            addr = addr.replace(/UNITED STATES/gi, '').trim();
            const m = addr.match(/,?\s*(PA|NJ)\s*(\d{5})/i);
            if (!m) return { address: addr, city: '', state: 'PA', zip: '' };
            const before = addr.substring(0, addr.indexOf(m[0])).trim();
            const suffixMatch = before.match(/(.+(?:WAY|ST|AVE|RD|DR|LN|CT|CIR|BLVD|PL|TER|PIKE|TRL|HWY|PKWY))\s*(.*)$/i);
            if (suffixMatch) return { address: suffixMatch[1], city: suffixMatch[2], state: m[1].toUpperCase(), zip: m[2] };
            const caseMatch = before.match(/^(.+[a-z])([A-Z][A-Za-z\s]+)$/);
            if (caseMatch) return { address: caseMatch[1], city: caseMatch[2], state: m[1].toUpperCase(), zip: m[2] };
            return { address: before, city: '', state: m[1].toUpperCase(), zip: m[2] };
          };
          
          const text = document.body.innerText;
          const jm = text.match(/Judge[:\s]+([A-Z][A-Z\s\.]+)/);
          if (jm) r.judge = jm[1].trim();
          
          for (const cell of document.querySelectorAll('[role="gridcell"], td')) {
            const t = cell.textContent?.trim() || '';
            if (t.match(/\b(PA|NJ)\s+\d{5}\b/i) && t.length < 200 && t.match(/^\d/)) {
              const p = parseAddr(t);
              if (p.address) { Object.assign(r, { propertyAddress: p.address, propertyCity: p.city, propertyState: p.state, propertyZip: p.zip }); break; }
            }
          }
          
          for (const row of document.querySelectorAll('[role="row"], tr')) {
            const cells = row.querySelectorAll('[role="gridcell"], td');
            if (cells.length >= 4) {
              let date = '', type = '', txt = '';
              for (const cell of cells) {
                const t = cell.textContent?.trim() || '';
                if (!date && t.match(/^\d{1,2}\/\d{1,2}\/\d{4}$/)) date = t;
                else if (date && !type && t.length > 3 && !t.match(/^\d+$/)) type = t;
                else if (date && type && t.length > 3) { txt = t; break; }
              }
              if (date && type) r.docketEntries.push({ date, description: type + (txt ? ' - ' + txt : '') });
            }
          }
          return r;
        });
        
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
        
        console.log(`   ${i + 1}/${targets.length} ✓ ${c.caseNumber} [${ls.grade}:${ls.score}] - ${c.propertyAddress || 'No addr'}`);
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
