// Camden County Lis Pendens Enrichment
// Resolves block/lot numbers to street addresses via NJ MOD-IV ArcGIS REST API
// Also parses raw Camden County Clerk CSV into structured case data

const https = require('https');
const fs = require('fs').promises;

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ============================================================
// NJ Municipality Code Mapping (Camden County = 04xx)
// Source: https://www.nj.gov/treasury/taxation/pdf/lpt/cntycode.pdf
// ============================================================
const TOWN_TO_MUN_CODE = {
  'AUDUBON': '0401',
  'AUDUBON PARK': '0402',
  'BARRINGTON': '0403',
  'BELLMAWR': '0404',
  'BERLIN BOROUGH': '0405',
  'BERLIN BORO': '0405',
  'BERLIN TWP': '0406',
  'BROOKLAWN': '0407',
  'CAMDEN': '0408',
  'CAMDEN CITY': '0408',
  'CHERRY HILL': '0409',
  'CHESILHURST': '0410',
  'CLEMENTON': '0411',
  'COLLINGSWOOD': '0412',
  'GIBBSBORO': '0413',
  'GLOUCESTER CITY': '0414',
  'GLOUCESTER TWP': '0415',
  'HADDON TWP': '0416',
  'HADDONFIELD': '0417',
  'HADDON HEIGHTS': '0418',
  'HI NELLA': '0419',
  'LAUREL SPRINGS': '0420',
  'LAWNSIDE': '0421',
  'LINDENWOLD': '0422',
  'MAGNOLIA': '0423',
  'MERCHANTVILLE': '0424',
  'MOUNT EPHRAIM': '0425',
  'MT EPHRAIM': '0425',
  'OAKLYN': '0426',
  'PENNSAUKEN': '0427',
  'PINE HILL': '0428',
  'RUNNEMEDE': '0430',
  'SOMERDALE': '0431',
  'STRATFORD': '0432',
  'TAVISTOCK': '0433',
  'VOORHEES': '0434',
  'VOORHEES TWP': '0434',
  'WATERFORD': '0435',
  'WATERFORD TWP': '0435',
  'WINSLOW TWP': '0436',
  'WINSLOW': '0436',
  'WOODLYNNE': '0437',
};

const ARCGIS_URL = 'https://maps.nj.gov/arcgis/rest/services/Framework/Cadastral/MapServer/0/query';
const OUT_FIELDS = [
  'PCLBLOCK', 'PCLLOT', 'PCLQCODE', 'PCL_MUN', 'MUN_NAME', 'COUNTY',
  'PROP_LOC', 'PROP_CLASS', 'BLDG_DESC',
  'LAND_VAL', 'IMPRVT_VAL', 'NET_VALUE',
  'SALE_PRICE', 'DEED_DATE', 'DEED_BOOK', 'DEED_PAGE',
  'YR_CONSTR', 'ADD_LOTS1', 'CALC_ACRE'
].join(',');

// ============================================================
// Plaintiff classification
// ============================================================
const TAX_LIEN_KEYWORDS = [
  'FIG ', 'FIG-', 'PRO CAP', 'PROCAP', 'ACTLIEN', 'TLCF', 'MTAG',
  'US BANK CUST', 'CUST.*TLCF', 'TAX LIEN', 'LIEN HOLDER',
  'FUND.*LLC', 'CAPITAL.*LLC', 'CERTES', 'TOWER',
  'INVESTORS.*LLC', 'HOLDINGS.*LLC'
];

const GOVERNMENT_KEYWORDS = [
  'COUNTY OF', 'STATE OF', 'CITY OF', 'TOWNSHIP OF', 'BOROUGH OF',
  'MUNICIPAL', 'HOUSING AUTHORITY', 'REDEVELOPMENT'
];

function classifyPlaintiff(name) {
  if (!name) return 'UNKNOWN';
  const upper = name.toUpperCase();
  for (const kw of TAX_LIEN_KEYWORDS) {
    if (kw.includes('.*')) {
      if (new RegExp(kw, 'i').test(upper)) return 'TAX_LIEN';
    } else if (upper.includes(kw)) return 'TAX_LIEN';
  }
  for (const kw of GOVERNMENT_KEYWORDS) {
    if (upper.includes(kw)) return 'GOVERNMENT';
  }
  return 'MORTGAGE';
}

