const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs').promises;
const { runScraper, CONFIG } = require('./scraper');
const { runPipelineScraper, OUTPUT_FILE: PIPELINE_FILE } = require('./pipeline-scraper');
const { parseCamdenCSV, enrichCamdenCases } = require('./scrapers/camden-enrichment');
// NOTE: nj-courts-status.js Puppeteer scraper removed - NJ Courts blocks datacenter IPs with CAPTCHA
// Court status is now checked via browser-based bookmarklet (court-status-bookmarklet.js)

const app = express();
const PORT = process.env.PORT || 3000;

const SITE_PASSWORD = process.env.SITE_PASSWORD || 'Benoro';

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.text({ limit: '10mb', type: 'text/csv' }));

const DATA_FILE = path.join(CONFIG.outputDir, CONFIG.outputFile);
const PIPELINE_DATA_FILE = path.join(CONFIG.outputDir, PIPELINE_FILE);
const CSV_FILE = path.join(CONFIG.outputDir, 'montco-cases.csv');
const CAMDEN_CSV_FILE = path.join(CONFIG.outputDir, 'camden-lis-pendens.csv');
const CAMDEN_DATA_FILE = path.join(CONFIG.outputDir, 'camden-pipeline.json');

async function ensureDataDir() {
  try { await fs.mkdir(CONFIG.outputDir, { recursive: true }); } catch (e) {}
}

app.post('/api/auth', (req, res) => {
  const { password } = req.body;
  if (password === SITE_PASSWORD) res.json({ success: true });
  else res.status(401).json({ success: false, error: 'Invalid password' });
});

const checkAuth = (req, res, next) => {
  const authHeader = req.headers['x-auth-token'];
  if (authHeader === SITE_PASSWORD) next();
  else res.status(401).json({ error: 'Unauthorized' });
};

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

app.get('/api/pipeline/export/csv', checkAuth, async (req, res) => {
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
    let cases = data.cases || [];

    // Filters
    if (req.query.plaintiffType) {
      cases = cases.filter(c => c.plaintiffType === req.query.plaintiffType.toUpperCase());
    }
    if (req.query.defendantType) {
      cases = cases.filter(c => c.defendantType === req.query.defendantType.toUpperCase());
    }
    if (req.query.town) {
      cases = cases.filter(c => (c.town || '').toLowerCase().includes(req.query.town.toLowerCase()));
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

// Serve the bookmarklet script with config injected
app.get('/api/camden/court-status-script', (req, res) => {
  const token = req.query.token || '';
  const testMode = req.query.test === 'true';
  const serverUrl = `${req.protocol}://${req.get('host')}`;

  const fs2 = require('fs');
  let script;
  try {
    script = fs2.readFileSync(path.join(__dirname, 'scrapers', 'court-status-bookmarklet.js'), 'utf8');
  } catch (e) {
    return res.status(500).send('// Error: court-status-bookmarklet.js not found');
  }

  script = script.replace(/__SERVER_URL__/g, serverUrl);
  script = script.replace(/__AUTH_TOKEN__/g, token);
  script = script.replace(/__TEST_MODE__/g, testMode.toString());

  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.send(script);
});

// Receive individual case court status updates from the bookmarklet
app.post('/api/camden/court-status-update', cors(), checkAuth, async (req, res) => {
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

    Object.assign(data.cases[caseIdx], courtData);
    await fs.writeFile(CAMDEN_DATA_FILE, JSON.stringify(data, null, 2));

    console.log(`⚖️ ${instrumentNumber} → ${courtData.courtStatus} (${courtData.courtDisposition || 'N/A'})`);
    res.json({ success: true, instrumentNumber, status: courtData.courtStatus });
  } catch (error) {
    console.error('Court status update error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Export Camden CSV
app.get('/api/camden/export/csv', checkAuth, async (req, res) => {
  try {
    const content = await fs.readFile(CAMDEN_DATA_FILE, 'utf8');
    const data = JSON.parse(content);
    const headers = [
      'Instrument #', 'Filing Date', 'Days Since Filing', 'Town',
      'Block', 'Lot', 'Property Address',
      'Plaintiff Type', 'Primary Plaintiff', 'Defendant Type', 'Primary Defendant',
      'All Defendants', 'Entity Co-Defendants',
      'Assessed Value', 'Land Value', 'Improvement Value',
      'Building Desc', 'Year Built', 'Last Sale Price', 'Property Class',
      'Court Status', 'Court Disposition', 'Docket Number', 'Court Filed Date'
    ];
    const esc = (s) => `"${(s || '').toString().replace(/"/g, '""')}"`;
    const rows = data.cases.map(c => [
      c.instrumentNumber, c.filingDate, c.daysSinceFiling, c.town,
      c.block, c.lot, esc(c.propertyAddress),
      c.plaintiffType, esc(c.primaryPlaintiff), c.defendantType, esc(c.primaryDefendant),
      esc((c.allDefendants || []).join('; ')), esc((c.entityCoDefendants || []).join('; ')),
      c.assessedValue || '', c.landValue || '', c.improvementValue || '',
      esc(c.buildingDesc), c.yearConstructed || '', c.lastSalePrice || '', c.propertyClass || '',
      c.courtStatus || '', esc(c.courtDisposition), c.courtDocketNumber || '', c.courtFiledDate || ''
    ]);
    const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=camden-lis-pendens.csv');
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
    
    // Schedule pipeline scrape at 3 AM Eastern Time every day
    scheduleNightlyScrape();
  });
});

// ============== SCHEDULED SCRAPING ==============

function scheduleNightlyScrape() {
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
