# Foreclosure Finder

A web scraper that collects foreclosure property listings from CivilView and displays them in a searchable interface.

## Current Counties

- **Camden County, NJ** (~165 properties)
- **Montgomery County, PA** (~235 properties)

---

## How to Add a New County

### Step 1: Find the County ID

Go to CivilView and browse to the county you want. Look at the URL:

```
https://salesweb.civilview.com/Sales/SalesSearch?countyId=23
                                                         ^^
                                                    This number is the ID
```

### Step 2: Edit `config.js`

1. Go to your GitHub repo
2. Click on `config.js`
3. Click the **pencil icon** ✏️ to edit
4. Add a new entry to the `counties` array:

```javascript
counties: [
  // ... existing counties ...
  {
    id: 99,                          // ← county ID from URL
    name: 'NewCounty',               // ← county name (no "County" suffix)
    state: 'PA',                     // ← state abbreviation (NJ or PA)
    searchUrl: 'https://salesweb.civilview.com/Sales/SalesSearch?countyId=99'
  }
]
```

5. Click **"Commit changes"**
6. Render will auto-deploy (wait 2-3 minutes)
7. Click "Refresh Data" on the website to scrape the new county

---

## File Structure

```
├── scraper.js           # Main orchestrator
├── config.js            # Settings & county list (EDIT THIS TO ADD COUNTIES)
├── server.js            # Web server
├── package.json         # Dependencies
├── Dockerfile           # Container config for Render
├── render.yaml          # Render deployment config
├── public/              # Frontend files
│   └── index.html       # Main webpage
└── scrapers/            # Scraper modules
    └── civilview.js     # CivilView scraper logic
```

---

## Configuration Options

In `config.js` you can also adjust:

| Setting | Default | Description |
|---------|---------|-------------|
| `requestDelay` | 400 | Milliseconds between requests |
| `batchSize` | 30 | Properties before pausing |
| `batchPause` | 3000 | Pause duration (ms) between batches |
| `countyPause` | 10000 | Pause duration (ms) between counties |

---

## Password

The site is password protected. Default password: `Benoro`

To change it, set the `SITE_PASSWORD` environment variable in Render.

---

## Troubleshooting

### Data shows "N/A" for debt amounts
The scraper may have been rate-limited. Wait 10 minutes and try "Refresh Data" again.

### Scraper times out
Some counties have many properties. Try increasing `pageTimeout` in `config.js`.

### New county not showing
1. Make sure you committed the changes to GitHub
2. Check Render dashboard to confirm it redeployed
3. Click "Refresh Data" to run a new scrape
