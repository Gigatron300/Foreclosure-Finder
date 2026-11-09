// payoff-estimate.js
// Estimates the total payoff on a Montgomery County foreclosure (senior + junior
// liens) from FREE sources only:
//   - the court docket page (judgment amount/date, stage, bankruptcy, sale status)
//   - the Recorder of Deeds parcel index, pasted in by the user (free account):
//     every recorded mortgage with its face amount, plus satisfactions
//   - other liens the user types in (borough, Domestic Relations, Revenue, ...)
//
// Tiers for the senior (foreclosing) debt:
//   A  judgment entered     -> judgment rolled forward to today
//   C  complaint only       -> loan rebuilt from the recorded mortgage (amortized)
//   -  neither available    -> no estimate; ask for Recorder data
//
// Everything returns a low/high band, never a single number: the exact payoff
// needs a servicer payoff letter.

const DAY = 86400000;

// Freddie Mac PMMS 30-year fixed, approximate annual averages. Used only when the
// recorded mortgage gives no rate (the index never does).
const PMMS_30YR = {
  1990: 10.13, 1991: 9.25, 1992: 8.39, 1993: 7.31, 1994: 8.38, 1995: 7.93, 1996: 7.81,
  1997: 7.60, 1998: 6.94, 1999: 7.44, 2000: 8.05, 2001: 6.97, 2002: 6.54, 2003: 5.83,
  2004: 5.84, 2005: 5.87, 2006: 6.41, 2007: 6.34, 2008: 6.03, 2009: 5.04, 2010: 4.69,
  2011: 4.45, 2012: 3.66, 2013: 3.98, 2014: 4.17, 2015: 3.85, 2016: 3.65, 2017: 3.99,
  2018: 4.54, 2019: 3.94, 2020: 3.11, 2021: 2.96, 2022: 5.34, 2023: 6.81, 2024: 6.72,
  2025: 6.60, 2026: 6.30
};

const ASSUMPTIONS = {
  // Taxes + insurance the servicer advances per year (Montco school taxes are high).
  escrowPerYear: { low: 3500, high: 7000 },
  insurancePerYear: { low: 1000, high: 2500 }, // used when the user gives the tax bill
  // Attorney fees + costs still to be added, by stage.
  fees: {
    complaint: { low: 1500, high: 3500 },
    judgment: { low: 2500, high: 4500 },
    writ: { low: 3500, high: 6500 }
  },
  legalRate: 0.06,            // PA legal rate on judgments
  courtLienRate: 0.10,        // municipal claims accrue up to 10%/yr plus costs
  monthsComplaintAfterDefault: 7, // first missed payment -> complaint filed
  closingDays: 0,             // price to today (set >0 to project to a later closing date)
  // Servicer advances, HIGH side (NJ payoff_math.py, calibrated on closed cases): with an
  // escrow/FHA tell, 8% of UPB per year in default; without one, 8% of UPB once.
  advancesHighPct: 0.08,
  junior: { rate: 0.08, unpaidFromYears: 1, maxUnpaidYears: 3, oldYears: 15 }
};

// ---------- small helpers ----------

function toDate(v) {
  if (!v) return null;
  if (v instanceof Date) return isNaN(v) ? null : v;
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) {
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    return new Date(y, +m[1] - 1, +m[2]);
  }
  const d = new Date(s);
  return isNaN(d) ? null : d;
}

