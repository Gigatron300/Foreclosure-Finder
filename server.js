require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs').promises;
const crypto = require('crypto');
const { runScraper, CONFIG } = require('./scraper');
const { runPipelineScraper, OUTPUT_FILE: PIPELINE_FILE } = require('./pipeline-scraper');
const { fetchParcelAddress } = require('./scrapers/montco-courts');
const { parseCSVLine, parseCamdenCSV, enrichCamdenCases, scoreCamdenCase, classifyDefendant } = require('./scrapers/camden-enrichment');
const { containsWholeWords, shouldSkipCourtSearchName } = require('./scrapers/search-skip-rules');
// NOTE: nj-courts-status.js Puppeteer scraper removed - NJ Courts blocks datacenter IPs with CAPTCHA
// Court status is now checked via browser-based bookmarklet (court-status-bookmarklet.js)

const app = express();
const PORT = process.env.PORT || 3000;

const SITE_PASSWORD = process.env.SITE_PASSWORD;
if (!SITE_PASSWORD) {
  console.error('SITE_PASSWORD environment variable is required. Set it before starting the server.');
  process.exit(1);
}
const STREETVIEW_MODE_PASSKEY = process.env.STREETVIEW_MODE_PASSKEY || '';

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.text({ limit: '10mb', type: 'text/csv' }));

const DATA_FILE = path.join(CONFIG.outputDir, CONFIG.outputFile);
const PIPELINE_DATA_FILE = path.join(CONFIG.outputDir, PIPELINE_FILE);
const CSV_FILE = path.join(CONFIG.outputDir, 'montco-cases.csv');
const CAMDEN_CSV_FILE = path.join(CONFIG.outputDir, 'camden-lis-pendens.csv');
const CAMDEN_DATA_FILE = path.join(CONFIG.outputDir, 'camden-pipeline.json');
const CAMDEN_COURT_REFRESH_BATCH_FILE = path.join(CONFIG.outputDir, 'camden-court-refresh-batch.json');
const CAMDEN_ANNOTATIONS_FILE = path.join(CONFIG.outputDir, 'camden-annotations.json');
const STREETVIEW_CACHE_DIR = path.join(CONFIG.outputDir, 'streetview-cache');
const STREETVIEW_CACHE_MAX_FILES = parseInt(process.env.STREETVIEW_CACHE_MAX_FILES || '4000', 10);
const STREETVIEW_CACHE_TTL_MS = parseInt(process.env.STREETVIEW_CACHE_TTL_MS || String(30 * 24 * 60 * 60 * 1000), 10);

async function ensureDataDir() {
  try { await fs.mkdir(CONFIG.outputDir, { recursive: true }); } catch (e) {}
}

async function ensureStreetViewCacheDir() {
  try { await fs.mkdir(STREETVIEW_CACHE_DIR, { recursive: true }); } catch (e) {}
}

