const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs').promises;
const { runScraper, CONFIG } = require('./scraper');
const { runPipelineScraper, OUTPUT_FILE: PIPELINE_FILE } = require('./pipeline-scraper');

const app = express();
const PORT = process.env.PORT || 3000;

const SITE_PASSWORD = process.env.SITE_PASSWORD || 'Benoro';

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.text({ limit: '10mb', type: 'text/csv' }));

const DATA_FILE = path.join(CONFIG.outputDir, CONFIG.outputFile);
const PIPELINE_DATA_FILE = path.join(CONFIG.outputDir, PIPELINE_FILE);
const CSV_FILE = path.join(CONFIG.outputDir, 'montco-cases.csv');

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

// ============== PIPELINE API ==============

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
  
  isPipelineScrapingInProgress = true;
  lastPipelineScrapeStatus = { started: new Date().toISOString(), status: 'running' };
  res.json({ message: 'Pipeline scrape started', status: lastPipelineScrapeStatus });
  
  try {
    const options = {
      enableEnrichment: req.body.enableEnrichment !== false,
      maxCasesToEnrich: req.body.maxCasesToEnrich || 25
    };
    const cases = await runPipelineScraper(options);
    const grades = { A: 0, B: 0, C: 0, D: 0, F: 0 };
    cases.forEach(c => grades[c.leadGrade || 'C']++);
    lastPipelineScrapeStatus = { completed: new Date().toISOString(), status: 'completed', casesFound: cases.length, grades };
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

ensureDataDir().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 Foreclosure Finder server running on port ${PORT}`);
    console.log(`   Open http://localhost:${PORT} in your browser`);
  });
});
