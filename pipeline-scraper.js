// Pipeline scraper - scrapes pre-foreclosure cases from court records
// Enhanced version with docket analysis, lead scoring, and property enrichment

const fs = require('fs').promises;
const path = require('path');
const { scrapeMontgomeryCourts } = require('./scrapers/montco-courts');
const { enrichCases, estimateEquity } = require('./scrapers/property-enrichment');

const OUTPUT_DIR = './data';
const OUTPUT_FILE = 'pipeline.json';

// Configuration
const PIPELINE_CONFIG = {
  enableEnrichment: true,       // Set to false to skip property enrichment
  maxCasesToEnrich: 25,         // Limit enrichment to top leads (by score)
  includeEquityEstimates: true  // Calculate equity estimates
};

async function runPipelineScraper(options = {}) {
  const config = { ...PIPELINE_CONFIG, ...options };
  
  console.log('🏛️ Pre-Foreclosure Pipeline Scraper (Enhanced)');
  console.log('==============================================');
  console.log(`Started at: ${new Date().toLocaleString()}`);
  console.log('Features: Docket analysis, lead scoring, distress signals');
  if (config.enableEnrichment) {
    console.log(`Property enrichment: Enabled (top ${config.maxCasesToEnrich} leads)`);
  }
  if (config.testMode) {
    console.log('⚡ TEST MODE ENABLED');
  }
  console.log('');
  
  let allCases = [];
  
  try {
    // Scrape Montgomery County Courts
    const montcoCases = await scrapeMontgomeryCourts({ testMode: config.testMode });
    allCases.push(...montcoCases);
    
    // Property enrichment for top leads
    if (config.enableEnrichment && allCases.length > 0) {
      console.log('\n📊 Starting property enrichment...');
      
      // Sort by lead score (already sorted, but ensure)
      allCases.sort((a, b) => (b.leadScore || 0) - (a.leadScore || 0));
      
      // Enrich top cases
      allCases = await enrichCases(allCases, {
        maxCases: config.maxCasesToEnrich
      });
      
      // Calculate equity estimates
      if (config.includeEquityEstimates) {
        allCases = allCases.map(c => ({
          ...c,
          equityEstimate: c.propertyEnrichment ? estimateEquity(c) : null
        }));
      }
    }
    
    // Can add more court sources here in the future
    
  } catch (error) {
    console.error('Scraper error:', error);
  }
  
  // Re-sort by lead score (highest first)
  allCases.sort((a, b) => (b.leadScore || 0) - (a.leadScore || 0));
  
  // Calculate statistics
  const stats = calculateStats(allCases);
  
  // Save results
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  
  const outputData = {
    lastUpdated: new Date().toISOString(),
    totalCases: allCases.length,
    sources: {
      'Montgomery County Courts': allCases.filter(c => c.county === 'Montgomery').length
    },
    statistics: stats,
    config: {
      enrichmentEnabled: config.enableEnrichment,
      casesEnriched: allCases.filter(c => c.propertyEnrichment).length
    },
    cases: allCases
  };
  
  await fs.writeFile(
    path.join(OUTPUT_DIR, OUTPUT_FILE),
    JSON.stringify(outputData, null, 2)
  );
  
  // Print summary
  console.log('\n' + '='.repeat(50));
  console.log('📊 PIPELINE SUMMARY');
  console.log('='.repeat(50));
  console.log(`Total cases: ${allCases.length}`);
  console.log(`\nLead Grades:`);
  console.log(`  🔥 A (Hot):     ${stats.byGrade.A || 0}`);
  console.log(`  ⭐ B (Good):    ${stats.byGrade.B || 0}`);
  console.log(`  📋 C (Average): ${stats.byGrade.C || 0}`);
  console.log(`  📉 D (Below):   ${stats.byGrade.D || 0}`);
  console.log(`  ❌ F (Poor):    ${stats.byGrade.F || 0}`);
  console.log(`\nKey Indicators:`);
  console.log(`  No judgment yet:       ${stats.noJudgement}`);
  console.log(`  No defendant response: ${stats.noDefendantResponse}`);
  console.log(`  Default motion filed:  ${stats.hasDefaultMotion}`);
  console.log(`  Has defendant attorney: ${stats.hasDefendantAttorney}`);
  if (stats.enrichedCases > 0) {
    console.log(`\nProperty Data:`);
    console.log(`  Cases enriched: ${stats.enrichedCases}`);
    console.log(`  Avg assessed value: $${stats.avgAssessedValue?.toLocaleString() || 'N/A'}`);
  }
  console.log(`\n💾 Saved to ${path.join(OUTPUT_DIR, OUTPUT_FILE)}`);
  console.log(`Completed at: ${new Date().toLocaleString()}`);
  
  return allCases;
}

// Calculate statistics from cases
function calculateStats(cases) {
  const stats = {
    total: cases.length,
    byGrade: { A: 0, B: 0, C: 0, D: 0, F: 0 },
    avgLeadScore: 0,
    avgDaysOpen: 0,
    noJudgement: 0,
    noDefendantResponse: 0,
    noDefendantAttorney: 0,
    hasDefaultMotion: 0,
    hasDefendantAttorney: 0,
    hasConciliation: 0,
    enrichedCases: 0,
    avgAssessedValue: null,
    byCity: {}
  };
  
  if (cases.length === 0) return stats;
  
  let totalScore = 0;
  let totalDays = 0;
  let totalAssessedValue = 0;
  let assessedCount = 0;
  
  for (const c of cases) {
    // Grade distribution
    stats.byGrade[c.leadGrade || 'C']++;
    
    // Averages
    totalScore += c.leadScore || 0;
    totalDays += c.daysOpen || 0;
    
    // Key indicators
    if (!c.hasJudgement) stats.noJudgement++;
    if (!c.docketSummary?.hasDefendantResponse) stats.noDefendantResponse++;
    if (!c.docketSummary?.hasDefendantAttorney) stats.noDefendantAttorney++;
    if (c.docketSummary?.hasDefaultMotion) stats.hasDefaultMotion++;
    if (c.docketSummary?.hasDefendantAttorney) stats.hasDefendantAttorney++;
    if (c.docketSummary?.hasConciliation) stats.hasConciliation++;
    
    // Enrichment
    if (c.propertyEnrichment) {
      stats.enrichedCases++;
      if (c.propertyEnrichment.assessedValue) {
        totalAssessedValue += c.propertyEnrichment.assessedValue;
        assessedCount++;
      }
    }
    
    // By city
    const city = c.propertyCity || 'Unknown';
    stats.byCity[city] = (stats.byCity[city] || 0) + 1;
  }
  
  stats.avgLeadScore = Math.round(totalScore / cases.length);
  stats.avgDaysOpen = Math.round(totalDays / cases.length);
  
  if (assessedCount > 0) {
    stats.avgAssessedValue = Math.round(totalAssessedValue / assessedCount);
  }
  
  return stats;
}

// Export for use by server
module.exports = { runPipelineScraper, OUTPUT_DIR, OUTPUT_FILE, PIPELINE_CONFIG };

// Run if called directly
if (require.main === module) {
  runPipelineScraper().catch(console.error);
}
