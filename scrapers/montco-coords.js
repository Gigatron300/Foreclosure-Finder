// Map coordinates for MontCo pipeline cases.
//
// A case with a county parcel number is placed at the centre of that parcel
// (county parcel layer). A case with only a street address is placed by the
// US Census geocoder. Results are cached by parcel / address, not by case, so
// a re-scrape or Clear Pipeline never has to look the same property up twice.

const { lookupParcelsByIds } = require('./montco-parcel-match');

const CENSUS_BATCH_URL = 'https://geocoding.geo.census.gov/geocoder/locations/addressbatch';
const PARCEL_CHUNK = 500;
const ADDRESS_CHUNK = 200;
// A lookup that found nothing is retried after this long (layer and geocoder updates).
const MISS_RETRY_MS = 14 * 24 * 60 * 60 * 1000;

const round6 = value => Math.round(value * 1e6) / 1e6;

function parcelKeyFor(c) {
  const first = String(c?.parcelNumber || '').split(',')[0].replace(/\D/g, '');
  return first.length === 12 ? `p:${first}` : '';
}

function addressKeyFor(c) {
  const street = String(c?.propertyAddress || '').toUpperCase().replace(/\s+/g, ' ').trim();
  const zip = String(c?.propertyZip || '').trim().slice(0, 5);
  const city = String(c?.propertyCity || '').toUpperCase().replace(/\s+/g, ' ').trim();
  const state = String(c?.propertyState || 'PA').toUpperCase().trim() || 'PA';
  if (!/^\d/.test(street) || (!zip && !city)) return '';
  return `a:${street}|${city}|${state}|${zip}`;
}

// The parcel is the better source: it is the property itself, where a geocoded
// address is only a point interpolated along the street.
function coordKeysFor(c) {
  return [parcelKeyFor(c), addressKeyFor(c)].filter(Boolean);
}

function isHit(entry) {
  return Array.isArray(entry) && entry.length === 2 && entry.every(Number.isFinite);
}

function isFreshMiss(entry, now = Date.now()) {
  return !!(entry && !Array.isArray(entry) && entry.miss && now - Date.parse(entry.miss) < MISS_RETRY_MS);
}

function coordsForCase(c, cache) {
  for (const key of coordKeysFor(c)) {
    if (isHit(cache[key])) return cache[key];
  }
  return null;
}

// Centre of the parcel's bounding box, as [lat, lng].
function centroidOf(geometry) {
  const points = (geometry?.rings || []).flat().filter(p => Array.isArray(p) && p.length >= 2);
  const xs = points.map(p => Number(p[0])).filter(Number.isFinite);
  const ys = points.map(p => Number(p[1])).filter(Number.isFinite);
  if (!xs.length || !ys.length) return null;
  const lng = (Math.min(...xs) + Math.max(...xs)) / 2;
  const lat = (Math.min(...ys) + Math.max(...ys)) / 2;
  return [round6(lat), round6(lng)];
}

// What still needs a lookup. An address is only geocoded when the case has no
// parcel, or its parcel lookup already came back empty.
function pendingLookups(cases, cache, now = Date.now()) {
  const parcels = new Set();
  const addresses = new Map();
  for (const c of cases || []) {
    if (coordsForCase(c, cache)) continue;
    const pKey = parcelKeyFor(c);
    if (pKey && !cache[pKey]) { parcels.add(pKey); continue; }
    if (pKey && !isFreshMiss(cache[pKey], now) && !isHit(cache[pKey])) { parcels.add(pKey); continue; }
    const aKey = addressKeyFor(c);
    if (!aKey || isFreshMiss(cache[aKey], now)) continue;
    if (!addresses.has(aKey)) {
      addresses.set(aKey, {
        street: String(c.propertyAddress || '').trim(),
        city: String(c.propertyCity || '').trim(),
        state: String(c.propertyState || 'PA').trim() || 'PA',
        zip: String(c.propertyZip || '').trim().slice(0, 5)
      });
    }
  }
  return { parcels: [...parcels], addresses: [...addresses] };
}

function csvField(value) {
  return `"${String(value == null ? '' : value).replace(/"/g, '""')}"`;
}

function parseCsvLine(line) {
  const fields = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') { current += '"'; i++; }
      else quoted = !quoted;
    } else if (ch === ',' && !quoted) {
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

// records: [{ id, street, city, state, zip }] -> Map(id -> [lat, lng])
async function geocodeAddresses(records) {
  const out = new Map();
  if (!records.length) return out;
  const csv = records.map(r => [r.id, r.street, r.city, r.state, r.zip].map(csvField).join(',')).join('\n') + '\n';
  const form = new FormData();
  form.append('addressFile', new Blob([csv], { type: 'text/csv' }), 'addresses.csv');
  form.append('benchmark', 'Public_AR_Current');
  const response = await fetch(CENSUS_BATCH_URL, { method: 'POST', body: form, signal: AbortSignal.timeout(180000) });
  if (!response.ok) throw new Error(`Census batch geocoder HTTP ${response.status}`);
  const text = await response.text();
  for (const line of text.split(/\r?\n/).filter(Boolean)) {
    const fields = parseCsvLine(line);
    if ((fields[2] || '').trim() !== 'Match') continue;
    const [lng, lat] = String(fields[5] || '').split(',').map(Number);
    if (Number.isFinite(lat) && Number.isFinite(lng)) out.set(String(fields[0]).trim(), [round6(lat), round6(lng)]);
  }
  return out;
}

/**
 * Look up every missing coordinate and write it into `cache` (mutated in place).
 * `save` is called after each batch so progress survives a restart.
 */
async function fillCoords({ cases, cache, save = async () => {}, onProgress = () => {} }) {
  const { parcels, addresses } = pendingLookups(cases, cache);
  const total = parcels.length + addresses.length;
  let done = 0;
  onProgress({ total, done });
  const missStamp = () => ({ miss: new Date().toISOString() });

  for (let i = 0; i < parcels.length; i += PARCEL_CHUNK) {
    const chunk = parcels.slice(i, i + PARCEL_CHUNK);
    const found = await lookupParcelsByIds(chunk.map(key => key.slice(2)));
    for (const key of chunk) {
      cache[key] = centroidOf(found.get(key.slice(2))?.parcelGeometry) || missStamp();
    }
    done += chunk.length;
    await save();
    onProgress({ total, done });
  }

  // Parcels that came back empty fall through to their street address.
  const remaining = pendingLookups(cases, cache).addresses;
  const extra = remaining.length - addresses.length;
  for (let i = 0; i < remaining.length; i += ADDRESS_CHUNK) {
    const chunk = remaining.slice(i, i + ADDRESS_CHUNK);
    const found = await geocodeAddresses(chunk.map(([, a], n) => ({ id: String(n), ...a })));
    chunk.forEach(([key], n) => { cache[key] = found.get(String(n)) || missStamp(); });
    done += chunk.length;
    await save();
    onProgress({ total: total + Math.max(0, extra), done });
  }
  return { total: total + Math.max(0, extra), done };
}

module.exports = { fillCoords, pendingLookups, coordsForCase, centroidOf, geocodeAddresses, parcelKeyFor, addressKeyFor };
