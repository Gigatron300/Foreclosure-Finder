// Montgomery County Courts scraper for pre-foreclosure pipeline
// Enhanced version with docket analysis, distress signals, and lead scoring
// Uses Puppeteer (required for session cookies) with memory optimizations

const puppeteer = require('puppeteer');

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const CONFIG = {
  requestDelay: 600,
  batchSize: 5,
  batchPause: 3000,
  resultsPerPage: 300,
  maxCasesToProcess: 50, // Process more cases for better lead quality
  
  // Ideal case age range (days)
  minDaysOld: 30,   // Owner has had time to realize the situation
  maxDaysOld: 365,  // Expand window - PA foreclosures take a long time
  
  caseTypes: [
    { id: 58, name: 'Complaint In Mortgage Foreclosure' },
  ],
  
  baseUrl: 'https://courtsapp.montcopa.org',
  searchUrl: 'https://courtsapp.montcopa.org/psi/v/search/case',
  
  // Distress signal keywords to look for in docket entries
  distressKeywords: {
    high: [
      'default judgment',
      'motion for default',
      'judgment entered',
      'writ of execution',
      'sheriff sale',
      'praecipe for writ',
      'rule to show cause',
      'failure to appear'
    ],
    medium: [
      'conciliation',
      'mediation',
      'service accepted',
      'answer filed',
      'motion to dismiss denied',
      'discovery'
    ],
    positive: [  // Signs the owner is fighting (may be harder to work with)
      'motion to dismiss',
      'answer and new matter',
      'counterclaim',
      'preliminary objections',
      'counsel appearance',
      'attorney appearance'
    ]
  }
};

// Parse date from MM/DD/YYYY to YYYY-MM-DD
function parseDate(dateStr) {
  if (!dateStr) return null;
  const match = dateStr.trim().match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (match) {
    return `${match[3]}-${match[1].padStart(2, '0')}-${match[2].padStart(2, '0')}`;
  }
  return dateStr.trim() || null;
}

// Calculate days since a date
function daysSince(dateStr) {
  if (!dateStr) return null;
  try {
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) return null;
    const now = new Date();
    return Math.ceil(Math.abs(now - date) / (1000 * 60 * 60 * 24));
  } catch (e) {
    return null;
  }
}

