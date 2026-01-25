// Property Enrichment Module for Montgomery County
// Fetches property assessment data, tax status, and owner information
// Uses Montgomery County's public assessment records

const puppeteer = require('puppeteer');

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const CONFIG = {
  assessmentUrl: 'https://propertyrecords.montcopa.org',
  requestDelay: 800,
  batchSize: 5,
  batchPause: 2000,
  timeout: 30000
};

// Enrich a single case with property data
async function enrichPropertyData(page, caseData) {
  const enrichment = {
    assessedValue: null,
    landValue: null,
    improvementValue: null,
    propertyType: null,
    yearBuilt: null,
    squareFeet: null,
    bedrooms: null,
    bathrooms: null,
    lotSize: null,
    ownerName: null,
    ownerMailingAddress: null,
    isOwnerOccupied: null,
    taxStatus: null,
    taxDelinquent: false,
    lastSaleDate: null,
    lastSalePrice: null,
    enrichmentSource: 'Montgomery County Assessment',
    enrichedAt: new Date().toISOString()
  };
  
  try {
    // Try searching by parcel number first (most accurate)
    if (caseData.parcelNumber) {
      const searchUrl = `${CONFIG.assessmentUrl}/Search?parcel=${encodeURIComponent(caseData.parcelNumber)}`;
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: CONFIG.timeout });
      await delay(1000);
      
      // Check if we got results
      const hasResults = await page.evaluate(() => {
        return document.body.textContent.includes('Property Details') || 
               document.querySelector('.property-card') !== null ||
               document.querySelector('table tr td') !== null;
      });
      
      if (hasResults) {
        const data = await extractPropertyData(page);
        Object.assign(enrichment, data);
      }
    }
    
    // If no results by parcel, try by address
    if (!enrichment.assessedValue && caseData.propertyAddress) {
      const addressQuery = `${caseData.propertyAddress} ${caseData.propertyCity || ''}`.trim();
      const searchUrl = `${CONFIG.assessmentUrl}/Search?address=${encodeURIComponent(addressQuery)}`;
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: CONFIG.timeout });
      await delay(1000);
      
      const data = await extractPropertyData(page);
      Object.assign(enrichment, data);
    }
    
    // Determine if owner-occupied by comparing defendant name with owner on record
    if (enrichment.ownerName && caseData.defendant) {
      const ownerLower = (enrichment.ownerName || '').toLowerCase();
      const defendantLower = (caseData.defendant || '').toLowerCase();
      
      // Extract last names for comparison
      const getLastName = (name) => {
        const parts = name.split(/[\s,]+/).filter(p => p.length > 1);
        return parts[0] || '';
      };
      
      const ownerLastName = getLastName(ownerLower);
      const defendantLastName = getLastName(defendantLower);
      
      enrichment.isOwnerOccupied = ownerLastName === defendantLastName || 
                                    ownerLower.includes(defendantLastName) ||
                                    defendantLower.includes(ownerLastName);
    }
    
    // Check if mailing address matches property address (another owner-occupied indicator)
    if (enrichment.ownerMailingAddress && caseData.propertyAddress) {
      const mailingLower = (enrichment.ownerMailingAddress || '').toLowerCase();
      const propertyLower = (caseData.propertyAddress || '').toLowerCase();
      
      // Extract street number for comparison
      const getStreetNum = (addr) => {
        const match = addr.match(/^\d+/);
        return match ? match[0] : '';
      };
      
      if (getStreetNum(mailingLower) === getStreetNum(propertyLower) && 
          mailingLower.includes(propertyLower.split(' ')[1] || '')) {
        enrichment.isOwnerOccupied = true;
      }
    }
    
  } catch (error) {
    console.log(`     Enrichment error: ${error.message}`);
  }
  
  return enrichment;
}

// Extract property data from the assessment page
async function extractPropertyData(page) {
  return await page.evaluate(() => {
    const data = {
      assessedValue: null,
      landValue: null,
      improvementValue: null,
      propertyType: null,
      yearBuilt: null,
      squareFeet: null,
      bedrooms: null,
      bathrooms: null,
      lotSize: null,
      ownerName: null,
      ownerMailingAddress: null,
      taxStatus: null,
      taxDelinquent: false,
      lastSaleDate: null,
      lastSalePrice: null
    };
    
    // Helper to find value by label
    const findValue = (labels) => {
      const allText = document.body.innerText;
      for (const label of labels) {
        const regex = new RegExp(`${label}[:\\s]+([\\d,$\\.]+|[\\w\\s]+)`, 'i');
        const match = allText.match(regex);
        if (match) return match[1].trim();
      }
      
      // Try table cells
      const tds = document.querySelectorAll('td, th');
      for (let i = 0; i < tds.length; i++) {
        const td = tds[i];
        for (const label of labels) {
          if (td.textContent.toLowerCase().includes(label.toLowerCase())) {
            const nextTd = tds[i + 1];
            if (nextTd) return nextTd.textContent.trim();
          }
        }
      }
      
      return null;
    };
    
    // Parse currency
    const parseCurrency = (str) => {
      if (!str) return null;
      const cleaned = str.replace(/[$,]/g, '');
      const num = parseFloat(cleaned);
      return isNaN(num) ? null : num;
    };
    
    // Parse integer
    const parseInt2 = (str) => {
      if (!str) return null;
      const num = parseInt(str.replace(/[^0-9]/g, ''));
      return isNaN(num) ? null : num;
    };
    
    // Extract values
    data.assessedValue = parseCurrency(findValue(['Total Value', 'Assessed Value', 'Market Value', 'Total Assessment']));
    data.landValue = parseCurrency(findValue(['Land Value', 'Land Assessment']));
    data.improvementValue = parseCurrency(findValue(['Improvement Value', 'Building Value', 'Improvement Assessment']));
    data.propertyType = findValue(['Property Type', 'Use Code', 'Property Class', 'Land Use']);
    data.yearBuilt = parseInt2(findValue(['Year Built', 'Year Constructed']));
    data.squareFeet = parseInt2(findValue(['Square Feet', 'Sq Ft', 'Living Area', 'Total Area']));
    data.bedrooms = parseInt2(findValue(['Bedrooms', 'Beds']));
    data.bathrooms = parseInt2(findValue(['Bathrooms', 'Baths', 'Full Baths']));
    data.lotSize = findValue(['Lot Size', 'Land Area', 'Acres']);
    data.ownerName = findValue(['Owner', 'Owner Name', 'Property Owner']);
    data.ownerMailingAddress = findValue(['Mailing Address', 'Owner Address']);
    data.lastSaleDate = findValue(['Sale Date', 'Last Sale', 'Transfer Date']);
    data.lastSalePrice = parseCurrency(findValue(['Sale Price', 'Sale Amount', 'Transfer Amount']));
    
    // Check for tax delinquency
    const pageText = document.body.innerText.toLowerCase();
    data.taxDelinquent = pageText.includes('delinquent') || 
                         pageText.includes('tax lien') ||
                         pageText.includes('unpaid taxes');
    
    if (pageText.includes('tax status')) {
      data.taxStatus = findValue(['Tax Status']);
    }
    
    return data;
  });
}

