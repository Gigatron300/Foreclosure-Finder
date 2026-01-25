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

// ============== PIPELINE API ENDPOINTS (ENHANCED) ==============

// Get all pipeline cases (protected)
app.get('/api/pipeline', checkAuth, async (req, res) => {
  try {
    const data = await fs.readFile(PIPELINE_DATA_FILE, 'utf8');
    const jsonData = JSON.parse(data);
    let cases = jsonData.cases;
    
    // Filter by lead grade
    if (req.query.grade) {
      const grades = req.query.grade.toUpperCase().split(',');
      cases = cases.filter(c => grades.includes(c.leadGrade));
    }
    
    // Filter by minimum lead score
    if (req.query.minScore) {
      const minScore = parseInt(req.query.minScore);
      cases = cases.filter(c => (c.leadScore || 0) >= minScore);
    }
    
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
    
    // Filter by has defendant attorney
    if (req.query.hasDefendantAttorney === 'true') {
      cases = cases.filter(c => c.docketSummary?.hasDefendantAttorney);
    } else if (req.query.hasDefendantAttorney === 'false') {
      cases = cases.filter(c => !c.docketSummary?.hasDefendantAttorney);
    }
    
    // Filter by has defendant response
    if (req.query.hasDefendantResponse === 'true') {
      cases = cases.filter(c => c.docketSummary?.hasDefendantResponse);
    } else if (req.query.hasDefendantResponse === 'false') {
      cases = cases.filter(c => !c.docketSummary?.hasDefendantResponse);
    }
    
    // Filter by has default motion
    if (req.query.hasDefaultMotion === 'true') {
      cases = cases.filter(c => c.docketSummary?.hasDefaultMotion);
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
        (c.propertyCity || '').toLowerCase().includes(req.query.city.toLowerCase())
      );
    }
    
    // Sort
    const sortBy = req.query.sortBy || 'leadScore';
    const sortOrder = req.query.sortOrder === 'asc' ? 1 : -1;
    
    cases.sort((a, b) => {
      if (sortBy === 'leadScore') {
        return ((a.leadScore || 0) - (b.leadScore || 0)) * sortOrder;
      }
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
      statistics: jsonData.statistics,
      cases
    });
    
  } catch (error) {
    if (error.code === 'ENOENT') {
      res.json({
        lastUpdated: null,
        totalCases: 0,
        sources: {},
        statistics: {},
        cases: [],
        message: 'No pipeline data yet. Click "Refresh Pipeline Data" to start scraping.'
      });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

// Get pipeline stats (protected) - ENHANCED
app.get('/api/pipeline/stats', checkAuth, async (req, res) => {
  try {
    const data = await fs.readFile(PIPELINE_DATA_FILE, 'utf8');
    const jsonData = JSON.parse(data);
    const cases = jsonData.cases || [];
    
    // Use pre-calculated stats if available, otherwise calculate
    const stats = jsonData.statistics || {
      total: cases.length,
      byGrade: { A: 0, B: 0, C: 0, D: 0, F: 0 },
      avgLeadScore: 0,
      avgDaysOpen: 0
    };
    
    // Add additional stats
    stats.lastUpdated = jsonData.lastUpdated;
    stats.sources = jsonData.sources;
    stats.withJudgement = cases.filter(c => c.hasJudgement).length;
    stats.withLisPendens = cases.filter(c => c.hasLisPendens).length;
    
    // Calculate if not present
    if (!stats.byGrade || Object.keys(stats.byGrade).length === 0) {
      stats.byGrade = { A: 0, B: 0, C: 0, D: 0, F: 0 };
      cases.forEach(c => {
        stats.byGrade[c.leadGrade || 'C']++;
      });
    }
    
    if (!stats.avgDaysOpen && cases.length > 0) {
      stats.avgDaysOpen = Math.round(
        cases.reduce((sum, c) => sum + (c.daysOpen || 0), 0) / cases.length
      );
    }
    
    if (!stats.avgLeadScore && cases.length > 0) {
      stats.avgLeadScore = Math.round(
        cases.reduce((sum, c) => sum + (c.leadScore || 0), 0) / cases.length
      );
    }
    
    // Top cities
    const byCity = {};
    cases.forEach(c => {
      const city = c.propertyCity || 'Unknown';
      byCity[city] = (byCity[city] || 0) + 1;
    });
    stats.topCities = Object.entries(byCity)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([city, count]) => ({ city, count }));
    
    res.json(stats);
  } catch (error) {
    res.json({ 
      lastUpdated: null, 
      total: 0, 
      sources: {},
      byGrade: { A: 0, B: 0, C: 0, D: 0, F: 0 }
    });
  }
});

// Get single case details (protected)
app.get('/api/pipeline/case/:caseNumber', checkAuth, async (req, res) => {
  try {
    const data = await fs.readFile(PIPELINE_DATA_FILE, 'utf8');
    const jsonData = JSON.parse(data);
    const caseData = jsonData.cases.find(c => c.caseNumber === req.params.caseNumber);
    
    if (caseData) {
      res.json(caseData);
    } else {
      res.status(404).json({ error: 'Case not found' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
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
    // Get options from request body
    const options = {
      enableEnrichment: req.body.enableEnrichment !== false,
      maxCasesToEnrich: req.body.maxCasesToEnrich || 25
    };
    
    const cases = await runPipelineScraper(options);
    
    // Calculate grade distribution
    const grades = { A: 0, B: 0, C: 0, D: 0, F: 0 };
    cases.forEach(c => grades[c.leadGrade || 'C']++);
    
    lastPipelineScrapeStatus = {
      completed: new Date().toISOString(),
      status: 'completed',
      casesFound: cases.length,
      grades
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

// Export pipeline data as CSV (protected) - ENHANCED
app.get('/api/pipeline/export/csv', checkAuth, async (req, res) => {
  try {
    const data = await fs.readFile(PIPELINE_DATA_FILE, 'utf8');
    const jsonData = JSON.parse(data);
    
    const headers = [
      'Lead Grade', 'Lead Score', 'Case Number', 'Case Type', 'Commenced Date', 
      'Days Open', 'Last Filing', 'Days Since Activity',
      'Plaintiff (Bank)', 'Defendant (Owner)', 'Property Address', 'City', 
      'State', 'Zip', 'Parcel #', 'Has Judgement', 
      'Has Default Motion', 'Has Defendant Attorney', 'Has Defendant Response',
      'Conciliation Status', 'Service Attempts', 'Failed Service',
      'Status', 'Judge', 'Remarks', 'Detail URL'
    ];
    
    const rows = jsonData.cases.map(c => {
      const ds = c.docketSummary || {};
      return [
        c.leadGrade || 'C',
        c.leadScore || 0,
        c.caseNumber,
        `"${c.caseType}"`,
        c.commencedDate,
        c.daysOpen,
        c.lastFilingDate || '',
        c.daysSinceLastActivity || '',
        `"${(c.plaintiff || '').replace(/"/g, '""')}"`,
        `"${(c.defendant || '').replace(/"/g, '""')}"`,
        `"${(c.propertyAddress || '').replace(/"/g, '""')}"`,
        c.propertyCity,
        c.propertyState,
        c.propertyZip,
        c.parcelNumber,
        c.hasJudgement ? 'Yes' : 'No',
        ds.hasDefaultMotion ? 'Yes' : 'No',
        ds.hasDefendantAttorney ? 'Yes' : 'No',
        ds.hasDefendantResponse ? 'Yes' : 'No',
        ds.conciliationStatus || '',
        ds.serviceAttempts || 0,
        ds.failedServiceAttempts || 0,
        c.status,
        `"${(c.judge || '').replace(/"/g, '""')}"`,
        `"${(c.remarks || '').replace(/"/g, '""')}"`,
        c.detailUrl
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

// Start server
ensureDataDir().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 Foreclosure Finder server running on port ${PORT}`);
    console.log(`   Open http://localhost:${PORT} in your browser`);
    console.log(`   API available at http://localhost:${PORT}/api/properties`);
    console.log(`   Pipeline API at http://localhost:${PORT}/api/pipeline`);
  });
});