// Analyze docket entries for distress signals
function analyzeDocket(docketEntries) {
  const analysis = {
    totalEntries: docketEntries.length,
    lastActivityDate: null,
    daysSinceLastActivity: null,
    hasDefaultMotion: false,
    hasDefaultJudgment: false,
    hasDefendantAttorney: false,
    hasDefendantResponse: false,
    hasConciliation: false,
    conciliationStatus: null,
    hasWritOfExecution: false,
    serviceAttempts: 0,
    failedServiceAttempts: 0,
    plaintiffFilings: 0,
    defendantFilings: 0,
    distressSignals: [],
    positiveSignals: [],
    recentActivity: [] // Last 5 entries
  };
  
  if (!docketEntries || docketEntries.length === 0) {
    return analysis;
  }
  
  // Sort by date descending (most recent first)
  const sorted = [...docketEntries].sort((a, b) => {
    const dateA = new Date(parseDate(a.date) || 0);
    const dateB = new Date(parseDate(b.date) || 0);
    return dateB - dateA;
  });
  
  // Get last activity
  if (sorted[0]?.date) {
    analysis.lastActivityDate = parseDate(sorted[0].date);
    analysis.daysSinceLastActivity = daysSince(analysis.lastActivityDate);
  }
  
  // Get recent activity (last 5)
  analysis.recentActivity = sorted.slice(0, 5).map(e => ({
    date: parseDate(e.date),
    description: e.description
  }));
  
  // Analyze each entry
  for (const entry of docketEntries) {
    const desc = (entry.description || '').toLowerCase();
    const filer = (entry.filer || '').toLowerCase();
    
    // Track who is filing
    if (filer.includes('plaintiff') || filer.includes('bank') || filer.includes('mortgage')) {
      analysis.plaintiffFilings++;
    }
    if (filer.includes('defendant') || filer.includes('owner') || filer.includes('homeowner')) {
      analysis.defendantFilings++;
    }
    
    // Check for distress signals (high priority)
    for (const keyword of CONFIG.distressKeywords.high) {
      if (desc.includes(keyword)) {
        analysis.distressSignals.push({
          type: 'high',
          keyword,
          date: parseDate(entry.date),
          description: entry.description
        });
        
        if (keyword.includes('default judgment') || keyword.includes('judgment entered')) {
          analysis.hasDefaultJudgment = true;
        }
        if (keyword.includes('motion for default')) {
          analysis.hasDefaultMotion = true;
        }
        if (keyword.includes('writ of execution') || keyword.includes('praecipe for writ')) {
          analysis.hasWritOfExecution = true;
        }
      }
    }
    
    // Check for medium distress signals
    for (const keyword of CONFIG.distressKeywords.medium) {
      if (desc.includes(keyword)) {
        analysis.distressSignals.push({
          type: 'medium',
          keyword,
          date: parseDate(entry.date),
          description: entry.description
        });
        
        if (keyword.includes('conciliation') || keyword.includes('mediation')) {
          analysis.hasConciliation = true;
          if (desc.includes('failed') || desc.includes('no show') || desc.includes('not appear')) {
            analysis.conciliationStatus = 'failed';
          } else if (desc.includes('scheduled') || desc.includes('set for')) {
            analysis.conciliationStatus = 'scheduled';
          } else if (desc.includes('completed') || desc.includes('held')) {
            analysis.conciliationStatus = 'completed';
          }
        }
      }
    }
    
    // Check for positive signals (owner fighting back)
    for (const keyword of CONFIG.distressKeywords.positive) {
      if (desc.includes(keyword)) {
        analysis.positiveSignals.push({
          keyword,
          date: parseDate(entry.date),
          description: entry.description
        });
        
        if (keyword.includes('attorney') || keyword.includes('counsel')) {
          analysis.hasDefendantAttorney = true;
        }
        if (keyword.includes('answer') || keyword.includes('counterclaim') || keyword.includes('objections')) {
          analysis.hasDefendantResponse = true;
        }
      }
    }
    
    // Count service attempts
    if (desc.includes('service') || desc.includes('served')) {
      analysis.serviceAttempts++;
      if (desc.includes('fail') || desc.includes('unable') || desc.includes('not found') || desc.includes('return')) {
        analysis.failedServiceAttempts++;
      }
    }
  }
  
  return analysis;
}

