// Map coordinates for Camden pipeline cases.
//
// Enrichment has already resolved each case to a street address in a known
// municipality, so the parcel is found again by exactly that: municipality code +
// the MOD-IV property location. That reuses the answer enrichment settled on and
// can be asked for a hundred addresses at a time. A case whose address is not in
// the parcel layer under that spelling (a manually entered address, say) is placed
// by the US Census geocoder instead. Results are cached by municipality / address,
// not by case, so each property is only ever looked up once.

const { resolveMunCodes } = require('./camden-enrichment');
const { centroidOf, geocodeAddresses, isHit, isFreshMiss } = require('./montco-coords');

const PARCEL_URL = 'https://maps.nj.gov/arcgis/rest/services/Framework/Cadastral/MapServer/0/query';
const PARCEL_CHUNK = 80;
const ADDRESS_CHUNK = 200;

const normAddress = value => String(value || '').toUpperCase().replace(/\s+/g, ' ').trim();
const sqlQuote = value => String(value == null ? '' : value).replace(/'/g, "''");

function munCodesFor(c) {
  if (c?.munCode) return [String(c.munCode).trim()];
  return resolveMunCodes(c?.town || '').trusted || [];
}

function parcelKeyFor(c) {
  const address = normAddress(c?.propertyAddress);
  const codes = munCodesFor(c);
  return address && codes.length ? `p:${codes.join('+')}|${address}` : '';
}

// "GLOUCESTER TWP" -> "GLOUCESTER": the geocoder knows places, not municipal titles.
function geocoderTown(c) {
  return normAddress(c?.uspsTown || c?.town).replace(/\s+(TWP|TOWNSHIP|BORO|BOROUGH|CITY)\.?$/, '');
}

function addressKeyFor(c) {
  const address = normAddress(c?.propertyAddress);
  const town = geocoderTown(c);
  return /^\d/.test(address) && town ? `a:${address}|${town}|NJ` : '';
}

function coordsForCase(c, cache) {
  for (const key of [parcelKeyFor(c), addressKeyFor(c)]) {
    if (key && isHit(cache[key])) return cache[key];
  }
  return null;
}

// What still needs a lookup. An address is only geocoded when the case has no
// parcel key, or its parcel lookup already came back empty.
function pendingLookups(cases, cache, now = Date.now()) {
  const parcels = new Set();
  const addresses = new Map();
  for (const c of cases || []) {
    if (coordsForCase(c, cache)) continue;
    const pKey = parcelKeyFor(c);
    if (pKey && !isFreshMiss(cache[pKey], now)) { parcels.add(pKey); continue; }
    const aKey = addressKeyFor(c);
    if (!aKey || isFreshMiss(cache[aKey], now) || addresses.has(aKey)) continue;
    addresses.set(aKey, { street: normAddress(c.propertyAddress), city: geocoderTown(c), state: 'NJ', zip: '' });
  }
  return { parcels: [...parcels], addresses: [...addresses] };
}

// keys: ["p:0408|123 MAIN ST", ...] sharing one municipality-code set.
// Returns Map(address -> [lat, lng]).
async function lookupParcelCentres(codes, addresses) {
  const where = `PCL_MUN IN (${codes.map(c => `'${sqlQuote(c)}'`).join(',')}) AND PROP_LOC IN (${addresses.map(a => `'${sqlQuote(a)}'`).join(',')})`;
  const body = new URLSearchParams({ where, outFields: 'PROP_LOC', returnGeometry: 'true', outSR: '4326', f: 'json' });
  const response = await fetch(PARCEL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(45000)
  });
  if (!response.ok) throw new Error(`NJ parcel service HTTP ${response.status}`);
  const data = await response.json();
  if (data.error) throw new Error(`NJ parcel service: ${data.error.message || 'error'}`);
  const out = new Map();
  for (const feature of data.features || []) {
    const address = normAddress(feature.attributes?.PROP_LOC);
    const centre = centroidOf(feature.geometry);
    // Several parcels can share one location (condo units): they are the same spot.
    if (address && centre && !out.has(address)) out.set(address, centre);
  }
  return out;
}

/**
 * Look up every missing coordinate and write it into `cache` (mutated in place).
 * `save` is called after each batch so progress survives a restart.
 */
async function fillCoords({ cases, cache, save = async () => {}, onProgress = () => {} }) {
  const first = pendingLookups(cases, cache);
  let total = first.parcels.length + first.addresses.length;
  let done = 0;
  onProgress({ total, done });
  const missStamp = () => ({ miss: new Date().toISOString() });

  // Group by municipality so each request is one "these addresses in this town".
  const byMun = new Map();
  for (const key of first.parcels) {
    const [codes] = key.slice(2).split('|');
    if (!byMun.has(codes)) byMun.set(codes, []);
    byMun.get(codes).push(key);
  }
  for (const [codes, keys] of byMun) {
    for (let i = 0; i < keys.length; i += PARCEL_CHUNK) {
      const chunk = keys.slice(i, i + PARCEL_CHUNK);
      const addressOf = key => key.slice(key.indexOf('|') + 1);
      const found = await lookupParcelCentres(codes.split('+'), chunk.map(addressOf));
      for (const key of chunk) cache[key] = found.get(addressOf(key)) || missStamp();
      done += chunk.length;
      await save();
      onProgress({ total, done });
    }
  }

  // Addresses the parcel layer did not have fall through to the geocoder.
  const remaining = pendingLookups(cases, cache).addresses;
  total = first.parcels.length + remaining.length;
  for (let i = 0; i < remaining.length; i += ADDRESS_CHUNK) {
    const chunk = remaining.slice(i, i + ADDRESS_CHUNK);
    const found = await geocodeAddresses(chunk.map(([, a], n) => ({ id: String(n), ...a })));
    chunk.forEach(([key], n) => { cache[key] = found.get(String(n)) || missStamp(); });
    done += chunk.length;
    await save();
    onProgress({ total, done });
  }
  return { total, done };
}

module.exports = { fillCoords, pendingLookups, coordsForCase, parcelKeyFor, addressKeyFor };
