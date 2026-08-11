// Camden County Lis Pendens Enrichment
// Resolves block/lot numbers to street addresses via NJ MOD-IV ArcGIS REST API
// Also parses raw Camden County Clerk CSV into structured case data

const https = require('https');
const fs = require('fs').promises;
const { shouldSkipCourtSearchName } = require('./search-skip-rules');

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
  'YR_CONSTR', 'ADD_LOTS1', 'CALC_ACRE', 'DWELL'
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

function classifyCourtCaseType(caseType) {
  const upper = String(caseType || '').toUpperCase().trim();
  if (!upper) return '';
  if (upper.includes('TAX FORECLOSURE')) return 'TAX_LIEN';
  if (upper.includes('RESIDENTIAL MORTGAGE FORECLOSURE')) return 'MORTGAGE';
  if (upper.includes('COMMERCIAL MORTGAGE FORECLOSURE')) return 'MORTGAGE';
  return '';
}

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

function resolveCaseCategory(caseData) {
  const byCaseType = classifyCourtCaseType(caseData && caseData.courtCaseType);
  if (byCaseType) return byCaseType;
  return classifyPlaintiff(caseData && caseData.primaryPlaintiff);
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

function uniqueNames(names) {
  return Array.from(new Set((names || []).map(name => (name || '').trim()).filter(Boolean)));
}

function normalizeTownName(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/\./g, ' ')
    .replace(/\bMT\b/g, 'MT')
    .trim()
    .replace(/\s+/g, ' ');
}

// ============================================================
// Locality / mailing-address aliases
// ------------------------------------------------------------
// The County Clerk "Town" column is not always the legal municipality - it is
// often the USPS place name on the deed (SICKLERVILLE, ATCO, WEST BERLIN...),
// and neighbouring towns get mislabelled outright. Each alias maps to an
// ORDERED list of municipality codes used to rank parcel matches.
// ============================================================
const LOCALITY_TO_MUN_CODES = {
  // Gloucester Twp mailing names
  'GLENDORA': ['0415'],
  'BLACKWOOD': ['0415'],
  'ERIAL': ['0415', '0436'],
  'GRENLOCH': ['0415'],
  'ALBION': ['0415'],
  // Winslow Twp mailing names
  'SICKLERVILLE': ['0436', '0415'],
  'CEDAR BROOK': ['0436'],
  'BLUE ANCHOR': ['0436', '0435'],
  'BRADDOCK': ['0436'],
  // Waterford Twp mailing names
  'ATCO': ['0435', '0436'],
  'WATERFORD WORKS': ['0435', '0436'],
  'TANSBORO': ['0435', '0406'],
  // Haddon Twp mailing name
  'WESTMONT': ['0416'],
  // Bare names shared by a boro and the township that surrounds it
  'BERLIN': ['0405', '0406', '0436', '0435'],
  'WEST BERLIN': ['0406', '0405', '0436'],
  'CLEMENTON': ['0411', '0415', '0428', '0422'],
  'LAUREL SPRINGS': ['0420', '0415', '0422', '0431'],
  'GLOUCESTER': ['0414', '0415'],
  'HADDONFIELD': ['0417', '0416', '0403', '0409'],
  'HADDON TWP': ['0416', '0417'],
  'HI-NELLA': ['0419'],
  // Pine Valley (0429) merged into Pine Hill in 2022; parcels still carry 0429
  'PINE VALLEY': ['0429', '0428'],
  'PINE HILL': ['0428', '0429'],
};

// Scope county-wide lookups by municipality-code prefix, NOT by COUNTY.
// MOD-IV leaves COUNTY null on incomplete records - the same ones that have a
// null PROP_LOC - so COUNTY='CAMDEN' silently drops them and lets a
// neighbouring town's parcel win instead. Camden County is 04xx.
const CAMDEN_MUN_FILTER = "PCL_MUN LIKE '04%'";

