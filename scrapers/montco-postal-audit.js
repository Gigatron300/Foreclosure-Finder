const {
  lookupParcelsByIds,
  parcelMatchesCase,
  repairHybridLocation,
  applyParcelMatch,
  normalizeMunicipalityCity,
  sameStreet,
  parcelDistanceMeters
} = require('./montco-parcel-match');

const POSTAL_CITY_VERSION = 1;
const CENSUS_BATCH_URL = 'https://geocoding.geo.census.gov/geocoder/locations/addressbatch';

const parcelKey = value => String(value || '').replace(/\D/g, '');

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
      if (quoted && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        quoted = !quoted;
      }
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

function postalParts(matchedAddress) {
  const parts = String(matchedAddress || '').split(',').map(value => value.trim()).filter(Boolean);
  if (parts.length < 4) return null;
  const zip = parts.at(-1).match(/\b(\d{5})\b/)?.[1] || '';
  const state = parts.at(-2).toUpperCase();
  const city = parts.at(-3);
  const street = parts.slice(0, -3).join(', ');
  return state === 'PA' && city && zip && street ? { street, city, zip } : null;
}

async function geocodeBatch(records) {
  if (!records.length) return new Map();
  const csv = records.map(record => [
    record.id,
    record.street,
    record.zip ? '' : record.municipality,
    'PA',
    record.zip
  ].map(csvField).join(',')).join('\n') + '\n';

  const form = new FormData();
  form.append('addressFile', new Blob([csv], { type: 'text/csv' }), 'montco-addresses.csv');
  form.append('benchmark', 'Public_AR_Current');
  const response = await fetch(CENSUS_BATCH_URL, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(120000)
  });
  if (!response.ok) throw new Error(`Census batch geocoder HTTP ${response.status}`);

  const out = new Map();
  const text = await response.text();
  for (const line of text.split(/\r?\n/).filter(Boolean)) {
    const fields = parseCsvLine(line);
    const id = parcelKey(fields[0]);
    if (!id) continue;
    out.set(id, {
      status: fields[2] || '',
      matchType: fields[3] || '',
      matchedAddress: fields[4] || '',
      coordinates: (() => {
        const [x, y] = String(fields[5] || '').split(',').map(Number);
        return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
      })()
    });
  }
  return out;
}

function isReliableParcelCase(c) {
  const source = String(c?.addressSource || '');
  return !!(c?.propertyAddress && parcelKey(c.parcelNumber).length === 12 &&
    (source === 'parcel' || source === 'parcel-match'));
}

async function normalizePostalCities({
  cases,
  onlyPending = true,
  shouldStop = () => false,
  onProgress = () => {},
  onCheckpoint = async () => {}
} = {}) {
  const groups = new Map();
  for (const c of cases || []) {
    if (!isReliableParcelCase(c)) continue;
    const key = parcelKey(c.parcelNumber);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }

  const targetIds = [...groups.entries()]
    .filter(([, members]) => !onlyPending || members.some(c => c.postalCityAudit?.version !== POSTAL_CITY_VERSION))
    .map(([key]) => key);
  const result = {
    total: targetIds.length,
    processed: 0,
    verified: 0,
    changed: 0,
    failed: 0,
    hybridRepaired: 0,
    hybridReverted: 0
  };
  if (!targetIds.length) return result;

  onProgress({ ...result, phase: 'postal-city', step: 'county-parcels' });
  const countyMatches = await lookupParcelsByIds(targetIds);
  const records = [];

  for (const id of targetIds) {
    if (shouldStop()) break;
    const members = groups.get(id) || [];
    const match = countyMatches.get(id);
    const representative = members.find(c => sameStreet(c.propertyAddress, match?.street));
    if (!match || !representative) {
      result.failed++;
      continue;
    }

    // Revalidate earlier owner-mailing repairs before selecting the postal ZIP.
    for (const c of members.filter(item => item.addressCorrection?.source === 'US Census Geocoder')) {
      const audit = await repairHybridLocation(c, match);
      if (audit.repaired || audit.reverted) {
        applyParcelMatch(c, audit.match);
        if (audit.repaired) result.hybridRepaired++;
        if (audit.reverted) result.hybridReverted++;
      }
    }

    const zip = String(match.zip || representative.propertyZip || '').trim().slice(0, 5);
    records.push({
      id,
      street: match.street,
      zip: /^\d{5}$/.test(zip) ? zip : '',
      municipality: normalizeMunicipalityCity(match.municipality || match.city),
      match,
      members
    });
  }

  const BATCH_SIZE = 2500;
  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    if (shouldStop()) break;
    const batch = records.slice(i, i + BATCH_SIZE);
    onProgress({ ...result, phase: 'postal-city', step: 'census', currentBatch: Math.floor(i / BATCH_SIZE) + 1 });
    let geocoded;
    try {
      geocoded = await geocodeBatch(batch);
    } catch (e) {
      result.failed += batch.length;
      continue;
    }

    for (const record of batch) {
      const census = geocoded.get(record.id);
      const postal = postalParts(census?.matchedAddress);
      const distance = parcelDistanceMeters(census?.coordinates, record.match.parcelGeometry);
      const valid = census?.status === 'Match' && census?.matchType === 'Exact' && postal &&
        sameStreet(record.street, postal.street) &&
        (!record.zip || postal.zip === record.zip) &&
        Number.isFinite(distance) && distance <= 250;
      result.processed++;
      if (!valid) {
        result.failed++;
        continue;
      }

      result.verified++;
      for (const c of record.members) {
        const originalCity = String(c.propertyCity || '').trim();
        const originalZip = String(c.propertyZip || '').trim().slice(0, 5);
        const changed = originalCity.toUpperCase() !== postal.city.toUpperCase() || originalZip !== postal.zip;
        c.propertyCity = postal.city.toUpperCase();
        c.propertyZip = postal.zip;
        c.propertyMunicipality = c.propertyMunicipality || record.match.municipality || '';
        c.postalCityAudit = {
          version: POSTAL_CITY_VERSION,
          parcel: record.id,
          originalCity,
          originalZip,
          postalCity: c.propertyCity,
          postalZip: c.propertyZip,
          matchedAddress: census.matchedAddress,
          source: 'US Census Batch Geocoder',
          parcelDistanceMeters: Math.round(distance),
          verifiedAt: new Date().toISOString()
        };
        if (changed) result.changed++;
      }
    }

    onProgress({ ...result, phase: 'postal-city', step: 'saving' });
    await onCheckpoint(result);
  }

  return result;
}

module.exports = {
  POSTAL_CITY_VERSION,
  normalizePostalCities,
  geocodeBatch,
  postalParts
};