// Calculate lead score based on all factors
function calculateLeadScore(caseData, docketAnalysis) {
  let score = 50; // Start at neutral
  const factors = [];
  
  // === POSITIVE FACTORS (increase score - better lead) ===
  
  // Case age sweet spot (30-180 days is ideal)
  const daysOpen = caseData.daysOpen || 0;
  if (daysOpen >= 30 && daysOpen <= 90) {
    score += 15;
    factors.push({ factor: 'Ideal age (30-90 days)', points: 15 });
  } else if (daysOpen > 90 && daysOpen <= 180) {
    score += 10;
    factors.push({ factor: 'Good age (90-180 days)', points: 10 });
  } else if (daysOpen > 180 && daysOpen <= 365) {
    score += 5;
    factors.push({ factor: 'Acceptable age (180-365 days)', points: 5 });
  } else if (daysOpen > 365) {
    score -= 5;
    factors.push({ factor: 'Old case (365+ days)', points: -5 });
  }
  
  // No judgment yet = early stage, more opportunity
  if (!caseData.hasJudgement) {
    score += 20;
    factors.push({ factor: 'No judgment entered', points: 20 });
  } else {
    score -= 15;
    factors.push({ factor: 'Judgment already entered', points: -15 });
  }
  
  // No defendant attorney = owner not fighting with legal help
  if (!docketAnalysis.hasDefendantAttorney) {
    score += 10;
    factors.push({ factor: 'No defendant attorney', points: 10 });
  }
  
  // No defendant response = owner may be overwhelmed/checked out
  if (!docketAnalysis.hasDefendantResponse && daysOpen > 45) {
    score += 15;
    factors.push({ factor: 'No defendant response filed', points: 15 });
  }
  
  // Default motion filed = lender moving forward, owner not responding
  if (docketAnalysis.hasDefaultMotion && !docketAnalysis.hasDefaultJudgment) {
    score += 10;
    factors.push({ factor: 'Default motion pending', points: 10 });
  }
  
  // Failed service attempts = owner may be avoiding
  if (docketAnalysis.failedServiceAttempts >= 2) {
    score += 5;
    factors.push({ factor: 'Multiple failed service attempts', points: 5 });
  }
  
  // Conciliation failed = mediation didn't work
  if (docketAnalysis.conciliationStatus === 'failed') {
    score += 10;
    factors.push({ factor: 'Conciliation failed', points: 10 });
  }
  
  // Inactive case (no activity in 60+ days) = may be stalled, owner stressed
  if (docketAnalysis.daysSinceLastActivity > 60 && daysOpen < 300) {
    score += 5;
    factors.push({ factor: 'Case inactive 60+ days', points: 5 });
  }
  
  // === NEGATIVE FACTORS (decrease score - harder lead) ===
  
  // Defendant has attorney = harder to work with
  if (docketAnalysis.hasDefendantAttorney) {
    score -= 10;
    factors.push({ factor: 'Defendant has attorney', points: -10 });
  }
  
  // Defendant actively responding = fighting the case
  if (docketAnalysis.hasDefendantResponse) {
    score -= 5;
    factors.push({ factor: 'Defendant actively responding', points: -5 });
  }
  
  // Writ of execution = very late stage, likely too late
  if (docketAnalysis.hasWritOfExecution) {
    score -= 20;
    factors.push({ factor: 'Writ of execution filed', points: -20 });
  }
  
  // Many positive signals = owner fighting hard
  if (docketAnalysis.positiveSignals.length >= 3) {
    score -= 10;
    factors.push({ factor: 'Owner actively fighting (3+ responses)', points: -10 });
  }
  
  // Ensure score is between 0-100
  score = Math.max(0, Math.min(100, score));
  
  // Determine lead grade
  let grade;
  if (score >= 80) grade = 'A';
  else if (score >= 65) grade = 'B';
  else if (score >= 50) grade = 'C';
  else if (score >= 35) grade = 'D';
  else grade = 'F';
  
  return {
    score,
    grade,
    factors
  };
}

