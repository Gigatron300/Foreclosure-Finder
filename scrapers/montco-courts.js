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
  // Legacy function - kept for compatibility
  return calculateEnhancedScore(c);
}

function calculateEnhancedScore(c) {
  let score = 0;
  const factors = [];
  const docket = c.docket || {};
  const entries = docket.entries || 0;
  const docketText = (docket.allText || '').toUpperCase();
  const docketTypes = (docket.allTypes || '').toUpperCase();
  const daysSinceLastFiling = docket.daysSinceLastFiling || 0;
  
  // ============================================
  // 1️⃣ CASE AGE SCORE (MAX 25 points)
  // ============================================
  const months = c.monthsOpen || Math.round((c.daysOpen || 0) / 30);
  const days = c.daysOpen || 0;
  
  if (days < 120) {
    factors.push({ text: '⏱️ Too early (<4 months) - owner likely in denial', impact: 0 });
  } else if (days >= 120 && days < 180) {
    score += 5;
    factors.push({ text: '⏱️ Early stage (4-6 months)', impact: +5 });
  } else if (days >= 180 && days < 270) {
    score += 12;
    factors.push({ text: '⏱️ Building pressure (6-9 months)', impact: +12 });
  } else if (days >= 270 && days <= 540) {
    score += 25;
    factors.push({ text: '🎯 SWEET SPOT (9-18 months) - maximum pressure', impact: +25 });
  } else if (days > 540 && days <= 720) {
    score += 18;
    factors.push({ text: '⏱️ Late stage (18-24 months)', impact: +18 });
  } else if (days > 720) {
    score += 10;
    factors.push({ text: '⏱️ Very old case (>24 months) - may be zombie', impact: +10 });
  }
  
  // ============================================
  // 2️⃣ DOCKET ACTIVITY INTENSITY (MAX 20 points)
  // ============================================
  if (entries <= 4) {
    score += 2;
    factors.push({ text: `📋 Low activity (${entries} entries)`, impact: +2 });
  } else if (entries >= 5 && entries <= 8) {
    score += 8;
    factors.push({ text: `📋 Moderate activity (${entries} entries)`, impact: +8 });
  } else if (entries >= 9 && entries <= 14) {
    score += 14;
    factors.push({ text: `📋 High activity (${entries} entries) - decision fatigue`, impact: +14 });
  } else if (entries >= 15) {
    score += 20;
    factors.push({ text: `📋 Very high activity (${entries} entries) - exhaustion likely`, impact: +20 });
  }
  
  // ============================================
  // 3️⃣ DELAY & CONTINUANCE SIGNALS (with diminishing returns)
  // ============================================
  const continuances = docket.continuanceCount || 0;
  if (continuances > 0) {
    // Diminishing returns: 1-3: +5 each, 4-6: +3 each, >6: +1 each
    let delayPoints = 0;
    for (let i = 1; i <= continuances; i++) {
      if (i <= 3) delayPoints += 5;
      else if (i <= 6) delayPoints += 3;
      else delayPoints += 1;
    }
    delayPoints = Math.min(25, delayPoints); // Cap at 25
    score += delayPoints;
    factors.push({ text: `🔄 ${continuances} continuance(s) - mounting costs & fatigue`, impact: +delayPoints });
  }
  
  // ============================================
  // 4️⃣ RESISTANCE vs CAPITULATION (-25 to +20)
  // ============================================
  
  // Track if defendant is actively fighting (for "false hope" check)
  let activeFighting = false;
  
  // NEGATIVE: Still fighting
  if (docketTypes.includes('ANSWER') && docketText.includes('NEW MATTER')) {
    score -= 5;
    activeFighting = true;
    factors.push({ text: '⚔️ Answer & New Matter filed - defendant fighting', impact: -5 });
  }
  if (docketTypes.includes('PRELIMINARY OBJECTIONS') || docketText.includes('PRELIMINARY OBJECTIONS')) {
    score -= 5;
    activeFighting = true;
    factors.push({ text: '⚔️ Preliminary Objections - active resistance', impact: -5 });
  }
  if (docketText.includes('OBJECTION') && docketText.includes('OPPOSITION')) {
    score -= 5;
    activeFighting = true;
    factors.push({ text: '⚔️ Objection/Opposition filed', impact: -5 });
  }
  if (docketText.includes('MOTION FOR SUMMARY JUDGMENT') && 
      (docketText.includes('DEFENDANT') || (docketText.includes('BY ') && !docketText.includes('BY PLAINTIFF')))) {
    score -= 10;
    activeFighting = true;
    factors.push({ text: '⚔️ Defendant filed Motion for Summary Judgment - believes they can win', impact: -10 });
  }
  if (docketText.includes('COUNTERCLAIM')) {
    score -= 8;
    activeFighting = true;
    factors.push({ text: '⚔️ Counterclaim filed - aggressive defense', impact: -8 });
  }
  if (docketTypes.includes('REPLY TO NEW MATTER') || docketText.includes('REPLY TO NEW MATTER')) {
    score -= 3;
    factors.push({ text: '⚔️ Reply to New Matter - litigation ongoing', impact: -3 });
  }
  
  // POSITIVE: Signs of capitulation
  if (docketTypes.includes('PRAECIPE TO REINSTATE') || docketText.includes('PRAEC TO REINSTATE') || docketText.includes('PRAECIPE TO REINSTATE')) {
    score += 5;
    factors.push({ text: '📄 Praecipe to Reinstate - case reactivated after pause', impact: +5 });
  }
  if (docketText.includes('ALTERNATE SERVICE') || docketText.includes('MOTION FOR ALTERNATE SERVICE')) {
    score += 5;
    factors.push({ text: '📬 Motion for Alternate Service - hard to locate defendant', impact: +5 });
  }
  if (docketText.includes('NOT FOUND') || docketText.includes('FAILURE OF SERVICE')) {
    score += 5;
    factors.push({ text: '❓ Service issues - defendant may be avoiding', impact: +5 });
  }
  if (docketText.includes('WITHDRAW') && docketText.includes('COUNSEL')) {
    score += 12;
    factors.push({ text: '💰 Withdrawal of Counsel - financial distress signal!', impact: +12 });
  }
  if (docketText.includes('SUBSTITUTION OF COUNSEL')) {
    score += 3;
    factors.push({ text: '🔄 Substitution of Counsel - possible financial strain', impact: +3 });
  }
  
  // ============================================
  // 5️⃣ SETTLEMENT / DE-ESCALATION (MAX 15 points)
  // ============================================
  let hasSettlementSignal = false;
  
  if (docketText.includes('MATTER SETTLED') || docketText.includes('SETTLED')) {
    score += 15;
    hasSettlementSignal = true;
    factors.push({ text: '🤝 Matter Settled notation - actively negotiating!', impact: +15 });
  }
  if (docketText.includes('STIPULATION') && !docketText.includes('DISMISSAL')) {
    score += 10;
    hasSettlementSignal = true;
    factors.push({ text: '📝 Stipulation filed - parties negotiating', impact: +10 });
  }
  if (docketText.includes('STIPULATION') && docketText.includes('DISMISSAL')) {
    score += 8;
    hasSettlementSignal = true;
    factors.push({ text: '📝 Stipulation of Dismissal - case may be resolving', impact: +8 });
  }
  
  // ============================================
  // 6️⃣ TRANSITION BONUSES (state changes matter!)
  // ============================================
  
  // Stay lifted after being stayed = case resuming, pressure back on
  if ((docketText.includes('STAY IS LIFTED') || docketText.includes('STAY LIFTED')) && docket.isStayed) {
    score += 12;
    factors.push({ text: '▶️ Stay LIFTED after pause - pressure resuming!', impact: +12 });
  } else if (docketText.includes('STAY IS LIFTED') || docketText.includes('STAY LIFTED')) {
    score += 8;
    factors.push({ text: '▶️ Stay Lifted - case resuming', impact: +8 });
  }
  
  // Silence after heavy activity = exhaustion (context-aware silence)
  if (entries >= 8 && daysSinceLastFiling >= 90) {
    score += 10;
    factors.push({ text: '💤 Silence after heavy activity - likely exhausted', impact: +10 });
  } else if (entries >= 5 && daysSinceLastFiling >= 60) {
    score += 5;
    factors.push({ text: '💤 Slowing down after activity', impact: +5 });
  }
  
  // ============================================
  // 7️⃣ RECENT ACTIVITY PENALTY (decay function)
  // ============================================
  if (daysSinceLastFiling > 0 && daysSinceLastFiling < 14) {
    score -= 12;
    factors.push({ text: '🔥 Very recent filing (<14 days) - actively litigating', impact: -12 });
  } else if (daysSinceLastFiling >= 14 && daysSinceLastFiling < 30) {
    score -= 8;
    factors.push({ text: '🔥 Recent filing (14-30 days)', impact: -8 });
  } else if (daysSinceLastFiling >= 30 && daysSinceLastFiling < 60) {
    score -= 4;
    factors.push({ text: '⏳ Activity 30-60 days ago', impact: -4 });
  } else if (daysSinceLastFiling >= 60 && daysSinceLastFiling < 90) {
    // Neutral - no penalty
    factors.push({ text: '⏳ Activity 60-90 days ago', impact: 0 });
  }
  // >90 days already handled in transition bonuses if high activity
  
  // ============================================
  // 8️⃣ "FALSE HOPE" DAMPENER
  // Early case + high activity + no adverse rulings = still believes they can win
  // ============================================
  const hasAdverseRuling = docketText.includes('DENIED') || docketText.includes('OVERRULED') || 
                           docketText.includes('MOTION GRANTED') && docketText.includes('PLAINTIFF');
  
  if (days < 360 && entries >= 6 && activeFighting && !hasAdverseRuling) {
    score -= 8;
    factors.push({ text: '⚠️ "False hope" - early fighter with no adverse rulings yet', impact: -8 });
  }
  
  // ============================================
  // 9️⃣ BANKRUPTCY CHECK (with decay)
  // ============================================
  if (docket.hasBankruptcy || docketText.includes('BANKRUPTCY')) {
    // Check if it's a DISCHARGE of bankruptcy (positive) vs active bankruptcy (negative)
    if (docketText.includes('DISCHARGE') && docketText.includes('BANKRUPTCY')) {
      score += 8;
      factors.push({ text: '✅ Bankruptcy DISCHARGED - case can proceed!', impact: +8 });
    } else {
      // Apply decay based on case age (rough proxy for BK timing)
      if (daysSinceLastFiling < 90) {
        score -= 25;
        factors.push({ text: '🚫 Recent bankruptcy activity - case likely stayed', impact: -25 });
      } else if (daysSinceLastFiling < 180) {
        score -= 18;
        factors.push({ text: '🚫 Bankruptcy (moderating) - still impacting case', impact: -18 });
      } else {
        score -= 10;
        factors.push({ text: '⚠️ Bankruptcy noted - may be old/resolved', impact: -10 });
      }
    }
  }
  
  // ============================================
  // 🔟 PROPERTY & DEFENDANT FACTORS
  // ============================================
  if (c.propertyAddress) {
    score += 3;
    factors.push({ text: '📍 Has property address', impact: +3 });
  } else {
    score -= 5;
    factors.push({ text: '❓ No address found', impact: -5 });
  }
  
  // Defendant type detection
  const defendant = (c.defendant || '').toUpperCase();
  if (defendant.includes('LLC') || defendant.includes('INC') || defendant.includes('CORP') || 
      defendant.includes('TRUST') || defendant.includes('ESTATE OF') || defendant.includes('BANK')) {
    score -= 8;
    factors.push({ text: '🏢 Entity defendant - less motivated', impact: -8 });
  }
  
  // ============================================
  // FINAL SCORE & GRADE
  // ============================================
  score = Math.max(0, Math.min(100, score));
  
  let grade;
  if (score >= 80) grade = 'A';      // Highly willing seller - call immediately
  else if (score >= 65) grade = 'B'; // Strong candidate - direct mail + call
  else if (score >= 50) grade = 'C'; // On the fence - nurture
  else if (score >= 35) grade = 'D'; // Low probability - watchlist
  else grade = 'F';                   // Not ready - ignore
  
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
      
      // Extract addresses AND docket entries
      const data = await page.evaluate((montcoTowns) => {
        const result = {
          addresses: [],
          docket: {
            entries: 0,
            hasBankruptcy: false,
            continuanceCount: 0,
            hasConciliation: false,
            isStayed: false,
            lastFilingDate: null,
            hasServiceCompleted: false,
            docketEvents: []
          }
        };
        
        const tables = document.querySelectorAll('table');
        
        for (let ti = 0; ti < tables.length; ti++) {
          const table = tables[ti];
          const headerRow = table.querySelector('tr');
          if (!headerRow) continue;
          
          const headerCells = headerRow.querySelectorAll('th, td');
          const headers = [];
          for (let hi = 0; hi < headerCells.length; hi++) {
            headers.push((headerCells[hi].textContent || '').trim().toLowerCase());
          }
          
          // Check if this is the Docket Entries table
          if (headers.includes('docket type') || headers.includes('docket text')) {
            const dateIdx = headers.findIndex(h => h.includes('filing date'));
            const typeIdx = headers.findIndex(h => h.includes('docket type'));
            const textIdx = headers.findIndex(h => h.includes('docket text'));
            
            const rows = table.querySelectorAll('tr');
            result.docket.entries = rows.length - 1; // Exclude header
            
            // Collect ALL docket text and types for comprehensive analysis
            let allDocketText = [];
            let allDocketTypes = [];
            let firstFilingDate = null;
            let lastFilingDate = null;
            
            for (let ri = 1; ri < rows.length; ri++) {
              const cells = rows[ri].querySelectorAll('td');
              const filingDate = dateIdx >= 0 && cells[dateIdx] ? cells[dateIdx].textContent.trim() : '';
              const docketType = typeIdx >= 0 && cells[typeIdx] ? cells[typeIdx].textContent.trim() : '';
              const docketText = textIdx >= 0 && cells[textIdx] ? cells[textIdx].textContent.trim().toUpperCase() : '';
              
              // Track first and last filing dates
              if (filingDate) {
                if (!firstFilingDate) firstFilingDate = filingDate;
                lastFilingDate = filingDate;
              }
              
              // Collect all text for comprehensive pattern matching
              if (docketType) allDocketTypes.push(docketType.toUpperCase());
              if (docketText) allDocketText.push(docketText);
              
              // Detect signals in docket text
              if (docketText.includes('BANKRUPTCY')) {
                result.docket.hasBankruptcy = true;
              }
              if (docketText.includes('CONTINUED TO') || docketText.includes('CONTINUANCE')) {
                result.docket.continuanceCount++;
              }
              if (docketText.includes('CONCILIATION') || docketText.includes('MEDIATION') || docketText.includes('CONFERENCE')) {
                result.docket.hasConciliation = true;
              }
              if (docketText.includes('STAYED') || docketText.includes('STAY ')) {
                result.docket.isStayed = true;
              }
              if (docketText.includes('SERVICE') && (docketText.includes('COMPLETED') || docketText.includes('SERVED'))) {
                result.docket.hasServiceCompleted = true;
              }
              
              // Store recent docket events (last 5)
              if (ri >= rows.length - 5) {
                result.docket.docketEvents.push({
                  date: filingDate,
                  type: docketType,
                  text: docketText.substring(0, 150)
                });
              }
            }
            
            // Store concatenated text for pattern matching in scoring
            result.docket.allText = allDocketText.join(' | ');
            result.docket.allTypes = allDocketTypes.join(' | ');
            result.docket.firstFilingDate = firstFilingDate;
            result.docket.lastFilingDate = lastFilingDate;
            
            // Calculate days since last filing
            if (lastFilingDate) {
              const parts = lastFilingDate.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
              if (parts) {
                const lastDate = new Date(parts[3], parts[1] - 1, parts[2]);
                result.docket.daysSinceLastFiling = Math.floor((new Date() - lastDate) / 86400000);
              }
            }
            
            continue;
          }
          
          // Check if this is the address table
          let addrIdx = -1;
          for (let hi = 0; hi < headers.length; hi++) {
            if (headers[hi] === 'address') {
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
            
            result.addresses.push({ street, city, state: 'PA', zip, inMontCo });
          }
        }
        
        return result;
      }, MONTCO_TOWNS);
      
      // Pick best address (from new data structure)
      const addresses = data.addresses || [];
      let bestAddr = addresses.find(a => a.inMontCo) || addresses[0] || null;
      
      c.propertyAddress = bestAddr?.street || '';
      c.propertyCity = bestAddr?.city || '';
      c.propertyState = bestAddr?.state || 'PA';
      c.propertyZip = bestAddr?.zip || '';
      c.inMontgomeryCounty = bestAddr?.inMontCo || false;
      c.detailUrl = currentUrl;
      
      // Store docket info
      c.docket = data.docket || {};
      
      // Calculate enhanced score with docket signals
      const ls = calculateEnhancedScore(c);
      
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
        docket: {
          entries: c.docket.entries || 0,
          hasBankruptcy: c.docket.hasBankruptcy || false,
          continuanceCount: c.docket.continuanceCount || 0,
          hasConciliation: c.docket.hasConciliation || false,
          isStayed: c.docket.isStayed || false,
          lastFilingDate: c.docket.lastFilingDate || null,
          daysSinceLastFiling: c.docket.daysSinceLastFiling || null,
          hasServiceCompleted: c.docket.hasServiceCompleted || false,
          recentEvents: c.docket.docketEvents || []
        },
        detailUrl: c.detailUrl,
        county: 'Montgomery',
        state: 'PA'
      });
      
      const gradeEmoji = ls.grade === 'A' ? '🔥' : ls.grade === 'B' ? '⭐' : ls.grade === 'C' ? '📋' : '⚠️';
      const docketInfo = c.docket.entries ? ` [${c.docket.entries}dok]` : '';
      const addrStr = c.propertyAddress ? 
        `${c.propertyAddress}, ${c.propertyCity}` : 
        'No addr';
      console.log(`   ${i + 1}/${targets.length} ${gradeEmoji} ${c.caseNumber} [${ls.grade}:${ls.score}]${docketInfo} - ${addrStr}`);
      
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
