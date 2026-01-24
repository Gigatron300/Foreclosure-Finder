const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs').promises;
const { runScraper, CONFIG } = require('./scraper');
const { runPipelineScraper, OUTPUT_FILE: PIPELINE_FILE } = require('./pipeline-scraper');

const app = express();
const PORT = process.env.PORT || 3000;

// Password for site access
const SITE_PASSWORD = process.env.SITE_PASSWORD || 'Benoro';

app.use(cors());
app.use(express.json());

const DATA_FILE = path.join(CONFIG.outputDir, CONFIG.outputFile);
const PIPELINE_DATA_FILE = path.join(CONFIG.outputDir, PIPELINE_FILE);

// Ensure data directory exists
async function ensureDataDir() {
  try {
    await fs.mkdir(CONFIG.outputDir, { recursive: true });
  } catch (e) {}
}

// Auth verification endpoint
app.post('/api/auth', (req, res) => {
  const { password } = req.body;
  if (password === SITE_PASSWORD) {
    res.json({ success: true });
  } else {
    res.status(401).json({ success: false, error: 'Invalid password' });
  }
});

// Middleware to check auth header on API routes
const checkAuth = (req, res, next) => {
  const authHeader = req.headers['x-auth-token'];
  if (authHeader === SITE_PASSWORD) {
    next();
  } else {
    res.status(401).json({ error: 'Unauthorized' });
  }
};

// Serve login page for unauthenticated users
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Serve static files
app.use(express.static('public'));