// Main scraper function
async function scrapeMontgomeryCourts() {
  console.log('\n🏛️ Scraping Montgomery County Courts (Enhanced)...');
  console.log('   Features: Docket analysis, distress signals, lead scoring\n');
  
  const allCases = [];
  
  // Launch browser with minimal memory settings
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-default-apps',
      '--disable-sync',
      '--disable-translate',
      '--hide-scrollbars',
      '--metrics-recording-only',
      '--mute-audio',
      '--no-first-run',
      '--safebrowsing-disable-auto-update',
      '--js-flags=--max-old-space-size=512'
    ]
  });
  
  const page = await browser.newPage();
  
  // Disable images and CSS to save memory
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const resourceType = req.resourceType();
    if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
      req.abort();
    } else {
      req.continue();
    }
  });
  
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
  
  try {
    for (const caseType of CONFIG.caseTypes) {
      console.log(`📋 Scraping: ${caseType.name}`);
      
      // Build search URL - get cases from last 2 years for comprehensive pipeline
      const twoYearsAgo = new Date();
      twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);
      const fromDate = `${twoYearsAgo.getMonth() + 1}/${twoYearsAgo.getDate()}/${twoYearsAgo.getFullYear()}`;
      
      const searchUrl = `${CONFIG.searchUrl}?Q=&IncludeSoundsLike=false&Count=${CONFIG.resultsPerPage}&fromAdv=1&CaseType=${caseType.id}&DateCommencedFrom=${encodeURIComponent(fromDate)}&Court=C&Court=F&Grid=true`;
      
      console.log(`   Searching for cases since ${fromDate}...`);
      
      console.log('   Loading search page...');
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await delay(2000);
      
      // Extract cases from results table
      console.log('   Extracting case data...');
      const pageCases = await page.evaluate(() => {
        const cases = [];
        const rows = document.querySelectorAll('table tr');
        
        for (let i = 1; i < rows.length; i++) {
          const cells = rows[i].querySelectorAll('td');
          if (cells.length < 9) continue;
          
          const selectLink = cells[0]?.querySelector('a[href*="/detail/Case/"]');
          const detailUrl = selectLink ? selectLink.href : '';
          const caseIdMatch = detailUrl.match(/\/detail\/Case\/(\d+)/);
          const caseId = caseIdMatch ? caseIdMatch[1] : '';
          
          cases.push({
            caseId,
            caseNumber: cells[1]?.textContent?.trim() || '',
            commencedDate: cells[2]?.textContent?.trim() || '',
            caseType: cells[3]?.textContent?.trim() || '',
            plaintiff: cells[4]?.textContent?.trim() || '',
            defendant: cells[5]?.textContent?.trim() || '',
            parcelNumber: cells[6]?.textContent?.trim() || '',
            hasJudgement: (cells[7]?.textContent?.trim() || '').toLowerCase() === 'yes',
            hasLisPendens: (cells[8]?.textContent?.trim() || '').toLowerCase() === 'yes',
            status: cells[9]?.textContent?.trim() || '',
            detailUrl
          });
        }
        return cases;
      });
      
      console.log(`   Found ${pageCases.length} total cases`);
      
      // Filter for OPEN cases only
      let openCases = pageCases.filter(c => c.status.toUpperCase().includes('OPEN'));
      console.log(`   ${openCases.length} are OPEN`);
      
      // EXCLUDE cases with Judgement (too late in process) for initial filtering
      // But we'll keep some with recent judgements for comparison
      const noJudgementCases = openCases.filter(c => !c.hasJudgement);
      console.log(`   ${noJudgementCases.length} have NO Judgement`);
      
      // Filter for target age range
      const now = new Date();
      const targetCases = noJudgementCases.filter(c => {
        if (!c.commencedDate) return true;
        const match = c.commencedDate.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
        if (!match) return true;
        const caseDate = new Date(match[3], match[1] - 1, match[2]);
        const daysOld = Math.ceil((now - caseDate) / (1000 * 60 * 60 * 24));
        return daysOld >= CONFIG.minDaysOld && daysOld <= CONFIG.maxDaysOld;
      });
      console.log(`   ${targetCases.length} are in target range (${CONFIG.minDaysOld}-${CONFIG.maxDaysOld} days)`);
      
      // Sort by date (oldest first - they need the most urgent attention)
      targetCases.sort((a, b) => {
        const parseDate = (dateStr) => {
          if (!dateStr) return new Date(0);
          const match = dateStr.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
          if (match) return new Date(match[3], match[1] - 1, match[2]);
          return new Date(0);
        };
        return parseDate(a.commencedDate) - parseDate(b.commencedDate);
      });
      
      // Limit to save memory
      let casesToProcess = targetCases;
      if (casesToProcess.length > CONFIG.maxCasesToProcess) {
        console.log(`   Limiting to ${CONFIG.maxCasesToProcess} cases`);
        casesToProcess = casesToProcess.slice(0, CONFIG.maxCasesToProcess);
      }
      
      // Fetch details and docket for each case
      console.log(`\n📍 Fetching details & docket for ${casesToProcess.length} cases...`);
      
      for (let i = 0; i < casesToProcess.length; i++) {
        const caseData = casesToProcess[i];
        
        if (i > 0 && i % CONFIG.batchSize === 0) {
          console.log('   ⏸ Batch pause...');
          await delay(CONFIG.batchPause);
        }
        
        try {
          await delay(CONFIG.requestDelay);
          await page.goto(caseData.detailUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
          
          // Extract case details AND docket entries
          const details = await page.evaluate(() => {
            const result = {
              propertyAddress: '',
              propertyCity: '',
              propertyState: 'PA',
              propertyZip: '',
              daysOpen: null,
              judge: '',
              docketEntries: []
            };
            
            // Get Days Open
            const allTds = document.querySelectorAll('td');
            for (const td of allTds) {
              if (td.textContent.trim() === 'Days Open' && td.nextElementSibling) {
                result.daysOpen = parseInt(td.nextElementSibling.textContent.trim()) || null;
              }
              if (td.textContent.trim() === 'Judge' && td.nextElementSibling) {
                result.judge = td.nextElementSibling.textContent.trim();
              }
            }
            
            // Get address from Defendants table
            const tables = document.querySelectorAll('table');
            if (tables.length >= 3) {
              const defTable = tables[2];
              const rows = defTable.querySelectorAll('tr');
              if (rows.length >= 2) {
                const cells = rows[1].querySelectorAll('td');
                if (cells[2]) {
                  const fullAddress = cells[2].textContent.trim();
                  const stateZipMatch = fullAddress.match(/,\s*(PA|NJ)\s*(\d{5})/i);
                  
                  if (stateZipMatch) {
                    result.propertyState = stateZipMatch[1].toUpperCase();
                    result.propertyZip = stateZipMatch[2];
                    const beforeStateZip = fullAddress.substring(0, fullAddress.indexOf(stateZipMatch[0]));
                    
                    const streetTypeMatch = beforeStateZip.match(/^(.+(?:WAY|STREET|ST|AVENUE|AVE|ROAD|RD|DRIVE|DR|LANE|LN|COURT|CT|CIRCLE|CIR|BOULEVARD|BLVD|PLACE|PL|TERRACE|TER|PIKE|TRAIL|TRL))\s*(.*)$/i);
                    
                    if (streetTypeMatch) {
                      result.propertyAddress = streetTypeMatch[1].trim();
                      result.propertyCity = streetTypeMatch[2].trim();
                    } else {
                      const doubleCapMatch = beforeStateZip.match(/^(.+[a-z])([A-Z][A-Za-z\s]+)$/);
                      if (doubleCapMatch) {
                        result.propertyAddress = doubleCapMatch[1].trim();
                        result.propertyCity = doubleCapMatch[2].trim();
                      } else {
                        result.propertyAddress = beforeStateZip.trim();
                      }
                    }
                  } else {
                    result.propertyAddress = fullAddress.replace(/UNITED STATES/i, '').trim();
                  }
                }
              }
            }
            
            // Get docket entries (usually table index 3 or 4)
            for (let t = 3; t < tables.length; t++) {
              const table = tables[t];
              const headerRow = table.querySelector('tr');
              if (headerRow && headerRow.textContent.toLowerCase().includes('date') && 
                  headerRow.textContent.toLowerCase().includes('filing')) {
                const docketRows = table.querySelectorAll('tr');
                for (let r = 1; r < docketRows.length; r++) {
                  const cells = docketRows[r].querySelectorAll('td');
                  if (cells.length >= 2) {
                    result.docketEntries.push({
                      date: cells[0]?.textContent?.trim() || '',
                      description: cells[1]?.textContent?.trim() || '',
                      filer: cells[2]?.textContent?.trim() || ''
                    });
                  }
                }
                break;
              }
            }
            
            return result;
          });
          
          // Analyze the docket
          const docketAnalysis = analyzeDocket(details.docketEntries);
          
          // Calculate days open
          const daysOpen = details.daysOpen || daysSince(parseDate(caseData.commencedDate));
          caseData.daysOpen = daysOpen;
          
          // Calculate lead score
          const leadScore = calculateLeadScore(caseData, docketAnalysis);
          
          // Store all data
          caseData.propertyAddress = details.propertyAddress;
          caseData.propertyCity = details.propertyCity;
          caseData.propertyState = details.propertyState;
          caseData.propertyZip = details.propertyZip;
          caseData.judge = details.judge;
          caseData.docketAnalysis = docketAnalysis;
          caseData.leadScore = leadScore;
          
          const addr = details.propertyAddress || 'No address';
          const grade = leadScore.grade;
          console.log(`   ${i + 1}/${casesToProcess.length} ✓ ${caseData.caseNumber} [${grade}:${leadScore.score}] - ${addr}`);
          
        } catch (err) {
          console.log(`   ${i + 1}/${casesToProcess.length} ~ ${caseData.caseNumber} (${err.message})`);
          caseData.daysOpen = daysSince(parseDate(caseData.commencedDate));
          caseData.docketAnalysis = analyzeDocket([]);
          caseData.leadScore = calculateLeadScore(caseData, caseData.docketAnalysis);
        }
      }
      
      allCases.push(...casesToProcess);
    }
  } catch (error) {
    console.error(`Error: ${error.message}`);
  } finally {
    await browser.close();
  }
  
  // Sort by lead score (highest first)
  allCases.sort((a, b) => (b.leadScore?.score || 0) - (a.leadScore?.score || 0));
  
  // Format final data
  const formattedCases = allCases.map(c => ({
    caseId: c.caseId,
    caseNumber: c.caseNumber,
    caseType: c.caseType,
    commencedDate: parseDate(c.commencedDate),
    daysOpen: c.daysOpen || daysSince(parseDate(c.commencedDate)),
    lastFilingDate: c.docketAnalysis?.lastActivityDate || null,
    daysSinceLastActivity: c.docketAnalysis?.daysSinceLastActivity || null,
    plaintiff: c.plaintiff,
    defendant: c.defendant,
    propertyAddress: c.propertyAddress || '',
    propertyCity: c.propertyCity || '',
    propertyState: c.propertyState || 'PA',
    propertyZip: c.propertyZip || '',
    parcelNumber: c.parcelNumber || '',
    hasJudgement: c.hasJudgement,
    hasLisPendens: c.hasLisPendens,
    status: c.status,
    judge: c.judge || '',
    
    // Lead scoring
    leadScore: c.leadScore?.score || 0,
    leadGrade: c.leadScore?.grade || 'C',
    scoreFactors: c.leadScore?.factors || [],
    
    // Docket analysis
    docketSummary: {
      totalEntries: c.docketAnalysis?.totalEntries || 0,
      hasDefaultMotion: c.docketAnalysis?.hasDefaultMotion || false,
      hasDefaultJudgment: c.docketAnalysis?.hasDefaultJudgment || false,
      hasDefendantAttorney: c.docketAnalysis?.hasDefendantAttorney || false,
      hasDefendantResponse: c.docketAnalysis?.hasDefendantResponse || false,
      hasConciliation: c.docketAnalysis?.hasConciliation || false,
      conciliationStatus: c.docketAnalysis?.conciliationStatus || null,
      hasWritOfExecution: c.docketAnalysis?.hasWritOfExecution || false,
      serviceAttempts: c.docketAnalysis?.serviceAttempts || 0,
      failedServiceAttempts: c.docketAnalysis?.failedServiceAttempts || 0,
      plaintiffFilings: c.docketAnalysis?.plaintiffFilings || 0,
      defendantFilings: c.docketAnalysis?.defendantFilings || 0
    },
    distressSignals: c.docketAnalysis?.distressSignals || [],
    positiveSignals: c.docketAnalysis?.positiveSignals || [],
    recentActivity: c.docketAnalysis?.recentActivity || [],
    
    remarks: generateRemarks(c),
    detailUrl: c.detailUrl,
    county: 'Montgomery',
    state: 'PA'
  }));
  
  // Stats summary
  const grades = { A: 0, B: 0, C: 0, D: 0, F: 0 };
  formattedCases.forEach(c => grades[c.leadGrade]++);
  
  console.log(`\n✅ Montgomery County Courts: ${formattedCases.length} pre-foreclosure cases`);
  console.log(`   Lead Grades: A=${grades.A} | B=${grades.B} | C=${grades.C} | D=${grades.D} | F=${grades.F}`);
  
  return formattedCases;
}

