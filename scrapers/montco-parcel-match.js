// Find the parcel for a MontCo case that has no parcel number (mortgage foreclosures),
// by looking up the defendant's street address on the county parcel layer and
// checking the parcel's owner against the defendant's surname.
//
// Match on zip, not town: the court shows the postal town ("LANSDALE") while the
// parcel layer has the municipality ("Towamencin Township").

const PARCEL_API_BASE = 'https://mapservices.pasda.psu.edu/server/rest/services/pasda/MontgomeryCounty/MapServer/14/query';
const OUT_FIELDS = 'PARCEL,PARCELTYPE,OWN1,OWN2,LOC_NO,LOC_DIR,LOC_STR,LOC_SUF,LOC_SUF2,LOC_UNITDE,LOC_UNITNO,LOC_ZIP1_Z,Muni_Name,ADDR1,ADDR3';
const CENSUS_GEOCODER = 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress';
const censusLocationCache = new Map();

const DIRECTIONS = { NORTH: 'N', SOUTH: 'S', EAST: 'E', WEST: 'W', N: 'N', S: 'S', E: 'E', W: 'W', NE: 'NE', NW: 'NW', SE: 'SE', SW: 'SW' };
const SUFFIXES = new Set([
  'ST', 'STREET', 'AVE', 'AV', 'AVENUE', 'RD', 'ROAD', 'DR', 'DRIVE', 'LN', 'LANE', 'WAY', 'CT', 'COURT',
  'CIR', 'CIRCLE', 'PL', 'PLACE', 'BLVD', 'BOULEVARD', 'TER', 'TERR', 'TERRACE', 'PIKE', 'PK', 'HWY', 'HIGHWAY',
  'PKWY', 'PARKWAY', 'TRL', 'TRAIL', 'ALY', 'ALLEY', 'SQ', 'SQUARE', 'RUN', 'XING', 'CROSSING', 'PATH', 'WALK', 'ROW'
]);
// Words the parcel layer abbreviates inside street names.
const NAME_ABBREV = {
  MOUNT: 'MT', SAINT: 'ST', FORT: 'FT',
  FIRST: '1ST', SECOND: '2ND', THIRD: '3RD', FOURTH: '4TH', FIFTH: '5TH',
  SIXTH: '6TH', SEVENTH: '7TH', EIGHTH: '8TH', NINTH: '9TH', TENTH: '10TH'
};
// The parcel layer writes units as "CONDO 22" / "UNIT B"; court addresses use APT, #, etc.
const UNIT_RE = /\s+(?:APT|APARTMENT|UNIT|CONDO|STE|SUITE|BLDG|BUILDING|FL|FLOOR|RM|ROOM|LOT|#)\b.*$|\s+#.*$/;
// Tokens in caption names that are never a surname.
const NAME_STOPWORDS = new Set([
  'THE', 'AND', 'ESTATE', 'OF', 'AS', 'ADMINISTRATOR', 'ADMINISTRATRIX', 'EXECUTOR', 'EXECUTRIX', 'HEIR', 'HEIRS',
  'UNKNOWN', 'DECEASED', 'SUCCESSORS', 'ASSIGNS', 'ALL', 'PERSONS', 'FIRMS', 'ASSOCIATIONS', 'ASSOCIA', 'CLAIMING',
  'RIGHT', 'TITLE', 'INTEREST', 'FROM', 'UNDER', 'JR', 'SR', 'II', 'III', 'IV', 'MR', 'MRS', 'MS', 'DR', 'LLC', 'INC',
  'TRUST', 'TRUSTEE', 'REAL', 'OWNER', 'OCCUPANT', 'OCCUPANTS', 'UNITED', 'STATES', 'AMERICA', 'SECRETARY', 'HOUSING'
]);

// "2070 VALLEY VIEW WAY APT 2" -> { number: 2070, name: 'VALLEY VIEW' }
function parseStreet(street) {
  const s = String(street || '').toUpperCase().replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim().replace(UNIT_RE, '');
  const m = s.match(/^(\d+)[A-Z]?(?:-\d+[A-Z]?)?\s+(.+)$/);
  if (!m) return null;
  const tokens = m[2].split(' ').filter(Boolean);
  if (tokens.length > 1 && DIRECTIONS[tokens[0]]) tokens.shift();
  if (tokens.length > 1 && DIRECTIONS[tokens[tokens.length - 1]]) tokens.pop();
  if (tokens.length > 1 && SUFFIXES.has(tokens[tokens.length - 1])) tokens.pop();
  const name = tokens.map(t => NAME_ABBREV[t] || t).join(' ');
  if (!name) return null;
  return { number: parseInt(m[1], 10), name };
}

// "HARKINS, KEVIN J" -> ['HARKINS']; "SMITH-JONES, ANN" -> ['SMITH-JONES', 'SMITH', 'JONES'];
// estate captions without a comma fall back to every name-like word.
function surnamesFrom(defendant) {
  const raw = String(defendant || '').toUpperCase();
  const pick = (text) => text.split(/[^A-Z'-]+/).filter(t => t.length >= 3 && !NAME_STOPWORDS.has(t));
  let names;
  if (raw.includes(',')) names = pick(raw.split(',')[0]);
  else names = pick(raw);
  const out = new Set();
  for (const n of names) {
    out.add(n);
    if (n.includes('-')) n.split('-').filter(p => p.length >= 3).forEach(p => out.add(p));
  }
  return [...out];
}

function ownerMatches(attrs, surnames) {
  const owner = `${attrs.OWN1 || ''} ${attrs.OWN2 || ''}`.toUpperCase();
  const words = new Set(owner.split(/[^A-Z'-]+/).filter(Boolean));
  for (const w of [...words]) if (w.includes('-')) w.split('-').forEach(p => words.add(p));
  return surnames.some(s => words.has(s));
}

function locationAddress(a) {
  const unit = [a.LOC_UNITDE, a.LOC_UNITNO].map(x => (x || '').trim()).filter(Boolean).join(' ');
  return [a.LOC_NO, a.LOC_DIR, a.LOC_STR, a.LOC_SUF, a.LOC_SUF2, unit]
    .map(x => (x == null ? '' : String(x)).trim()).filter(Boolean).join(' ');
}

function normalizeMunicipalityCity(value) {
  return String(value || '')
    .replace(/^Municipality of\s+/i, '')
    .replace(/\s+(borough|township|city|town)\s*$/i, '')
    .trim();
}

function parseMailingLocality(value) {
  const m = String(value || '').trim().match(/^(.+?)\s+PA\s+(\d{5})(?:-\d{4})?$/i);
  return m ? { city: m[1].trim(), zip: m[2] } : { city: '', zip: '' };
}

function sameText(a, b) {
  return String(a || '').toUpperCase().replace(/[^A-Z0-9]/g, '') ===
    String(b || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function sameStreet(a, b) {
  const left = parseStreet(a);
  const right = parseStreet(b);
  return !!(left && right && left.number === right.number && left.name === right.name);
}

function parcelMatchFromRow(row) {
  if (!row) return null;
  const muni = (row.Muni_Name || '').trim();
  const ownerMailing = parseMailingLocality(row.ADDR3);
  return {
    parcel: row.PARCEL,
    confidence: 'owner',
    street: locationAddress(row),
    city: normalizeMunicipalityCity(muni),
    zip: String(row.LOC_ZIP1_Z || '').trim().slice(0, 5),
    owner: [row.OWN1, row.OWN2].map(x => (x || '').trim()).filter(Boolean).join(' / '),
    municipality: muni,
    parcelType: (row.PARCELTYPE || '').trim(),
    ownerMailingStreet: String(row.ADDR1 || '').trim(),
    ownerMailingCity: ownerMailing.city,
    ownerMailingZip: ownerMailing.zip
  };
}

function hybridLocationLooksContaminated(c, match) {
  if (!c || !match || !match.ownerMailingStreet || !match.ownerMailingCity) return false;
  if (!sameStreet(c.propertyAddress, match.street)) return false;
  if (sameStreet(match.street, match.ownerMailingStreet)) return false;

  const caseCity = String(c.propertyCity || '').trim();
  const caseZip = String(c.propertyZip || '').trim().slice(0, 5);
  const mailingCityMatches = !!caseCity && sameText(caseCity, match.ownerMailingCity);
  const mailingZipMatches = !!caseZip && caseZip === match.ownerMailingZip;

  // Requiring both parts avoids replacing legitimate postal towns that differ
  // from their legal municipality (for example Lansdale / Towamencin Township).
  return mailingCityMatches && mailingZipMatches;
}

async function censusPropertyLocation(street, municipality) {
  const city = normalizeMunicipalityCity(municipality);
  const parsedStreet = parseStreet(street);
  if (!parsedStreet || !city) return null;
  const key = `${parsedStreet.number}|${parsedStreet.name}|${city.toUpperCase()}`;
  if (censusLocationCache.has(key)) return censusLocationCache.get(key);

  let location = null;
  try {
    const params = new URLSearchParams({
      address: `${street}, ${city}, PA`,
      benchmark: 'Public_AR_Current',
      format: 'json'
    });
    const response = await fetch(`${CENSUS_GEOCODER}?${params}`, { signal: AbortSignal.timeout(12000) });
    if (response.ok) {
      const data = await response.json();
      const matches = (data?.result?.addressMatches || []).filter(item => {
        const candidateStreet = String(item.matchedAddress || '').split(',')[0];
        return sameStreet(street, candidateStreet);
      });
      if (matches.length === 1) {
        const item = matches[0];
        location = {
          city: String(item.addressComponents?.city || city).trim(),
          zip: String(item.addressComponents?.zip || '').trim().slice(0, 5),
          matchedAddress: String(item.matchedAddress || '').trim(),
          source: 'US Census Geocoder'
        };
      }
    }
  } catch (e) {
    location = null;
  }
  censusLocationCache.set(key, location);
  return location;
}

async function repairHybridLocation(c, match) {
  if (!hybridLocationLooksContaminated(c, match)) {
    return { match, suspicious: false, repaired: false };
  }

  const verified = await censusPropertyLocation(match.street, match.municipality || match.city);
  if (!verified || !verified.zip) {
    return {
      match,
      suspicious: true,
      repaired: false,
      reason: 'Property locality matched the owner mailing address, but Census could not verify a replacement ZIP'
    };
  }

  const currentCity = String(c.propertyCity || '').trim();
  const currentZip = String(c.propertyZip || '').trim().slice(0, 5);
  if (sameText(currentCity, verified.city) && currentZip === verified.zip) {
    // The owner happens to receive mail in the same postal locality as the
    // property. Nothing is contaminated, even though the streets differ.
    return { match, suspicious: false, repaired: false };
  }

  return {
    suspicious: true,
    repaired: true,
    match: {
      ...match,
      city: verified.city || normalizeMunicipalityCity(match.municipality),
      zip: verified.zip,
      locationCorrection: {
        originalCity: currentCity,
        originalZip: currentZip,
        correctedCity: verified.city,
        correctedZip: verified.zip,
        matchedAddress: verified.matchedAddress,
        reason: 'Displayed locality matched the parcel owner mailing address instead of the property location',
        source: verified.source,
        correctedAt: new Date().toISOString()
      }
    }
  };
}

async function queryParcels(where) {
  const params = new URLSearchParams({ where, outFields: OUT_FIELDS, returnGeometry: 'false', f: 'json' });
  const resp = await fetch(`${PARCEL_API_BASE}?${params}`, { signal: AbortSignal.timeout(15000) });
  if (!resp.ok) throw new Error(`parcel API HTTP ${resp.status}`);
  const data = await resp.json();
  if (data.error) throw new Error(`parcel API: ${data.error.message || 'error'}`);
  return (data.features || []).map(f => f.attributes);
}

const sqlEsc = (s) => String(s).replace(/'/g, "''");

async function lookupParcelById(parcelRaw) {
  const parcel = String(parcelRaw || '').replace(/\D/g, '');
  if (parcel.length !== 12) return null;
  const rows = await queryParcels(`PARCEL='${sqlEsc(parcel)}'`);
  return rows.length === 1 ? parcelMatchFromRow(rows[0]) : null;
}

function parcelMatchesCase(match, { street, zip, defendant } = {}) {
  if (!match) return { confirmed: false, addressMatch: false, ownerMatch: false };
  const wantedStreet = parseStreet(street);
  const parcelStreet = parseStreet(match.street);
  const wantedZip = String(zip || '').trim().slice(0, 5);
  const parcelZip = String(match.zip || '').trim().slice(0, 5);
  const hasAddress = !!wantedStreet;
  const addressMatch = !!(wantedStreet && parcelStreet &&
    wantedStreet.number === parcelStreet.number && wantedStreet.name === parcelStreet.name);
  const zipMatch = !wantedZip || !parcelZip || wantedZip === parcelZip;
  const surnames = surnamesFrom(defendant);
  const hasOwner = surnames.length > 0;
  const ownerMatch = hasOwner && ownerMatches({ OWN1: match.owner, OWN2: '' }, surnames);
  return {
    confirmed: (hasAddress || hasOwner) && (!hasAddress || addressMatch) && (!hasOwner || ownerMatch),
    addressMatch,
    ownerMatch,
    zipMatch
  };
}

/**
 * @returns {Promise<null | {
 *   parcel, confidence: 'owner'|'address', street, city, zip, owner, municipality
 * }>}
 *   'owner'   — address and an owner surname agree: treat as the property.
 *   'address' — the address is a parcel, but its owner isn't the defendant (sold, LLC, typo).
 *   null      — no single parcel at that address.
 * Throws on network/API errors so callers can tell "no match" from "couldn't check".
 */
async function matchParcelByAddress({ street, city, zip, defendant }) {
  const parsed = parseStreet(street);
  if (!parsed) return null;
  const zip5 = String(zip || '').slice(0, 5);
  const surnames = surnamesFrom(defendant);

  let rows = await queryParcels(`LOC_NO=${parsed.number} AND LOC_STR LIKE '${sqlEsc(parsed.name)}%'`);
  // Street name spelled differently (e.g. "VALLEYVIEW"): retry on the first word, then let zip/owner narrow it.
  if (rows.length === 0 && parsed.name.includes(' ')) {
    const first = parsed.name.split(' ')[0];
    // 3 letters is enough ("SAW MILL"): house number, zip and owner still narrow it down.
    if (first.length >= 3) rows = await queryParcels(`LOC_NO=${parsed.number} AND LOC_STR LIKE '${sqlEsc(first)}%'`);
  }
  if (rows.length === 0) return null;

  // Keep parcels in the defendant's zip. Parcels with no zip on file stay in as possibles.
  if (zip5) {
    const sameZip = rows.filter(a => String(a.LOC_ZIP1_Z || '').startsWith(zip5));
    const noZip = rows.filter(a => !String(a.LOC_ZIP1_Z || '').trim());
    rows = sameZip.length ? sameZip : noZip;
  }
  if (rows.length === 0) return null;

  const owned = surnames.length ? rows.filter(a => ownerMatches(a, surnames)) : [];
  let pick = null;
  let confidence = null;
  if (owned.length >= 1) {
    // Several parcels at one address all owned by the defendant (house + side lot): any is right.
    pick = owned[0];
    confidence = 'owner';
  } else if (rows.length === 1) {
    pick = rows[0];
    confidence = 'address';
  }
  if (!pick) return null;

  const match = parcelMatchFromRow(pick);
  match.confidence = confidence;
  if (!match.zip) match.zip = zip5;
  return (await repairHybridLocation({
    propertyAddress: street,
    propertyCity: city,
    propertyZip: zip
  }, match)).match;
}

/**
 * Apply a match to a pipeline case in place. Returns the confidence applied, or null.
 * Owner-confirmed matches become the property address; address-only matches keep the
 * defendant address (and its warning) but record the parcel and who owns it now.
 */
function applyParcelMatch(c, match) {
  if (!match) {
    // A re-run that no longer finds an address-only match drops it, so the card doesn't
    // keep a parcel number nothing supports any more.
    if (c.parcelMatch && c.parcelMatch.confidence === 'address') {
      if (c.parcelNumber === c.parcelMatch.parcel) c.parcelNumber = '';
      c.propertyOwner = '';
      c.propertyMunicipality = '';
      delete c.parcelMatch;
    }
    c.parcelMatchStatus = 'none';
    return null;
  }
  c.parcelMatchStatus = match.confidence;
  c.parcelMatch = {
    parcel: match.parcel,
    confidence: match.confidence,
    owner: match.owner,
    municipality: match.municipality,
    matchedFrom: [c.propertyAddress, c.propertyZip].filter(Boolean).join(' '),
    matchedAt: new Date().toISOString()
  };
  c.parcelNumber = match.parcel;
  c.propertyOwner = match.owner;
  c.propertyMunicipality = match.municipality;
  c.parcelType = match.parcelType || '';
  if (match.confidence === 'owner') {
    c.propertyAddress = match.street;
    // Same house as the defendant address, so keep its postal town ("LANSDALE"):
    // Zillow and Maps search better on it than on the township name.
    c.propertyCity = match.locationCorrection ? match.city : (c.propertyCity || match.city);
    c.propertyState = 'PA';
    c.propertyZip = match.locationCorrection ? match.zip : (match.zip || c.propertyZip);
    c.inMontgomeryCounty = true;
    c.addressSource = 'parcel-match';
    if (match.locationCorrection) c.addressCorrection = match.locationCorrection;
  }
  return match.confidence;
}

// "MORTGAGE BK# 11527 PAGE 1951" -> { book: '11527', page: '1951' }
function parseMortgageBookPage(remarks) {
  const m = String(remarks || '').match(/\bBK\s*#?\s*(\d+)\s*(?:,|\/)?\s*(?:PAGE|PG)\s*#?\s*(\d+)/i);
  return m ? { book: m[1], page: m[2] } : null;
}

module.exports = {
  matchParcelByAddress, lookupParcelById, parcelMatchesCase, applyParcelMatch,
  repairHybridLocation, hybridLocationLooksContaminated, normalizeMunicipalityCity,
  parseStreet, surnamesFrom, parseMortgageBookPage
};
