const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs').promises;
const { runScraper, CONFIG } = require('./scraper');

const app = express();
const PORT = process.env.PORT || 3000;

// Password for site access
const SITE_PASSWORD = process.env.SITE_PASSWORD || 'Benoro';

app.use(cors());
app.use(express.json());

const DATA_FILE = path.join(CONFIG.outputDir, CONFIG.outputFile);

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

// Start server
ensureDataDir().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 Foreclosure Finder server running on port ${PORT}`);
    console.log(`   Open http://localhost:${PORT} in your browser`);
    console.log(`   API available at http://localhost:${PORT}/api/properties`);
  });
});