// Generate human-readable remarks based on analysis
function generateRemarks(caseData) {
  const remarks = [];
  const da = caseData.docketAnalysis || {};
  const ls = caseData.leadScore || {};
  
  if (ls.grade === 'A') {
    remarks.push('🔥 HOT LEAD');
  } else if (ls.grade === 'B') {
    remarks.push('⭐ Good lead');
  }
  
  if (!caseData.hasJudgement && caseData.daysOpen >= 60) {
    remarks.push('No judgment - early stage');
  }
  
  if (!da.hasDefendantAttorney && !da.hasDefendantResponse) {
    remarks.push('Owner not responding');
  }
  
  if (da.hasDefaultMotion && !da.hasDefaultJudgment) {
    remarks.push('Default motion pending');
  }
  
  if (da.conciliationStatus === 'failed') {
    remarks.push('Mediation failed');
  }
  
  if (da.failedServiceAttempts >= 2) {
    remarks.push('Service difficulties');
  }
  
  if (da.daysSinceLastActivity > 60) {
    remarks.push(`Inactive ${da.daysSinceLastActivity} days`);
  }
  
  if (da.hasDefendantAttorney) {
    remarks.push('⚠️ Has attorney');
  }
  
  if (da.hasWritOfExecution) {
    remarks.push('⚠️ Writ filed - late stage');
  }
  
  return remarks.join(' | ');
}

module.exports = { scrapeMontgomeryCourts, CONFIG, analyzeDocket, calculateLeadScore };