// Get all properties (protected)
app.get('/api/properties', checkAuth, async (req, res) => {
  try {
    const data = await fs.readFile(DATA_FILE, 'utf8');
    const jsonData = JSON.parse(data);
    let properties = jsonData.properties;
    
    if (req.query.maxDebt) {
      const maxDebt = parseFloat(req.query.maxDebt);
      properties = properties.filter(p => p.debtAmount <= maxDebt);
    }
    
    if (req.query.county) {
      properties = properties.filter(p => p.county === req.query.county);
    }
    
    if (req.query.city) {
      properties = properties.filter(p => 
        p.city.toLowerCase().includes(req.query.city.toLowerCase())
      );
    }
    
    if (req.query.minDebt) {
      const minDebt = parseFloat(req.query.minDebt);
      properties = properties.filter(p => p.debtAmount >= minDebt);
    }
    
    const sortBy = req.query.sortBy || 'debtAmount';
    const sortOrder = req.query.sortOrder === 'desc' ? -1 : 1;
    
    properties.sort((a, b) => {
      if (sortBy === 'debtAmount') {
        return (a.debtAmount - b.debtAmount) * sortOrder;
      }
      if (sortBy === 'salesDate') {
        return (new Date(a.salesDate) - new Date(b.salesDate)) * sortOrder;
      }
      if (sortBy === 'address') {
        return a.address.localeCompare(b.address) * sortOrder;
      }
      return 0;
    });
    
    res.json({
      lastUpdated: jsonData.lastUpdated,
      totalProperties: properties.length,
      sources: jsonData.sources,
      properties
    });
    
  } catch (error) {
    if (error.code === 'ENOENT') {
      res.json({
        lastUpdated: null,
        totalProperties: 0,
        sources: { civilView: 0, bid4Assets: 0 },
        properties: [],
        message: 'No data yet. Click "Refresh Data from Counties" to start scraping.'
      });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

// Get single property by ID (protected)
app.get('/api/properties/:id', checkAuth, async (req, res) => {
  try {
    const data = await fs.readFile(DATA_FILE, 'utf8');
    const jsonData = JSON.parse(data);
    const property = jsonData.properties.find(p => p.propertyId === req.params.id);
    
    if (property) {
      res.json(property);
    } else {
      res.status(404).json({ error: 'Property not found' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get stats (protected)
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

// Manually trigger a scrape (protected)
let isScrapingInProgress = false;
let lastScrapeStatus = null;

app.post('/api/scrape', checkAuth, async (req, res) => {
  if (isScrapingInProgress) {
    return res.status(429).json({ 
      error: 'Scrape already in progress',
      status: lastScrapeStatus 
    });
  }
  
  isScrapingInProgress = true;
  lastScrapeStatus = { started: new Date().toISOString(), status: 'running' };
  
  res.json({ message: 'Scrape started', status: lastScrapeStatus });
  
  try {
    const properties = await runScraper();
    lastScrapeStatus = {
      completed: new Date().toISOString(),
      status: 'completed',
      propertiesFound: properties.length
    };
  } catch (error) {
    lastScrapeStatus = {
      completed: new Date().toISOString(),
      status: 'error',
      error: error.message
    };
  } finally {
    isScrapingInProgress = false;
  }
});

// Get scrape status (protected)
app.get('/api/scrape/status', checkAuth, (req, res) => {
  res.json({
    inProgress: isScrapingInProgress,
    lastStatus: lastScrapeStatus
  });
});

// Export data as CSV (protected)
app.get('/api/export/csv', checkAuth, async (req, res) => {
  try {
    const data = await fs.readFile(DATA_FILE, 'utf8');
    const jsonData = JSON.parse(data);
    
    const headers = [
      'Address', 'City', 'State', 'Zip', 'Debt Amount', 'Defendant', 
      'Plaintiff', 'Sheriff #', 'Court Case', 'Sale Date', 'Status', 
      'Attorney', 'Attorney Phone', 'Parcel #', 'County', 'Township', 
      'Source', 'URL'
    ];
    
    const rows = jsonData.properties.map(p => [
      `"${p.address}"`,
      p.city,
      p.state,
      p.zipCode,
      p.debtAmount,
      `"${(p.defendant || '').replace(/"/g, '""')}"`,
      `"${(p.plaintiff || '').replace(/"/g, '""')}"`,
      p.sheriffNumber,
      p.courtCase,
      p.salesDate,
      p.status,
      `"${(p.attorney || '').replace(/"/g, '""')}"`,
      p.attorneyPhone,
      p.parcelNumber,
      p.county,
      p.township,
      p.source,
      p.detailUrl
    ]);
    
    const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=foreclosures.csv');
    res.send(csv);
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============== PIPELINE API ENDPOINTS ==============

// Get all pipeline cases (protected)
app.get('/api/pipeline', checkAuth, async (req, res) => {
  try {
    const data = await fs.readFile(PIPELINE_DATA_FILE, 'utf8');
    const jsonData = JSON.parse(data);
    let cases = jsonData.cases;
    
    // Filter by status
    if (req.query.status) {
      cases = cases.filter(c => c.status.toLowerCase().includes(req.query.status.toLowerCase()));
    }
    
    // Filter by has judgement
    if (req.query.hasJudgement === 'true') {
      cases = cases.filter(c => c.hasJudgement);
    } else if (req.query.hasJudgement === 'false') {
      cases = cases.filter(c => !c.hasJudgement);
    }
    
    // Filter by has lis pendens
    if (req.query.hasLisPendens === 'true') {
      cases = cases.filter(c => c.hasLisPendens);
    } else if (req.query.hasLisPendens === 'false') {
      cases = cases.filter(c => !c.hasLisPendens);
    }
    
    // Filter by minimum days open
    if (req.query.minDaysOpen) {
      const minDays = parseInt(req.query.minDaysOpen);
      cases = cases.filter(c => (c.daysOpen || 0) >= minDays);
    }
    
    // Filter by maximum days open
    if (req.query.maxDaysOpen) {
      const maxDays = parseInt(req.query.maxDaysOpen);
      cases = cases.filter(c => (c.daysOpen || 0) <= maxDays);
    }
    
    // Filter by city
    if (req.query.city) {
      cases = cases.filter(c => 
        c.propertyCity.toLowerCase().includes(req.query.city.toLowerCase())
      );
    }
    
    // Sort
    const sortBy = req.query.sortBy || 'daysOpen';
    const sortOrder = req.query.sortOrder === 'asc' ? 1 : -1;
    
    cases.sort((a, b) => {
      if (sortBy === 'daysOpen') {
        return ((a.daysOpen || 0) - (b.daysOpen || 0)) * sortOrder;
      }
      if (sortBy === 'commencedDate') {
        return (new Date(a.commencedDate) - new Date(b.commencedDate)) * sortOrder;
      }
      if (sortBy === 'caseNumber') {
        return a.caseNumber.localeCompare(b.caseNumber) * sortOrder;
      }
      return 0;
    });
    
    res.json({
      lastUpdated: jsonData.lastUpdated,
      totalCases: cases.length,
      sources: jsonData.sources,
      cases
    });
    
  } catch (error) {
    if (error.code === 'ENOENT') {
      res.json({
        lastUpdated: null,
        totalCases: 0,
        sources: {},
        cases: [],
        message: 'No pipeline data yet. Click "Refresh Pipeline Data" to start scraping.'
      });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

// Get pipeline stats (protected)
app.get('/api/pipeline/stats', checkAuth, async (req, res) => {
  try {
    const data = await fs.readFile(PIPELINE_DATA_FILE, 'utf8');
    const jsonData = JSON.parse(data);
    const cases = jsonData.cases;
    
    const stats = {
      lastUpdated: jsonData.lastUpdated,
      total: cases.length,
      sources: jsonData.sources,
      withJudgement: cases.filter(c => c.hasJudgement).length,
      withLisPendens: cases.filter(c => c.hasLisPendens).length,
      avgDaysOpen: cases.length > 0 
        ? Math.round(cases.reduce((sum, c) => sum + (c.daysOpen || 0), 0) / cases.length)
        : 0,
      byStatus: {},
      byCaseType: {}
    };
    
    cases.forEach(c => {
      // Simplify status (just OPEN or number)
      const statusKey = c.status.includes('OPEN') ? 'OPEN' : c.status;
      stats.byStatus[statusKey] = (stats.byStatus[statusKey] || 0) + 1;
      stats.byCaseType[c.caseType] = (stats.byCaseType[c.caseType] || 0) + 1;
    });
    
    res.json(stats);
  } catch (error) {
    res.json({ lastUpdated: null, total: 0, sources: {} });
  }
});

// Manually trigger pipeline scrape (protected)
let isPipelineScrapingInProgress = false;
let lastPipelineScrapeStatus = null;

app.post('/api/pipeline/scrape', checkAuth, async (req, res) => {
  if (isPipelineScrapingInProgress) {
    return res.status(429).json({ 
      error: 'Pipeline scrape already in progress',
      status: lastPipelineScrapeStatus 
    });
  }
  
  isPipelineScrapingInProgress = true;
  lastPipelineScrapeStatus = { started: new Date().toISOString(), status: 'running' };
  
  res.json({ message: 'Pipeline scrape started', status: lastPipelineScrapeStatus });
  
  try {
    const cases = await runPipelineScraper();
    lastPipelineScrapeStatus = {
      completed: new Date().toISOString(),
      status: 'completed',
      casesFound: cases.length
    };
  } catch (error) {
    lastPipelineScrapeStatus = {
      completed: new Date().toISOString(),
      status: 'error',
      error: error.message
    };
  } finally {
    isPipelineScrapingInProgress = false;
  }
});

// Get pipeline scrape status (protected)
app.get('/api/pipeline/scrape/status', checkAuth, (req, res) => {
  res.json({
    inProgress: isPipelineScrapingInProgress,
    lastStatus: lastPipelineScrapeStatus
  });
});

// Export pipeline data as CSV (protected)
app.get('/api/pipeline/export/csv', checkAuth, async (req, res) => {
  try {
    const data = await fs.readFile(PIPELINE_DATA_FILE, 'utf8');
    const jsonData = JSON.parse(data);
    
    const headers = [
      'Case Number', 'Case Type', 'Commenced Date', 'Days Open', 'Last Filing',
      'Plaintiff (Bank)', 'Defendant (Owner)', 'Property Address', 'City', 
      'State', 'Zip', 'Parcel #', 'Has Judgement', 'Has Lis Pendens', 
      'Status', 'Judge', 'Remarks', 'Detail URL'
    ];
    
    const rows = jsonData.cases.map(c => [
      c.caseNumber,
      `"${c.caseType}"`,
      c.commencedDate,
      c.daysOpen,
      c.lastFilingDate,
      `"${(c.plaintiff || '').replace(/"/g, '""')}"`,
      `"${(c.defendant || '').replace(/"/g, '""')}"`,
      `"${(c.propertyAddress || '').replace(/"/g, '""')}"`,
      c.propertyCity,
      c.propertyState,
      c.propertyZip,
      c.parcelNumber,
      c.hasJudgement ? 'Yes' : 'No',
      c.hasLisPendens ? 'Yes' : 'No',
      c.status,
      `"${(c.judge || '').replace(/"/g, '""')}"`,
      `"${(c.remarks || '').replace(/"/g, '""')}"`,
      c.detailUrl
    ]);
    
    const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=pre-foreclosure-pipeline.csv');
    res.send(csv);
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Start server
ensureDataDir().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 Foreclosure Finder server running on port ${PORT}`);
    console.log(`   Open http://localhost:${PORT} in your browser`);
    console.log(`   API available at http://localhost:${PORT}/api/properties`);
  });
});
