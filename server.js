const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs').promises;

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const DATA_FILE = './data/properties.json';

// Ensure data directory exists
async function ensureDataDir() {
  try {
    await fs.mkdir('./data', { recursive: true });
  } catch (e) {}
}

// Get all properties
app.get('/api/properties', async (req, res) => {
  try {
    const data = await fs.readFile(DATA_FILE, 'utf8');
    const jsonData = JSON.parse(data);
    let properties = jsonData.properties;
    
    if (req.query.maxDebt) {
      const maxDebt = parseFloat(req.query.maxDebt);
      properties = properties.filter(p => p.debtAmount <= maxDebt);
    }
    
    if (req.query.source) {
      properties = properties.filter(p => p.source === req.query.source);
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
    
    properties.sort((a, b) => a.debtAmount - b.debtAmount);
    
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
        message: 'No data yet. Scraper not available on free tier - upgrade to paid to enable.'
      });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

// Get stats
app.get('/api/stats', async (req, res) => {
  try {
    const data = await fs.readFile(DATA_FILE, 'utf8');
    const jsonData = JSON.parse(data);
    const properties = jsonData.properties;
    
    res.json({
      lastUpdated: jsonData.lastUpdated,
      total: properties.length,
      bySources: jsonData.sources
    });
  } catch (error) {
    res.json({ lastUpdated: null, total: 0, bySources: {} });
  }
});

// Scrape endpoint - disabled on lite version
let isScrapingInProgress = false;
let lastScrapeStatus = null;

app.post('/api/scrape', async (req, res) => {
  res.status(503).json({ 
    error: 'Scraper requires paid tier. Please upgrade your Render instance to Starter ($7/mo) to enable scraping.',
    upgradeUrl: 'https://dashboard.render.com'
  });
});

app.get('/api/scrape/status', (req, res) => {
  res.json({
    inProgress: false,
    lastStatus: { status: 'Scraper disabled on free tier' }
  });
});

// Export CSV
app.get('/api/export/csv', async (req, res) => {
  try {
    const data = await fs.readFile(DATA_FILE, 'utf8');
    const jsonData = JSON.parse(data);
    
    const headers = ['Address', 'City', 'State', 'Zip', 'Debt Amount', 'Defendant', 'Plaintiff', 'Sheriff #', 'Court Case', 'Sale Date', 'Status', 'Attorney', 'County', 'Source', 'URL'];
    
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
      p.county,
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

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
ensureDataDir().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 Foreclosure Finder server running on port ${PORT}`);
    console.log(`   Open http://localhost:${PORT} in your browser`);
    console.log(`   NOTE: This is the lite version. Upgrade to paid tier for scraping.`);
  });
});
