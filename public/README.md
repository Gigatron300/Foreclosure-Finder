# Foreclosure Property Finder

A web application that scrapes foreclosure listings from:
- **CivilView** - Camden County, NJ Sheriff Sales
- **Bid4Assets** - Montgomery County, PA Sheriff Sales

## Features

- 🏠 Scrapes all property details including debt amounts, addresses, defendants, sale dates
- 🔍 Filter by maximum debt, source, city
- 📊 Statistics dashboard
- 📸 Google Street View integration (optional API key)
- 🔗 Direct links to Zillow and Google Maps
- 📥 CSV export
- ⏰ Scheduled automatic updates

## Quick Deploy to Render

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy)

Or follow the detailed [Deployment Guide](DEPLOYMENT_GUIDE.md).

## Local Development

```bash
# Install dependencies
npm install

# Run the scraper once
npm run scrape

# Start the web server
npm start

# Open http://localhost:3000
```

## API Endpoints

- `GET /api/properties` - Get all properties (with optional filters)
- `GET /api/properties/:id` - Get single property
- `GET /api/stats` - Get statistics
- `POST /api/scrape` - Trigger a new scrape
- `GET /api/scrape/status` - Check scrape status
- `GET /api/export/csv` - Download CSV

## Query Parameters

```
/api/properties?maxDebt=200000&source=CivilView&city=Camden
```

- `maxDebt` - Maximum debt amount
- `minDebt` - Minimum debt amount  
- `source` - CivilView or Bid4Assets
- `city` - Filter by city name
- `sortBy` - debtAmount, salesDate, or address
- `sortOrder` - asc or desc

## License

MIT