function toCSVField(value) {
  const str = value == null ? '' : String(value);
  return /[",\r\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

const LATE_TAX_LIEN_SIGNALS = [
  'FINAL JUDGMENT',
  'WRIT OF EXECUTION',
  'FORECLOSURE WRIT NOTICE',
  'ALIAS WRIT',
  'WRIT RETURN'
];

function normalizeCourtDocket(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function findMatchingCourtDocket(normalizedCaseDocket, normalizedDockets) {
  return normalizedDockets.find(docket =>
    docket === normalizedCaseDocket ||
    normalizedCaseDocket.endsWith(docket) ||
    docket.endsWith(normalizedCaseDocket)
  ) || null;
}

function getCourtStageContext(c) {
  return [
    c.courtCaseType || '',
    c.courtDisposition || '',
    c.courtCaseActionsText || '',
    c.courtLatestActionText || ''
  ].join(' ').toUpperCase();
}

function isLateStageTaxLien(c) {
  if ((c.plaintiffType || '').toUpperCase() !== 'TAX_LIEN') return false;
  const context = getCourtStageContext(c);
  return LATE_TAX_LIEN_SIGNALS.some(signal => context.includes(signal));
}

function hasActiveOpenCourtState(c) {
  const rawStatus = String(c.courtStatusRaw || '').toUpperCase();
  const disposition = String(c.courtDisposition || '').toUpperCase();
  return /\bACTIVE\b/.test(rawStatus) || /\bOPEN\b/.test(disposition);
}

async function readJsonFileSafe(filePath, fallback = null) {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return JSON.parse(content);
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

function mapCaseForCourtStatus(c) {
  const searchCandidates = getCourtSearchCandidates(c);
  const searchNames = Array.from(new Set(searchCandidates.map(candidate => candidate.name).filter(Boolean)));

  return {
    instrumentNumber: c.instrumentNumber,
    defendant: c.primaryDefendant,
    searchCandidates,
    searchNames,
    allDefendants: (c.allDefendants || []).filter(n => n),
    plaintiff: c.primaryPlaintiff || '',
    filingDate: c.filingDateISO || c.filingDate || '',
    courtStatus: c.courtStatus || '',
    courtDocketNumber: c.courtDocketNumber || ''
  };
}

function getCourtSearchCandidates(c) {
  const allowSkipOverride = !!(c && c.courtDocketNumber);
  if (Array.isArray(c?.searchCandidates) && c.searchCandidates.length) {
    return c.searchCandidates
      .map(candidate => ({
        name: (candidate?.name || '').trim(),
        partyCode: (candidate?.partyCode || '').trim()
      }))
      .filter(candidate => candidate.name)
      .filter(candidate => allowSkipOverride || !shouldSkipCourtSearchName(candidate.name));
  }

  const receivingParties = (Array.isArray(c?.searchNames) && c.searchNames.length ? c.searchNames : (Array.isArray(c?.defendants) && c.defendants.length ? c.defendants : c?.allDefendants)) || [];
  const deliveryFallbacks = Array.isArray(c?.plaintiffs) ? c.plaintiffs.filter(name => classifyDefendant(name) !== 'ENTITY') : [];

  return Array.from(new Set(
    [
      ...receivingParties.map(name => JSON.stringify({ name: (name || '').trim(), partyCode: 'R' })),
      ...deliveryFallbacks.map(name => JSON.stringify({ name: (name || '').trim(), partyCode: 'D' }))
    ]
  ))
    .map(value => JSON.parse(value))
    .filter(candidate => candidate.name)
    .filter(candidate => allowSkipOverride || !shouldSkipCourtSearchName(candidate.name));
}

function hasCourtLookupInput(c) {
  return !!(c?.courtDocketNumber || getCourtSearchCandidates(c).length);
}

function getDefaultCourtStatusCases(data, { testMode = false } = {}) {
  let cases = (data.cases || []).filter(c => {
    const existingStatus = (c.courtStatus || '').trim().toUpperCase();
    if (existingStatus) return false;
    if (!hasCourtLookupInput(c)) return false;
    return true;
  }).map(mapCaseForCourtStatus);

  if (testMode) {
    cases = cases.slice(0, 10);
  }
  return cases;
}

function getCamdenOpenRefreshCases(data, { testMode = false } = {}) {
  let cases = (data.cases || []).filter(c => {
    const existingStatus = (c.courtStatus || '').toUpperCase();
    if (existingStatus !== 'OPEN' && existingStatus !== 'STAY' && existingStatus !== 'REINSTATED') return false;
    if (!c.courtDocketNumber) return false;
    if (!hasCourtLookupInput(c)) return false;
    return true;
  }).map(mapCaseForCourtStatus);

  if (testMode) {
    cases = cases.slice(0, 10);
  }
  return cases;
}

function getRemainingBatchCases(batch) {
  const completed = batch && batch.completed ? batch.completed : {};
  return (batch?.queue || []).filter(c => !completed[c.instrumentNumber]);
}

function getNextBatchInstrumentNumber(batch) {
  const nextCase = getRemainingBatchCases(batch)[0];
  return nextCase ? nextCase.instrumentNumber : null;
}

function summarizeCourtRefreshBatch(batch) {
  if (!batch) return null;
  const remainingCases = getRemainingBatchCases(batch);
  return {
    batchId: batch.batchId,
    status: batch.status,
    mode: batch.mode,
    testMode: !!batch.testMode,
    total: batch.total || (batch.queue || []).length,
    completedCount: Object.keys(batch.completed || {}).length,
    remainingCount: remainingCases.length,
    currentInstrumentNumber: batch.currentInstrumentNumber || getNextBatchInstrumentNumber(batch),
    startedAt: batch.startedAt || null,
    updatedAt: batch.updatedAt || null,
    completedAt: batch.completedAt || null
  };
}

async function loadCourtRefreshBatch() {
  return readJsonFileSafe(CAMDEN_COURT_REFRESH_BATCH_FILE, null);
}

async function saveCourtRefreshBatch(batch) {
  await ensureDataDir();
  await fs.writeFile(CAMDEN_COURT_REFRESH_BATCH_FILE, JSON.stringify(batch, null, 2));
}

function buildCourtRefreshBatch(cases, { testMode = false } = {}) {
  const now = new Date().toISOString();
  return {
    batchId: crypto.randomUUID(),
    mode: 'open-refresh',
    testMode,
    status: 'running',
    startedAt: now,
    updatedAt: now,
    completedAt: null,
    total: cases.length,
    queue: cases,
    completed: {},
    currentInstrumentNumber: cases[0] ? cases[0].instrumentNumber : null
  };
}

async function markCourtRefreshBatchProgress(batchId, instrumentNumber, status = '') {
  const batch = await loadCourtRefreshBatch();
  if (!batch || batch.status !== 'running' || batch.batchId !== batchId) {
    return null;
  }

  const hasCase = (batch.queue || []).some(c => c.instrumentNumber === instrumentNumber);
  if (!hasCase) {
    return batch;
  }

  const now = new Date().toISOString();
  batch.completed = batch.completed || {};
  batch.completed[instrumentNumber] = {
    at: now,
    status: status || ''
  };
  batch.updatedAt = now;

  const remaining = getRemainingBatchCases(batch);
  if (remaining.length === 0) {
    batch.status = 'completed';
    batch.completedAt = now;
    batch.currentInstrumentNumber = null;
  } else {
    batch.currentInstrumentNumber = remaining[0].instrumentNumber;
  }

  await saveCourtRefreshBatch(batch);
  return batch;
}

app.post('/api/auth', (req, res) => {
  const { password } = req.body;
  if (password === SITE_PASSWORD) res.json({ success: true });
  else res.status(401).json({ success: false, error: 'Invalid password' });
});

// Serve NJ Courts credentials for Tampermonkey auto-login after CAPTCHA recovery
app.get('/api/nj-courts-creds', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const token = req.query.token || req.headers['x-auth-token'];
  if (token !== SITE_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const user = process.env.NJ_COURTS_USER;
  const pass = process.env.NJ_COURTS_PASS;
  if (!user || !pass) return res.status(500).json({ error: 'NJ_COURTS_USER and NJ_COURTS_PASS env vars not set' });
  res.json({ user, pass });
});

const checkAuth = (req, res, next) => {
  const authHeader = req.headers['x-auth-token'];
  if (authHeader === SITE_PASSWORD) next();
  else res.status(401).json({ error: 'Unauthorized' });
};

function isAuthorized(req) {
  const authHeader = req.headers['x-auth-token'];
  const tokenQuery = req.query.token;
  return authHeader === SITE_PASSWORD || tokenQuery === SITE_PASSWORD;
}

app.get('/api/streetview-mode/config', checkAuth, (req, res) => {
  res.json({ requiresPasskey: !!STREETVIEW_MODE_PASSKEY });
});

app.post('/api/streetview-mode/unlock', checkAuth, (req, res) => {
  const passkey = (req.body?.passkey || '').toString();
  if (!STREETVIEW_MODE_PASSKEY) {
    return res.json({ success: true, unlocked: true, requiresPasskey: false });
  }
  if (passkey === STREETVIEW_MODE_PASSKEY) {
    return res.json({ success: true, unlocked: true, requiresPasskey: true });
  }
  return res.status(403).json({ success: false, unlocked: false, error: 'Invalid passkey' });
});

async function trimStreetViewCache() {
  try {
    const files = await fs.readdir(STREETVIEW_CACHE_DIR);
    if (files.length <= STREETVIEW_CACHE_MAX_FILES) return;

    const stats = await Promise.all(files.map(async (name) => {
      const filePath = path.join(STREETVIEW_CACHE_DIR, name);
      const st = await fs.stat(filePath);
      return { name, filePath, mtimeMs: st.mtimeMs };
    }));

    stats.sort((a, b) => a.mtimeMs - b.mtimeMs);
    const toDelete = stats.slice(0, stats.length - STREETVIEW_CACHE_MAX_FILES);
    await Promise.all(toDelete.map((f) => fs.unlink(f.filePath).catch(() => {})));
  } catch (e) {
    // best effort
  }
}

app.get('/api/streetview', async (req, res) => {
  try {
    if (!isAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });

    const location = (req.query.location || '').toString().trim();
    const size = (req.query.size || '600x400').toString().trim();
    const heading = (req.query.heading || '').toString().trim();
    const pitch = (req.query.pitch || '').toString().trim();
    const fov = (req.query.fov || '').toString().trim();
    const key = (req.query.key || process.env.GOOGLE_MAPS_API_KEY || '').toString().trim();

    if (!location) return res.status(400).json({ error: 'Missing location' });
    if (!key) return res.status(400).json({ error: 'Missing Google Maps API key' });
    if (!/^\d{2,4}x\d{2,4}$/.test(size)) return res.status(400).json({ error: 'Invalid size format' });

    const params = new URLSearchParams({ size, location, key });
    if (heading) params.set('heading', heading);
    if (pitch) params.set('pitch', pitch);
    if (fov) params.set('fov', fov);

    const cacheIdentity = `${size}|${location}|${heading}|${pitch}|${fov}`;
    const cacheKey = crypto.createHash('sha1').update(cacheIdentity).digest('hex');
    const cacheFile = path.join(STREETVIEW_CACHE_DIR, `${cacheKey}.jpg`);

    await ensureDataDir();
    await ensureStreetViewCacheDir();

    try {
      const st = await fs.stat(cacheFile);
      const ageMs = Date.now() - st.mtimeMs;
      if (ageMs <= STREETVIEW_CACHE_TTL_MS) {
        const bytes = await fs.readFile(cacheFile);
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Cache-Control', 'private, max-age=86400');
        return res.send(bytes);
      }
    } catch (e) {
      // cache miss/expired
    }

    const googleUrl = `https://maps.googleapis.com/maps/api/streetview?${params.toString()}`;
    const upstream = await fetch(googleUrl);
    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '');
      return res.status(upstream.status).send(text || 'Street View request failed');
    }

    const buffer = Buffer.from(await upstream.arrayBuffer());
    await fs.writeFile(cacheFile, buffer);
    trimStreetViewCache();

    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'image/jpeg');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    return res.send(buffer);
  } catch (error) {
    console.error('Street View proxy error:', error.message);
    return res.status(500).json({ error: 'Street View proxy failed' });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use(express.static('public'));

// ============== CSV UPLOAD ENDPOINT ==============

app.post('/api/pipeline/upload-csv', checkAuth, async (req, res) => {
  try {
    const { csvData, filename } = req.body;
    
    if (!csvData) {
      return res.status(400).json({ error: 'No CSV data provided' });
    }
    
    // Validate it looks like a CSV with expected headers
    const firstLine = csvData.split('\n')[0].toLowerCase();
    if (!firstLine.includes('casenumber') || !firstLine.includes('defendant')) {
      return res.status(400).json({ 
        error: 'Invalid CSV format. Make sure you exported from the Montgomery County court website.' 
      });
    }
    
    // Count rows
    const lines = csvData.split('\n').filter(l => l.trim());
    const rowCount = lines.length - 1; // Exclude header
    
    // Save to data directory
    await ensureDataDir();
    await fs.writeFile(CSV_FILE, csvData, 'utf8');
    
    res.json({ 
      success: true, 
      message: `CSV uploaded successfully`,
      filename: filename || 'montco-cases.csv',
      rowCount,
      savedTo: CSV_FILE
    });
    
  } catch (error) {
    console.error('CSV upload error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Check if CSV exists
app.get('/api/pipeline/csv-status', checkAuth, async (req, res) => {
  try {
    const stats = await fs.stat(CSV_FILE);
    const content = await fs.readFile(CSV_FILE, 'utf8');
    const lines = content.split('\n').filter(l => l.trim());
    
    res.json({
      exists: true,
      filename: 'montco-cases.csv',
      size: stats.size,
      rowCount: lines.length - 1,
      lastModified: stats.mtime
    });
  } catch (error) {
    res.json({ exists: false });
  }
});

// ============== PROPERTIES API ==============

app.get('/api/properties', checkAuth, async (req, res) => {
  try {
    const data = await fs.readFile(DATA_FILE, 'utf8');
    const jsonData = JSON.parse(data);
    let properties = jsonData.properties;
    
    if (req.query.maxDebt) properties = properties.filter(p => p.debtAmount <= parseFloat(req.query.maxDebt));
    if (req.query.county) properties = properties.filter(p => p.county === req.query.county);
    if (req.query.city) properties = properties.filter(p => p.city.toLowerCase().includes(req.query.city.toLowerCase()));
    if (req.query.minDebt) properties = properties.filter(p => p.debtAmount >= parseFloat(req.query.minDebt));
    
    const sortBy = req.query.sortBy || 'debtAmount';
    const sortOrder = req.query.sortOrder === 'desc' ? -1 : 1;
    properties.sort((a, b) => {
      if (sortBy === 'debtAmount') return (a.debtAmount - b.debtAmount) * sortOrder;
      if (sortBy === 'salesDate') return (new Date(a.salesDate) - new Date(b.salesDate)) * sortOrder;
      return 0;
    });
    
    res.json({ lastUpdated: jsonData.lastUpdated, totalProperties: properties.length, sources: jsonData.sources, properties });
  } catch (error) {
    if (error.code === 'ENOENT') {
      res.json({ lastUpdated: null, totalProperties: 0, sources: {}, properties: [], message: 'No data yet.' });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

app.get('/api/properties/:id', checkAuth, async (req, res) => {
  try {
    const data = await fs.readFile(DATA_FILE, 'utf8');
    const jsonData = JSON.parse(data);
    const property = jsonData.properties.find(p => p.propertyId === req.params.id);
    if (property) res.json(property);
    else res.status(404).json({ error: 'Property not found' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/stats', checkAuth, async (req, res) => {
  try {
    const data = await fs.readFile(DATA_FILE, 'utf8');
    const jsonData = JSON.parse(data);
    const properties = jsonData.properties;
    const stats = {
      lastUpdated: jsonData.lastUpdated,
      total: properties.length,
      bySources: jsonData.sources,
      byCounty: {},
      byStatus: {},
      debtRange: properties.length > 0 ? {
        min: Math.min(...properties.map(p => p.debtAmount)),
        max: Math.max(...properties.map(p => p.debtAmount)),
        avg: properties.reduce((sum, p) => sum + p.debtAmount, 0) / properties.length
      } : { min: 0, max: 0, avg: 0 }
    };
    properties.forEach(p => {
      stats.byCounty[p.county] = (stats.byCounty[p.county] || 0) + 1;
      stats.byStatus[p.status] = (stats.byStatus[p.status] || 0) + 1;
    });
    res.json(stats);
  } catch (error) {
    res.json({ lastUpdated: null, total: 0, bySources: {} });
  }
});

let isScrapingInProgress = false;
let lastScrapeStatus = null;

app.post('/api/scrape', checkAuth, async (req, res) => {
  if (isScrapingInProgress) return res.status(429).json({ error: 'Scrape already in progress', status: lastScrapeStatus });
  isScrapingInProgress = true;
  lastScrapeStatus = { started: new Date().toISOString(), status: 'running' };
  res.json({ message: 'Scrape started', status: lastScrapeStatus });
  try {
    const properties = await runScraper();
    lastScrapeStatus = { completed: new Date().toISOString(), status: 'completed', propertiesFound: properties.length };
  } catch (error) {
    lastScrapeStatus = { completed: new Date().toISOString(), status: 'error', error: error.message };
  } finally {
    isScrapingInProgress = false;
  }
});

app.get('/api/scrape/status', checkAuth, (req, res) => {
  res.json({ inProgress: isScrapingInProgress, lastStatus: lastScrapeStatus });
});

app.get('/api/export/csv', checkAuth, async (req, res) => {
  try {
    const data = await fs.readFile(DATA_FILE, 'utf8');
    const jsonData = JSON.parse(data);
    const headers = ['Address', 'City', 'State', 'Zip', 'Debt Amount', 'Defendant', 'Plaintiff', 'Sheriff #', 'Court Case', 'Sale Date', 'Status', 'Attorney', 'County', 'URL'];
    const rows = jsonData.properties.map(p => [
      `"${p.address}"`, p.city, p.state, p.zipCode, p.debtAmount,
      `"${(p.defendant || '').replace(/"/g, '""')}"`, `"${(p.plaintiff || '').replace(/"/g, '""')}"`,
      p.sheriffNumber, p.courtCase, p.salesDate, p.status, `"${(p.attorney || '').replace(/"/g, '""')}"`, p.county, p.detailUrl
    ]);
    const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=foreclosures.csv');
    res.send(csv);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============== PIPELINE API (Montgomery County) ==============

app.get('/api/pipeline', checkAuth, async (req, res) => {
  try {
    const data = await fs.readFile(PIPELINE_DATA_FILE, 'utf8');
    const jsonData = JSON.parse(data);
    let cases = jsonData.cases;
    
    if (req.query.grade) {
      const grades = req.query.grade.toUpperCase().split(',');
      cases = cases.filter(c => grades.includes(c.leadGrade));
    }
    if (req.query.minScore) cases = cases.filter(c => (c.leadScore || 0) >= parseInt(req.query.minScore));
    if (req.query.status) cases = cases.filter(c => c.status.toLowerCase().includes(req.query.status.toLowerCase()));
    if (req.query.hasJudgement === 'true') cases = cases.filter(c => c.hasJudgement);
    else if (req.query.hasJudgement === 'false') cases = cases.filter(c => !c.hasJudgement);
    if (req.query.hasDefendantAttorney === 'true') cases = cases.filter(c => c.docketSummary?.hasDefendantAttorney);
    else if (req.query.hasDefendantAttorney === 'false') cases = cases.filter(c => !c.docketSummary?.hasDefendantAttorney);
    if (req.query.hasDefendantResponse === 'true') cases = cases.filter(c => c.docketSummary?.hasDefendantResponse);
    else if (req.query.hasDefendantResponse === 'false') cases = cases.filter(c => !c.docketSummary?.hasDefendantResponse);
    if (req.query.hasDefaultMotion === 'true') cases = cases.filter(c => c.docketSummary?.hasDefaultMotion);
    if (req.query.minDaysOpen) cases = cases.filter(c => (c.daysOpen || 0) >= parseInt(req.query.minDaysOpen));
    if (req.query.maxDaysOpen) cases = cases.filter(c => (c.daysOpen || 0) <= parseInt(req.query.maxDaysOpen));
    if (req.query.city) cases = cases.filter(c => (c.propertyCity || '').toLowerCase().includes(req.query.city.toLowerCase()));
    
    const sortBy = req.query.sortBy || 'leadScore';
    const sortOrder = req.query.sortOrder === 'asc' ? 1 : -1;
    cases.sort((a, b) => {
      if (sortBy === 'leadScore') return ((a.leadScore || 0) - (b.leadScore || 0)) * sortOrder;
      if (sortBy === 'daysOpen') return ((a.daysOpen || 0) - (b.daysOpen || 0)) * sortOrder;
      if (sortBy === 'commencedDate') return (new Date(a.commencedDate) - new Date(b.commencedDate)) * sortOrder;
      return 0;
    });
    
    res.json({ lastUpdated: jsonData.lastUpdated, totalCases: cases.length, sources: jsonData.sources, statistics: jsonData.statistics, cases });
  } catch (error) {
    if (error.code === 'ENOENT') {
      res.json({ lastUpdated: null, totalCases: 0, sources: {}, statistics: {}, cases: [], message: 'No pipeline data yet.' });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

app.get('/api/pipeline/stats', checkAuth, async (req, res) => {
  try {
    const data = await fs.readFile(PIPELINE_DATA_FILE, 'utf8');
    const jsonData = JSON.parse(data);
    const cases = jsonData.cases || [];
    const stats = jsonData.statistics || { total: cases.length, byGrade: { A: 0, B: 0, C: 0, D: 0, F: 0 } };
    stats.lastUpdated = jsonData.lastUpdated;
    stats.sources = jsonData.sources;
    if (!stats.byGrade || !Object.keys(stats.byGrade).length) {
      stats.byGrade = { A: 0, B: 0, C: 0, D: 0, F: 0 };
      cases.forEach(c => stats.byGrade[c.leadGrade || 'C']++);
    }
    if (!stats.avgDaysOpen && cases.length) {
      stats.avgDaysOpen = Math.round(cases.reduce((sum, c) => sum + (c.daysOpen || 0), 0) / cases.length);
    }
    if (!stats.avgLeadScore && cases.length) {
      stats.avgLeadScore = Math.round(cases.reduce((sum, c) => sum + (c.leadScore || 0), 0) / cases.length);
    }
    stats.noDefendantResponse = cases.filter(c => !c.docketSummary?.hasDefendantResponse).length;
    stats.noDefendantAttorney = cases.filter(c => !c.docketSummary?.hasDefendantAttorney).length;
    res.json(stats);
  } catch (error) {
    res.json({ lastUpdated: null, total: 0, sources: {}, byGrade: { A: 0, B: 0, C: 0, D: 0, F: 0 } });
  }
});

app.get('/api/pipeline/case/:caseNumber', checkAuth, async (req, res) => {
  try {
    const data = await fs.readFile(PIPELINE_DATA_FILE, 'utf8');
    const jsonData = JSON.parse(data);
    const caseData = jsonData.cases.find(c => c.caseNumber === req.params.caseNumber);
    if (caseData) res.json(caseData);
    else res.status(404).json({ error: 'Case not found' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/pipeline/clear', checkAuth, async (req, res) => {
  const files = [
    PIPELINE_DATA_FILE,
    path.join(CONFIG.outputDir, 'url-cache.json')
  ];
  const deleted = [];

  for (const file of files) {
    try {
      await fs.unlink(file);
      deleted.push(path.basename(file));
    } catch (error) {
      if (error.code !== 'ENOENT') {
        return res.status(500).json({ error: error.message, file: path.basename(file) });
      }
    }
  }

  res.json({
    success: true,
    message: 'Pipeline data cleared',
    deleted
  });
});

let isPipelineScrapingInProgress = false;
let lastPipelineScrapeStatus = null;

app.post('/api/pipeline/scrape', checkAuth, async (req, res) => {
  if (isPipelineScrapingInProgress) {
    return res.status(429).json({ error: 'Pipeline scrape already in progress', status: lastPipelineScrapeStatus });
  }
  
  // Check if CSV exists
  try {
    await fs.access(CSV_FILE);
  } catch (e) {
    return res.status(400).json({ 
      error: 'No CSV file found. Please upload a CSV export from the Montgomery County court website first.',
      needsCsv: true
    });
  }
  
  const testMode = req.body.testMode === true;
  
  isPipelineScrapingInProgress = true;
  lastPipelineScrapeStatus = { started: new Date().toISOString(), status: 'running', testMode };
  res.json({ message: testMode ? 'Test scrape started (10 cases)' : 'Pipeline scrape started', status: lastPipelineScrapeStatus });
  
  try {
    const options = {
      enableEnrichment: req.body.enableEnrichment !== false,
      maxCasesToEnrich: req.body.maxCasesToEnrich || 25,
      testMode: testMode
    };
    const cases = await runPipelineScraper(options);
    const grades = { A: 0, B: 0, C: 0, D: 0, F: 0 };
    const withAddress = cases.filter(c => c.propertyAddress).length;
    cases.forEach(c => grades[c.leadGrade || 'C']++);
    lastPipelineScrapeStatus = { completed: new Date().toISOString(), status: 'completed', casesFound: cases.length, withAddress, grades, testMode };
  } catch (error) {
    lastPipelineScrapeStatus = { completed: new Date().toISOString(), status: 'error', error: error.message };
  } finally {
    isPipelineScrapingInProgress = false;
  }
});

app.get('/api/pipeline/scrape/status', checkAuth, (req, res) => {
  res.json({ inProgress: isPipelineScrapingInProgress, lastStatus: lastPipelineScrapeStatus });
});

app.post('/api/pipeline/rescan-parcels', checkAuth, async (req, res) => {
  if (isPipelineScrapingInProgress) {
    return res.status(429).json({ error: 'A scrape is in progress; try again when it finishes.' });
  }

  let pipeline;
  try {
    const raw = await fs.readFile(PIPELINE_DATA_FILE, 'utf8');
    pipeline = JSON.parse(raw);
  } catch (e) {
    return res.status(404).json({ error: 'No pipeline data found.' });
  }

  const cases = pipeline.cases || [];
  const targets = cases.filter(c =>
    c.caseTypeKind === 'lien' &&
    c.addressSource === 'defendant-fallback' &&
    c.parcelNumber
  );

  if (targets.length === 0) {
    return res.json({ attempted: 0, recovered: 0, stillFailed: 0, message: 'No lien cases with defendant-fallback addresses found.' });
  }

  const CONCURRENCY = 5;
  let recovered = 0;
  let stillFailed = 0;

  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    const chunk = targets.slice(i, i + CONCURRENCY);
    await Promise.all(chunk.map(async (c) => {
      try {
        const info = await fetchParcelAddress(c.parcelNumber, { bypassCache: true });
        if (info && info.street) {
          c.propertyAddress = info.street;
          c.propertyCity = info.city || '';
          c.propertyState = 'PA';
          c.propertyZip = info.zip || '';
          c.propertyOwner = info.owner || '';
          c.propertyMunicipality = info.municipality || '';
          c.inMontgomeryCounty = true;
          c.addressSource = 'parcel';
          recovered++;
        } else {
          stillFailed++;
        }
      } catch (e) {
        stillFailed++;
      }
    }));
  }

  pipeline.lastUpdated = new Date().toISOString();
  await fs.writeFile(PIPELINE_DATA_FILE, JSON.stringify(pipeline, null, 2));

  res.json({ attempted: targets.length, recovered, stillFailed });
});

app.get('/api/pipeline/export/csv', async (req, res) => {
  if (!isAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const data = await fs.readFile(PIPELINE_DATA_FILE, 'utf8');
    const jsonData = JSON.parse(data);
    const headers = ['Lead Grade', 'Lead Score', 'Case Number', 'Commenced Date', 'Days Open', 'Last Filing', 'Plaintiff', 'Defendant', 'Address', 'City', 'State', 'Zip', 'Has Judgement', 'Has Attorney', 'Has Response', 'Status', 'Remarks', 'URL'];
    const rows = jsonData.cases.map(c => {
      const ds = c.docketSummary || {};
      return [
        c.leadGrade, c.leadScore, c.caseNumber, c.commencedDate, c.daysOpen, c.lastFilingDate || '',
        `"${(c.plaintiff || '').replace(/"/g, '""')}"`, `"${(c.defendant || '').replace(/"/g, '""')}"`,
        `"${(c.propertyAddress || '').replace(/"/g, '""')}"`, c.propertyCity, c.propertyState, c.propertyZip,
        c.hasJudgement ? 'Yes' : 'No', ds.hasDefendantAttorney ? 'Yes' : 'No', ds.hasDefendantResponse ? 'Yes' : 'No',
        c.status, `"${(c.remarks || '').replace(/"/g, '""')}"`, c.detailUrl
      ];
    });
    const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=pre-foreclosure-pipeline.csv');
    res.send(csv);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============== CAMDEN COUNTY PIPELINE API ==============

async function readAnnotations() {
  try {
    const raw = await fs.readFile(CAMDEN_ANNOTATIONS_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    if (e.code === 'ENOENT') return {}; // File doesn't exist yet, that's fine
    console.error('⚠️ Annotations file corrupted or unreadable:', e.message);
    throw e; // Don't return {} — caller must not overwrite with empty data
  }
}

async function writeAnnotations(annotations) {
  await ensureDataDir();
  // Write to temp file first, then rename atomically to avoid corruption on partial writes
  const tmp = CAMDEN_ANNOTATIONS_FILE + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(annotations, null, 2));
  await fs.rename(tmp, CAMDEN_ANNOTATIONS_FILE);
}

function pushScoreHistory(caseObj, annotations) {
  if (typeof caseObj.sellerScore !== 'number') return;
  const key = caseObj.instrumentNumber;
  if (!annotations[key]) annotations[key] = {};
  if (!Array.isArray(annotations[key].scoreHistory)) annotations[key].scoreHistory = [];
  const history = annotations[key].scoreHistory;
  const last = history[history.length - 1];
  if (!last || last.score !== caseObj.sellerScore) {
    history.push({ score: caseObj.sellerScore, grade: caseObj.sellerGrade || '', date: new Date().toISOString() });
    if (history.length > 20) annotations[key].scoreHistory = history.slice(-20);
  }
}

app.post('/api/camden/manual-address', checkAuth, async (req, res) => {
    try {
      const { instrumentNumber, address } = req.body;
      if (!instrumentNumber || !address) return res.status(400).json({ error: 'Missing fields' });

      const raw = await fs.readFile(CAMDEN_DATA_FILE, 'utf8');
      const data = JSON.parse(raw);

      const found = data.cases.find(c => c.instrumentNumber === instrumentNumber);
      if (!found) return res.status(404).json({ error: 'Case not found' });

      found.propertyAddress = address;
      found.enrichmentSource = 'Manual entry';
      found.enrichedAt = new Date().toISOString();
      const annForAddr = await readAnnotations();
      pushScoreHistory(found, annForAddr);
      Object.assign(found, scoreCamdenCase(found));

      await fs.writeFile(CAMDEN_DATA_FILE, JSON.stringify(data, null, 2));
      await writeAnnotations(annForAddr);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

app.post('/api/camden/tag', checkAuth, async (req, res) => {
  try {
    const { instrumentNumber, tag, action } = req.body;
    if (!instrumentNumber || !tag) return res.status(400).json({ error: 'Missing fields' });
    const annotations = await readAnnotations();
    if (!annotations[instrumentNumber]) annotations[instrumentNumber] = {};
    // Migrate old single userTag to array
    let tags = Array.isArray(annotations[instrumentNumber].userTags)
      ? [...annotations[instrumentNumber].userTags]
      : (annotations[instrumentNumber].userTag ? [annotations[instrumentNumber].userTag] : []);
    delete annotations[instrumentNumber].userTag;
    if (action === 'remove') {
      tags = tags.filter(t => t !== tag);
    } else {
      if (!tags.includes(tag)) tags.push(tag);
    }
    annotations[instrumentNumber].userTags = tags;
    await writeAnnotations(annotations);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/camden/notes', checkAuth, async (req, res) => {
  try {
    const { instrumentNumber, notes } = req.body;
    if (!instrumentNumber) return res.status(400).json({ error: 'Missing instrumentNumber' });
    const annotations = await readAnnotations();
    if (!annotations[instrumentNumber]) annotations[instrumentNumber] = {};
    annotations[instrumentNumber].userNotes = notes || '';
    await writeAnnotations(annotations);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Upload Camden County CSV
app.post('/api/camden/upload-csv', checkAuth, async (req, res) => {
  try {
    const { csvData, filename } = req.body;
    if (!csvData) return res.status(400).json({ error: 'No CSV data provided' });

    // Parse and validate
    let parsed;
    try {
      parsed = parseCamdenCSV(csvData);
    } catch (e) {
      return res.status(400).json({ error: `CSV parsing error: ${e.message}` });
    }

    // Save raw CSV
    await ensureDataDir();
    await fs.writeFile(CAMDEN_CSV_FILE, csvData, 'utf8');

    // Merge court status + enrichment data from existing file for cases that already exist
    const existingData = await readJsonFileSafe(CAMDEN_DATA_FILE, null);
    if (existingData && Array.isArray(existingData.cases)) {
      const existingByInstrument = new Map(existingData.cases.map(c => [c.instrumentNumber, c]));
      const importMeta = parsed.importMetadata || {};
      const hasCourtStatusColumn = importMeta.hasCourtStatusColumn === true;
      const hasCourtDocketColumn = importMeta.hasCourtDocketColumn === true;
      const courtFields = [
        'courtStatus', 'courtStatusRaw', 'courtStatusNote', 'courtDocketNumber',
        'courtDisposition', 'courtCaseType', 'courtCaseCaption', 'courtFiledDate',
        'courtDispositionDate', 'courtCaseActions', 'courtCaseActionsText',
        'courtCaseActionCount', 'courtLatestActionText', 'courtLatestActionDate', 'courtMatchScore'
      ];
      const enrichmentFields = [
        'propertyAddress', 'assessedValue', 'landValue', 'improvementValue',
        'buildingDesc', 'yearConstructed', 'lastSalePrice', 'lastSaleDate',
        'propertyClass', 'ownerOfRecord', 'dwellingUnits'
      ];
      parsed.cases = parsed.cases.map(c => {
        const existing = existingByInstrument.get(c.instrumentNumber);
        if (!existing) return c;
        const merged = { ...c };
        const uploadedCourtStatus = String(c.courtStatus || '').trim();
        const uploadedCourtDocket = String(c.courtDocketNumber || '').trim();

        for (const field of [...courtFields, ...enrichmentFields]) {
          if (field === 'courtStatus' && hasCourtStatusColumn) continue;
          if (field === 'courtStatusNote' && hasCourtStatusColumn) continue;
          if (field === 'courtDocketNumber' && hasCourtDocketColumn) continue;
          if (existing[field] !== undefined && existing[field] !== null && existing[field] !== '') {
            merged[field] = existing[field];
          }
        }

        if (hasCourtStatusColumn) {
          merged.courtStatus = uploadedCourtStatus ? uploadedCourtStatus.toUpperCase() : '';
          merged.courtStatusNote = uploadedCourtStatus ? `MANUAL_CSV_OVERRIDE:${merged.courtStatus}` : '';
        }
        if (hasCourtDocketColumn) {
          merged.courtDocketNumber = uploadedCourtDocket;
        }

        return merged;
      });
    }

    // Save parsed JSON
    await fs.writeFile(CAMDEN_DATA_FILE, JSON.stringify(parsed, null, 2));

    res.json({
      success: true,
      filename: filename || 'camden-lis-pendens.csv',
      totalRows: parsed.totalRows,
      uniqueCases: parsed.totalCases,
      summary: parsed.summary
    });
  } catch (error) {
    console.error('Camden CSV upload error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Check Camden CSV status
app.get('/api/camden/csv-status', checkAuth, async (req, res) => {
  try {
    const stats = await fs.stat(CAMDEN_DATA_FILE);
    const content = await fs.readFile(CAMDEN_DATA_FILE, 'utf8');
    const data = JSON.parse(content);
    res.json({
      exists: true,
      caseCount: data.totalCases,
      lastModified: stats.mtime,
      summary: data.summary,
      enrichmentSummary: data.enrichmentSummary || null
    });
  } catch (error) {
    res.json({ exists: false });
  }
});

// Get Camden pipeline data
app.get('/api/camden', checkAuth, async (req, res) => {
  try {
    const content = await fs.readFile(CAMDEN_DATA_FILE, 'utf8');
    const data = JSON.parse(content);
    const annotations = await readAnnotations();
    let cases = (data.cases || []).map(c => {
      const scored = scoreCamdenCase(c);
      const ann = annotations[c.instrumentNumber] || {};
      // Migrate old single userTag to array
      let userTags = Array.isArray(ann.userTags) ? ann.userTags
        : (ann.userTag ? [ann.userTag] : (c.userTag ? [c.userTag] : []));
      return {
        ...scored,
        userTags,
        userNotes: ann.userNotes ?? c.userNotes ?? '',
        scoreHistory: ann.scoreHistory ?? c.scoreHistory ?? []
      };
    });

    // Filters
    if (req.query.plaintiffType) {
      cases = cases.filter(c => c.plaintiffType === req.query.plaintiffType.toUpperCase());
    }
    if (req.query.defendantType) {
      cases = cases.filter(c => c.defendantType === req.query.defendantType.toUpperCase());
    }
    const townFilters = []
      .concat(req.query.town || [])
      .flatMap(value => String(value).split(','))
      .map(value => value.trim().toUpperCase())
      .filter(Boolean);
    if (townFilters.length) {
      const townSet = new Set(townFilters);
      cases = cases.filter(c => townSet.has(String(c.town || '').trim().toUpperCase()));
    }
    if (req.query.hasAddress === 'true') {
      cases = cases.filter(c => c.propertyAddress);
    } else if (req.query.hasAddress === 'false') {
      cases = cases.filter(c => !c.propertyAddress);
    }

    // Sort
    const sortBy = req.query.sortBy || 'daysSinceFiling';
    const sortOrder = req.query.sortOrder === 'asc' ? 1 : -1;
    cases.sort((a, b) => {
      if (sortBy === 'sellerScore') return ((a.sellerScore || 0) - (b.sellerScore || 0)) * sortOrder;
      if (sortBy === 'daysSinceFiling') return ((a.daysSinceFiling || 0) - (b.daysSinceFiling || 0)) * sortOrder;
      if (sortBy === 'assessedValue') return ((a.assessedValue || 0) - (b.assessedValue || 0)) * sortOrder;
      if (sortBy === 'town') return (a.town || '').localeCompare(b.town || '') * sortOrder;
      return 0;
    });

    res.json({
      lastUpdated: data.processedAt,
      totalCases: cases.length,
      summary: data.summary,
      enrichmentSummary: data.enrichmentSummary || null,
      cases
    });
  } catch (error) {
    if (error.code === 'ENOENT') {
      res.json({ lastUpdated: null, totalCases: 0, summary: {}, cases: [] });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

// Enrich Camden data (resolve addresses)
let isCamdenEnriching = false;
let lastCamdenEnrichStatus = null;

app.post('/api/camden/enrich', checkAuth, async (req, res) => {
  if (isCamdenEnriching) {
    return res.status(429).json({ error: 'Enrichment already in progress', status: lastCamdenEnrichStatus });
  }

  try {
    await fs.access(CAMDEN_DATA_FILE);
  } catch (e) {
    return res.status(400).json({ error: 'No Camden data found. Upload a CSV first.', needsCsv: true });
  }

  const testMode = req.body.testMode === true;
  isCamdenEnriching = true;
  lastCamdenEnrichStatus = { started: new Date().toISOString(), status: 'running', testMode };
  res.json({ message: testMode ? 'Test enrichment started (10 cases)' : 'Enrichment started', status: lastCamdenEnrichStatus });

  try {
    const content = await fs.readFile(CAMDEN_DATA_FILE, 'utf8');
    let data = JSON.parse(content);

    data = await enrichCamdenCases(data, { testMode, testLimit: 10 });

    await fs.writeFile(CAMDEN_DATA_FILE, JSON.stringify(data, null, 2));

    const withAddress = data.cases.filter(c => c.propertyAddress).length;
    lastCamdenEnrichStatus = {
      completed: new Date().toISOString(),
      status: 'completed',
      totalCases: data.totalCases,
      withAddress,
      enrichmentSummary: data.enrichmentSummary,
      testMode
    };
  } catch (error) {
    lastCamdenEnrichStatus = { completed: new Date().toISOString(), status: 'error', error: error.message };
    console.error('Camden enrichment error:', error);
  } finally {
    isCamdenEnriching = false;
  }
});

app.get('/api/camden/enrich/status', checkAuth, (req, res) => {
  res.json({ inProgress: isCamdenEnriching, lastStatus: lastCamdenEnrichStatus });
});

// ============== NJ COURTS STATUS (BROWSER-BASED) ==============
// Instead of Puppeteer (blocked by CAPTCHA), court status is checked via a
// bookmarklet that runs in the user's browser on the NJ Courts search page.
// The bookmarklet fetches cases from this server, searches NJ Courts, and
// POSTs results back one at a time.

// ============================================================
// ADD THIS TO server.js - right before the existing
// app.get('/api/camden/court-status-script' ...) endpoint
// ============================================================

// Refresh-mode batch loader for OPEN cases with docket numbers.
app.get('/api/camden/court-status-cases', async (req, res, next) => {
  const mode = (req.query.mode || 'default').toString().toLowerCase();
  if (mode !== 'refresh') return next();

  res.setHeader('Access-Control-Allow-Origin', '*');

  const token = req.query.token || req.headers['x-auth-token'];
  if (token !== SITE_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const content = await fs.readFile(CAMDEN_DATA_FILE, 'utf8');
    const data = JSON.parse(content);
    const testMode = req.query.test === 'true';
    const resume = req.query.resume === 'true';

    let batch;
    if (resume) {
      batch = await loadCourtRefreshBatch();
      if (!batch || batch.status !== 'running') {
        return res.json({
          mode,
          resume,
          batch: null,
          cases: [],
          message: 'No active refresh batch to resume.'
        });
      }
      if (!!batch.testMode !== testMode) {
        return res.status(409).json({
          error: `Active refresh batch mode mismatch. Existing batch is ${batch.testMode ? 'test' : 'full'} mode.`
        });
      }
    } else {
      batch = buildCourtRefreshBatch(getCamdenOpenRefreshCases(data, { testMode }), { testMode });
      await saveCourtRefreshBatch(batch);
    }

    const cases = getRemainingBatchCases(batch);
    console.log(`Serving ${cases.length} Camden refresh cases (${resume ? 'resume' : 'new batch'}${testMode ? ', test mode' : ''})`);
    res.json({
      mode,
      resume,
      batch: summarizeCourtRefreshBatch(batch),
      cases
    });
  } catch (error) {
    if (error.code === 'ENOENT') {
      res.json({ mode, resume: req.query.resume === 'true', batch: null, cases: [] });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

app.get('/api/camden/court-status-refresh/state', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const token = req.query.token || req.headers['x-auth-token'];
  if (token !== SITE_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const batch = await loadCourtRefreshBatch();
    res.json({ batch: summarizeCourtRefreshBatch(batch) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/camden/court-search-config', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const token = req.query.token || req.headers['x-auth-token'];
  if (token !== SITE_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  res.json({
    containsWholeWords
  });
});

// Serve cases that need court status lookup
app.get('/api/camden/court-status-cases', async (req, res) => {
  // Allow CORS for bookmarklet running on NJ Courts domain
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  const token = req.query.token || req.headers['x-auth-token'];
  if (token !== SITE_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const content = await fs.readFile(CAMDEN_DATA_FILE, 'utf8');
    const data = JSON.parse(content);
    const testMode = req.query.test === 'true';
    const blankOnly = req.query.blankOnly === 'true';

    // Filter to cases that need court status
    let cases = (data.cases || []).filter(c => {
      const existingStatusRaw = (c.courtStatus || '').trim();
      const existingStatus = existingStatusRaw.toUpperCase();
      if (blankOnly) {
        if (existingStatusRaw) return false;
      } else {
        // Skip if already closed; OPEN cases can be re-scanned for richer docket/action data.
        if (existingStatus === 'CLOSED') return false;
      }
      const searchNames = Array.isArray(c.defendants) && c.defendants.length ? c.defendants : c.allDefendants;
      if (!Array.isArray(searchNames) || !searchNames.some(name => (name || '').trim())) return false;
      return true;
    });

    // Map to just the fields the bookmarklet needs
    cases = cases.map(mapCaseForCourtStatus);

    if (testMode) {
      cases = cases.slice(0, 10);
    }

    console.log(`📋 Serving ${cases.length} cases for court status lookup${blankOnly ? ' (blank court status only)' : ''}${testMode ? ' (TEST MODE)' : ''}`);
    res.json(cases);
  } catch (error) {
    if (error.code === 'ENOENT') {
      res.json([]);
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

// Serve the bookmarklet script with config injected
app.get('/api/camden/court-status-script', (req, res) => {
  const token = req.query.token || '';
  const testMode = req.query.test === 'true';
  const runMode = (req.query.mode || 'default').toString().toLowerCase();
  const resumeMode = req.query.resume === 'true';
  const serverUrl = `https://${req.get('host')}`;

  const fs2 = require('fs');
  let coreScript;
  let script;
  try {
    coreScript = fs2.readFileSync(path.join(__dirname, 'scrapers', 'court-status-core.js'), 'utf8');
    script = fs2.readFileSync(path.join(__dirname, 'scrapers', 'court-status-bookmarklet.js'), 'utf8');
  } catch (e) {
    return res.status(500).send('// Error: court-status script files not found');
  }

  script = script.replace(/__SERVER_URL__/g, serverUrl);
  script = script.replace(/__AUTH_TOKEN__/g, token);
  script = script.replace(/__TEST_MODE__/g, testMode.toString());
  script = script.replace(/__RUN_MODE__/g, JSON.stringify(runMode));
  script = script.replace(/__RESUME_MODE__/g, resumeMode ? 'true' : 'false');
  script = `globalThis.__CSC_SEARCH_SKIP_WHOLE_WORDS__ = ${JSON.stringify(containsWholeWords)};\n\n${coreScript}\n\n${script}`;

  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.send(script);
});

// Receive individual case court status updates from the bookmarklet
app.options('/api/camden/court-status-update', cors());
app.post('/api/camden/court-status-update', cors({
  origin: '*',
  allowedHeaders: ['Content-Type', 'X-Auth-Token']
}), (req, res, next) => {
  const token = req.headers['x-auth-token'] || req.query.token;
  if (token === SITE_PASSWORD) next();
  else res.status(401).json({ error: 'Unauthorized' });
}, async (req, res) => {
  try {
    const { instrumentNumber, courtData } = req.body;
    if (!instrumentNumber || !courtData) {
      return res.status(400).json({ error: 'instrumentNumber and courtData required' });
    }

    const content = await fs.readFile(CAMDEN_DATA_FILE, 'utf8');
    const data = JSON.parse(content);

    const caseIdx = data.cases.findIndex(c => c.instrumentNumber === instrumentNumber);
    if (caseIdx === -1) {
      return res.status(404).json({ error: `Case ${instrumentNumber} not found` });
    }

    const existingStatus = (data.cases[caseIdx].courtStatus || '').toUpperCase();
    const incomingStatus = (courtData.courtStatus || '').toUpperCase();

    // Preserve manual/final overrides: don't downgrade OPEN/CLOSED/STAY to uncertain statuses.
    const isFinalStatus = existingStatus === 'OPEN' || existingStatus === 'CLOSED' || existingStatus === 'STAY' || existingStatus === 'REINSTATED';
    const isDowngrade = incomingStatus === 'RECHECK' || incomingStatus === 'NOT_FOUND' || incomingStatus === 'UNKNOWN';
    const mergedCourtData = { ...courtData };

    if (incomingStatus === 'RECHECK') {
      mergedCourtData.courtDocketNumber = data.cases[caseIdx].courtDocketNumber || '';
    }

    if (isFinalStatus && isDowngrade) {
      mergedCourtData.courtStatus = existingStatus;
      if (!mergedCourtData.courtDocketNumber) {
        mergedCourtData.courtDocketNumber = data.cases[caseIdx].courtDocketNumber || '';
      }
      console.log(`⚖️ ${instrumentNumber} → kept ${existingStatus}, merged non-status updates`);
    }

    Object.assign(data.cases[caseIdx], mergedCourtData);
    const annForCourt = await readAnnotations();
    pushScoreHistory(data.cases[caseIdx], annForCourt);
    data.cases[caseIdx] = scoreCamdenCase(data.cases[caseIdx]);
    await fs.writeFile(CAMDEN_DATA_FILE, JSON.stringify(data, null, 2));
    await writeAnnotations(annForCourt);

    console.log(`⚖️ ${instrumentNumber} → ${data.cases[caseIdx].courtStatus} (${mergedCourtData.courtDisposition || 'N/A'})`);
    res.json({ success: true, instrumentNumber, status: data.cases[caseIdx].courtStatus });
  } catch (error) {
    console.error('Court status update error:', error);
    res.status(500).json({ error: error.message });
  }
});

// One-shot admin: bulk-close all late-stage tax lien cases.
// Uses the exact same detection as the UI's isLateTaxLien() + getCaseStageContext().
app.post('/api/camden/admin/close-late-stage-tax-liens', async (req, res) => {
  const token = req.headers['x-auth-token'] || req.query.token;
  if (token !== SITE_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const content = await fs.readFile(CAMDEN_DATA_FILE, 'utf8');
    const data = JSON.parse(content);
    const ann = await readAnnotations();

    let closed = 0;
    let skipped = 0;
    data.cases = data.cases.map(c => {
      if ((c.courtStatus || '').toUpperCase() === 'CLOSED') { skipped++; return c; }
      if (hasActiveOpenCourtState(c)) { skipped++; return c; }
      if (!isLateStageTaxLien(c)) { skipped++; return c; }

      c.courtStatus = 'CLOSED';
      c.courtStatusNote = 'BULK_CLOSED:LATE_STAGE_TAX_LIEN';
      pushScoreHistory(c, ann);
      c = scoreCamdenCase(c);
      closed++;
      return c;
    });

    await fs.writeFile(CAMDEN_DATA_FILE, JSON.stringify(data, null, 2));
    await writeAnnotations(ann);

    console.log(`Bulk-closed ${closed} late-stage tax lien cases (${skipped} skipped)`);
    res.json({ success: true, closed, skipped });
  } catch (error) {
    console.error('Bulk close error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Export Camden CSV — preserves original format, adds court status columns
app.options('/api/camden/admin/reopen-court-status-by-docket', cors());
app.post('/api/camden/admin/reopen-court-status-by-docket', cors({
  origin: '*',
  allowedHeaders: ['Content-Type', 'X-Auth-Token']
}), (req, res, next) => {
  const token = req.headers['x-auth-token'] || req.query.token;
  if (token === SITE_PASSWORD) next();
  else res.status(401).json({ error: 'Unauthorized' });
}, async (req, res) => {
  try {
    const rawDockets = Array.isArray(req.body?.dockets) ? req.body.dockets : [];
    const normalizedDockets = Array.from(new Set(rawDockets.map(normalizeCourtDocket).filter(Boolean)));
    if (!normalizedDockets.length) {
      return res.status(400).json({ error: 'dockets array required' });
    }

    const nextStatus = String(req.body?.courtStatus || 'OPEN').toUpperCase();
    if (!['OPEN', 'RECHECK'].includes(nextStatus)) {
      return res.status(400).json({ error: 'courtStatus must be OPEN or RECHECK' });
    }

    const notePrefix = String(req.body?.note || 'ADMIN_REOPENED:DOCKET_BATCH').trim() || 'ADMIN_REOPENED:DOCKET_BATCH';
    const content = await fs.readFile(CAMDEN_DATA_FILE, 'utf8');
    const data = JSON.parse(content);
    const ann = await readAnnotations();
    const notFound = new Set(normalizedDockets);
    const updated = [];

    data.cases = data.cases.map(c => {
      const normalizedCaseDocket = normalizeCourtDocket(c.courtDocketNumber);
      if (!normalizedCaseDocket) return c;

      const matchedDocket = findMatchingCourtDocket(normalizedCaseDocket, Array.from(notFound));
      if (!matchedDocket) return c;

      notFound.delete(matchedDocket);
      c.courtStatus = nextStatus;
      c.courtStatusNote = `${notePrefix} | raw:${c.courtStatusRaw || '-'} | disp:${c.courtDisposition || '-'}`;
      pushScoreHistory(c, ann);
      c = scoreCamdenCase(c);
      updated.push({
        instrumentNumber: c.instrumentNumber,
        docket: c.courtDocketNumber || '',
        status: c.courtStatus,
        rawStatus: c.courtStatusRaw || '',
        disposition: c.courtDisposition || ''
      });
      return c;
    });

    await fs.writeFile(CAMDEN_DATA_FILE, JSON.stringify(data, null, 2));
    await writeAnnotations(ann);

    console.log(`Reopened ${updated.length} court-status cases by docket (${Array.from(notFound).length} not found)`);
    res.json({
      success: true,
      updatedCount: updated.length,
      updated,
      notFound: Array.from(notFound)
    });
  } catch (error) {
    console.error('Reopen by docket error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.options('/api/camden/court-status-refresh/advance', cors());
app.post('/api/camden/court-status-refresh/advance', cors({
  origin: '*',
  allowedHeaders: ['Content-Type', 'X-Auth-Token']
}), (req, res, next) => {
  const token = req.headers['x-auth-token'] || req.query.token;
  if (token === SITE_PASSWORD) next();
  else res.status(401).json({ error: 'Unauthorized' });
}, async (req, res) => {
  try {
    const { batchId, instrumentNumber, status } = req.body || {};
    if (!batchId || !instrumentNumber) {
      return res.status(400).json({ error: 'batchId and instrumentNumber required' });
    }

    const batch = await markCourtRefreshBatchProgress(batchId, instrumentNumber, status);
    if (!batch) {
      return res.status(404).json({ error: 'Active batch not found or already completed' });
    }

    res.json({ success: true, batch: summarizeCourtRefreshBatch(batch) });
  } catch (error) {
    console.error('Court refresh advance error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/camden/export/csv', (req, res, next) => {
  const token = req.headers['x-auth-token'] || req.query.token;
  if (token === SITE_PASSWORD) next();
  else res.status(401).json({ error: 'Unauthorized' });
}, async (req, res) => {
  try {
    let originalCsv;
    try {
      originalCsv = await fs.readFile(CAMDEN_CSV_FILE, 'utf8');
    } catch (e) {
      return res.status(404).json({ error: 'No CSV file found. Upload one first.' });
    }

    let caseData = {};
    try {
      const content = await fs.readFile(CAMDEN_DATA_FILE, 'utf8');
      const data = JSON.parse(content);
      (data.cases || []).forEach(c => {
        if (c.instrumentNumber) {
          caseData[c.instrumentNumber] = {
            status: c.courtStatus || '',
            docket: c.courtDocketNumber || ''
          };
        }
      });
    } catch (e) {}

    const lines = originalCsv.split(/\r?\n/);
    const outputLines = [];
    let instrNumIdx = 12;
    let existingCourtStatusIdx = 15;
    let existingCourtDocketIdx = 16;
    let exportColumnMap = null;

    function findHeaderIndex(normalizedHeader, patterns) {
      return normalizedHeader.findIndex(h => patterns.some(pattern => h === pattern || h.includes(pattern)));
    }

    function buildExportColumns(cols) {
      if (!exportColumnMap) return [];
      return exportColumnMap.map(col => (col.idx >= 0 ? (cols[col.idx] || '').trim() : ''));
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;

      if (i === 0) {
        const cols = parseCSVLine(line);
        const normalizedHeader = cols.map(h => (h || '').toLowerCase().replace(/\s+/g, ''));
        exportColumnMap = [
          { label: '', idx: -1 },
          { label: 'Party Code', idx: findHeaderIndex(normalizedHeader, ['partycode']) },
          { label: 'Name', idx: findHeaderIndex(normalizedHeader, ['name']) },
          { label: 'Cross Name', idx: findHeaderIndex(normalizedHeader, ['crossname']) },
          { label: 'Date', idx: findHeaderIndex(normalizedHeader, ['date']) },
          { label: 'Type', idx: findHeaderIndex(normalizedHeader, ['type']) },
          { label: 'Book Type', idx: findHeaderIndex(normalizedHeader, ['booktype']) },
          { label: 'Book', idx: findHeaderIndex(normalizedHeader, ['book']) },
          { label: 'Page', idx: findHeaderIndex(normalizedHeader, ['page']) },
          { label: 'Town', idx: findHeaderIndex(normalizedHeader, ['town']) },
          { label: 'Lot', idx: findHeaderIndex(normalizedHeader, ['lot']) },
          { label: 'Block', idx: findHeaderIndex(normalizedHeader, ['block']) },
          { label: 'Instr#', idx: findHeaderIndex(normalizedHeader, ['instr']) },
          { label: 'Status', idx: findHeaderIndex(normalizedHeader, ['status']) },
          { label: 'Flag', idx: findHeaderIndex(normalizedHeader, ['flag']) }
        ];
        const detectedInstrNumIdx = normalizedHeader.findIndex(h => h.includes('instr'));
        const detectedCourtStatusIdx = normalizedHeader.findIndex(h => h.includes('courtcasestatus'));
        const detectedCourtDocketIdx = normalizedHeader.findIndex(h => h.includes('docketnumber') || h.includes('docket'));
        if (detectedInstrNumIdx >= 0) instrNumIdx = detectedInstrNumIdx;
        if (detectedCourtStatusIdx >= 0) existingCourtStatusIdx = detectedCourtStatusIdx;
        if (detectedCourtDocketIdx >= 0) existingCourtDocketIdx = detectedCourtDocketIdx;
        outputLines.push(
          [...exportColumnMap.map(col => col.label), 'Court Case Status', 'Docket Number']
            .map(toCSVField)
            .join(',')
        );
      } else {
        const cols = parseCSVLine(line);
        const instrNum = (cols[instrNumIdx] || '').trim();
        const baseCols = buildExportColumns(cols);
        const courtInfo = caseData[instrNum] || {};
        const existingStatus = existingCourtStatusIdx >= 0 ? (cols[existingCourtStatusIdx] || '').trim() : '';
        const existingDocket = existingCourtDocketIdx >= 0 ? (cols[existingCourtDocketIdx] || '').trim() : '';
        outputLines.push(
          [...baseCols, courtInfo.status || existingStatus || '', courtInfo.docket || existingDocket || '']
            .map(toCSVField)
            .join(',')
        );
      }
    }

    const csv = outputLines.join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=camden-lis-pendens.csv');
    res.send(csv);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/camden/export/open-addresses', (req, res, next) => {
  const token = req.headers['x-auth-token'] || req.query.token;
  if (token === SITE_PASSWORD) next();
  else res.status(401).json({ error: 'Unauthorized' });
}, async (req, res) => {
  try {
    const content = await fs.readFile(CAMDEN_DATA_FILE, 'utf8');
    const data = JSON.parse(content);
    const cases = (data.cases || [])
      .map(scoreCamdenCase)
      .filter(c => ['OPEN', 'REINSTATED'].includes((c.courtStatus || '').toUpperCase()) && c.propertyAddress);

    const headers = ['Instrument Number', 'Address', 'Town', 'Docket Number', 'Plaintiff', 'Defendant'];
    const rows = cases.map(c => ([
      c.instrumentNumber || '',
      c.propertyAddress || '',
      c.town || '',
      c.courtDocketNumber || '',
      c.primaryPlaintiff || '',
      c.primaryDefendant || ''
    ]).map(toCSVField).join(','));

    const csv = [headers.map(toCSVField).join(','), ...rows].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=camden-open-addresses.csv');
    res.send(csv);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============== START SERVER ==============

ensureDataDir().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 Foreclosure Finder server running on port ${PORT}`);
    console.log(`   Open http://localhost:${PORT} in your browser`);
    
    // Schedule automatic jobs
    scheduleNightlySheriffScrape();   // 2 AM ET
    // scheduleNightlyPipelineScrape();  // 3 AM ET — disabled; pipeline scrape is run manually
  });
});

// ============== SCHEDULED SCRAPING ==============

function scheduleNightlyPipelineScrape() {
  const SCRAPE_HOUR = 3;  // 3 AM
  const TIMEZONE_OFFSET = -5;  // Eastern Time (adjust for daylight saving if needed: -4 for EDT, -5 for EST)
  
  function getNextScrapeTime() {
    const now = new Date();
    const utcHour = now.getUTCHours();
    const targetUTCHour = SCRAPE_HOUR - TIMEZONE_OFFSET;  // Convert 3 AM ET to UTC
    
    let next = new Date(now);
    next.setUTCHours(targetUTCHour, 0, 0, 0);
    
    // If we've passed 3 AM today, schedule for tomorrow
    if (now >= next) {
      next.setDate(next.getDate() + 1);
    }
    
    return next;
  }
  
  function scheduleNext() {
    const nextScrape = getNextScrapeTime();
    const msUntilScrape = nextScrape.getTime() - Date.now();
    
    console.log(`📅 Next scheduled pipeline scrape: ${nextScrape.toLocaleString('en-US', { timeZone: 'America/New_York' })} ET`);
    console.log(`   (in ${Math.round(msUntilScrape / 1000 / 60 / 60 * 10) / 10} hours)`);
    
    setTimeout(async () => {
      console.log(`\n⏰ Starting scheduled 3 AM pipeline scrape...`);
      
      // Check if CSV exists before starting
      try {
        await fs.access(CSV_FILE);
      } catch (e) {
        console.log('   ⚠️ No CSV file found, skipping scheduled scrape');
        scheduleNext();
        return;
      }
      
      // Check if scrape is already in progress
      if (isPipelineScrapingInProgress) {
        console.log('   ⚠️ Scrape already in progress, skipping');
        scheduleNext();
        return;
      }
      
      isPipelineScrapingInProgress = true;
      lastPipelineScrapeStatus = { started: new Date().toISOString(), status: 'running', scheduled: true };
      
      try {
        const cases = await runPipelineScraper({ enableEnrichment: false });
        const grades = { A: 0, B: 0, C: 0, D: 0, F: 0 };
        const withAddress = cases.filter(c => c.propertyAddress).length;
        cases.forEach(c => grades[c.leadGrade || 'C']++);
        lastPipelineScrapeStatus = { 
          completed: new Date().toISOString(), 
          status: 'completed', 
          casesFound: cases.length,
          withAddress,
          grades,
          scheduled: true 
        };
        console.log(`   ✅ Scheduled scrape complete: ${cases.length} cases (${withAddress} with addresses)`);
      } catch (error) {
        lastPipelineScrapeStatus = { 
          completed: new Date().toISOString(), 
          status: 'error', 
          error: error.message,
          scheduled: true 
        };
        console.log(`   ❌ Scheduled scrape error: ${error.message}`);
      } finally {
        isPipelineScrapingInProgress = false;
      }
      
      // Schedule the next one
      scheduleNext();
    }, msUntilScrape);
  }
  
  scheduleNext();
}

function scheduleNightlySheriffScrape() {
  const SCRAPE_HOUR = 2;  // 2 AM
  const TIMEZONE_OFFSET = -5;  // Eastern Time (adjust for daylight saving if needed: -4 for EDT, -5 for EST)
  
  function getNextScrapeTime() {
    const now = new Date();
    const targetUTCHour = SCRAPE_HOUR - TIMEZONE_OFFSET;  // Convert 2 AM ET to UTC
    
    let next = new Date(now);
    next.setUTCHours(targetUTCHour, 0, 0, 0);
    
    // If we've passed 2 AM today, schedule for tomorrow
    if (now >= next) {
      next.setDate(next.getDate() + 1);
    }
    
    return next;
  }
  
  function scheduleNext() {
    const nextScrape = getNextScrapeTime();
    const msUntilScrape = nextScrape.getTime() - Date.now();
    
    console.log(`📅 Next scheduled sheriff scrape: ${nextScrape.toLocaleString('en-US', { timeZone: 'America/New_York' })} ET`);
    console.log(`   (in ${Math.round(msUntilScrape / 1000 / 60 / 60 * 10) / 10} hours)`);
    
    setTimeout(async () => {
      console.log(`\n⏰ Starting scheduled 2 AM sheriff scrape...`);
      
      // Check if scrape is already in progress
      if (isScrapingInProgress) {
        console.log('   ⚠️ Sheriff scrape already in progress, skipping');
        scheduleNext();
        return;
      }
      
      isScrapingInProgress = true;
      lastScrapeStatus = { started: new Date().toISOString(), status: 'running', scheduled: true };
      
      try {
        const properties = await runScraper();
        lastScrapeStatus = {
          completed: new Date().toISOString(),
          status: 'completed',
          propertiesFound: properties.length,
          scheduled: true
        };
        console.log(`   ✅ Scheduled sheriff scrape complete: ${properties.length} properties`);
      } catch (error) {
        lastScrapeStatus = {
          completed: new Date().toISOString(),
          status: 'error',
          error: error.message,
          scheduled: true
        };
        console.log(`   ❌ Scheduled sheriff scrape error: ${error.message}`);
      } finally {
        isScrapingInProgress = false;
      }
      
      // Schedule the next one
      scheduleNext();
    }, msUntilScrape);
  }
  
  scheduleNext();
}
