// montco-courts.js  (V3 SINGLE-FILE DROP-IN)
// Montgomery County Courts scraper - WAIT FOR FULL PAGE LOAD
const puppeteer = require('puppeteer');
const fs = require('fs').promises;
const path = require('path');

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
  requestDelay: 1200,
  pageLoadWait: 3000,
  batchSize: 15,
  batchPause: 4000,
  maxCasesToProcess: 0,
  testModeLimit: 10,

  // Date ranges in MONTHS (calculated dynamically from today)
  minMonthsOld: 6,
  maxMonthsOld: 24,
  sweetSpotMinMonths: 9,
  sweetSpotMaxMonths: 18,

  searchUrl: 'https://courtsapp.montcopa.org/psi/v/search/case?fromAdv=1',
  csvPath: path.join(process.env.DATA_DIR || './data', 'montco-cases.csv')
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

function normalizeDefendantName(name) {
  return (name || '')
    .toUpperCase()
    .replace(/[.,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseDate(dateStr) {
  if (!dateStr) return null;
  const m = dateStr.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : null;
}

/* ===========================================================
   ✅ V3 SCORING (4 Pillars)
   - Pressure Stage (0–30)
   - Resistance (-20..+10)
   - Momentum (0–25)
   - Fatigue (0–25)
   Returns: { score, grade, pillars, factors }
   =========================================================== */
function calculateScore(c) {
  return calculateV3Score(c);
}

function calculateV3Score(c) {
  const docket = c.docket || {};
  const entries = docket.entries || 0;
  const textAll = (docket.allText || '').toUpperCase();
  const typesAll = (docket.allTypes || '').toUpperCase();
  const lastText = (docket.lastEventText || '').toUpperCase();
  const lastType = (docket.lastEventType || '').toUpperCase();
  const daysOpen = c.daysOpen || 0;
  const monthsOpen = c.monthsOpen || Math.round(daysOpen / 30);
  const daysSinceLast = docket.daysSinceLastFiling || 0;
  const continuances = docket.continuanceCount || 0;

  // Helpers
  const has = (s) => textAll.includes(s);
  const lastHas = (s) => lastText.includes(s);
  const factors = [];

  // --- Identify defense vs admin/progress in last event
  const lastLooksDefensive =
    lastHas('ANSWER') ||
    lastHas('NEW MATTER') ||
    lastHas('COUNTERCLAIM') ||
    lastHas('PRELIMINARY OBJECTION') ||
    lastHas('OBJECTION') ||
    lastHas('OPPOSITION') ||
    lastHas('DEFENDANT') && lastHas('MOTION');

  const lastLooksAdminOrProgress =
    lastHas('STAY IS LIFTED') || lastHas('STAY LIFTED') ||
    (lastHas('DISCHARGE') && lastHas('BANKRUPTCY')) ||
    lastHas('PRAECIPE') || lastHas('REINSTATE') || lastHas('REACTIVATE') ||
    lastHas('CIVIL CASE MANAGEMENT') || lastHas('DISCOVERY') ||
    lastHas('ALTERNATE SERVICE') || lastHas('POSTED PREMISES') ||
    lastHas('NOT FOUND') || lastHas('FAILURE OF SERVICE') ||
    lastHas('SERVED') || lastHas('SERVICE');

  /* ---------------------------
     🧱 PILLAR 1: PRESSURE (0–30)
     --------------------------- */
  let pressure = 0;

  // Age band (max 20)
  if (daysOpen < 120) { pressure += 0; }
  else if (daysOpen < 180) { pressure += 5; }
  else if (daysOpen < 270) { pressure += 12; }
  else if (daysOpen <= 540) { pressure += 25; }
  else if (daysOpen <= 720) { pressure += 15; }
  else { pressure += 8; }

  // Acceleration events (max +10; overall cap at 30)
  let accel = 0;
  if (has('STAY IS LIFTED') || has('STAY LIFTED')) accel += 5;
  if (has('DISCHARGE') && has('BANKRUPTCY')) {
  accel += 8;      // pressure bump
}
  if (has('MOTION FOR SUMMARY JUDGMENT') && (has('PLAINTIFF') || has('PLTF'))) accel += 5;
  if (has('MOTION FOR SUMMARY JUDGMENT') && (has('GRANTED') && (has('PLAINTIFF') || has('PLTF')))) accel += 10;

  accel = Math.min(10, accel);
  pressure = Math.min(30, pressure + accel);

  if (daysOpen >= 270 && daysOpen <= 540) {
    factors.push({ text: '🧱 Pressure: SWEET SPOT (9–18 months)', impact: '+20' });
  } else {
    factors.push({ text: `🧱 Pressure: ${monthsOpen} mo open`, impact: `+${Math.min(20, pressure)}` });
  }
  if (accel > 0) factors.push({ text: '🧱 Pressure: acceleration events present', impact: `+${accel}` });

  /* -------------------------------
     🛡 PILLAR 2: RESISTANCE (-20..+10)
     ------------------------------- */
  let resistance = 0;

  const defenseSignals =
    (typesAll.includes('ANSWER') && has('NEW MATTER')) ||
    has('COUNTERCLAIM') ||
    has('PRELIMINARY OBJECTION') ||
    (has('MOTION FOR SUMMARY JUDGMENT') && has('DEFENDANT')) ||
    (has('OBJECTION') && has('OPPOSITION'));

  // Active resistance penalties
  if (typesAll.includes('ANSWER') && has('NEW MATTER')) resistance -= 5;
  if (has('COUNTERCLAIM')) resistance -= 10;
  if (has('PRELIMINARY OBJECTION')) resistance -= 5;
  if (has('MOTION FOR SUMMARY JUDGMENT') && has('DEFENDANT')) resistance -= 10;
  if (has('OBJECTION') && has('OPPOSITION')) resistance -= 5;

  // Passive bonus
  if (!defenseSignals && monthsOpen > 12) resistance += 5;
  if (!defenseSignals && !has('DEFENDANT') /* crude proxy: no defendant-coded events */) resistance += 5;

  resistance = Math.max(-20, Math.min(10, resistance));

  if (resistance < 0) factors.push({ text: '🛡 Resistance: active defense signals', impact: `${resistance}` });
  else if (resistance > 0) factors.push({ text: '🛡 Resistance: passive defendant bonus', impact: `+${resistance}` });
  else factors.push({ text: '🛡 Resistance: neutral', impact: '0' });

  /* --------------------------------
     ⚙️ PILLAR 3: MOMENTUM (0–25)
     -------------------------------- */
  let momentum = 0;

  if (has('ALTERNATE SERVICE')) momentum += 5;
  if (has('POSTED PREMISES')) momentum += 5;
  if (has('SERVICE') && (has('SERVED') || has('COMPLETED'))) momentum += 3;
  if (has('CIVIL CASE MANAGEMENT') || has('DISCOVERY TO BE COMPLETED')) {
    momentum += (daysOpen >= 270 && daysOpen <= 540) ? 8 : 6;
  }

  // Plaintiff MSJ outcomes (best-effort heuristics)
  const plaintiffMSJ = has('MOTION FOR SUMMARY JUDGMENT') && (has('PLAINTIFF') || has('PLTF'));
  if (plaintiffMSJ) momentum += 5;
  if (plaintiffMSJ && has('GRANTED')) momentum += 10;
  if (plaintiffMSJ && has('DENIED')) momentum -= 6; // defendant win slows momentum

  // Other plaintiff-progress: motion granted + plaintiff
  if (has('MOTION GRANTED') && (has('PLAINTIFF') || has('PLTF'))) momentum += 5;

  momentum = Math.max(0, Math.min(25, momentum));

  factors.push({ text: '⚙️ Momentum: procedural progress', impact: `+${momentum}` });

  /* ------------------------------
     😓 PILLAR 4: FATIGUE (0–25)
     ------------------------------ */
  let fatigue = 0;

  // Continuances
  if (continuances === 1) fatigue += 5;
  else if (continuances === 2) fatigue += 8;
  else if (continuances >= 3) fatigue += 12;

  // Failed bankruptcy attempt (pressure + fatigue)
  if (has('DISCHARGE') && has('BANKRUPTCY')) fatigue += 10;

  // Silence context-aware
  if (entries >= 10 && daysSinceLast >= 120) {
  fatigue += lastLooksDefensive ? 12 : 10;
} else if (entries >= 8 && daysSinceLast >= 90) {
  fatigue += lastLooksDefensive ? 10 : 8;
}

  // Long-term passive defendant fatigue bump
if (!defenseSignals && monthsOpen > 12) {
  fatigue += 5;
}
  fatigue = Math.min(25, fatigue);

  factors.push({ text: '😓 Fatigue: delays / stalls / burnout patterns', impact: `+${fatigue}` });

  /* ------------------------------
     ⚠️ Small recency penalty (v3)
     Only if last event looks defensive (not admin/progress)
     ------------------------------ */
  let recencyPenalty = 0;
  if (!lastLooksAdminOrProgress && lastLooksDefensive && daysSinceLast > 0 && daysSinceLast < 14) recencyPenalty = -6;
  else if (!lastLooksAdminOrProgress && lastLooksDefensive && daysSinceLast >= 14 && daysSinceLast < 30) recencyPenalty = -4;

  if (recencyPenalty !== 0) factors.push({ text: '⚠️ Recency: very recent DEFENSIVE activity', impact: `${recencyPenalty}` });
  else if (daysSinceLast > 0 && daysSinceLast < 14 && lastLooksAdminOrProgress)
    factors.push({ text: '✅ Recency: recent admin/progress event (no penalty)', impact: '0' });

  /* ------------------------------
     FINAL SCORE
     ------------------------------ */
  let score = pressure + resistance + momentum + fatigue + recencyPenalty;

  // Small “admin noise guardrail”:
  // If huge entries but no defense, don’t let "entries" inflate anything implicitly.
  // (v3 doesn't reward entries directly, but this avoids edge cases where momentum+fatigue
  // are high from admin-only patterns.)
  if (entries >= 15 && !defenseSignals && momentum < 10) {
    score -= 3;
    factors.push({ text: '🧽 Noise control: high docket volume mostly procedural', impact: '-3' });
  }

  score = Math.max(0, Math.min(100, score));

  let grade = 'F';
  if (score >= 80) grade = 'A';
  else if (score >= 65) grade = 'B';
  else if (score >= 50) grade = 'C';
  else if (score >= 35) grade = 'D';

  return {
    score,
    grade,
    pillars: { pressure, resistance, momentum, fatigue },
    factors
  };
}

async function scrapeMontgomeryCourts(options = {}) {
  const csvPath = options.csvPath || CONFIG.csvPath;
  const testMode = options.testMode || false;

  console.log('\n🏛️ Montgomery County Scraper (V3)');
  if (testMode) console.log('⚡ TEST MODE - Limited to ' + CONFIG.testModeLimit + ' cases');
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
  const allCaseHistoryByDefendant = new Map();
  for (const c of allCases) {
    const key = normalizeDefendantName(c.defendant);
    if (!key) continue;
    const history = allCaseHistoryByDefendant.get(key) || [];
    history.push({
      caseNumber: c.caseNumber,
      commencedDate: c.commencedDate || '',
      status: c.status || '',
      hasJudgement: !!c.hasJudgement
    });
    allCaseHistoryByDefendant.set(key, history);
  }

  const minDaysOld = CONFIG.minMonthsOld * 30;
  const maxDaysOld = CONFIG.maxMonthsOld * 30;
  const sweetSpotMinDays = CONFIG.sweetSpotMinMonths * 30;
  const sweetSpotMaxDays = CONFIG.sweetSpotMaxMonths * 30;

  console.log(`   Date range: ${CONFIG.minMonthsOld}-${CONFIG.maxMonthsOld} months old`);
  console.log(`   Sweet spot: ${CONFIG.sweetSpotMinMonths}-${CONFIG.sweetSpotMaxMonths} months old`);

  let targets = allCases
    .filter(c => c.status.toUpperCase().includes('OPEN') && !c.hasJudgement)
    .map(c => {
      const m = c.commencedDate.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
      c.daysOpen = m ? Math.ceil((now - new Date(m[3], m[1] - 1, m[2])) / 86400000) : 0;
      c.monthsOpen = Math.round(c.daysOpen / 30);
      c.inSweetSpot = c.daysOpen >= sweetSpotMinDays && c.daysOpen <= sweetSpotMaxDays;
      return c;
    })
    .filter(c => c.daysOpen >= minDaysOld && c.daysOpen <= maxDaysOld);

  const sweetSpotCount = targets.filter(c => c.inSweetSpot).length;
  console.log(`   ${targets.length} OPEN cases in range (${sweetSpotCount} in sweet spot 🎯)`);

  targets.sort((a, b) => {
    if (a.inSweetSpot && !b.inSweetSpot) return -1;
    if (!a.inSweetSpot && b.inSweetSpot) return 1;
    return b.daysOpen - a.daysOpen;
  });

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

      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
    }

    const c = targets[i];

    try {
      await delay(CONFIG.requestDelay);

      await page.goto(CONFIG.searchUrl, { waitUntil: 'networkidle2', timeout: 30000 });
      await delay(1000);

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

      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {});
      await delay(CONFIG.pageLoadWait);

      const currentUrl = page.url();
      if (!currentUrl.includes('/detail/Case/')) {
        console.log(`   ${i + 1}/${targets.length} ~ ${c.caseNumber} (no detail)`);
        continue;
      }

      try {
        await page.waitForFunction(() => {
          const t = document.body.innerText;
          return t.includes('Defendants') && t.includes('Address');
        }, { timeout: 5000 });
      } catch (e) {}

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
            daysSinceLastFiling: null,
            hasServiceCompleted: false,
            docketEvents: [],
            allText: '',
            allTypes: '',
            lastEventText: '',
            lastEventType: ''
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

          // Docket table
          if (headers.includes('docket type') || headers.includes('docket text')) {
            const dateIdx = headers.findIndex(h => h.includes('filing date'));
            const typeIdx = headers.findIndex(h => h.includes('docket type'));
            const textIdx = headers.findIndex(h => h.includes('docket text'));

            const rows = table.querySelectorAll('tr');
            result.docket.entries = rows.length - 1;

            let allDocketText = [];
            let allDocketTypes = [];
            let lastFilingDate = null;

            for (let ri = 1; ri < rows.length; ri++) {
              const cells = rows[ri].querySelectorAll('td');
              const filingDate = dateIdx >= 0 && cells[dateIdx] ? cells[dateIdx].textContent.trim() : '';
              const docketType = typeIdx >= 0 && cells[typeIdx] ? cells[typeIdx].textContent.trim() : '';
              const docketText = textIdx >= 0 && cells[textIdx] ? (cells[textIdx].textContent || '').trim().toUpperCase() : '';

              if (filingDate) lastFilingDate = filingDate;

              if (docketType) allDocketTypes.push(docketType.toUpperCase());
              if (docketText) allDocketText.push(docketText);

              if (docketText.includes('BANKRUPTCY')) result.docket.hasBankruptcy = true;
              if (docketText.includes('CONTINUED TO') || docketText.includes('CONTINUANCE')) result.docket.continuanceCount++;
              if (docketText.includes('CONCILIATION') || docketText.includes('MEDIATION') || docketText.includes('CONFERENCE'))
                result.docket.hasConciliation = true;
              if (docketText.includes('STAYED') || docketText.includes('STAY '))
                result.docket.isStayed = true;
              if (docketText.includes('SERVICE') && (docketText.includes('COMPLETED') || docketText.includes('SERVED')))
                result.docket.hasServiceCompleted = true;

              // Save last row as last event
              if (ri === rows.length - 1) {
                result.docket.lastEventText = docketText.substring(0, 500);
                result.docket.lastEventType = (docketType || '').toUpperCase();
              }

              // Keep last 5 events
              if (ri >= rows.length - 5) {
                result.docket.docketEvents.push({
                  date: filingDate,
                  type: docketType,
                  text: docketText.substring(0, 150)
                });
              }
            }

            result.docket.allText = allDocketText.join(' | ');
            result.docket.allTypes = allDocketTypes.join(' | ');
            result.docket.lastFilingDate = lastFilingDate;

            if (lastFilingDate) {
              const parts = lastFilingDate.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
              if (parts) {
                const d = new Date(parts[3], parts[1] - 1, parts[2]);
                result.docket.daysSinceLastFiling = Math.floor((new Date() - d) / 86400000);
              }
            }

            continue;
          }

          // Address table
          let addrIdx = -1;
          for (let hi = 0; hi < headers.length; hi++) {
            if (headers[hi] === 'address') { addrIdx = hi; break; }
          }
          if (addrIdx === -1) continue;

          const rows = table.querySelectorAll('tr');
          for (let ri = 1; ri < rows.length; ri++) {
            const cells = rows[ri].querySelectorAll('td');
            if (cells.length <= addrIdx) continue;

            const addrCell = cells[addrIdx];
            const text = (addrCell.textContent || '').trim();
            const html = addrCell.innerHTML || '';

            const paIdx = text.indexOf('PA ');
            if (paIdx === -1) continue;

            const afterPA = text.substring(paIdx + 3);
            let zip = '';
            for (let di = 0; di < 5 && di < afterPA.length; di++) {
              const ch = afterPA.charAt(di);
              if (ch >= '0' && ch <= '9') zip += ch;
              else break;
            }
            if (zip.length !== 5) continue;

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

            const upperCity = city.toUpperCase();
            let inMontCo = false;
            for (let mi = 0; mi < montcoTowns.length; mi++) {
              if (upperCity.indexOf(montcoTowns[mi]) !== -1) { inMontCo = true; break; }
            }

            result.addresses.push({ street, city, state: 'PA', zip, inMontCo });
          }
        }

        return result;
      }, MONTCO_TOWNS);

      const addresses = data.addresses || [];
      const bestAddr = addresses.find(a => a.inMontCo) || addresses[0] || null;

      c.propertyAddress = bestAddr?.street || '';
      c.propertyCity = bestAddr?.city || '';
      c.propertyState = bestAddr?.state || 'PA';
      c.propertyZip = bestAddr?.zip || '';
      c.inMontgomeryCounty = bestAddr?.inMontCo || false;
      c.detailUrl = currentUrl;

      c.docket = data.docket || {};

      // ✅ V3 SCORING HERE
      const ls = calculateScore(c);

      results.push({
        caseNumber: c.caseNumber,
        commencedDate: parseDate(c.commencedDate),
        daysOpen: c.daysOpen,
        monthsOpen: c.monthsOpen,
        inSweetSpot: c.inSweetSpot,
        plaintiff: c.plaintiff,
        defendant: c.defendant,
        repeatDefendant: false,
        priorCaseCount: 0,
        priorCases: [],
        propertyAddress: c.propertyAddress,
        propertyCity: c.propertyCity,
        propertyState: c.propertyState,
        propertyZip: c.propertyZip,
        inMontgomeryCounty: c.inMontgomeryCounty,
        hasJudgement: c.hasJudgement,
        status: c.status,

        // Score output
        leadScore: ls.score,
        leadGrade: ls.grade,
        scoreFactors: ls.factors,
        pillars: ls.pillars,

        docket: {
          entries: c.docket.entries || 0,
          hasBankruptcy: c.docket.hasBankruptcy || false,
          continuanceCount: c.docket.continuanceCount || 0,
          hasConciliation: c.docket.hasConciliation || false,
          isStayed: c.docket.isStayed || false,
          lastFilingDate: c.docket.lastFilingDate || null,
          daysSinceLastFiling: c.docket.daysSinceLastFiling || null,
          hasServiceCompleted: c.docket.hasServiceCompleted || false,
          recentEvents: c.docket.docketEvents || [],
          lastEventText: c.docket.lastEventText || '',
          lastEventType: c.docket.lastEventType || ''
        },

        detailUrl: c.detailUrl,
        county: 'Montgomery',
        state: 'PA'
      });

      const gradeEmoji = ls.grade === 'A' ? '🔥' : ls.grade === 'B' ? '⭐' : ls.grade === 'C' ? '📋' : '⚠️';
      const addrStr = c.propertyAddress ? `${c.propertyAddress}, ${c.propertyCity}` : 'No addr';
      console.log(`   ${i + 1}/${targets.length} ${gradeEmoji} ${c.caseNumber} [${ls.grade}:${ls.score}] [P:${ls.pillars.pressure} R:${ls.pillars.resistance} M:${ls.pillars.momentum} F:${ls.pillars.fatigue}] - ${addrStr}`);

    } catch (err) {
      console.log(`   ${i + 1}/${targets.length} ~ ${c.caseNumber} (${(err.message || '').slice(0, 60)})`);
    }
  }

  for (const r of results) {
    const key = normalizeDefendantName(r.defendant);
    if (!key) continue;
    const history = allCaseHistoryByDefendant.get(key) || [];
    const priorCases = history.filter(h => h.caseNumber !== r.caseNumber);
    if (priorCases.length > 0) {
      priorCases.sort((a, b) => {
        const ad = new Date(a.commencedDate || 0).getTime();
        const bd = new Date(b.commencedDate || 0).getTime();
        return bd - ad;
      });
      r.repeatDefendant = true;
      r.priorCaseCount = priorCases.length;
      r.priorCases = priorCases.slice(0, 5);
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
