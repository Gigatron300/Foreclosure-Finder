// One key per defendant, so the same party is recognised across the court's
// different caption spellings: "WEINTRAUB HERBERT FOUNDATION LLC THE" and
// "HERBERT WEINTRAUB FOUNDATION LLC" are the same defendant.
//
// Names are compared as a set of words: order, punctuation and filler words
// (THE, LLC, INC, ...) are ignored. Middle initials still count, so
// "SMITH JOHN A" and "SMITH JOHN" stay apart. Two different people with the
// same name share a key, as they did with exact matching.

const FILLER = new Set(['THE', 'AND', 'LLC', 'INC', 'CORP', 'CORPORATION', 'CO', 'COMPANY', 'LTD', 'LP', 'LLP']);

function defendantKey(name) {
  const words = String(name || '').toUpperCase()
    .replace(/&/g, ' AND ')
    .replace(/\bET\s*AL\b/g, ' ')
    .replace(/[^A-Z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter(w => w && !FILLER.has(w));
  // "UNKNOWN HEIRS..." captions are not one person.
  if (!words.length || words.includes('UNKNOWN')) return '';
  return [...new Set(words)].sort().join(' ');
}

// Camden's "primary defendant" is sometimes a lienholder named in the suit (the
// State, a county agency, a lender) rather than the owner. Those would look like
// repeat defendants on hundreds of properties, so they get no key.
const INSTITUTION = /\b(STATE|COUNTY|UNITED STATES|NEW JERSEY|CITY OF|TOWNSHIP|BOROUGH|MUNICIPAL|AUTHORITY|AGENCY|DEPARTMENT|SECRETARY|COMMISSION|INTERNAL REVENUE|BANK|MORTGAGE|CREDIT UNION|FUNDING|FINANCE|FINANCIAL|LOAN|LENDING|HOUSING|INSURANCE|HOSPITAL|SERVICES|ASSOCIATION)\b/;
function ownerDefendantKey(name) {
  const upper = String(name || '').toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ');
  return INSTITUTION.test(upper) ? '' : defendantKey(name);
}

module.exports = { defendantKey, ownerDefendantKey };