function classifyDefendant(name) {
  if (!name) return 'UNKNOWN';
  const upper = name.toUpperCase();
  const entityKeywords = ['LLC', 'INC', 'CORP', 'L.P.', 'TRUST', 'ESTATE OF', 'BANK', 'ASSOCIATION', 'AUTHORITY', 'COUNTY OF', 'STATE OF', 'CITY OF', 'TOWNSHIP', 'BOROUGH', 'UNITED STATES'];
  for (const kw of entityKeywords) {
    if (upper.includes(kw)) return 'ENTITY';
  }
  return 'INDIVIDUAL';
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function gradeFromScore(score) {
  if (score >= 80) return 'A';
  if (score >= 65) return 'B';
  if (score >= 50) return 'C';
  if (score >= 35) return 'D';
  return 'F';
}

function labelFromGrade(grade) {
  if (grade === 'A') return 'Very High';
  if (grade === 'B') return 'High';
  if (grade === 'C') return 'Moderate';
  if (grade === 'D') return 'Low';
  return 'Very Low';
}

function scoreCamdenCase(caseData) {
  const c = caseData || {};
  const status = (c.status || '').toUpperCase();
  const courtStatus = (c.courtStatus || '').toUpperCase();
  const caseType = (c.courtCaseType || '').toUpperCase();
  const disposition = (c.courtDisposition || '').toUpperCase();
  const actionList = Array.isArray(c.courtCaseActions) ? c.courtCaseActions : [];
  const actionText = (
    c.courtCaseActionsText ||
    actionList.map(a => (a && a.docketText) ? a.docketText : '').join(' | ')
  ).toUpperCase();
  const latestActionText = (c.courtLatestActionText || '').toUpperCase();
  const contextText = [status, courtStatus, caseType, disposition, actionText, latestActionText].join(' | ');
  const factors = [];
  const has = (s) => contextText.includes(s);
  const hasAny = (arr) => arr.some(has);
  const hasAll = (arr) => arr.every(has);

  const defaultSignals = hasAny(['DEFAULT', 'DEFAULTED', 'REQUEST FOR DEFAULT']);
  const settlementSignals = hasAny(['STIPULATION OF SETTLEMENT', 'STIPULATION OF DISMISSAL', 'SETTLEMENT']);
  const bankruptcySignals = hasAny(['BANKRUPTCY', 'AUTOMATIC STAY', 'CHAPTER 7', 'CHAPTER 13']);
  const saleStaySignals = hasAny(['MOTION TO STAY OF SHERIFF SALE', 'STAY OF SHERIFF SALE', 'POSTPONEMENT LETTER', 'SHERIFF SALE']);
  const contestedWithCounterclaim = hasAny(['CONTESTED ANSWER W/ COUNTERCLAIM', 'CONTESTED ANSWER WITH COUNTERCLAIM']);
  const contestedAnswerOnly = hasAny(['CONTESTED ANSWER']) && !contestedWithCounterclaim;
  const trialSignals = hasAny(['TRIAL SCHEDULED', 'TRIAL DATE', 'TRIAL']);

  // A) Stage & Time Pressure (0-35): highest that applies
  const hasWritReturn = hasAny(['WRIT RETURN']);
  const hasWritIssued = hasAny(['WRIT OF EXECUTION', 'FORECLOSURE WRIT NOTICE', 'ALIAS WRIT']);
  const hasFinalJudgment = hasAny(['UNCONTESTED ORDER FOR FINAL JUDGMENT', 'ORDER FOR FINAL JUDGMENT', 'FINAL JUDGMENT']);
  const hasMfjFiled = hasAny(['MOTION FOR FINAL JUDGMENT']);
  let stageA = 2;
  if (saleStaySignals) stageA = 35;
  else if (hasWritReturn) stageA = 30;
  else if (hasWritIssued) stageA = 25;
  else if (hasFinalJudgment) stageA = 20;
  else if (hasMfjFiled) stageA = 12;
  else if (defaultSignals) stageA = 6;
  stageA = clamp(stageA, 0, 35);
  factors.push({ text: 'A Stage & Time Pressure', impact: stageA });

  // B) Distress Signals (0-25): additive, capped
  let distressB = 0;
  if (defaultSignals) distressB += 8;
  if (hasAny(['ADDITIONAL SUMS'])) distressB += 6;
  if (hasAny(['ALIAS WRIT'])) distressB += 6;
  if (hasAny(['FORECLOSURE JUDGMENT NOTICE', 'FORECLOSURE WRIT NOTICE'])) distressB += 5;
  if (hasAny(['CERTIFICATION REGARDING 14-DAY NOTICE', '14-DAY NOTICE'])) distressB += 4;
  distressB = clamp(distressB, 0, 25);
  factors.push({ text: 'B Distress Signals', impact: distressB });

  // C) Resistance / Defense (-30..0): subtractive section
  let resistanceC = 0;
  if (contestedWithCounterclaim) resistanceC -= 25;
  else if (contestedAnswerOnly) resistanceC -= 18;
  if (trialSignals) resistanceC -= 12;
  if (hasAny(['NOTICE OF APPEARANCE'])) resistanceC -= 10;
  if (saleStaySignals) resistanceC -= 10;
  if (hasAny(['OBJECTION', 'REPLY BRIEF', 'OPPOSITION'])) resistanceC -= 6;
  resistanceC = clamp(resistanceC, -30, 0);
  factors.push({ text: 'C Resistance / Defense', impact: resistanceC });

  // D) Title/Probate/Friction (-25..0): subtractive section
  let frictionD = 0;
  const heirsOrGal = hasAny(['GUARDIAN AD LITEM', 'HEIRS', 'DEVISEES', 'DECEASED', 'ESTATE', 'PERSONAL REPRESENTATIVE']);
  const substitutionOrLimitedRep = hasAny(['SUBSTITUTION OF ATTORNEY', 'LIMITED REPRESENTATION', 'DEFICIENCY NOTICE']);
  const diligentInquiry = hasAny(['CERTIFICATION OF DILIGENT INQUIRY', 'DILIGENT INQUIRY']);
  const reformOrCorrection = hasAny(['MOTION TO REFORM MORTGAGE', 'REFORM MORTGAGE', 'CORRECTING DEFENDANT NAME']);
  if (bankruptcySignals) frictionD -= 25;
  else if (heirsOrGal) frictionD -= 15;
  if (substitutionOrLimitedRep) frictionD -= 10;
  if (diligentInquiry) frictionD -= 6;
  if (reformOrCorrection) frictionD -= 5;
  frictionD = clamp(frictionD, -25, 0);
  factors.push({ text: 'D Title/Probate/Friction', impact: frictionD });

  // E) Exit / Resolution Signals (0-20): additive, capped
  let exitE = 0;
  const redemptionOrder = hasAny(['MOTION FIXING AMOUNT', 'ORDER FIXING AMOUNT', 'REDEMPTION']);
  const softWindow = hasAny(['POSTPONEMENT LETTER', 'SALE POSTPONEMENT', 'LIMITED REPRESENTATION']);
  if (settlementSignals) exitE += 20;
  if (softWindow) exitE += 10;
  if (hasAny(['MOTION WITHDRAWN', 'WITHDRAWN'])) exitE += 6;
  if (redemptionOrder) exitE = Math.max(exitE, 20);
  exitE = clamp(exitE, 0, 20);
  factors.push({ text: 'E Exit / Resolution', impact: exitE });

  // Small confidence guardrail
  let confidenceAdj = 0;
  if (actionList.length > 0) confidenceAdj += 2;
  if (c.courtDocketNumber) confidenceAdj += 1;
  if (courtStatus === 'NOT_FOUND' || courtStatus === 'ERROR') confidenceAdj -= 3;
  confidenceAdj = clamp(confidenceAdj, -5, 5);
  if (confidenceAdj !== 0) factors.push({ text: 'Confidence adjustment', impact: confidenceAdj });

  const rawScore = stageA + distressB + resistanceC + frictionD + exitE + confidenceAdj;
  const score = clamp(Math.round(rawScore), 0, 100);
  const grade = gradeFromScore(score);
  const summary = [
    `A:${stageA}`,
    `B:${distressB}`,
    `C:${resistanceC}`,
    `D:${frictionD}`,
    `E:${exitE}`,
    `Conf:${confidenceAdj}`
  ].join(' ');

  return {
    ...c,
    sellerScore: score,
    sellerGrade: grade,
    sellerLikelihood: labelFromGrade(grade),
    sellerFactors: factors,
    sellerScoreSummary: summary,
    scoreComponents: {
      stageA,
      distressB,
      resistanceC,
      frictionD,
      exitE,
      confidenceAdj
    }
  };
}

// ============================================================
// CSV Parsing - Camden County Clerk format
// ============================================================
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

function parseCamdenCSV(csvText) {
  const lines = csvText.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) throw new Error('CSV appears empty');

  const header = parseCSVLine(lines[0]).map(h => h.toLowerCase().replace(/\s+/g, ''));
  
  console.log('CSV headers found:', header.join(', '));

  // Find column indices - Camden County Clerk CSV format
  // Actual headers: (blank), Party Code, Name, Cross Name, Date, Type, Book Type, Book, Page, Town, Lot, Block, Instr#, Status, Flag
  const col = {
    partyCode: header.findIndex(h => h.includes('partycode') || h === 'partycode'),
    name: header.findIndex(h => h === 'name'),
    crossName: header.findIndex(h => h.includes('crossname') || h === 'crossname'),
    date: header.findIndex(h => h === 'date'),
    type: header.findIndex(h => h === 'type'),
    bookType: header.findIndex(h => h.includes('booktype') || h === 'booktype'),
    book: header.findIndex(h => h === 'book'),
    page: header.findIndex(h => h === 'page'),
    town: header.findIndex(h => h === 'town'),
    lot: header.findIndex(h => h === 'lot'),
    block: header.findIndex(h => h === 'block'),
    instrNum: header.findIndex(h => h.includes('instr')),
    status: header.findIndex(h => h === 'status'),
    flag: header.findIndex(h => h === 'flag'),
    courtStatus: header.findIndex(h => h.includes('courtcasestatus')),
    courtDocket: header.findIndex(h => h.includes('docketnumber') || h.includes('docket')),
  };
  
  console.log('Column mapping:', JSON.stringify(col));

  // Group rows by instrument number
  const caseMap = new Map();
  const statusPriority = (s) => {
    const u = (s || '').toUpperCase().trim();
    if (u === 'OPEN' || u === 'CLOSED') return 3;
    if (u === 'RECHECK') return 2;
    if (u) return 1;
    return 0;
  };

  for (let i = 1; i < lines.length; i++) {
    const v = parseCSVLine(lines[i]);
    const instrNum = col.instrNum >= 0 ? v[col.instrNum] : '';
    if (!instrNum) continue;

    if (!caseMap.has(instrNum)) {
      caseMap.set(instrNum, {
        instrumentNumber: instrNum,
        book: col.book >= 0 ? v[col.book] : '',
        page: col.page >= 0 ? v[col.page] : '',
        filingDate: col.date >= 0 ? v[col.date] : '',
        town: col.town >= 0 ? (v[col.town] || '').toUpperCase().trim() : '',
        block: col.block >= 0 ? (v[col.block] || '').trim() : '',
        lot: col.lot >= 0 ? (v[col.lot] || '').trim() : '',
        status: col.status >= 0 ? v[col.status] : '',
        docType: col.type >= 0 ? v[col.type] : '',
        courtStatus: col.courtStatus >= 0 ? (v[col.courtStatus] || '').trim() : '',
        courtDocket: col.courtDocket >= 0 ? (v[col.courtDocket] || '').trim() : '',
        plaintiffNames: [],
        defendantNames: [],
      });
    }

    const entry = caseMap.get(instrNum);
    const rowCourtStatus = col.courtStatus >= 0 ? (v[col.courtStatus] || '').trim() : '';
    const rowCourtDocket = col.courtDocket >= 0 ? (v[col.courtDocket] || '').trim() : '';

    // CSV contains one row per party; preserve best non-empty manual override across all rows for the same case.
    if (statusPriority(rowCourtStatus) > statusPriority(entry.courtStatus)) {
      entry.courtStatus = rowCourtStatus;
    }
    if (rowCourtDocket && !entry.courtDocket) {
      entry.courtDocket = rowCourtDocket;
    }

    const partyCode = col.partyCode >= 0 ? (v[col.partyCode] || '').toUpperCase().trim() : '';
    // The "Name" column has the full name for this party row
    const fullName = col.name >= 0 ? (v[col.name] || '').trim() : '';

    if (!fullName) continue;

    if (partyCode === 'D') {
      if (!entry.plaintiffNames.includes(fullName)) entry.plaintiffNames.push(fullName);
    } else if (partyCode === 'R') {
      if (!entry.defendantNames.includes(fullName)) entry.defendantNames.push(fullName);
    }
  }

  // Build structured cases
  const now = new Date();
  const cases = [];

  for (const [instrNum, raw] of caseMap) {
    // Separate individual defendants from entity co-defendants
    const personDefendants = [];
    const entityCoDefendants = [];
    for (const name of raw.defendantNames) {
      if (classifyDefendant(name) === 'ENTITY') entityCoDefendants.push(name);
      else personDefendants.push(name);
    }

    // Calculate days since filing
    let daysSinceFiling = 0;
    let filingDateISO = '';
    if (raw.filingDate) {
      const m = raw.filingDate.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
      if (m) {
        const filed = new Date(parseInt(m[3]), parseInt(m[1]) - 1, parseInt(m[2]));
        daysSinceFiling = Math.ceil((now - filed) / 86400000);
        filingDateISO = `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
      }
    }

    const primaryPlaintiff = raw.plaintiffNames[0] || '';
    const primaryDefendant = personDefendants[0] || raw.defendantNames[0] || '';

    cases.push({
      instrumentNumber: instrNum,
      filingDate: raw.filingDate,
      filingDateISO,
      daysSinceFiling,
      town: raw.town,
      block: raw.block,
      lot: raw.lot,
      book: raw.book,
      page: raw.page,
      status: raw.status,
      plaintiffs: raw.plaintiffNames,
      primaryPlaintiff,
      plaintiffType: classifyPlaintiff(primaryPlaintiff),
      defendants: personDefendants,
      primaryDefendant,
      defendantType: classifyDefendant(primaryDefendant),
      entityCoDefendants,
      allDefendants: raw.defendantNames,
      county: 'Camden',
      state: 'NJ',
      courtStatus: raw.courtStatus || '',
      courtDocketNumber: raw.courtDocket || '',
      // Enrichment fields (filled later)
      propertyAddress: '',
      assessedValue: null,
      landValue: null,
      improvementValue: null,
      buildingDesc: '',
      yearConstructed: null,
      lastSalePrice: null,
      propertyClass: '',
      ownerOfRecord: '',
    });
  }

  const scoredCases = cases.map(scoreCamdenCase);

  // Sort by town then date
  scoredCases.sort((a, b) => {
    const townCmp = a.town.localeCompare(b.town);
    if (townCmp !== 0) return townCmp;
    return (a.daysSinceFiling || 0) - (b.daysSinceFiling || 0);
  });

  // Build summary
  const byPlaintiffType = {};
  const byDefendantType = {};
  const byTown = {};
  for (const c of scoredCases) {
    byPlaintiffType[c.plaintiffType] = (byPlaintiffType[c.plaintiffType] || 0) + 1;
    byDefendantType[c.defendantType] = (byDefendantType[c.defendantType] || 0) + 1;
    byTown[c.town] = (byTown[c.town] || 0) + 1;
  }

  return {
    source: 'Camden County Clerk - Lis Pendens Filed',
    processedAt: new Date().toISOString(),
    totalCases: scoredCases.length,
    totalRows: lines.length - 1,
    summary: { byPlaintiffType, byDefendantType, byTown },
    cases: scoredCases
  };
}

// ============================================================
// ArcGIS REST API Query
// ============================================================
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PropertyResearch/1.0)' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          // ArcGIS returns { error: { ... } } on bad queries
          if (parsed.error) {
            console.log(`     API error: ${parsed.error.message || JSON.stringify(parsed.error)}`);
            resolve({ features: [] });
            return;
          }
          resolve(parsed);
        }
        catch (e) {
          console.log(`     JSON parse error. Response starts with: ${data.substring(0, 200)}`);
          resolve({ features: [] });
        }
      });
    }).on('error', (err) => {
      console.log(`     HTTP error: ${err.message}`);
      resolve({ features: [] });
    });
  });
}

function buildQueryUrl(where) {
  const params = new URLSearchParams({
    where,
    outFields: OUT_FIELDS,
    returnGeometry: 'false',
    f: 'json'
  });
  return `${ARCGIS_URL}?${params.toString()}`;
}

async function queryParcel(munCode, block, lot) {
  // Try exact match first
  const where1 = `PCL_MUN='${munCode}' AND PCLBLOCK='${block}' AND PCLLOT='${lot}'`;
  let data = await httpsGet(buildQueryUrl(where1));
  let features = (data && data.features) || [];

  // Fallback: strip leading zeros
  if (!features.length) {
    const blockStripped = block.replace(/^0+/, '') || '0';
    const lotStripped = lot.replace(/^0+/, '') || '0';
    if (blockStripped !== block || lotStripped !== lot) {
      const where2 = `PCL_MUN='${munCode}' AND PCLBLOCK='${blockStripped}' AND PCLLOT='${lotStripped}'`;
      await delay(300);
      data = await httpsGet(buildQueryUrl(where2));
      features = (data && data.features) || [];
    }
  }

  // Fallback: LIKE query for decimal qualifiers
  if (!features.length && !block.includes('.')) {
    const where3 = `PCL_MUN='${munCode}' AND PCLBLOCK LIKE '${block}%' AND PCLLOT='${lot}'`;
    await delay(300);
    data = await httpsGet(buildQueryUrl(where3));
    features = (data && data.features) || [];
  }

  if (!features.length) return null;

  const attrs = features[0].attributes || {};
  return {
    propertyAddress: (attrs.PROP_LOC || '').trim(),
    municipality: (attrs.MUN_NAME || '').trim(),
    propertyClass: attrs.PROP_CLASS || '',
    buildingDesc: (attrs.BLDG_DESC || '').trim(),
    landValue: attrs.LAND_VAL,
    improvementValue: attrs.IMPRVT_VAL,
    netValue: attrs.NET_VALUE,
    salePrice: attrs.SALE_PRICE,
    saleDate: attrs.DEED_DATE,
    yearConstructed: attrs.YR_CONSTR,
    acreage: attrs.CALC_ACRE,
    matchedBlock: attrs.PCLBLOCK,
    matchedLot: attrs.PCLLOT,
    matchCount: features.length,
  };
}

// ============================================================
// Main enrichment pipeline
// ============================================================
async function enrichCamdenCases(data, options = {}) {
  const { testMode = false, testLimit = 10 } = options;
  let cases = data.cases || [];

  if (testMode) {
    cases = cases.slice(0, testLimit);
    console.log(`⚡ TEST MODE: Processing ${testLimit} of ${data.cases.length} cases`);
  }

  const total = cases.length;
  let found = 0, notFound = 0, skipped = 0, errors = 0;

  console.log(`\n🏠 Camden County Address Enrichment`);
  console.log(`${'='.repeat(50)}`);
  console.log(`Cases: ${total}`);
  console.log(`API: NJ MOD-IV ArcGIS REST\n`);

  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    const prefix = `  ${i + 1}/${total}`;

    if (c.propertyAddress) {
      // Backfill lastSaleDate if missing
      if (!c.lastSaleDate && c.town && c.block && c.lot) {
        const munCode = TOWN_TO_MUN_CODE[(c.town || '').toUpperCase().trim()];
        if (munCode) {
          await delay(400);
          try {
            const result = await queryParcel(munCode, c.block, c.lot);
            if (result && result.saleDate) {
              c.lastSaleDate = result.saleDate;
              console.log(`${prefix} 📅 Backfilled sale date for ${c.instrumentNumber}`);
            }
          } catch (e) {}
        }
      }
      skipped++;
      continue;
    }

    const town = (c.town || '').toUpperCase().trim();
    const block = (c.block || '').trim();
    const lot = (c.lot || '').trim();
    const munCode = TOWN_TO_MUN_CODE[town];

    if (!munCode) {
      console.log(`${prefix} ⚠ ${c.instrumentNumber} - Unknown town: '${town}'`);
      c.enrichmentError = `Unknown town: ${town}`;
      errors++;
      continue;
    }

    if (!block || !lot) {
      console.log(`${prefix} ⚠ ${c.instrumentNumber} - Missing block/lot`);
      c.enrichmentError = 'Missing block or lot';
      errors++;
      continue;
    }

    await delay(400);

    try {
      const result = await queryParcel(munCode, block, lot);

      if (result && result.propertyAddress) {
        c.propertyAddress = result.propertyAddress;
        c.assessedValue = result.netValue;
        c.landValue = result.landValue;
        c.improvementValue = result.improvementValue;
        c.buildingDesc = result.buildingDesc;
        c.yearConstructed = result.yearConstructed;
        c.lastSalePrice = result.salePrice;
        c.lastSaleDate = result.saleDate;
        c.propertyClass = result.propertyClass;
        c.enrichmentSource = 'NJ MOD-IV via ArcGIS REST';
        c.enrichedAt = new Date().toISOString();

        const val = result.netValue ? `$${result.netValue.toLocaleString()}` : 'N/A';
        console.log(`${prefix} ✅ ${c.instrumentNumber} B:${block} L:${lot} → ${result.propertyAddress} (${val})`);
        found++;
      } else {
        c.enrichmentError = 'No parcel match found';
        console.log(`${prefix} ❌ ${c.instrumentNumber} B:${block} L:${lot} in ${town} → Not found`);
        notFound++;
      }
    } catch (err) {
      c.enrichmentError = err.message;
      console.log(`${prefix} ⚠ ${c.instrumentNumber} - Error: ${err.message}`);
      errors++;
    }
  }

  // Update data object
  if (testMode) {
    // In test mode, only update the cases we processed
    for (let i = 0; i < cases.length; i++) {
      data.cases[i] = scoreCamdenCase(cases[i]);
    }
  }

  if (!testMode) {
    data.cases = (data.cases || []).map(scoreCamdenCase);
  }

  data.enrichmentSummary = {
    enrichedAt: new Date().toISOString(),
    source: 'NJ MOD-IV via ArcGIS REST API',
    totalCases: total,
    addressesFound: found,
    notFound,
    skipped,
    errors,
    hitRate: (total - skipped) > 0 ? `${(found / (total - skipped) * 100).toFixed(1)}%` : 'N/A',
  };

  console.log(`\n${'='.repeat(50)}`);
  console.log(`📊 ENRICHMENT SUMMARY`);
  console.log(`  Addresses found: ${found} ✅`);
  console.log(`  Not found: ${notFound} ❌`);
  console.log(`  Skipped: ${skipped} | Errors: ${errors}`);
  if ((total - skipped) > 0) {
    console.log(`  Hit rate: ${found}/${total - skipped} = ${(found / (total - skipped) * 100).toFixed(1)}%`);
  }

  return data;
}

module.exports = {
  parseCamdenCSV,
  enrichCamdenCases,
  scoreCamdenCase,
  classifyPlaintiff,
  classifyDefendant,
  TOWN_TO_MUN_CODE
};