// Batch enrich multiple cases
async function enrichCases(cases, options = {}) {
  const { maxCases = 25, onProgress } = options;
  
  console.log(`\n🏠 Enriching property data for ${Math.min(cases.length, maxCases)} cases...`);
  
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu'
    ]
  });
  
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
  
  // Disable images to speed up
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (['image', 'stylesheet', 'font'].includes(req.resourceType())) {
      req.abort();
    } else {
      req.continue();
    }
  });
  
  const enrichedCases = [];
  const casesToEnrich = cases.slice(0, maxCases);
  
  try {
    for (let i = 0; i < casesToEnrich.length; i++) {
      const caseData = casesToEnrich[i];
      
      if (i > 0 && i % CONFIG.batchSize === 0) {
        console.log('   ⏸ Batch pause...');
        await delay(CONFIG.batchPause);
      }
      
      await delay(CONFIG.requestDelay);
      
      const enrichment = await enrichPropertyData(page, caseData);
      
      const enrichedCase = {
        ...caseData,
        propertyEnrichment: enrichment
      };
      
      enrichedCases.push(enrichedCase);
      
      const value = enrichment.assessedValue 
        ? `$${enrichment.assessedValue.toLocaleString()}` 
        : 'No data';
      const type = enrichment.propertyType || 'Unknown';
      
      console.log(`   ${i + 1}/${casesToEnrich.length} ✓ ${caseData.propertyAddress || 'Property'} - ${value} (${type})`);
      
      if (onProgress) {
        onProgress(i + 1, casesToEnrich.length, enrichedCase);
      }
    }
  } catch (error) {
    console.error(`Enrichment error: ${error.message}`);
  } finally {
    await browser.close();
  }
  
  // Add non-enriched cases back
  const remainingCases = cases.slice(maxCases).map(c => ({
    ...c,
    propertyEnrichment: null
  }));
  
  console.log(`✅ Enriched ${enrichedCases.length} cases with property data`);
  
  return [...enrichedCases, ...remainingCases];
}

// Calculate equity estimate
function estimateEquity(caseData) {
  const enrichment = caseData.propertyEnrichment;
  if (!enrichment?.assessedValue) return null;
  
  // Assessment is typically 85-100% of market value in PA
  // Use 90% as a conservative estimate
  const estimatedMarketValue = enrichment.assessedValue * 1.1;
  
  // We don't have mortgage balance, but can use plaintiff (lender) info
  // as a rough indicator of loan type
  const plaintiff = (caseData.plaintiff || '').toLowerCase();
  
  let estimatedLTV = 0.80; // Default assumption: 80% LTV
  
  // FHA/VA loans often have higher LTV
  if (plaintiff.includes('hud') || plaintiff.includes('fha') || 
      plaintiff.includes('va ') || plaintiff.includes('veterans')) {
    estimatedLTV = 0.95;
  }
  
  // Subprime indicators
  if (plaintiff.includes('freedom') || plaintiff.includes('nationstar') ||
      plaintiff.includes('ocwen') || plaintiff.includes('caliber')) {
    estimatedLTV = 0.90;
  }
  
  const estimatedMortgage = estimatedMarketValue * estimatedLTV;
  const estimatedEquity = estimatedMarketValue - estimatedMortgage;
  
  return {
    estimatedMarketValue: Math.round(estimatedMarketValue),
    assessedValue: enrichment.assessedValue,
    estimatedLTV,
    estimatedMortgage: Math.round(estimatedMortgage),
    estimatedEquity: Math.round(estimatedEquity),
    equityPercent: Math.round((1 - estimatedLTV) * 100),
    confidence: enrichment.assessedValue > 50000 ? 'medium' : 'low',
    note: 'Estimate based on assessment value and typical LTV. Actual equity may vary significantly.'
  };
}

module.exports = { 
  enrichCases, 
  enrichPropertyData, 
  estimateEquity,
  CONFIG 
};