function isoDate(d) {
  if (!d) return null;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function addMonths(d, n) {
  return new Date(d.getFullYear(), d.getMonth() + n, d.getDate());
}

function daysBetween(a, b) {
  return Math.max(0, Math.round((b - a) / DAY));
}

function money(v) {
  if (v == null || v === '') return null;
  const n = parseFloat(String(v).replace(/[$,\s]/g, ''));
  return isNaN(n) ? null : n;
}

function round(n) { return Math.round(n); }

// Balance after `paid` monthly payments on a fully amortizing loan.
function amortizedBalance(principal, annualRate, termMonths, paid) {
  const r = annualRate / 12;
  if (paid <= 0) return principal;
  if (paid >= termMonths) return 0;
  if (r === 0) return principal * (1 - paid / termMonths);
  const pmt = principal * r / (1 - Math.pow(1 + r, -termMonths));
  const g = Math.pow(1 + r, paid);
  return principal * g - pmt * (g - 1) / r;
}

function pmmsRate(year) {
  if (PMMS_30YR[year]) return PMMS_30YR[year] / 100;
  const years = Object.keys(PMMS_30YR).map(Number);
  const nearest = year < years[0] ? years[0] : years[years.length - 1];
  return PMMS_30YR[nearest] / 100;
}

// ---------- docket facts ----------

// events: [{date, type, text}] (full docket if the scraper stored it, else the
// last few). judgments: [{for, against, date, amount}] from the Judgments table.
function extractDocketFacts(c) {
  const d = c.docket || {};
  const events = (d.events && d.events.length ? d.events : d.recentEvents) || [];
  const up = (s) => String(s || '').toUpperCase();
  const all = events.map(e => `${up(e.type)} ${up(e.text)}`);
  const any = (re) => all.some(t => re.test(t));

  const lienListEvent = events.find(e => /3129/.test(`${up(e.type)} ${up(e.text)}`) && !/3129\.2/.test(`${up(e.type)} ${up(e.text)}`))
    || events.find(e => /3129/.test(`${up(e.type)} ${up(e.text)}`));
  const facts = {
    judgment: null,          // { amount, date, kind: 'default'|'summary'|'other' }
    writFiled: any(/WRIT/),
    lienListFiled: !!lienListEvent,
    lienListDate: lienListEvent ? lienListEvent.date : null,
    saleContinued: any(/CONTINUED SHERIFF SALE|SHERIFF SALE.*(CONTINU|POSTPON)|POSTPONE/),
    // The sheriff returned the writ: either the sale happened or it was returned unexecuted.
    writReturned: any(/WRIT.{0,20}RETURN|RETURN.{0,20}WRIT|SHERIFF.?S DEED|PROPERTY SOLD|SOLD TO/),
    bankruptcy: !!d.hasBankruptcy || any(/BANKRUPTCY/),
    bankruptcyDischarged: any(/DISCHARGE/),
    stayed: !!d.isStayed && !any(/STAY IS LIFTED|STAY LIFTED/),
    defendantHasLawyer: any(/ENTRY OF APPEARANCE/) || any(/PRELIMINARY OBJECTIONS OF|ANSWER\/RESPONSE|BY DEFENDANT/),
    fullDocket: !!(d.events && d.events.length)
  };

  // Judgment amount + date: Judgments table first, docket text second.
  const jRows = (c.judgments || []).filter(j => money(j.amount) != null);
  const jEvent = [...events].reverse().find(e => /JUDGMENT|JDMT/.test(`${up(e.type)} ${up(e.text)}`) &&
    /\$?\s?[\d,]{4,}\.\d{2}/.test(up(e.text)));
  let amount = null, date = null, kindText = '';
  if (jRows.length) {
    const last = jRows[jRows.length - 1];
    amount = money(last.amount);
    date = toDate(last.date);
    kindText = up(last.amount) + ' ' + up(last.type || '');
  } else if (c.judgmentAmount != null) {
    amount = money(c.judgmentAmount);
  }
  if (jEvent) {
    if (amount == null) {
      const m = up(jEvent.text).match(/\$?\s?([\d,]{4,}\.\d{2})/);
      if (m) amount = money(m[1]);
    }
    if (!date) date = toDate(jEvent.date);
    kindText += ' ' + up(jEvent.type) + ' ' + up(jEvent.text);
  }
  if (amount != null) {
    const kind = /DEFAULT/.test(kindText) ? 'default' : /SUMMARY/.test(kindText) ? 'summary' : 'other';
    facts.judgment = { amount, date, dateKnown: !!date, kind };
  }
  return facts;
}

// ---------- Recorder index parsing ----------

const DOC_TYPES = [
  'Satisfaction of Mortgage', 'Mortgage Assignment', 'Assignment of Mortgage',
  'Mortgage Modification', 'Modification of Mortgage', 'Modification Agreement',
  'Partial Release', 'Subordination Agreement', 'Subordination', 'Release',
  'Lis Pendens', 'Power of Attorney', 'Agreement', 'Modification', 'Deed', 'Mortgage',
  'Miscellaneous'
];
const TYPE_RE = new RegExp(
  // The parenthetical is either the amount "($69,800.00)" or a qualifier like "(ASSIGNMENT)".
  `\\b(${DOC_TYPES.map(t => t.replace(/ /g, '\\s+')).join('|')})\\s*(?:\\+\\s*)?(?:\\((\\$[\\d,]+(?:\\.\\d{2})?|[A-Za-z][A-Za-z ]{1,30})\\))?\\s*(\\d{1,2}\\/\\d{1,2}\\/\\d{4})`,
  'i'
);
// "MTG 16102 00522" / "SAT 1332\n02543" -> volume, book, page (pages are 5-digit padded)
const ROW_START_RE = /\b([A-Z]{2,4})\s+(\d{1,6})\s+(\d{5})\b/g;

// Text copied from the Recorder "Search Results" page (or its print view).
// Returns [{ key, volume, book, page, type, amount, recorded, text }]
function parseRecorderIndex(text) {
  const src = String(text || '').replace(/ /g, ' ');
  const starts = [];
  let m;
  ROW_START_RE.lastIndex = 0;
  while ((m = ROW_START_RE.exec(src))) {
    starts.push({ idx: m.index, end: ROW_START_RE.lastIndex, volume: m[1], book: +m[2], page: +m[3] });
  }
  const rows = [];
  const seen = new Set();
  for (let i = 0; i < starts.length; i++) {
    const s = starts[i];
    const chunk = src.slice(s.end, i + 1 < starts.length ? starts[i + 1].idx : src.length)
      .replace(/\s+/g, ' ').trim();
    const t = chunk.match(TYPE_RE);
    if (!t) continue;
    let type = t[1].replace(/\s+/g, ' ');
    const paren = t[2] || '';
    const amountText = paren.startsWith('$') ? paren : null;
    if (paren && !amountText) {
      // "Mortgage (ASSIGNMENT)" -> "Mortgage Assignment"; other qualifiers kept as-is.
      type = /assign/i.test(paren) && /^mortgage$/i.test(type) ? 'Mortgage Assignment' : `${type} (${paren.trim()})`;
    }
    // "Court Order: Deed ($0.00)" is a court order recorded in the deed books, not a transfer.
    const isOrder = /court\s+order\s*:?\s*$/i.test(chunk.slice(0, t.index));
    if (isOrder) type = 'Court Order';
    const key = `${s.volume} ${s.book}/${s.page}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      key,
      volume: s.volume,
      book: s.book,
      page: s.page,
      type: type.replace(/\b\w/g, ch => ch.toUpperCase()).replace(/\bOf\b/, 'of'),
      amount: amountText ? money(amountText) : null,
      recorded: isoDate(toDate(t[3])),
      parties: chunk.slice(0, t.index).replace(/court\s+order\s*:?\s*$/i, '')
        .replace(/\s*\+\s*/g, ' ').replace(/\s+\d\s+/g, ' / ').trim()
    });
  }
  return rows;
}

// Plaintiffs that mostly hold home-equity / second-lien loans. When one of them
// forecloses, a first mortgage usually sits AHEAD of it and survives the sale.
const JUNIOR_LENDER_RE = /FIGURE\s+LENDING|SPRING\s*EQ|DISCOVER\s+BANK|HOME\s+EQUITY|HELOC|SECOND\s+MORTGAGE|MEB\s+LOAN\s+TRUST|BAYVIEW.*SECOND|VERUS.*SECOND/i;

function isClosedCase(c) {
  if (c.liveClosed) return true;
  const s = String(c.liveStatus || c.status || '').toUpperCase();
  return /CLOS|DISPOS|SETTL|DISMISS|WITHDRAW|SATISF|DISCONTINU/.test(s) && !/OPEN|ACTIVE|PENDING/.test(s);
}

const isMortgage = (r) => /^mortgage$/i.test(r.type);
// Releases filed in the deed books ("Miscellaneous (RELEASE)") are not mortgage payoffs.
const isSatisfaction = (r) => /satisfaction|release/i.test(r.type) && !/partial|miscellaneous/i.test(r.type) && !/^DEE/i.test(r.volume || '');
const isModification = (r) => /modification/i.test(r.type);
const isHud = (r) => /HOUSING\s+(AND|&)\s+URBAN|\bHUD\b/i.test(r.parties || '');

// Lender-name words for matching a satisfaction to its mortgage (owner names,
// MERS and corporate filler are ignored).
const NAME_NOISE = new Set(['INC', 'LLC', 'CORP', 'CO', 'BANK', 'NATIONAL', 'NAT', 'ASSOCIATION', 'NA', 'BK',
  'MORTGAGE', 'MORT', 'HOME', 'HOMES', 'LOANS', 'LOAN', 'LN', 'FINANCIAL', 'FIN', 'CAPITAL', 'FUNDING', 'THE',
  'OF', 'AND', 'MERS', 'ELECTRONIC', 'REGISTRATION', 'SYSTEMS', 'FSB', 'FCU', 'FSA', 'SAVS', 'S&LA', 'ATTY', 'FKA', 'AKA',
  'TRUST', 'TRUSTEE', 'COMPANY', 'SERVICES', 'SERVICING', 'SERVICER', 'LENDING', 'SAVINGS', 'FEDERAL', 'CREDIT', 'UNION',
  'FIRST', 'AMERICA', 'AMERICAN', 'UNITED', 'STATES', 'SERIES', 'CERTIFICATES', 'ASSET', 'BACKED', 'DBA', 'SER', 'SUCCESSOR']);
function lenderWords(text, ownerWords) {
  return new Set(String(text || '').toUpperCase().replace(/[^A-Z0-9& ]/g, ' ').split(/\s+/)
    .filter(w => w.length > 2 && !NAME_NOISE.has(w) && !ownerWords.has(w)));
}

// Party groups of an index row: "1 HARKINS KEVIN J / PNC BANK" -> ['HARKINS KEVIN J', 'PNC BANK'].
// Mortgage: [borrower, lender]. Satisfaction: [lender, borrower].
function partyGroups(r) {
  return String(r.parties || '').split(' / ').map(s => s.replace(/^\d+\s+/, '').trim()).filter(Boolean);
}
function personWords(text) {
  return new Set(String(text || '').toUpperCase().split(/[^A-Z]+/).filter(w => w.length > 2));
}
const sharesWord = (a, b) => [...a].some(w => b.has(w));
// The lender's party group: second on a mortgage, first on a satisfaction.
function lenderSide(r, kind) {
  const g = partyGroups(r);
  if (g.length < 2) return r.parties || '';
  return kind === 'satisfaction' ? g[0] : g[1];
}

// Which recorded mortgages are still open. Each satisfaction cancels an earlier
// unsatisfied mortgage of the SAME borrower, preferring one whose lender name it
// shares, else the most recent. A mortgage assigned after a satisfaction was not
// paid by it, and keys in opts.protect (the loan being foreclosed) are never
// closed by a satisfaction recorded before opts.protectUntil. Mortgages over 30
// years old are treated as expired. The user can override any row.
function resolveOpenMortgages(rows, overrides = {}, asOf = new Date(), opts = {}) {
  const mortgages = rows.filter(isMortgage).map(r => ({ ...r, open: true, satisfiedBy: null }));
  // Owner names = grantees of deeds; their words never identify a lender.
  const ownerWords = new Set();
  rows.filter(r => /^deed/i.test(r.type)).forEach(r =>
    String(r.parties || '').toUpperCase().split(/[^A-Z]+/).forEach(w => w.length > 2 && ownerWords.add(w)));
  const assignments = rows.filter(r => /assign/i.test(r.type) && r.amount && r.recorded);
  const protect = new Set(opts.protect || []);
  const sats = rows.filter(isSatisfaction).sort((a, b) => (a.recorded || '').localeCompare(b.recorded || ''));
  for (const s of sats) {
    const satBorrower = personWords(partyGroups(s)[1]);
    let candidates = mortgages
      .filter(mt => mt.open && (mt.recorded || '') <= (s.recorded || ''))
      // same borrower (a satisfaction of the previous owner's loan does not count)
      .filter(mt => {
        const mb = personWords(partyGroups(mt)[0]);
        return !satBorrower.size || !mb.size || sharesWord(satBorrower, mb);
      })
      // assigned later with the same face amount -> still alive after this satisfaction
      .filter(mt => !assignments.some(a => a.amount === mt.amount && a.recorded > s.recorded))
      // the foreclosed loan was not paid off before the foreclosure was filed
      .filter(mt => !(protect.has(mt.key) && (!opts.protectUntil || (s.recorded || '') < opts.protectUntil)))
      .sort((a, b) => (b.recorded || '').localeCompare(a.recorded || ''));
    // A refinance records the new loan days before the old one's satisfaction:
    // the satisfaction belongs to an older loan when there is one.
    const sd = toDate(s.recorded);
    const older = candidates.filter(mt => sd && daysBetween(toDate(mt.recorded), sd) > 45);
    if (older.length) candidates = older;
    const sw = lenderWords(lenderSide(s, 'satisfaction'), ownerWords);
    const byName = sw.size ? candidates.find(mt => [...lenderWords(lenderSide(mt, 'mortgage'), ownerWords)].some(w => sw.has(w))) : null;
    // A satisfaction signed only by MERS belongs to a MERS-registered loan.
    const MERS_RE = /\bMERS\b|ELECTRONIC\s+REGISTRATION/i;
    const byMers = MERS_RE.test(s.parties || '') ? candidates.find(mt => MERS_RE.test(mt.parties || '')) : null;
    const target = byName || byMers || candidates[0];
    if (target) { target.open = false; target.satisfiedBy = s.key; }
  }
  const cutoff = isoDate(new Date(asOf.getFullYear() - 30, asOf.getMonth(), asOf.getDate()));
  for (const mt of mortgages) {
    if (mt.open && mt.recorded && mt.recorded < cutoff) { mt.open = false; mt.satisfiedBy = 'expired (30+ years)'; }
  }
  for (const mt of mortgages) {
    mt.autoOpen = mt.open;
    if (Object.prototype.hasOwnProperty.call(overrides, mt.key)) {
      mt.open = !!overrides[mt.key];
      mt.overridden = mt.open !== mt.autoOpen;
    }
  }
  return mortgages.sort((a, b) => (b.recorded || '').localeCompare(a.recorded || ''));
}

// ---------- the estimate ----------

function stageOf(facts) {
  if (facts.writFiled || facts.saleContinued) return 'writ';
  if (facts.judgment) return 'judgment';
  return 'complaint';
}

function escrowBand(years, inputs) {
  const taxes = money(inputs.annualTaxes);
  const per = taxes != null
    ? { low: taxes + ASSUMPTIONS.insurancePerYear.low, high: taxes + ASSUMPTIONS.insurancePerYear.high }
    : ASSUMPTIONS.escrowPerYear;
  return { low: per.low * years, high: per.high * years, perYear: per, fromTaxBill: taxes != null };
}

/**
 * @param c       pipeline case (as stored by montco-courts.js)
 * @param inputs  user data: { recorderText, overrides, otherLiens:[{name,amount}],
 *                annualTaxes, rate, originalAmount, originationDate }
 * @param asOf    Date to roll forward to (default today)
 */
function estimatePayoff(c, inputs = {}, asOf = new Date()) {
  const facts = extractDocketFacts(c);
  const stage = stageOf(facts);
  const flags = [];
  const lines = [];
  const closing = new Date(asOf.getFullYear(), asOf.getMonth(), asOf.getDate() + ASSUMPTIONS.closingDays);
  const rows = inputs.recorderText ? parseRecorderIndex(inputs.recorderText) : [];
  // Escrow/FHA tell: a HUD partial-claim mortgage means an FHA loan, which escrows taxes.
  const escrowTell = rows.some(r => isMortgage(r) && isHud(r)) ? 'HUD mortgage on record (FHA loan)' : null;
  // HIGH advances = the larger of the flat per-year figure and the calibrated % of UPB.
  const advancesHigh = (flatHigh, upb, years) => Math.max(flatHigh,
    upb * ASSUMPTIONS.advancesHighPct * (escrowTell ? years : 1));
  let perDiemHigh = 0, advancesPerYearHigh = 0;
  // The foreclosed mortgage, found on the raw rows before resolving satisfactions:
  // the docket Remarks book/page, else a mortgage assigned to the plaintiff (an
  // assignment row naming the plaintiff, with the loan's face amount).
  const book = parseInt(c.mortgageBook, 10), page = parseInt(c.mortgagePage, 10);
  const protect = [];
  let protectedBy = '';
  if (c.caseTypeKind !== 'lien') {
    const byBook = rows.find(r => isMortgage(r) && r.book === book && r.page === page);
    if (byBook) protect.push(byBook.key);
    else {
      const pw = lenderWords(c.plaintiff, new Set());
      const toPlaintiff = rows.filter(r => /assign/i.test(r.type) && r.amount && sharesWord(lenderWords(r.parties, new Set()), pw));
      for (const a of toPlaintiff) {
        const m = rows.find(r => isMortgage(r) && r.amount === a.amount && r.recorded <= a.recorded);
        if (m && !protect.includes(m.key)) { protect.push(m.key); protectedBy = `assigned to the plaintiff ${a.recorded}`; }
      }
      if (!protect.length) {
        // Last resort: a mortgage made to the plaintiff itself. With a judgment, the
        // loan whose face fits it best (judgments run ~10% over principal).
        const named = rows.filter(r => isMortgage(r) && r.amount && !isHud(r) && sharesWord(lenderWords(r.parties, new Set()), pw));
        const jAmt = facts.judgment && facts.judgment.amount;
        const pick = jAmt
          ? [...named].sort((a, b) => Math.abs(Math.log(jAmt / a.amount) - 0.1) - Math.abs(Math.log(jAmt / b.amount) - 0.1))[0]
          : [...named].sort((a, b) => (b.recorded || '').localeCompare(a.recorded || ''))[0];
        if (pick) { protect.push(pick.key); protectedBy = `mortgage made to the plaintiff${named.length > 1 ? ` (best fit of ${named.length})` : ''}`; }
      }
    }
  }
  // While the foreclosure is open its loan is unpaid by definition (a payoff ends the
  // case), so no satisfaction closes it. Once the case is closed, only satisfactions
  // recorded before the filing are ignored.
  const caseOpen = !isClosedCase(c);
  const mortgages = resolveOpenMortgages(rows, inputs.overrides || {}, asOf, {
    protect, protectUntil: caseOpen ? null : (c.commencedDate ? isoDate(toDate(c.commencedDate)) : null)
  });

  let senior = mortgages.find(mt => mt.book === book && mt.page === page) || null;
  if (!senior && protect.length && c.caseTypeKind !== 'lien') {
    senior = mortgages.find(mt => mt.key === protect[0]) || null;
    if (senior) flags.push(`Foreclosed loan identified as ${senior.key} ($${round(senior.amount || 0).toLocaleString()}, ${senior.recorded}): ${protectedBy}.`);
  }
  if (!senior && rows.length) {
    // No book/page match: look for open mortgages made to the plaintiff.
    const pw = lenderWords(c.plaintiff, new Set());
    const named = mortgages.filter(mt => mt.open && mt.amount && !isHud(mt) &&
      [...lenderWords(mt.parties, new Set())].some(w => pw.has(w)));
    if (named.length) {
      const jAmt = facts.judgment && facts.judgment.amount;
      // With a judgment, pick the loan whose face fits it best (judgments run ~10% over principal).
      senior = jAmt
        ? [...named].sort((a, b) => Math.abs(Math.log(jAmt / a.amount) - 0.1) - Math.abs(Math.log(jAmt / b.amount) - 0.1))[0]
        : [...named].sort((a, b) => b.amount - a.amount)[0];
      flags.push(`Foreclosed loan matched by lender name to ${senior.key} ($${round(senior.amount).toLocaleString()}, ${senior.recorded})` +
        (named.length > 1 ? `; ${named.length - 1} other open loan(s) from the same lender are counted separately.` : '.'));
    } else if (facts.judgment) {
      flags.push('Could not tell which recorded mortgage is the one being foreclosed. If one of the listed mortgages is it, untick it to avoid counting it twice.');
    }
  }
  if (!senior && (!facts.judgment || (c.caseTypeKind === 'mortgage' && isClosedCase(c)))) {
    // No book/page match (Remarks missing or points at the deed): assume the
    // largest open non-HUD mortgage is the one being foreclosed.
    senior = mortgages.filter(mt => mt.open && mt.amount && !isHud(mt))
      .sort((a, b) => b.amount - a.amount)[0] || null;
    if (senior) flags.push(`Foreclosed loan assumed to be ${senior.key} (largest open mortgage). The docket did not name its book/page.`);
  }
  // A recorded modification after the foreclosed loan resets it: amortize from the
  // modification's new principal and date (it can exceed the original note).
  const mod = senior ? rows.filter(r => isModification(r) && r.amount && r.recorded && r.recorded > senior.recorded)
    .sort((a, b) => b.recorded.localeCompare(a.recorded))[0] : null;
  if (mod) flags.push(`Loan modified ${mod.recorded} ($${round(mod.amount).toLocaleString()}): estimate starts from the modification, not the original note.`);
  const seniorAmount = money(inputs.originalAmount) ?? (mod ? mod.amount : senior && senior.amount);
  const seniorDate = toDate(inputs.originationDate) || (mod ? toDate(mod.recorded) : senior && toDate(senior.recorded));
  const rateGiven = money(inputs.rate);
  const contractRate = rateGiven != null
    ? rateGiven / 100
    : seniorDate ? pmmsRate(seniorDate.getFullYear()) + 0.0025 : null;

  const juniorPlaintiff = JUNIOR_LENDER_RE.test(c.plaintiff || '');

  const looksModified =
    rows.some(isModification) ||
    (/TRUSTEE|TRUST\b|CERTIFICATES|SERIES\s+\d{4}/i.test(c.plaintiff || '') &&
      seniorDate && seniorDate.getFullYear() <= 2008);

  let seniorBand = null;
  let tier = null;
  let basis = '';
  const fees = ASSUMPTIONS.fees[stage];

  // A CLOSED foreclosure does not mean the mortgage is gone: the loan was
  // reinstated, modified, paid off, or the house sold. Its judgment (if any) is
  // no longer a payoff figure.
  const closedForeclosure = c.caseTypeKind === 'mortgage' && isClosedCase(c);
  const caseFiled = toDate(c.commencedDate);
  const deedsAfter = rows.filter(r => /^deed$/i.test(r.type) && r.recorded && caseFiled && toDate(r.recorded) >= caseFiled);
  const sheriffDeed = deedsAfter.find(r => /SHERIFF/i.test(r.parties || ''));
  const seniorSatisfied = !!(closedForeclosure && senior && !senior.open);
  if (closedForeclosure && !sheriffDeed) {
    const tail = !rows.length
      ? 'Recorder data (pulled after each Process All) will show whether it was satisfied or sold.'
      : seniorSatisfied ? '' : 'Estimate assumes the loan is current at its scheduled balance.';
    flags.push(`Foreclosure case reads ${c.liveStatus || c.status || 'CLOSED'}. The loan was likely reinstated, modified, paid off, or the house sold. ${tail}`.trim());
    if (seniorSatisfied) flags.unshift(`The foreclosed mortgage ${senior.key} shows a satisfaction on record: it was paid off.`);
  }
  if (sheriffDeed) {
    flags.unshift(`Sheriff's deed recorded ${sheriffDeed.recorded}: the property was already sold at sheriff sale.`);
  } else if (deedsAfter.length) {
    flags.unshift(`Deed recorded ${deedsAfter[0].recorded}, after the case was filed: ownership may have changed.`);
  }
  // Court orders recorded against the property (quiet title, reformation, federal cases).
  const orders = rows.filter(r => r.type === 'Court Order' && r.recorded && (!caseFiled || toDate(r.recorded) >= addMonths(caseFiled, -24)));
  for (const o of orders) {
    const parties = [...new Set(String(o.parties || '').split(/\/ORDER|\s\/\s/i)
      .map(s => s.replace(/^\d+\s+|^AKA\s+/i, '').trim()).filter(Boolean))].join(', ').slice(0, 160);
    flags.push(`Court order recorded ${o.recorded} (${o.key}): ${parties}. Not a sale; read it before pricing.`);
  }
  if (rows.some(r => /UNITED STATES OF AMERICA|INTERNAL REVENUE|\bIRS\b/i.test(r.parties || '') && !isHud(r))) {
    flags.unshift('The United States appears on the record: possible federal (IRS) lien. Its amount is filed with the Prothonotary, not the Recorder. If the US is a lienholder, it can redeem for up to a year after a sheriff sale (28 U.S.C. 2410).');
  }

  if (sheriffDeed) {
    tier = null;
    basis = `Sold at sheriff sale (deed recorded ${sheriffDeed.recorded}). Not a pre-foreclosure lead anymore.`;
  } else if (closedForeclosure) {
    if (seniorAmount && seniorDate && senior && senior.open) {
      // ---- Tier C (reinstated): scheduled balance today, no arrears ----
      tier = 'C';
      const firstPayment = new Date(seniorDate.getFullYear(), seniorDate.getMonth() + 1, 1);
      const paid = Math.max(0, (asOf.getFullYear() - firstPayment.getFullYear()) * 12 + (asOf.getMonth() - firstPayment.getMonth()));
      const rLow = contractRate - (rateGiven != null ? 0 : 0.00375);
      const rHigh = contractRate + (rateGiven != null ? 0 : 0.00375);
      // A modification usually capitalizes the arrears, so the high side allows +10% (+20% if it looks modified).
      const balLow = amortizedBalance(seniorAmount, rLow, 360, paid);
      const balHigh = amortizedBalance(seniorAmount, rHigh, 360, paid) * (looksModified ? 1.2 : 1.1);
      lines.push({ label: `Scheduled balance today on $${round(seniorAmount).toLocaleString()} recorded ${isoDate(seniorDate)} (assumes the loan was brought current)`, low: balLow, high: balHigh });
      basis = 'Foreclosure closed: recorded mortgage amortized to today';
    } else {
      tier = null;
      basis = senior && !senior.open
        ? 'Foreclosure closed and the mortgage was satisfied. Only the other liens remain.'
        : 'Foreclosure closed. Recorder data is needed to estimate the remaining mortgage balance.';
    }
  } else if (facts.judgment) {
    // ---- Tier A: judgment rolled forward ----
    tier = 'A';
    const j = facts.judgment;
    const jDate = j.date || toDate(c.docket && c.docket.lastFilingDate) || toDate(c.commencedDate);
    if (!j.dateKnown) flags.push('Judgment date not on file. Using the last docket date. Re-scan the case to fix.');
    const days = daysBetween(jDate, closing);
    const lowRate = Math.min(contractRate || 0.04, ASSUMPTIONS.legalRate);
    const highRate = Math.max(contractRate || 0, ASSUMPTIONS.legalRate);
    const intLow = j.amount * 0.9 * lowRate / 365 * days;   // contract rate runs on principal only
    const intHigh = j.amount * highRate / 365 * days;
    // Default judgments carry the complaint's figures, so tax/insurance advances
    // since the complaint are missing from them. Other judgments use a fresh affidavit.
    const escrowFrom = j.kind === 'default' ? toDate(c.commencedDate) || jDate : jDate;
    // A lien case (municipal/tax claim) or a home-equity loan has no servicer
    // advancing taxes (the first-mortgage servicer does that).
    const escrow = c.caseTypeKind === 'lien' || juniorPlaintiff
      ? { low: 0, high: 0 }
      : escrowBand(daysBetween(escrowFrom, closing) / 365, inputs);
    if (!(c.caseTypeKind === 'lien' || juniorPlaintiff)) {
      const yrs = daysBetween(escrowFrom, closing) / 365;
      escrow.high = advancesHigh(escrow.high, j.amount * 0.9, yrs);
      advancesPerYearHigh = yrs > 0 ? escrow.high / yrs : 0;
    }
    perDiemHigh = j.amount * highRate / 365;

    lines.push({ label: `Judgment (${isoDate(jDate)}${j.kind === 'default' ? ', default' : j.kind === 'summary' ? ', summary' : ''})`, low: j.amount, high: j.amount });
    lines.push({ label: `Interest since judgment (${days} days)`, low: intLow, high: intHigh });
    lines.push({ label: `Taxes + insurance advanced since ${isoDate(escrowFrom)}`, low: escrow.low, high: escrow.high });
    lines.push({ label: `Attorney fees + sheriff costs (${stage} stage)`, low: fees.low, high: fees.high });
    basis = c.caseTypeKind === 'lien'
      ? 'Court judgments/liens, rolled forward'
      : 'Judgment on the court docket, rolled forward';
  } else if (seniorAmount && seniorDate) {
    // ---- Tier C: rebuild the loan from the recorded mortgage ----
    tier = 'C';
    const filed = toDate(c.commencedDate) || asOf;
    const defaultDate = addMonths(filed, -ASSUMPTIONS.monthsComplaintAfterDefault);
    const firstPayment = new Date(seniorDate.getFullYear(), seniorDate.getMonth() + 1, 1);
    const paid = Math.max(0,
      (defaultDate.getFullYear() - firstPayment.getFullYear()) * 12 +
      (defaultDate.getMonth() - firstPayment.getMonth()) + 1);
    const rLow = contractRate - (rateGiven != null ? 0 : 0.00375);
    const rHigh = contractRate + (rateGiven != null ? 0 : 0.00375);
    // Higher rate -> slower paydown and more interest, so it bounds the high side.
    const balLow = amortizedBalance(seniorAmount, rLow, 360, paid);
    const balHigh = amortizedBalance(seniorAmount, rHigh, 360, paid) * (looksModified ? 1.2 : 1);
    const days = daysBetween(defaultDate, closing);
    const escrow = escrowBand(days / 365, inputs);
    escrow.high = advancesHigh(escrow.high, balHigh, days / 365);
    advancesPerYearHigh = days > 0 ? escrow.high / (days / 365) : 0;
    perDiemHigh = balHigh * rHigh / 365;

    lines.push({ label: `Principal at default (~${isoDate(defaultDate)}), from $${round(seniorAmount).toLocaleString()} recorded ${isoDate(seniorDate)}`, low: balLow, high: balHigh });
    lines.push({ label: `Interest since default at ${(rLow * 100).toFixed(2)}–${(rHigh * 100).toFixed(2)}%`, low: balLow * rLow / 365 * days, high: balHigh * rHigh / 365 * days });
    lines.push({ label: 'Taxes + insurance advanced since default', low: escrow.low, high: escrow.high });
    lines.push({ label: `Attorney fees + costs (${stage} stage)`, low: fees.low, high: fees.high });
    basis = rateGiven != null
      ? 'Recorded mortgage, amortized at the rate you entered'
      : `Recorded mortgage, amortized at the ${seniorDate.getFullYear()} market rate (assumed)`;
    if (looksModified) flags.push('Loan may have been modified (old securitized loan or a recorded modification). The high end includes +20% principal. Buying the complaint would settle it.');
  } else {
    tier = null;
    basis = c.mortgageBook
      ? `No judgment yet. Recorder data is needed to estimate from mortgage Bk ${c.mortgageBook} / Pg ${c.mortgagePage}.`
      : 'No judgment yet and no mortgage book/page on the docket. Recorder data is needed.';
  }

  if (tier) {
    seniorBand = {
      low: lines.reduce((s, l) => s + l.low, 0),
      high: lines.reduce((s, l) => s + l.high, 0)
    };
  }

  // ---- Junior liens ----
  const juniors = [];
  const seniorRecorded = senior ? senior.recorded : null;

  // Other open court cases on the same parcel (municipal/tax liens, a second
  // mortgage's own foreclosure). Their judgment is a better number than a
  // recorded face amount, so a matching recorded mortgage is dropped below.
  const coveredByCourt = new Set();
  for (const s of inputs.courtCases || []) {
    if (isClosedCase(s)) continue;
    const kind = s.caseTypeKind === 'lien' ? 'Lien case' : s.caseTypeKind === 'mortgage' ? 'Mortgage case' : 'Court case';
    const who = String(s.plaintiff || '').slice(0, 60);
    const sb = parseInt(s.mortgageBook, 10), sp = parseInt(s.mortgagePage, 10);
    const rec = mortgages.find(mt => mt.book === sb && mt.page === sp);
    if (rec && rec !== senior) coveredByCourt.add(rec);
    const amt = money(s.judgmentAmount);
    if (amt == null) {
      juniors.push({ label: `${kind} ${s.caseNumber} (${who}): no judgment yet, amount unknown`, low: 0, high: 0, court: true, unknown: true });
      flags.push(`Court case ${s.caseNumber} on this parcel has no judgment amount yet. It is not in the total.`);
      continue;
    }
    const sf = extractDocketFacts(s);
    const since = (sf.judgment && sf.judgment.date) || toDate(s.commencedDate) || asOf;
    const yrs = daysBetween(since, closing) / 365;
    juniors.push({
      label: `${kind} ${s.caseNumber} (${who}), judgment`,
      low: amt,
      high: amt * (1 + ASSUMPTIONS.courtLienRate * yrs),
      court: true
    });
  }

  for (const mt of mortgages) {
    if (!mt.open || mt === senior || coveredByCourt.has(mt)) continue;
    if (mt.amount == null) continue;
    const prior = seniorRecorded && mt.recorded && mt.recorded < seniorRecorded && !isHud(mt);
    if (prior) {
      // Recorded before the foreclosed loan: it is ahead of it and survives the sheriff sale.
      const md = toDate(mt.recorded);
      const firstPay = new Date(md.getFullYear(), md.getMonth() + 1, 1);
      const paid = Math.max(0, (asOf.getFullYear() - firstPay.getFullYear()) * 12 + (asOf.getMonth() - firstPay.getMonth()));
      const bal = amortizedBalance(mt.amount, pmmsRate(md.getFullYear()), 360, paid);
      juniors.push({
        key: mt.key,
        label: `Prior mortgage ${mt.recorded}, $${round(mt.amount).toLocaleString()} face (ahead of the foreclosing loan; survives the sale)`,
        low: bal,
        high: Math.max(bal * 1.1, bal + 5000),
        prior: true
      });
      flags.push(`Mortgage ${mt.key} was recorded before the foreclosed loan and has no satisfaction on file, so it is counted as a prior lien. Untick it if it was paid off.`);
      continue;
    }
    if (isHud(mt)) {
      juniors.push({ key: mt.key, label: `HUD partial claim ${mt.recorded} (0% interest, face = payoff)`, low: mt.amount, high: mt.amount, exact: true });
    } else {
      const yrs = mt.recorded ? daysBetween(toDate(mt.recorded), closing) / 365 : 0;
      // Unpaid interest on a junior is capped: we never know when it stopped paying,
      // and an old loan has been paying down, not compounding, for most of its life.
      const unpaidYrs = Math.min(ASSUMPTIONS.junior.maxUnpaidYears, Math.max(0, yrs - ASSUMPTIONS.junior.unpaidFromYears));
      const old = yrs > ASSUMPTIONS.junior.oldYears;
      juniors.push({
        key: mt.key,
        label: `Mortgage ${mt.recorded}, $${round(mt.amount).toLocaleString()} face${old ? ' (old: may be paid off without a recorded satisfaction)' : ''}`,
        low: mt.amount * 0.95,
        high: mt.amount * (1 + ASSUMPTIONS.junior.rate * unpaidYrs),
        negotiable: true
      });
      if (old) flags.push(`Mortgage ${mt.key} (${mt.recorded}) is ${Math.floor(yrs)} years old with no satisfaction on file. It is counted at face plus interest; untick it if it was paid off.`);
    }
  }
  for (const l of inputs.otherLiens || []) {
    const amt = money(l.amount);
    if (amt == null) continue;
    juniors.push({ label: l.name || 'Other lien', low: amt, high: amt, manual: true });
  }

  const juniorBand = {
    low: juniors.reduce((s, j) => s + j.low, 0),
    high: juniors.reduce((s, j) => s + j.high, 0)
  };

  if (juniorPlaintiff) {
    flags.unshift(rows.length
      ? 'Plaintiff is a home-equity lender, so this is likely a 2nd mortgage. Any older open mortgage below is counted as a prior lien.'
      : 'Plaintiff is a home-equity lender, so this is likely a 2nd mortgage. A first mortgage probably sits AHEAD of it and is NOT in this total until Recorder data is pulled.');
  }
  if (!rows.length) flags.push('No Recorder data yet, so other mortgages are unknown. It is pulled after each Process All (or click Pull Recorder Data).');
  // A 3129 affidavit only matters while the foreclosure is live.
  const lienListLive = facts.lienListFiled && !closedForeclosure;
  if (lienListLive) {
    flags.push(`Rule 3129 affidavit filed${facts.lienListDate ? ' ' + facts.lienListDate : ''}: it names every lien holder of record (borough, Domestic Relations, Revenue, junior mortgages), the easiest way to see everything that must be paid off.`);
  }
  if (facts.bankruptcyDischarged) flags.push('Bankruptcy discharged. The owner is not personally liable, but liens stay on the house, which gives you leverage to negotiate a junior lien down.');
  if (facts.writReturned) flags.unshift('STOP: the docket shows the writ returned or a sheriff sale outcome. The house may already be sold. Verify with the Sheriff (610-278-3331) before pricing.');
  if (facts.saleContinued) flags.push('Sheriff sale was postponed. Check Bid4Assets for the new date.');
  if (facts.defendantHasLawyer) flags.push('Defendant has appeared or is contesting. Expect to deal through their lawyer.');

  const r = (b) => b ? { low: round(b.low), high: round(b.high) } : null;
  return {
    asOf: isoDate(asOf),
    closingDate: isoDate(closing),
    escrowTell,
    carryPerMonth: tier ? round(perDiemHigh * 30.44 + advancesPerYearHigh / 12) : null,
    tier,
    stage,
    basis,
    senior: r(seniorBand),
    seniorLines: lines.map(l => ({ label: l.label, low: round(l.low), high: round(l.high) })),
    juniors: juniors.map(j => ({ ...j, low: round(j.low), high: round(j.high) })),
    juniorTotal: r(juniorBand),
    total: sheriffDeed ? null
      : seniorBand ? { low: round(seniorBand.low + juniorBand.low), high: round(seniorBand.high + juniorBand.high) }
      : seniorSatisfied ? r(juniorBand) : null,
    sold: !!sheriffDeed,
    seniorSatisfied,
    contractRate: contractRate != null ? +(contractRate * 100).toFixed(3) : null,
    juniorPlaintiff,
    recorder: {
      rows: rows.length,
      mortgages: mortgages.map(mt => ({
        key: mt.key, recorded: mt.recorded, amount: mt.amount, open: mt.open, autoOpen: mt.autoOpen,
        satisfiedBy: mt.satisfiedBy, hud: isHud(mt), senior: mt === senior, parties: mt.parties
      }))
    },
    facts: {
      judgment: facts.judgment ? { ...facts.judgment, date: isoDate(facts.judgment.date) } : null,
      writFiled: facts.writFiled, lienListFiled: lienListLive, lienListDate: facts.lienListDate,
      saleContinued: facts.saleContinued, writReturned: facts.writReturned,
      bankruptcy: facts.bankruptcy, bankruptcyDischarged: facts.bankruptcyDischarged
    },
    flags
  };
}

module.exports = {
  estimatePayoff, extractDocketFacts, isClosedCase, parseRecorderIndex, resolveOpenMortgages,
  amortizedBalance, ASSUMPTIONS, PMMS_30YR
};