// Ordered spellings to look up for a raw town string, most specific first, so
// "BERLIN TWP" resolves to 0406 before the bare-"BERLIN" fallbacks apply.
function townNameVariants(raw) {
  const base = normalizeTownName(raw).replace(/[^A-Z0-9\- ]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!base) return [];

  const expanded = base
    .replace(/\bTOWNSHIP\b/g, 'TWP')
    .replace(/\bBOROUGH\b/g, 'BORO')
    .replace(/\bMOUNT\b/g, 'MT');
  // NB: "COUNTY" is deliberately not stripped - a "CAMDEN COUNTY" label is a
  // county-wide placeholder, not the City of Camden.
  const stripped = expanded.replace(/\b(TWP|BORO|CITY|TOWN)\b/g, '');

  const variants = [];
  for (const v of [base, expanded, expanded.replace(/-/g, ' '), stripped, stripped.replace(/-/g, ' ')]) {
    const clean = v.replace(/\s+/g, ' ').trim();
    if (clean && !variants.includes(clean)) variants.push(clean);
  }
  return variants;
}

// Ordered, de-duplicated candidate municipality codes for a town label.
// Empty means "no idea" - the caller falls back to a county-wide match.
function resolveMunCodes(rawTown) {
  const codes = [];
  const push = (code) => { if (code && !codes.includes(code)) codes.push(code); };

  for (const variant of townNameVariants(rawTown)) {
    push(TOWN_TO_MUN_CODE[variant]);
    for (const code of LOCALITY_TO_MUN_CODES[variant] || []) push(code);
  }
  return codes;
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

function buildUrgencySignal(signals) {
  const reasons = [];
  let level = 'NONE';
  const caseCategory = String(signals.caseCategory || '').toUpperCase();
  if (signals.isClosedCase) {
    return {
      level: 'NONE',
      reasons: [],
      buyerWarning: ''
    };
  }
  const hasLateTaxLienSignal = !!(signals.hasFinalJudgment);

  if (caseCategory === 'TAX_LIEN' && hasLateTaxLienSignal) {
    level = 'NONE';
  } else if (caseCategory === 'TAX_LIEN' && signals.hasRedemptionOrder) {
    level = 'MEDIUM';
    reasons.push('Redemption amount set -- owner has a deadline to pay or lose the property');
  } else if (caseCategory === 'TAX_LIEN' && signals.defaultSignals) {
    level = 'MEDIUM';
    reasons.push('Default stage -- owner disengaged, no hard deadline yet');
  } else if (caseCategory === 'TAX_LIEN') {
    level = 'NONE';
  } else if (signals.hasWritReturn) {
    level = 'NONE';
    // Writ Return = sale has already run or been attempted -- no longer actionable
  } else if (signals.hasWritIssued) {
    level = 'HIGH';
    reasons.push('Writ issued');
  } else if (signals.saleStaySignals) {
    level = 'HIGH';
    reasons.push('Sheriff sale activity or postponement');
  } else if (caseCategory !== 'TAX_LIEN' && signals.hasFinalJudgment) {
    level = 'MEDIUM';
    reasons.push('Final judgment entered');
  } else if (caseCategory !== 'TAX_LIEN' && signals.hasMfjFiled) {
    level = 'MEDIUM';
    reasons.push('Motion for final judgment filed');
  }

  return {
    level,
    reasons,
    buyerWarning: level === 'NONE'
      ? ''
      : level === 'HIGH'
        ? 'High urgency: compressed buyer timeline'
        : 'Moderate urgency: watch buyer timeline'
  };
}

function scoreCamdenCase(caseData) {
  const c = caseData || {};
  const resolvedPlaintiffType = resolveCaseCategory(c);
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
  const isClosedCase = courtStatus === 'CLOSED' || courtStatus === 'STAY';

  const defaultSignals = hasAny(['DEFAULT', 'DEFAULTED', 'REQUEST FOR DEFAULT']);
  const settlementSignals = hasAny(['STIPULATION OF SETTLEMENT', 'STIPULATION OF DISMISSAL', 'SETTLEMENT']);
  const bankruptcySignals = hasAny(['BANKRUPTCY', 'AUTOMATIC STAY', 'CHAPTER 7', 'CHAPTER 13']);
  const saleStaySignals = hasAny(['MOTION TO STAY OF SHERIFF SALE', 'STAY OF SHERIFF SALE', 'POSTPONEMENT LETTER', 'SHERIFF SALE']);
  const contestedWithCounterclaim = hasAny(['CONTESTED ANSWER W/ COUNTERCLAIM', 'CONTESTED ANSWER WITH COUNTERCLAIM']);
  const contestedAnswerOnly = hasAny(['CONTESTED ANSWER']) && !contestedWithCounterclaim;
  const trialSignals = hasAny(['TRIAL SCHEDULED', 'TRIAL DATE', 'TRIAL']);

  // A) Stage & Time Pressure (0-35): highest that applies
  // Note: saleStaySignals no longer tops the chart — a stay means the sale was postponed,
  // not imminent, and the owner is actively fighting (already penalized in section C).
  const hasWritReturn = hasAny(['WRIT RETURN']);
  const hasWritIssued = hasAny(['WRIT OF EXECUTION', 'FORECLOSURE WRIT NOTICE', 'ALIAS WRIT']);
  const hasFinalJudgment = hasAny(['UNCONTESTED ORDER FOR FINAL JUDGMENT', 'ORDER FOR FINAL JUDGMENT', 'FINAL JUDGMENT']);
  const hasMfjFiled = hasAny(['MOTION FOR FINAL JUDGMENT']);
  const redemptionOrder = hasAny(['MOTION FIXING AMOUNT', 'ORDER FIXING AMOUNT', 'REDEMPTION']);
  const urgencySignal = buildUrgencySignal({
    caseCategory: resolvedPlaintiffType,
    isClosedCase,
    defaultSignals,
    hasWritReturn,
    hasWritIssued,
    hasFinalJudgment,
    hasMfjFiled,
    hasRedemptionOrder: redemptionOrder,
    saleStaySignals
  });
  let stageA = 2;
  if (hasWritReturn && resolvedPlaintiffType !== 'TAX_LIEN') stageA = 0;
  else if (hasWritReturn) stageA = 35;
  else if (hasWritIssued || saleStaySignals) stageA = 25;
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
  const softWindow = hasAny(['POSTPONEMENT LETTER', 'SALE POSTPONEMENT', 'LIMITED REPRESENTATION']);
  if (settlementSignals) exitE += 20;
  if (softWindow) exitE += 10;
  if (hasAny(['MOTION WITHDRAWN', 'WITHDRAWN'])) exitE += 6;
  if (redemptionOrder) exitE = Math.max(exitE, 20);
  exitE = clamp(exitE, 0, 20);
  factors.push({ text: 'E Exit / Resolution', impact: exitE });

  // F) Time in Foreclosure (-5..+8): sweet spot is 12-30 months
  // Too fresh = owner still has hope/options; too old = situation is complex
  let timeF = 0;
  const daysOpen = c.daysSinceFiling || 0;
  if (daysOpen >= 365 && daysOpen < 900) timeF = 8;        // 1–2.5 years: sweet spot
  else if (daysOpen >= 900 && daysOpen < 1460) timeF = 4;  // 2.5–4 years: still solid
  else if (daysOpen > 0 && daysOpen < 180) timeF = -5;     // under 6 months: too fresh
  else if (daysOpen >= 1460) timeF = -3;                   // 4+ years: likely complicated
  // 6–12 months: neutral (0)
  timeF = clamp(timeF, -5, 8);
  if (timeF !== 0) factors.push({ text: 'F Time in Foreclosure', impact: timeF });

  // G) Plaintiff Type: early-stage tax liens are motivated sellers (small amounts owed, less sophisticated).
  // Late-stage tax liens are no-go — lien holder has effectively taken the property and wants a profit.
  let plaintiffG = 0;
  const pType = resolvedPlaintiffType.toUpperCase();
  if (pType === 'TAX_LIEN') {
    const isLateStageTaxLien = hasFinalJudgment || hasWritIssued || hasWritReturn;
    plaintiffG = isLateStageTaxLien ? -15 : 6;
  }
  if (plaintiffG !== 0) factors.push({ text: 'G Plaintiff Type (Tax Lien)', impact: plaintiffG });

  // H) Terminal Outcome (-40..0): mortgage cases with writ return are usually over.
  let terminalH = 0;
  if (hasWritReturn && pType !== 'TAX_LIEN') terminalH = -40;
  if (terminalH !== 0) factors.push({ text: 'H Terminal Outcome', impact: terminalH });

  // Small confidence guardrail
  let confidenceAdj = 0;
  if (actionList.length > 0) confidenceAdj += 2;
  if (c.courtDocketNumber) confidenceAdj += 1;
  if (courtStatus === 'NOT_FOUND' || courtStatus === 'ERROR') confidenceAdj -= 3;
  confidenceAdj = clamp(confidenceAdj, -5, 5);
  if (confidenceAdj !== 0) factors.push({ text: 'Confidence adjustment', impact: confidenceAdj });

  const rawScore = stageA + distressB + resistanceC + frictionD + exitE + timeF + plaintiffG + terminalH + confidenceAdj;
  const score = clamp(Math.round(rawScore), 0, 100);
  const grade = gradeFromScore(score);
  const summary = [
    `A:${stageA}`,
    `B:${distressB}`,
    `C:${resistanceC}`,
    `D:${frictionD}`,
    `E:${exitE}`,
    `F:${timeF}`,
    `G:${plaintiffG}`,
    `H:${terminalH}`,
    `Conf:${confidenceAdj}`
  ].join(' ');

  // Writ countdown: find the earliest writ issuance date from court actions
  const WRIT_ISSUED_SIGNALS = ['WRIT OF EXECUTION', 'FORECLOSURE WRIT NOTICE', 'ALIAS WRIT'];
  let writIssuedDate = null;
  let daysUntilSale = null;
  let daysUntilSaleEst = null;
  if (hasWritIssued && !hasWritReturn && actionList.length > 0) {
    const writAction = actionList.find(a =>
      a && a.docketText && WRIT_ISSUED_SIGNALS.some(s => a.docketText.toUpperCase().includes(s))
    );
    if (writAction && writAction.filedDate) {
      try {
        const parsed = new Date(writAction.filedDate);
        if (!isNaN(parsed)) {
          writIssuedDate = writAction.filedDate;
          const daysSinceWrit = Math.floor((Date.now() - parsed) / 86400000);
          daysUntilSale = Math.max(0, 150 - daysSinceWrit);
          daysUntilSaleEst = Math.max(0, 90 - daysSinceWrit);
        }
      } catch (e) { /* ignore parse errors */ }
    }
  }

  return {
    ...c,
    plaintiffType: resolvedPlaintiffType,
    sellerScore: score,
    sellerGrade: grade,
    sellerLikelihood: labelFromGrade(grade),
    urgencyLevel: urgencySignal.level,
    urgencyReasons: urgencySignal.reasons,
    buyerWarning: urgencySignal.buyerWarning,
    sellerFactors: factors,
    sellerScoreSummary: summary,
    writIssuedDate,
    daysUntilSale,
    daysUntilSaleEst,
    scoreComponents: {
      stageA,
      distressB,
      resistanceC,
      frictionD,
      exitE,
      timeF,
      plaintiffG,
      terminalH,
      confidenceAdj,
      urgencyLevel: urgencySignal.level
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
    if (u === 'OPEN' || u === 'CLOSED' || u === 'STAY') return 3;
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
    const personPlaintiffFallbacks = raw.plaintiffNames
      .filter(name => classifyDefendant(name) !== 'ENTITY')
      .filter(name => !shouldSkipCourtSearchName(name));
    const searchablePersonDefendants = personDefendants.filter(name => !shouldSkipCourtSearchName(name));
    const searchCandidates = [
      ...searchablePersonDefendants.map(name => ({ name, partyCode: 'R' })),
      ...personPlaintiffFallbacks.map(name => ({ name, partyCode: 'D' }))
    ];

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
      searchNames: uniqueNames([...searchablePersonDefendants, ...personPlaintiffFallbacks]),
      searchCandidates,
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
    importMetadata: {
      hasCourtStatusColumn: col.courtStatus >= 0,
      hasCourtDocketColumn: col.courtDocket >= 0
    },
    totalCases: scoredCases.length,
    totalRows: lines.length - 1,
    summary: { byPlaintiffType, byDefendantType, byTown },
    cases: scoredCases
  };
}

// ============================================================
// ArcGIS REST API Query
// ============================================================
// Resolves { features } on success or { failed, reason } on any transport,
// HTTP or API-level error. These MUST stay distinguishable: an error that
// looks like an empty result silently turns a real property into
// "No parcel match found", and concurrency makes those errors routine.
function httpsGetOnce(url) {
  return new Promise((resolve) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PropertyResearch/1.0)' },
      timeout: 45000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          resolve({ failed: true, reason: `HTTP ${res.statusCode}` });
          return;
        }
        try {
          const parsed = JSON.parse(data);
          // ArcGIS reports query problems as { error: { ... } } with HTTP 200.
          if (parsed.error) {
            resolve({ failed: true, reason: `API: ${parsed.error.message || JSON.stringify(parsed.error)}` });
            return;
          }
          resolve({ features: parsed.features || [] });
        } catch (e) {
          resolve({ failed: true, reason: `bad JSON: ${data.substring(0, 120)}` });
        }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ failed: true, reason: 'timeout' }); });
    req.on('error', (err) => resolve({ failed: true, reason: err.message }));
  });
}

