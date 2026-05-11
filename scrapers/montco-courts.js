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
  requestDelay: 500,
  pageLoadWait: 500,
  batchSize: 30,
  batchPause: 4000,
  concurrency: 2,
  maxCasesToProcess: 0,
  testModeLimit: 10,

  // Sweet spot remains a scoring/labeling concept, not a hard filter
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
  // Normalize headers so "Case Number", "case_number", "CaseNumber" all match.
  const normHeaders = header.map(h => h.toLowerCase().replace(/[\s_\-#]+/g, ''));
  const col = {
    caseNumber: normHeaders.findIndex(h => h.includes('casenumber') || h === 'case' || h === 'caseno' || h === 'caseid'),
    commenced: normHeaders.findIndex(h => h.includes('commenced') || h.includes('filed') || h.includes('filing')),
    caseType: normHeaders.findIndex(h => h.includes('casetype') || h === 'type'),
    parcelNumber: normHeaders.findIndex(h => h.includes('parcel') || h === 'pin'),
    plaintiff: normHeaders.findIndex(h => h.includes('plaintiff')),
    defendant: normHeaders.findIndex(h => h.includes('defendant')),
    judgement: normHeaders.findIndex(h => h.includes('judgement') || h.includes('judgment')),
    status: normHeaders.findIndex(h => h.includes('status'))
  };

  console.log(`   CSV headers: ${header.join(' | ')}`);
  console.log(`   Column matches: caseNumber=${col.caseNumber} commenced=${col.commenced} caseType=${col.caseType} parcel=${col.parcelNumber} status=${col.status}`);

  const cases = [];
  let nonEmptyParcels = 0, nonEmptyCaseTypes = 0;
  const parcelSamples = [];
  for (let i = 1; i < lines.length; i++) {
    const v = parseCSVLine(lines[i]);
    if (!v[col.caseNumber]) continue;
    const rawParcel = col.parcelNumber >= 0 ? (v[col.parcelNumber] || '') : '';
    // Excel sometimes emits leading apostrophes or wraps numerics — strip the apostrophe.
    const parcel = String(rawParcel).replace(/^['"]/, '').trim();
    const caseType = col.caseType >= 0 ? (v[col.caseType] || '') : '';
    if (parcel) nonEmptyParcels++;
    if (caseType) nonEmptyCaseTypes++;
    if (parcel && parcelSamples.length < 5) parcelSamples.push(JSON.stringify(rawParcel));
    cases.push({
      caseNumber: v[col.caseNumber],
      commencedDate: v[col.commenced] || '',
      caseType,
      parcelNumber: parcel,
      plaintiff: v[col.plaintiff] || '',
      defendant: v[col.defendant] || '',
      hasJudgement: (v[col.judgement] || '').toLowerCase() === 'yes',
      status: v[col.status] || ''
    });
  }
  console.log(`   Populated: ${nonEmptyParcels}/${cases.length} have parcel numbers, ${nonEmptyCaseTypes}/${cases.length} have case types`);
  if (parcelSamples.length) console.log(`   Parcel samples: ${parcelSamples.join(', ')}`);
  return cases;
}

function classifyCaseType(rawType) {
  const t = (rawType || '').toUpperCase();
  if (t.includes('LIEN')) return 'lien';
  if (t.includes('FORECLOSURE') || t.includes('MORTGAGE')) return 'mortgage';
  return 'other';
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

// Parse a commenced-date value from any common CSV/Excel-export representation.
// Returns { year, month, day } (numeric) or null. Accepts:
//   M/D/YYYY, MM/DD/YYYY, M/D/YY (windowed: 50-99 -> 19xx, 00-49 -> 20xx)
//   YYYY-MM-DD (ISO)
//   Excel date-serial numbers (days since 1899-12-30)
function parseCommencedParts(raw) {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim();
  if (!s) return null;

  // M/D/YYYY or M/D/YY
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (m) {
    let yr = parseInt(m[3], 10);
    if (m[3].length === 2) yr = yr >= 50 ? 1900 + yr : 2000 + yr;
    return { year: yr, month: parseInt(m[1], 10), day: parseInt(m[2], 10) };
  }

  // ISO YYYY-MM-DD
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) {
    return { year: parseInt(m[1], 10), month: parseInt(m[2], 10), day: parseInt(m[3], 10) };
  }

  // Excel serial number (days since 1899-12-30). Use a reasonable range.
  if (/^\d+(\.\d+)?$/.test(s)) {
    const serial = parseFloat(s);
    if (serial > 25000 && serial < 80000) {
      const ms = Math.round((serial - 25569) * 86400 * 1000);
      const d = new Date(ms);
      if (!isNaN(d.getTime())) {
        return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
      }
    }
  }

  return null;
}

function parseDate(dateStr) {
  const p = parseCommencedParts(dateStr);
  if (!p) return null;
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

// ===== Montgomery County parcel -> address resolver =====
// Uses PASDA's public ArcGIS REST endpoint for the county Parcels layer.
// PARCEL is the 12-digit parcel ID (we strip dashes / non-digits).
const PARCEL_API_BASE = 'https://mapservices.pasda.psu.edu/server/rest/services/pasda/MontgomeryCounty/MapServer/14/query';
const parcelAddressCache = new Map();
let _parcelDebugRemaining = 8; // Log the first N lookups verbosely

async function fetchParcelAddress(parcelRaw) {
  const parcel = String(parcelRaw || '').replace(/\D/g, '');
  if (!parcel) return null;
  if (parcelAddressCache.has(parcel)) return parcelAddressCache.get(parcel);

  const params = new URLSearchParams({
    where: `PARCEL='${parcel}'`,
    outFields: 'PARCEL,ADDR1,ADDR2,ADDR3,LOC_ZIP1_Z,OWN1,Muni_Name',
    returnGeometry: 'false',
    f: 'json'
  });
  const url = `${PARCEL_API_BASE}?${params.toString()}`;

  let info = null;
  let debugStatus = '';
  let debugFeatures = -1;
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
    debugStatus = `HTTP ${resp.status}`;
    if (resp.ok) {
      const data = await resp.json();
      debugFeatures = data?.features?.length ?? 0;
      const f = data?.features?.[0]?.attributes;
      if (f && (f.ADDR1 || f.ADDR3)) {
        // ADDR3 looks like "HATBORO PA 19040" — split out city + zip.
        let city = '', zip = (f.LOC_ZIP1_Z || '').trim();
        const m = (f.ADDR3 || '').match(/^(.+?)\s+PA\s+(\d{5})/i);
        if (m) { city = m[1].trim(); zip = m[2]; }
        info = {
          street: (f.ADDR1 || '').trim(),
          city,
          state: 'PA',
          zip,
          owner: (f.OWN1 || '').trim(),
          municipality: (f.Muni_Name || '').trim(),
          parcel: f.PARCEL
        };
      }
    }
  } catch (e) {
    debugStatus = `ERROR: ${(e.message || '').slice(0, 80)}`;
    // Network/timeout — fall back to defendant address
  }

  parcelAddressCache.set(parcel, info);

  if (_parcelDebugRemaining > 0) {
    _parcelDebugRemaining--;
    const rawDisplay = JSON.stringify(String(parcelRaw)); // shows quotes / hidden chars
    const matched = info ? `MATCH "${info.street}, ${info.city}"` : 'NO MATCH';
    console.log(`   [parcel-debug] raw=${rawDisplay} norm="${parcel}" (${parcel.length}d) ${debugStatus} features=${debugFeatures} -> ${matched}`);
  }

  return info;
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

// Builds a search-results URL using the same shape Montco's UI emits.
// Pagination is offset-based via Skip=N (page 2 = Skip=20 when Count=20).
function buildSearchResultsUrl({ caseTypeCode, dateFrom, dateTo, count, skip }) {
  return `https://courtsapp.montcopa.org/psi/v/search/case`
    + `?Q=&IncludeSoundsLike=false`
    + `&Count=${encodeURIComponent(String(count))}`
    + `&fromAdv=1&CaseNumber=&ParcelNumber=`
    + `&CaseType=${encodeURIComponent(caseTypeCode)}`
    + `&DateCommencedFrom=${encodeURIComponent(dateFrom)}`
    + `&DateCommencedTo=${encodeURIComponent(dateTo)}`
    + `&IncludeInitialFilings=false&IncludeInitialEFilings=false`
    + `&FilingType=&FilingDateFrom=&FilingDateTo=`
    + `&IncludeSubsequentFilings=false&IncludeSubsequentEFilings=false`
    + `&Court=C&Court=F&JudgeID=&Attorney=&AttorneyID=&Grid=true`
    + `&Skip=${encodeURIComponent(String(skip))}`;
}

async function discoverCaseTypeCodes(browser) {
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
  try {
    await page.goto(CONFIG.searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    return await page.evaluate(() => {
      const select = document.querySelector('select[name="CaseType"]')
                  || document.querySelector('select#CaseType')
                  || document.querySelector('select[id*="CaseType" i]');
      if (!select) return {};
      const map = {};
      for (const opt of select.querySelectorAll('option')) {
        const value = opt.getAttribute('value') || opt.value || '';
        const label = (opt.textContent || '').trim();
        if (value && label) map[label.toLowerCase()] = value;
      }
      return map;
    });
  } finally {
    await page.close().catch(() => {});
  }
}

async function harvestDetailUrls(browser, { caseTypeCode, dateFrom, dateTo, label = '', pageSize = 200 }) {
  const map = new Map();
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const t = req.resourceType();
    if (t === 'image' || t === 'stylesheet' || t === 'font' || t === 'media') req.abort();
    else req.continue();
  });

  try {
    let skip = 0;
    let pageNum = 0;
    while (true) {
      pageNum++;
      const url = buildSearchResultsUrl({ caseTypeCode, dateFrom, dateTo, count: pageSize, skip });
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

      const rows = await page.evaluate(() => {
        const tables = document.querySelectorAll('table');
        for (const table of tables) {
          const headerCells = table.querySelectorAll('tr:first-child > *');
          const headers = Array.from(headerCells).map(h => (h.textContent || '').trim().toLowerCase());
          const caseIdx = headers.findIndex(h => h.includes('case number'));
          if (caseIdx === -1) continue;

          const out = [];
          const trs = table.querySelectorAll('tr');
          for (let i = 1; i < trs.length; i++) {
            const tds = trs[i].querySelectorAll('td');
            if (tds.length <= caseIdx) continue;
            const caseNumber = (tds[caseIdx].textContent || '').trim();
            const link = trs[i].querySelector('a[href*="/detail/Case/"]');
            const href = link ? link.getAttribute('href') || '' : '';
            if (caseNumber && href) {
              const detailUrl = href.startsWith('http')
                ? href
                : 'https://courtsapp.montcopa.org' + (href.startsWith('/') ? '' : '/') + href;
              out.push({ caseNumber, detailUrl });
            }
          }
          return out;
        }
        return [];
      });

      if (rows.length === 0) break;
      for (const r of rows) map.set(r.caseNumber, r.detailUrl);
      console.log(`   ${label}page ${pageNum} (skip=${skip}): ${rows.length} rows, total ${map.size}`);
      if (rows.length < pageSize) break;
      skip += pageSize;
    }
  } finally {
    await page.close().catch(() => {});
  }
  return map;
}

// Resolve a CSV CaseType value to a Montco dropdown code.
// Tries case-insensitive exact match first, then substring matches in either direction.
function resolveCaseTypeCode(codes, csvCaseType) {
  if (!csvCaseType) return null;
  const target = csvCaseType.toLowerCase().trim();
  if (codes[target]) return codes[target];
  for (const [label, value] of Object.entries(codes)) {
    if (label === target) return value;
  }
  for (const [label, value] of Object.entries(codes)) {
    if (label.includes(target) || target.includes(label)) return value;
  }
  return null;
}

// Montco's search caps the result set at 1,000 records, so we chunk by month instead of year.
const MONTCO_RESULT_CAP = 1000;

// Group CSV cases by (year-month, exact CaseType from CSV), then harvest each bucket.
async function harvestUrlCacheFromCSV(browser, cases) {
  const codes = await discoverCaseTypeCodes(browser);
  if (Object.keys(codes).length === 0) {
    console.log('   ⚠️ Could not discover CaseType codes; skipping harvest');
    return new Map();
  }

  // Group cases by (year-month, exact CaseType string from CSV)
  const groups = new Map();
  for (const c of cases) {
    const parts = parseCommencedParts(c.commencedDate);
    if (!parts) continue;
    const year = String(parts.year);
    const month = String(parts.month).padStart(2, '0');
    const caseType = (c.caseType || '').trim();
    if (!caseType) continue;
    const key = `${year}-${month}|${caseType}`;
    groups.set(key, (groups.get(key) || 0) + 1);
  }

  if (groups.size === 0) return new Map();
  console.log(`🌐 Bulk URL harvest across ${groups.size} (month, case-type) buckets...`);

  const merged = new Map();
  const unresolved = new Set();
  const cappedBuckets = [];
  for (const [key, csvCount] of groups) {
    const sep = key.indexOf('|');
    const ym = key.slice(0, sep); // "2026-04"
    const caseType = key.slice(sep + 1);
    const code = resolveCaseTypeCode(codes, caseType);
    if (!code) {
      unresolved.add(caseType);
      console.log(`   skipping "${caseType}" ${ym}: no matching dropdown option (${csvCount} cases)`);
      continue;
    }

    const [yearStr, monthStr] = ym.split('-');
    const year = parseInt(yearStr, 10);
    const month = parseInt(monthStr, 10);
    const lastDay = new Date(year, month, 0).getDate(); // last day of this month
    const dateFrom = `${monthStr}/01/${yearStr}`;
    const dateTo = `${monthStr}/${String(lastDay).padStart(2, '0')}/${yearStr}`;

    try {
      const m = await harvestDetailUrls(browser, {
        caseTypeCode: code,
        dateFrom, dateTo,
        label: `"${caseType}" ${ym}: `,
      });
      for (const [k, v] of m) merged.set(k, v);
      if (m.size >= MONTCO_RESULT_CAP) {
        cappedBuckets.push(`${caseType} ${ym} (${m.size} hits)`);
      }
    } catch (err) {
      console.log(`   harvest failed for "${caseType}" ${ym}: ${(err.message || '').slice(0, 80)}`);
    }
  }
  if (unresolved.size > 0) {
    console.log(`   ⚠️ Unresolved CSV case types: ${Array.from(unresolved).join(', ')} — these will fall back to per-case search`);
  }
  if (cappedBuckets.length > 0) {
    console.log(`   ⚠️ Hit Montco's ${MONTCO_RESULT_CAP}-result cap on: ${cappedBuckets.join('; ')} — those months may be truncated; affected cases will fall back to per-case search`);
  }
  return merged;
}

async function scrapeMontgomeryCourts(options = {}) {
  const csvPath = options.csvPath || CONFIG.csvPath;
  const testMode = options.testMode || false;
  const urlCache = options.urlCache || {};
  const enableHarvest = options.enableHarvest !== false;

  console.log('\n🏛️ Montgomery County Scraper (V3)');
  if (testMode) console.log('⚡ TEST MODE - Limited to ' + CONFIG.testModeLimit + ' cases');
  if (Object.keys(urlCache).length > 0) {
    console.log(`💾 URL cache: ${Object.keys(urlCache).length} known cases (will skip search hop for these)`);
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

  // Bulk URL harvest from search-results pages — populates the URL cache for cases we haven't scraped before
  if (enableHarvest && !testMode) {
    const uncached = allCases.filter(c => c.caseNumber && !urlCache[c.caseNumber]);
    if (uncached.length >= 50) {
      const harvestBrowser = await launchBrowser();
      try {
        const harvested = await harvestUrlCacheFromCSV(harvestBrowser, uncached);
        let added = 0;
        for (const [k, v] of harvested) {
          if (!urlCache[k]) { urlCache[k] = v; added++; }
        }
        console.log(`   ✅ Harvest added ${added} URLs to cache (now ${Object.keys(urlCache).length} cached)`);
      } catch (err) {
        console.log(`   ⚠️ Harvest error (falling back to per-case search): ${(err.message || '').slice(0, 80)}`);
      } finally {
        await harvestBrowser.close().catch(() => {});
      }
    }
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

  const sweetSpotMinDays = CONFIG.sweetSpotMinMonths * 30;
  const sweetSpotMaxDays = CONFIG.sweetSpotMaxMonths * 30;

  console.log(`   Sweet spot: ${CONFIG.sweetSpotMinMonths}-${CONFIG.sweetSpotMaxMonths} months old`);

  let targets = allCases
    .filter(c => c.status.toUpperCase().includes('OPEN'))
    .map(c => {
      const p = parseCommencedParts(c.commencedDate);
      c.daysOpen = p ? Math.ceil((now - new Date(p.year, p.month - 1, p.day)) / 86400000) : 0;
      c.monthsOpen = Math.round(c.daysOpen / 30);
      c.inSweetSpot = c.daysOpen >= sweetSpotMinDays && c.daysOpen <= sweetSpotMaxDays;
      return c;
    });

  const sweetSpotCount = targets.filter(c => c.inSweetSpot).length;
  const withDate = targets.filter(c => c.daysOpen > 0).length;
  console.log(`   ${targets.length} OPEN cases (${sweetSpotCount} in sweet spot 🎯, ${withDate} with parseable commenced date)`);

  targets.sort((a, b) => b.daysOpen - a.daysOpen);

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

  const concurrency = CONFIG.concurrency || 1;
  const restartEvery = CONFIG.batchSize;

  console.log(`\n🌐 Scraping ${targets.length} cases (concurrency: ${concurrency})...`);

  for (let chunkStart = 0; chunkStart < targets.length; chunkStart += restartEvery) {
    const chunkEnd = Math.min(chunkStart + restartEvery, targets.length);
    console.log(`   🔄 Browser restart (cases ${chunkStart + 1}-${chunkEnd})...`);
    const browser = await launchBrowser();

    let nextIndex = chunkStart;
    const workers = [];
    for (let w = 0; w < concurrency; w++) {
      workers.push((async () => {
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');

        // Block non-essential resources — case pages are plain HTML tables
        await page.setRequestInterception(true);
        page.on('request', (req) => {
          const type = req.resourceType();
          if (type === 'image' || type === 'stylesheet' || type === 'font' || type === 'media') {
            req.abort();
          } else {
            req.continue();
          }
        });

        while (true) {
          const i = nextIndex++;
          if (i >= chunkEnd) break;
          const c = targets[i];

    try {
      await delay(CONFIG.requestDelay);

      // Kick off the parcel API lookup in parallel with the Puppeteer page load.
      // The parcel number is already known from the CSV, so this lets the
      // ArcGIS round-trip overlap the (much slower) court page navigation.
      const parcelPromise = c.parcelNumber
        ? fetchParcelAddress(c.parcelNumber)
        : Promise.resolve(null);

      // Try cached URL first (skips search hop entirely on subsequent runs)
      let detailLoaded = false;
      const cachedUrl = urlCache[c.caseNumber];
      if (cachedUrl && cachedUrl.includes('/detail/Case/')) {
        try {
          await page.goto(cachedUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
          const url = page.url();
          if (url.includes('/detail/Case/')) detailLoaded = true;
        } catch (e) {
          // fall through to search
        }
      }

      if (!detailLoaded) {
        await page.goto(CONFIG.searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

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

        await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
      }

      if (CONFIG.pageLoadWait > 0) await delay(CONFIG.pageLoadWait);

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
          judgmentAmount: null,
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

          // Judgments table — has For / Against / Date / Amount columns
          const amountIdx = headers.findIndex(h => h === 'amount');
          const againstIdx = headers.findIndex(h => h === 'against');
          const forIdx = headers.findIndex(h => h === 'for');
          if (amountIdx >= 0 && againstIdx >= 0 && forIdx >= 0) {
            const rows = table.querySelectorAll('tr');
            let latestAmount = null;
            for (let ri = 1; ri < rows.length; ri++) {
              const cells = rows[ri].querySelectorAll('td');
              if (cells.length <= amountIdx) continue;
              const raw = (cells[amountIdx].textContent || '').trim();
              const m = raw.match(/[\d,]+\.\d{2}|[\d,]+/);
              if (!m) continue;
              const num = parseFloat(m[0].replace(/,/g, ''));
              if (!isNaN(num)) latestAmount = num;
            }
            if (latestAmount !== null) result.judgmentAmount = latestAmount;
            continue;
          }

          // Address table
          let addrIdx = -1;
          for (let hi = 0; hi < headers.length; hi++) {
            if (headers[hi] === 'address') { addrIdx = hi; break; }
          }
          if (addrIdx === -1) continue;

          // Skip the Plaintiffs section — its address is the bank/municipality, not the property.
          // Walk up from the table looking for a heading-like sibling labeled "Plaintiffs" or "Defendants".
          let section = 'unknown';
          let walker = table;
          for (let depth = 0; depth < 10 && walker; depth++) {
            let sib = walker.previousElementSibling;
            while (sib) {
              const sibText = (sib.textContent || '').trim();
              if (/^plaintiffs?\b/i.test(sibText)) { section = 'plaintiff'; break; }
              if (/^defendants?\b/i.test(sibText)) { section = 'defendant'; break; }
              sib = sib.previousElementSibling;
            }
            if (section !== 'unknown') break;
            walker = walker.parentElement;
          }
          if (section === 'plaintiff') continue;

          const rows = table.querySelectorAll('tr');
          for (let ri = 1; ri < rows.length; ri++) {
            const cells = rows[ri].querySelectorAll('td');
            if (cells.length <= addrIdx) continue;

            const addrCell = cells[addrIdx];
            const html = addrCell.innerHTML || '';

            // Convert <br> to newlines first, then strip remaining HTML.
            // This preserves line boundaries even with multi-line addresses (apt/unit on its own line).
            const plain = html
              .replace(/<br\s*\/?>/gi, '\n')
              .replace(/<[^>]*>/g, '')
              .replace(/\r/g, '');
            const lines = plain.split('\n').map(l => l.trim()).filter(Boolean);
            if (lines.length === 0) continue;

            // Find the line containing "PA <zip>" — that's the city/state/zip line.
            // Anything before it is street (apartment line included).
            let cityLineIdx = -1;
            let city = '';
            let zip = '';
            for (let li = lines.length - 1; li >= 0; li--) {
              const m = lines[li].match(/^(.*?),?\s*PA\s+(\d{5})(?:-\d{4})?\s*(?:UNITED STATES)?\s*$/i);
              if (m) {
                city = m[1].replace(/,/g, '').trim();
                zip = m[2];
                cityLineIdx = li;
                break;
              }
            }
            if (cityLineIdx === -1 || zip.length !== 5) continue;

            const street = lines.slice(0, cityLineIdx).join(' ').trim();

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

      // Prefer parcel-derived address (the property with the lien) over the
      // defendant's mailing address (which can be a different home entirely).
      // The lookup was kicked off in parallel with the page load above.
      const parcelAddr = await parcelPromise;

      if (parcelAddr && parcelAddr.street) {
        c.propertyAddress = parcelAddr.street;
        c.propertyCity = parcelAddr.city || '';
        c.propertyState = 'PA';
        c.propertyZip = parcelAddr.zip || '';
        c.inMontgomeryCounty = true;
        c.propertyOwner = parcelAddr.owner || '';
        c.propertyMunicipality = parcelAddr.municipality || '';
        c.addressSource = 'parcel';
      } else {
        const addresses = data.addresses || [];
        const bestAddr = addresses.find(a => a.inMontCo) || addresses[0] || null;
        c.propertyAddress = bestAddr?.street || '';
        c.propertyCity = bestAddr?.city || '';
        c.propertyState = bestAddr?.state || 'PA';
        c.propertyZip = bestAddr?.zip || '';
        c.inMontgomeryCounty = bestAddr?.inMontCo || false;
        c.propertyOwner = '';
        c.propertyMunicipality = '';
        c.addressSource = c.parcelNumber ? 'defendant-fallback' : 'defendant';
      }
      c.detailUrl = currentUrl;
      c.judgmentAmount = data.judgmentAmount != null ? data.judgmentAmount : null;

      c.docket = data.docket || {};

      // ✅ V3 SCORING HERE
      const ls = calculateScore(c);

      results.push({
        caseNumber: c.caseNumber,
        commencedDate: parseDate(c.commencedDate),
        caseType: c.caseType || '',
        caseTypeKind: classifyCaseType(c.caseType),
        parcelNumber: c.parcelNumber || '',
        judgmentAmount: c.judgmentAmount != null ? c.judgmentAmount : null,
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
        propertyOwner: c.propertyOwner || '',
        propertyMunicipality: c.propertyMunicipality || '',
        addressSource: c.addressSource || '',
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
      const srcTag = c.addressSource ? ` [src:${c.addressSource}]` : '';
      console.log(`   ${i + 1}/${targets.length} ${gradeEmoji} ${c.caseNumber} [${ls.grade}:${ls.score}] [P:${ls.pillars.pressure} R:${ls.pillars.resistance} M:${ls.pillars.momentum} F:${ls.pillars.fatigue}] - ${addrStr}${srcTag}`);

    } catch (err) {
      console.log(`   ${i + 1}/${targets.length} ~ ${c.caseNumber} (${(err.message || '').slice(0, 60)})`);
    }
        }

        await page.close().catch(() => {});
      })());
    }

    await Promise.all(workers);
    await browser.close().catch(() => {});
    await delay(500);
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

  results.sort((a, b) => b.leadScore - a.leadScore);

  const grades = { A: 0, B: 0, C: 0, D: 0, F: 0 };
  results.forEach(c => grades[c.leadGrade]++);

  const withAddr = results.filter(r => r.propertyAddress).length;
  const inMontCo = results.filter(r => r.inMontgomeryCounty).length;
  const fromParcel = results.filter(r => r.addressSource === 'parcel').length;
  const fromDefendant = results.filter(r => r.addressSource === 'defendant' || r.addressSource === 'defendant-fallback').length;

  console.log(`\n✅ Done: ${results.length} cases`);
  console.log(`   ${withAddr} with addresses (${inMontCo} in Montgomery County)`);
  console.log(`   Address source: ${fromParcel} from parcel API, ${fromDefendant} from defendant addr`);
  console.log(`   Grades: A=${grades.A} B=${grades.B} C=${grades.C} D=${grades.D} F=${grades.F}`);

  return results;
}

module.exports = { scrapeMontgomeryCourts, parseCSV, CONFIG, MONTCO_TOWNS };
