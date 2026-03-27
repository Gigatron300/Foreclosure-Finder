const containsWholeWords = [
  'LLC',
  'MORTGAGE',
  'TRUST',
  'FUND',
  'CORP',
  'EQUITY',
  'LOAN',
  'CONSULTING',
  'PROPERTIES',
  'INVESTMENTS',
  'COUNTY',
  'HOUSING',
  'BANK',
  'PARTNERSHIP',
  'FINANCIAL',
  'DEVELOPMENT',
  'STATE',
  'UNITED STATES',
  'COMMISSION',
  'SERVICES',
  'NEW JERSEY',
  'INC',
  'INSURANCE',
  'CREDIT UNION',
  'SOCIETY',
  'CAMDEN COUNTY',
  'URBAN DEVELOPMENT',
  'FUNDING',
  'CAMDEN CITY',
  'ASSOCIATES',
  'INVESTMENT',
  'WSFS',
  'SERVICES',
  'FUNDING',
  'HOSPITAL',
  'CHURCH OF',
  'MEMORIAL',
  'CONSTRUCTION',
  'PARTNERS',
  'COMMUNITY'
];

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeNameForSkipMatch(name) {
  return String(name || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function hasWholeWordPhrase(name, phrase) {
  const normalizedName = normalizeNameForSkipMatch(name);
  const normalizedPhrase = normalizeNameForSkipMatch(phrase);
  if (!normalizedName || !normalizedPhrase) return false;
  const re = new RegExp(`(?:^|\\s)${escapeRegex(normalizedPhrase)}(?:\\s|$)`);
  return re.test(normalizedName);
}

function shouldSkipCourtSearchName(name) {
  return containsWholeWords.some(phrase => hasWholeWordPhrase(name, phrase));
}

module.exports = {
  containsWholeWords,
  normalizeNameForSkipMatch,
  hasWholeWordPhrase,
  shouldSkipCourtSearchName
};