async function httpsGet(url, attempts = 3) {
  let last = { failed: true, reason: 'no attempt' };
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await delay(1000 * i);   // linear backoff: 1s, 2s
    last = await httpsGetOnce(url);
    if (!last.failed) return last;
  }
  console.log(`     query failed after ${attempts} attempts: ${last.reason}`);
  return last;
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

// ArcGIS string literals are single-quoted; escape any embedded quote.
function sqlQuote(value) {
  return String(value == null ? '' : value).replace(/'/g, "''");
}

// The Clerk's Lot column concatenates the lot with its condo/unit qualifier
// (e.g. "2C505A" = lot 2, qualifier C505A), but MOD-IV keeps them in separate
// PCLLOT / PCLQCODE fields.
function splitLotQualifier(lot) {
  const m = String(lot || '').trim().match(/^(\d+(?:\.\d+)?)\s*([A-Za-z][A-Za-z0-9\-.\/]*)$/);
  if (!m) return null;
  return { lot: m[1], qualifier: m[2].toUpperCase() };
}

// MOD-IV writes block/lot decimals with two digits ("339.30", "21.01"). When
// the Clerk sheet round-trips through Excel the value becomes a number, so
// "339.30" loses its trailing zero and arrives as "339.3" while "21.01" is
// left alone. A single decimal digit is therefore ambiguous - try both, and
// let the caller flag it when both turn out to be real parcels.
function decimalPadVariants(value) {
  const raw = String(value == null ? '' : value).trim();
  const m = raw.match(/^(\d+)\.(\d)$/);
  if (!m) return [raw];
  return [raw, `${m[1]}.${m[2]}0`, `${m[1]}.0${m[2]}`];
}

function sqlInList(values) {
  return values.map(v => `'${sqlQuote(v)}'`).join(', ');
}

// Ordered lookup strategies, most exact first, so the common case still costs
// a single request.
function buildWhereClauses(munFilter, rawBlock, rawLot) {
  // Callers may hand us numbers straight out of the pipeline JSON.
  const block = String(rawBlock == null ? '' : rawBlock).trim();
  const lot = String(rawLot == null ? '' : rawLot).trim();
  const b = sqlQuote(block);
  const l = sqlQuote(lot);
  const clauses = [`${munFilter} AND PCLBLOCK='${b}' AND PCLLOT='${l}'`];

  const blockStripped = block.replace(/^0+/, '') || '0';
  const lotStripped = lot.replace(/^0+/, '') || '0';
  if (blockStripped !== block || lotStripped !== lot) {
    clauses.push(`${munFilter} AND PCLBLOCK='${sqlQuote(blockStripped)}' AND PCLLOT='${sqlQuote(lotStripped)}'`);
  }

  const split = splitLotQualifier(lot);
  if (split) {
    const sl = sqlQuote(split.lot);
    const sq = sqlQuote(split.qualifier);
    clauses.push(`${munFilter} AND PCLBLOCK='${b}' AND PCLLOT='${sl}' AND PCLQCODE='${sq}'`);
    clauses.push(`${munFilter} AND PCLBLOCK='${b}' AND PCLLOT='${sl}' AND PCLQCODE LIKE '${sq}%'`);
  } else if (/^[A-Za-z]/.test(lot.trim())) {
    // Qualifier with no lot prefix, e.g. lot "C2020".
    clauses.push(`${munFilter} AND PCLBLOCK='${b}' AND PCLQCODE='${sqlQuote(lot.trim().toUpperCase())}'`);
  }

  // Excel-mangled decimals; one query covers every padding combination so a
  // genuine tie is visible in a single result set.
  const blockVars = decimalPadVariants(block);
  const lotVars = decimalPadVariants(lot);
  if (blockVars.length > 1 || lotVars.length > 1) {
    clauses.push(`${munFilter} AND PCLBLOCK IN (${sqlInList(blockVars)}) AND PCLLOT IN (${sqlInList(lotVars)})`);
  }

  if (!block.includes('.')) {
    clauses.push(`${munFilter} AND PCLBLOCK LIKE '${b}%' AND PCLLOT='${l}'`);
  }
  return clauses;
}

// Throws on a genuine query failure so the caller records an error rather than
// mistaking a throttled request for "this parcel does not exist".
async function runClauses(clauses) {
  for (let i = 0; i < clauses.length; i++) {
    if (i > 0) await delay(300);
    const data = await httpsGet(buildQueryUrl(clauses[i]));
    if (data.failed) throw new Error(`Parcel lookup failed (${data.reason})`);
    if (data.features.length) return data.features;
  }
  return [];
}

// All features belonging to the highest-priority candidate municipality.
function pickByCandidate(features, candidates) {
  for (const code of candidates) {
    const matches = features.filter(f => ((f.attributes || {}).PCL_MUN || '').trim() === code);
    if (matches.length) return { code, matches };
  }
  return null;
}

const parcelKey = (f) => {
  const a = f.attributes || {};
  return [a.PCLBLOCK, a.PCLLOT, a.PCLQCODE, (a.PROP_LOC || '').trim()].join('|');
};

// Search the whole county by block/lot in one pass and let the candidate
// municipalities *rank* the results, rather than querying each town in turn.
// Costs the same single request in the common case, and still finds the parcel
// when the Clerk's town label is wrong.
async function queryParcel(munCodes, block, lot) {
  const candidates = (Array.isArray(munCodes) ? munCodes : [munCodes]).filter(Boolean);

  // Fast path: an exact PCL_MUN match runs ~25% quicker than the LIKE '04%'
  // scan, and the labelled town is right the overwhelming majority of the
  // time. Only widen when it misses.
  if (candidates.length) {
    const primary = await runClauses(buildWhereClauses(`PCL_MUN='${sqlQuote(candidates[0])}'`, block, lot));
    const addressedPrimary = primary.filter(f => ((f.attributes || {}).PROP_LOC || '').trim());
    // A single clean hit needs no county-wide confirmation; anything else
    // (nothing, no address, or a tie) falls through to the full search.
    if (addressedPrimary.length && new Set(addressedPrimary.map(parcelKey)).size === 1) {
      const result = toParcelResult(addressedPrimary);
      result.matchedVia = 'primary';
      return result;
    }
  }

  const features = await runClauses(buildWhereClauses(CAMDEN_MUN_FILTER, block, lot));
  if (!features.length) return null;

  const hit = pickByCandidate(features, candidates);
  let scoped, matchedVia;
  if (hit) {
    scoped = hit.matches;
    matchedVia = hit.code === candidates[0] ? 'primary' : 'alias';
  } else {
    // No candidate town matched. Block/lot pairs repeat across municipalities,
    // so only accept a county-wide hit when it points at a single town.
    const distinctMuns = new Set(features.map(f => ((f.attributes || {}).PCL_MUN || '').trim()));
    if (distinctMuns.size > 1) {
      return {
        ambiguous: true,
        reason: 'multiple municipalities',
        candidates: [...new Set(features.map(f => ((f.attributes || {}).MUN_NAME || '').trim()))],
        matchCount: features.length,
      };
    }
    scoped = features;
    matchedVia = 'county-wide';
  }

  // MOD-IV carries plenty of parcels with a blank PROP_LOC. That is a missing
  // address, not a failed match - the valuation fields are still usable.
  const addressed = scoped.filter(f => ((f.attributes || {}).PROP_LOC || '').trim());
  if (!addressed.length) {
    const result = toParcelResult(scoped);
    result.matchedVia = matchedVia;
    result.noAddressOnFile = true;
    return result;
  }

  // A padding tie (block 21.01 vs 21.10) or an unqualified condo lot resolves
  // to several real addresses. Guessing would put a wrong address on a lead.
  const distinctParcels = new Set(addressed.map(parcelKey));
  if (distinctParcels.size > 1) {
    return {
      ambiguous: true,
      reason: 'multiple parcels',
      candidates: addressed.slice(0, 4).map(f => {
        const a = f.attributes || {};
        return `blk ${a.PCLBLOCK} lot ${a.PCLLOT}${a.PCLQCODE ? ' q' + a.PCLQCODE : ''} = ${(a.PROP_LOC || '').trim()}`;
      }),
      matchCount: distinctParcels.size,
    };
  }

  const result = toParcelResult(addressed);
  result.matchedVia = matchedVia;

  // The Clerk named a town but the only parcel with this block/lot sits
  // somewhere else entirely - usually a corrupt block number rather than a
  // mislabelled town (real mislabels resolve through the alias list above).
  // Suggest it for review instead of asserting it.
  if (matchedVia === 'county-wide' && candidates.length) {
    return {
      needsReview: true,
      reason: 'block/lot found outside the labelled town',
      suggestion: result,
    };
  }
  return result;
}

function toParcelResult(features) {
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
    dwellingUnits: attrs.DWELL != null ? attrs.DWELL : null,
    matchedBlock: attrs.PCLBLOCK,
    matchedLot: attrs.PCLLOT,
    matchedQualifier: (attrs.PCLQCODE || '').trim(),
    matchedMunCode: (attrs.PCL_MUN || '').trim(),
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
  // Non-success outcomes worth telling apart on a full-county run.
  let ambiguous = 0, needsReview = 0, noAddressOnFile = 0;

  console.log(`\n🏠 Camden County Address Enrichment`);
  console.log(`${'='.repeat(50)}`);
  console.log(`Cases: ${total}`);
  console.log(`API: NJ MOD-IV ArcGIS REST\n`);

  // The NJ ArcGIS service costs ~6s per query, so a full county re-resolve is
  // hours long when run one at a time. Three in flight keeps this feature
  // usable without the memory footprint that forced the scrapers to 1.
  const ADDRESS_CONCURRENCY = 3;

  async function processCase(c, i) {
    const prefix = `  ${i + 1}/${total}`;

    if (c.propertyAddress) {
      // Backfill missing fields from already-enriched cases
      const needsBackfill = (!c.lastSaleDate || c.dwellingUnits == null) && c.town && c.block && c.lot;
      if (needsBackfill) {
        await delay(400);
        try {
          const result = await queryParcel(resolveMunCodes(c.town), c.block, c.lot);
          if (result && !result.ambiguous) {
            if (!c.lastSaleDate && result.saleDate) {
              c.lastSaleDate = result.saleDate;
            }
            if (c.dwellingUnits == null && result.dwellingUnits != null) {
              c.dwellingUnits = result.dwellingUnits;
            }
          }
        } catch (e) {}
      }
      skipped++;
      return;
    }

    const town = normalizeTownName(c.town);
    const block = (c.block || '').trim();
    const lot = (c.lot || '').trim();
    const munCodes = resolveMunCodes(town);

    if (!munCodes.length) {
      // Not fatal - queryParcel still searches the whole county by block/lot.
      console.log(`${prefix} ℹ ${c.instrumentNumber} - Unmapped town '${town}', searching county-wide`);
    }

    if (!block || !lot) {
      console.log(`${prefix} ⚠ ${c.instrumentNumber} - Missing block/lot`);
      c.enrichmentError = 'Missing block or lot';
      errors++;
      return;
    }

    await delay(400);

    try {
      const result = await queryParcel(munCodes, block, lot);

      if (result && result.ambiguous) {
        c.enrichmentError = `Ambiguous (${result.reason}): ${result.candidates.join(' | ')}`;
        c.enrichmentAmbiguous = result.candidates;
        console.log(`${prefix} ❓ ${c.instrumentNumber} B:${block} L:${lot} → ambiguous, ${result.matchCount} matches (${result.reason})`);
        ambiguous++;
      } else if (result && result.needsReview) {
        const s = result.suggestion;
        c.enrichmentError = `Needs review - ${result.reason}: suggests ${s.propertyAddress} (${s.municipality})`;
        c.suggestedAddress = s.propertyAddress;
        c.suggestedMunicipality = s.municipality;
        console.log(`${prefix} 🔍 ${c.instrumentNumber} B:${block} L:${lot} → needs review, suggests ${s.propertyAddress} (${s.municipality})`);
        needsReview++;
      } else if (result && result.noAddressOnFile) {
        // Keep the valuation data - only the street address is missing.
        c.assessedValue = result.netValue;
        c.landValue = result.landValue;
        c.improvementValue = result.improvementValue;
        c.propertyClass = result.propertyClass;
        c.dwellingUnits = result.dwellingUnits;
        c.resolvedMunicipality = result.municipality;
        c.enrichmentError = 'Parcel found but MOD-IV has no street address on file';
        console.log(`${prefix} ⃠ ${c.instrumentNumber} B:${block} L:${lot} → parcel found, no address on file`);
        noAddressOnFile++;
      } else if (result && result.propertyAddress) {
        c.propertyAddress = result.propertyAddress;
        c.assessedValue = result.netValue;
        c.landValue = result.landValue;
        c.improvementValue = result.improvementValue;
        c.buildingDesc = result.buildingDesc;
        c.yearConstructed = result.yearConstructed;
        c.lastSalePrice = result.salePrice;
        c.lastSaleDate = result.saleDate;
        c.propertyClass = result.propertyClass;
        c.dwellingUnits = result.dwellingUnits;
        c.enrichmentSource = 'NJ MOD-IV via ArcGIS REST';
        c.enrichedAt = new Date().toISOString();
        c.enrichmentError = '';
        c.resolvedMunicipality = result.municipality;
        // Surface, rather than silently correct, a Clerk town label that turned
        // out to belong to a different municipality.
        c.townMismatch = result.matchedVia !== 'primary'
          ? `Clerk town '${town}' resolved to ${result.municipality}`
          : '';

        const val = result.netValue ? `$${result.netValue.toLocaleString()}` : 'N/A';
        const via = result.matchedVia === 'primary' ? '' : ` [via ${result.matchedVia}: ${result.municipality}]`;
        console.log(`${prefix} ✅ ${c.instrumentNumber} B:${block} L:${lot} → ${result.propertyAddress} (${val})${via}`);
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

  // Hand each worker the next index; counters stay safe because Node runs the
  // synchronous parts of processCase to completion between awaits.
  let cursor = 0;
  async function worker() {
    while (cursor < cases.length) {
      const i = cursor++;
      await processCase(cases[i], i);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(ADDRESS_CONCURRENCY, cases.length) }, worker)
  );

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
    ambiguous,
    needsReview,
    noAddressOnFile,
    skipped,
    errors,
    hitRate: (total - skipped) > 0 ? `${(found / (total - skipped) * 100).toFixed(1)}%` : 'N/A',
  };

  console.log(`\n${'='.repeat(50)}`);
  console.log(`📊 ENRICHMENT SUMMARY`);
  console.log(`  Addresses found: ${found} ✅`);
  console.log(`  No parcel at all: ${notFound} ❌`);
  console.log(`  Ambiguous (needs a pick): ${ambiguous} ❓`);
  console.log(`  Found outside labelled town: ${needsReview} 🔍`);
  console.log(`  Parcel exists, no address on file: ${noAddressOnFile} ⃠`);
  console.log(`  Skipped: ${skipped} | Errors: ${errors}`);
  if ((total - skipped) > 0) {
    console.log(`  Hit rate: ${found}/${total - skipped} = ${(found / (total - skipped) * 100).toFixed(1)}%`);
  }

  return data;
}

module.exports = {
  parseCSVLine,
  parseCamdenCSV,
  enrichCamdenCases,
  scoreCamdenCase,
  classifyCourtCaseType,
  classifyPlaintiff,
  classifyDefendant,
  TOWN_TO_MUN_CODE,
  LOCALITY_TO_MUN_CODES,
  normalizeTownName,
  townNameVariants,
  resolveMunCodes,
  splitLotQualifier,
  queryParcel
};
