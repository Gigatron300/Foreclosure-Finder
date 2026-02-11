// NJ Courts Case Status Enrichment
// Logs into NJ eCourts portal, searches by defendant name,
// matches foreclosure cases by plaintiff + date proximity,
// and extracts case status (Open/Closed) and disposition.
//
// Credentials: Set NJ_COURTS_USER and NJ_COURTS_PASS env vars on Render
// Portal: https://portal.njcourts.gov/webcivilcj/CIVILCaseJacketWeb/pages/civilCaseSearch.faces

const puppeteer = require('puppeteer');
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const CONFIG = {
  loginUrl: 'https://portal.njcourts.gov/webcivilcj/CIVILCaseJacketWeb/pages/civilCaseSearch.faces',
  portalLoginUrl: 'https://portal.njcourts.gov/webe20/MPAWeb/login.faces',
  searchUrl: 'https://portal.njcourts.gov/webcivilcj/CIVILCaseJacketWeb/pages/civilCaseSearch.faces',
  requestDelay: 1500,       // Delay between searches
  loginWait: 5000,          // Wait after login for session
  pageLoadWait: 3000,       // Wait for search results
  batchSize: 10,            // Pause every N cases
  batchPause: 5000,         // Pause duration between batches
  maxRetries: 2,            // Retry failed searches
};

// ============================================================
// Name parsing helpers
// ============================================================

/**
 * Extract searchable last name from defendant name string
 * "HENDERSON LAKISHA N" → { lastName: "HENDERSON", firstName: "LAKISHA" }
 * "GLADDEN DEAN" → { lastName: "GLADDEN", firstName: "DEAN" }
 * "SMITH JR JOHN" → { lastName: "SMITH", firstName: "JOHN" }
 */
function parseDefendantName(fullName) {
  if (!fullName) return null;

  let name = fullName.toUpperCase().trim();

  // Remove common suffixes
  name = name.replace(/\b(JR|SR|II|III|IV|ESQ|MD|PHD)\b\.?/g, '').trim();
  // Remove extra whitespace
  name = name.replace(/\s+/g, ' ');

  const parts = name.split(' ').filter(p => p.length > 0);
  if (parts.length === 0) return null;

  // Camden CSV format is "LASTNAME FIRSTNAME MIDDLE"
  return {
    lastName: parts[0],
    firstName: parts.length > 1 ? parts[1] : '',
    fullParts: parts,
    searchName: parts[0]  // Search by last name only for broader results
  };
}

/**
 * Extract plaintiff last name for matching against case caption
 * "CITIZENS BANK" → "CITIZENS"
 * "NATIONSTAR MORTGAGE LLC" → "NATIONSTAR"
 * "GOREE TAMMY" → "GOREE"
 */
function parsePlaintiffForMatch(plaintiffName) {
  if (!plaintiffName) return '';
  const upper = plaintiffName.toUpperCase().trim();
  // Remove entity suffixes for matching
  const cleaned = upper.replace(/\b(LLC|INC|CORP|N\.?A\.?|BANK|MORTGAGE|SERVICING|TRUST|LP|L\.P\.)\b/g, '').trim();
  // First significant word
  const parts = cleaned.split(/\s+/).filter(p => p.length > 2);
  return parts[0] || upper.split(/\s+/)[0] || '';
}

// ============================================================
// Browser & Login
// ============================================================

async function launchBrowser() {
  return puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-gpu', '--disable-extensions', '--disable-background-networking',
      '--js-flags=--max-old-space-size=256'
    ]
  });
}

async function loginToNJCourts(page, username, password) {
  console.log('  🔑 Logging into NJ Courts portal...');

  // Navigate to the civil case search - it will redirect to login
  await page.goto(CONFIG.loginUrl, { waitUntil: 'networkidle2', timeout: 30000 });
  await delay(2000);

  const currentUrl = page.url();
  console.log(`  Current URL: ${currentUrl}`);

  // Check if we're on a login page
  const isLoginPage = await page.evaluate(() => {
    const text = document.body.innerText || '';
    return text.includes('User ID') && text.includes('Password');
  });

  if (!isLoginPage) {
    // May already be logged in
    const isSearchPage = await page.evaluate(() => {
      const text = document.body.innerText || '';
      return text.includes('Party Name') || text.includes('Case Search') || text.includes('Docket Number');
    });
    if (isSearchPage) {
      console.log('  ✅ Already logged in');
      return true;
    }
  }

  // Find and fill login fields
  const loginSuccess = await page.evaluate((user, pass) => {
    // Try various input selectors for the NJ Courts login form
    const userInputs = document.querySelectorAll('input[type="text"], input[name*="user" i], input[id*="user" i], input[name*="login" i]');
    const passInputs = document.querySelectorAll('input[type="password"]');

    let userInput = null;
    let passInput = passInputs[0] || null;

    // Find the user ID field
    for (const inp of userInputs) {
      const label = inp.closest('div')?.textContent || '';
      const name = (inp.name || '').toLowerCase();
      const id = (inp.id || '').toLowerCase();
      if (label.includes('User ID') || name.includes('user') || id.includes('user') || id.includes('login')) {
        userInput = inp;
        break;
      }
    }

    // Fallback: first text input before password
    if (!userInput && userInputs.length > 0) {
      userInput = userInputs[0];
    }

    if (userInput && passInput) {
      userInput.value = user;
      userInput.dispatchEvent(new Event('input', { bubbles: true }));
      userInput.dispatchEvent(new Event('change', { bubbles: true }));
      passInput.value = pass;
      passInput.dispatchEvent(new Event('input', { bubbles: true }));
      passInput.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    return false;
  }, username, password);

  if (!loginSuccess) {
    console.error('  ❌ Could not find login fields');
    return false;
  }

  // Click login button
  await page.evaluate(() => {
    const buttons = document.querySelectorAll('button, input[type="submit"], a.btn, a[class*="login" i]');
    for (const btn of buttons) {
      const text = (btn.textContent || btn.value || '').toLowerCase();
      if (text.includes('log in') || text.includes('login') || text.includes('sign in') || text.includes('submit')) {
        btn.click();
        return;
      }
    }
    // Fallback: submit the form
    const form = document.querySelector('form');
    if (form) form.submit();
  });

  // Wait for navigation
  await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {});
  await delay(CONFIG.loginWait);

  // Check if login succeeded - should be on search page now
  const afterLoginUrl = page.url();
  console.log(`  After login URL: ${afterLoginUrl}`);

  const loggedIn = await page.evaluate(() => {
    const text = document.body.innerText || '';
    // If we see the search form, we're in
    return text.includes('Party Name') || text.includes('Case Search') ||
           text.includes('Docket Number') || text.includes('Case Jacket');
  });

  if (loggedIn) {
    console.log('  ✅ Login successful');
    return true;
  }

  // Check for error messages
  const errorMsg = await page.evaluate(() => {
    const text = document.body.innerText || '';
    if (text.includes('Authentication Failed')) return 'Authentication Failed';
    if (text.includes('locked')) return 'Account locked';
    if (text.includes('invalid') || text.includes('Invalid')) return 'Invalid credentials';
    return null;
  });

  if (errorMsg) {
    console.error(`  ❌ Login failed: ${errorMsg}`);
  } else {
    console.error('  ❌ Login failed - unexpected page after login');
  }

  return false;
}

// ============================================================
// Search & Match
// ============================================================

/**
 * Search for a defendant by last name on the NJ Courts portal
 * Returns array of search result rows
 */
async function searchByPartyName(page, lastName) {
  // Make sure we're on the search page
  const onSearchPage = await page.evaluate(() => {
    const text = document.body.innerText || '';
    return text.includes('Party Name') || text.includes('Case Search');
  });

  if (!onSearchPage) {
    await page.goto(CONFIG.searchUrl, { waitUntil: 'networkidle2', timeout: 20000 });
    await delay(2000);
  }

  // Clear any previous search and fill in party name
  await page.evaluate((name) => {
    // Find the Party Name input - try by label, placeholder, or ID
    const allInputs = document.querySelectorAll('input[type="text"]');
    let partyInput = null;

    for (const inp of allInputs) {
      const id = (inp.id || '').toLowerCase();
      const name_ = (inp.name || '').toLowerCase();
      const placeholder = (inp.placeholder || '').toLowerCase();
      const label = inp.closest('tr')?.textContent?.toLowerCase() || 
                    inp.closest('div')?.textContent?.toLowerCase() || '';

      if (id.includes('party') || name_.includes('party') || 
          placeholder.includes('party') || label.includes('party name')) {
        partyInput = inp;
        break;
      }
    }

    // Fallback: first text input that's not docket
    if (!partyInput) {
      for (const inp of allInputs) {
        const id = (inp.id || '').toLowerCase();
        if (!id.includes('docket') && !id.includes('number')) {
          partyInput = inp;
          break;
        }
      }
    }

    if (partyInput) {
      partyInput.value = '';
      partyInput.value = name;
      partyInput.dispatchEvent(new Event('input', { bubbles: true }));
      partyInput.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    return false;
  }, lastName);

  await delay(500);

  // Click search button
  await page.evaluate(() => {
    const buttons = document.querySelectorAll('button, input[type="submit"], input[type="button"], a');
    for (const btn of buttons) {
      const text = (btn.textContent || btn.value || '').toLowerCase().trim();
      if (text === 'search' || text.includes('search')) {
        btn.click();
        return true;
      }
    }
    return false;
  });

  // Wait for results
  await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
  await delay(CONFIG.pageLoadWait);

  // Extract search results
  const results = await page.evaluate(() => {
    const rows = [];
    const tables = document.querySelectorAll('table');

    for (const table of tables) {
      const headerRow = table.querySelector('tr');
      if (!headerRow) continue;

      const headers = Array.from(headerRow.querySelectorAll('th, td'))
        .map(h => (h.textContent || '').trim().toLowerCase());

      // Look for result table with docket number, case caption, etc.
      const hasDocket = headers.some(h => h.includes('docket'));
      const hasCaption = headers.some(h => h.includes('caption') || h.includes('case'));
      const hasVenue = headers.some(h => h.includes('venue') || h.includes('county'));

      if (!hasDocket && !hasCaption) continue;

      const docketIdx = headers.findIndex(h => h.includes('docket'));
      const captionIdx = headers.findIndex(h => h.includes('caption') || h.includes('case'));
      const venueIdx = headers.findIndex(h => h.includes('venue') || h.includes('county'));
      const statusIdx = headers.findIndex(h => h.includes('status'));
      const dateIdx = headers.findIndex(h => h.includes('date') || h.includes('initiation') || h.includes('filed'));
      const dispositionIdx = headers.findIndex(h => h.includes('disposition'));
      const typeIdx = headers.findIndex(h => h.includes('type'));

      const allRows = table.querySelectorAll('tr');
      for (let i = 1; i < allRows.length; i++) {
        const cells = allRows[i].querySelectorAll('td');
        if (cells.length < 2) continue;

        // Check for a link to the case jacket
        const link = allRows[i].querySelector('a');
        const linkHref = link ? link.href : '';

        rows.push({
          docketNumber: docketIdx >= 0 && cells[docketIdx] ? cells[docketIdx].textContent.trim() : '',
          caseCaption: captionIdx >= 0 && cells[captionIdx] ? cells[captionIdx].textContent.trim() : '',
          venue: venueIdx >= 0 && cells[venueIdx] ? cells[venueIdx].textContent.trim() : '',
          status: statusIdx >= 0 && cells[statusIdx] ? cells[statusIdx].textContent.trim() : '',
          filedDate: dateIdx >= 0 && cells[dateIdx] ? cells[dateIdx].textContent.trim() : '',
          disposition: dispositionIdx >= 0 && cells[dispositionIdx] ? cells[dispositionIdx].textContent.trim() : '',
          caseType: typeIdx >= 0 && cells[typeIdx] ? cells[typeIdx].textContent.trim() : '',
          detailLink: linkHref,
          rowText: allRows[i].textContent.replace(/\s+/g, ' ').trim()
        });
      }
    }

    // Also check if there's just page text with results (non-table format)
    if (rows.length === 0) {
      // Store page text for debugging
      const bodyText = document.body.innerText.substring(0, 3000);
      rows.push({ _pageDebug: bodyText, _isDebug: true });
    }

    return rows;
  });

  return results.filter(r => !r._isDebug);
}

/**
 * Given search results and case info, find the best matching court case
 */
function findBestMatch(searchResults, caseData) {
  if (!searchResults || searchResults.length === 0) return null;

  const plaintiffKey = parsePlaintiffForMatch(caseData.primaryPlaintiff);
  const defendantParts = parseDefendantName(caseData.primaryDefendant);

  // Parse the lis pendens filing date for proximity matching
  let lisPendensDate = null;
  if (caseData.filingDateISO) {
    lisPendensDate = new Date(caseData.filingDateISO);
  } else if (caseData.filingDate) {
    const m = caseData.filingDate.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (m) lisPendensDate = new Date(parseInt(m[3]), parseInt(m[1]) - 1, parseInt(m[2]));
  }

  const candidates = [];

  for (const result of searchResults) {
    let score = 0;
    const caption = (result.caseCaption || result.rowText || '').toUpperCase();
    const docket = (result.docketNumber || '').toUpperCase();
    const venue = (result.venue || result.rowText || '').toUpperCase();
    const caseType = (result.caseType || result.rowText || '').toUpperCase();

    // Must be Camden venue
    if (venue.includes('CAMDEN') || venue.includes('CAM')) {
      score += 20;
    } else if (venue && !venue.includes('CAMDEN')) {
      continue;  // Wrong venue, skip entirely
    }

    // Must be foreclosure type (docket starts with F or type mentions foreclosure)
    if (docket.includes('-F-') || docket.startsWith('F-') || docket.includes('CAM-F')) {
      score += 15;
    }
    if (caseType.includes('FORECLOSURE') || caption.includes('FORECLOSURE')) {
      score += 10;
    }

    // Check if plaintiff name appears in caption
    // Caption format: "CITIZENS BANK VS HENDERSON LAKISHA"
    if (plaintiffKey && caption.includes(plaintiffKey)) {
      score += 25;
    }

    // Check if defendant last name appears in caption
    if (defendantParts && caption.includes(defendantParts.lastName)) {
      score += 15;
    }

    // Date proximity: lis pendens is typically 1-8 weeks after case initiation
    if (lisPendensDate && result.filedDate) {
      const m = result.filedDate.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
      if (m) {
        const courtDate = new Date(parseInt(m[3]), parseInt(m[1]) - 1, parseInt(m[2]));
        const daysDiff = Math.abs((lisPendensDate - courtDate) / 86400000);

        if (daysDiff <= 14) score += 20;        // Within 2 weeks
        else if (daysDiff <= 60) score += 15;    // Within 2 months
        else if (daysDiff <= 120) score += 8;    // Within 4 months
        else if (daysDiff <= 365) score += 3;    // Within 1 year
        // More than a year apart = probably not the same case
      }
    }

    if (score >= 30) {  // Minimum threshold - at least venue + one other match
      candidates.push({ ...result, matchScore: score });
    }
  }

  // Sort by match score, pick best
  candidates.sort((a, b) => b.matchScore - a.matchScore);
  return candidates[0] || null;
}

/**
 * Click into a case jacket to get full status details
 * (only needed if the search results don't have status/disposition)
 */
async function getCaseDetails(page, result) {
  // If we already have status from search results, use it
  if (result.status && result.disposition) {
    return {
      docketNumber: result.docketNumber,
      caseStatus: result.status,
      caseDisposition: result.disposition,
      caseCaption: result.caseCaption,
      caseType: result.caseType,
      venue: result.venue,
      filedDate: result.filedDate
    };
  }

  // If there's a detail link, click into it
  if (result.detailLink) {
    try {
      await page.goto(result.detailLink, { waitUntil: 'networkidle2', timeout: 15000 });
      await delay(2000);

      const details = await page.evaluate(() => {
        const text = document.body.innerText || '';
        const getField = (labels) => {
          for (const label of labels) {
            const regex = new RegExp(label + '[:\\s]+([^\\n]+)', 'i');
            const match = text.match(regex);
            if (match) return match[1].trim();
          }
          return '';
        };

        return {
          caseStatus: getField(['Case Status']),
          caseDisposition: getField(['Case Disposition', 'Disposition']),
          caseCaption: getField(['Case Caption']),
          caseType: getField(['Case Type']),
          venue: getField(['Venue']),
          filedDate: getField(['Case Initiation Date', 'Filed Date', 'Initiation Date']),
          dispositionDate: getField(['Disposition Date'])
        };
      });

      return {
        docketNumber: result.docketNumber,
        ...details
      };
    } catch (err) {
      console.log(`     ⚠ Could not load case jacket: ${err.message}`);
    }
  }

  // Return what we have
  return {
    docketNumber: result.docketNumber,
    caseStatus: result.status || '',
    caseDisposition: result.disposition || '',
    caseCaption: result.caseCaption,
    caseType: result.caseType,
    venue: result.venue,
    filedDate: result.filedDate
  };
}

// ============================================================
// Main enrichment function
// ============================================================

/**
 * Enrich Camden cases with NJ Courts case status
 * @param {Object} data - The camden-pipeline.json data object
 * @param {Object} options - { testMode, testLimit, skipAlreadyEnriched }
 * @returns {Object} Updated data object with courtStatus fields on each case
 */
async function enrichCourtStatus(data, options = {}) {
  const { testMode = false, testLimit = 10, skipAlreadyEnriched = true } = options;

  const username = process.env.NJ_COURTS_USER;
  const password = process.env.NJ_COURTS_PASS;

  if (!username || !password) {
    console.error('❌ NJ_COURTS_USER and NJ_COURTS_PASS environment variables are required');
    console.error('   Set these in your Render dashboard → Environment tab');
    return data;
  }

  let cases = data.cases || [];
  if (testMode) {
    cases = cases.slice(0, testLimit);
  }

  // Filter to cases that need status lookup
  const toProcess = skipAlreadyEnriched
    ? cases.filter(c => !c.courtStatus)
    : cases;

  if (toProcess.length === 0) {
    console.log('✅ All cases already have court status');
    return data;
  }

  console.log(`\n⚖️ NJ Courts Case Status Enrichment`);
  console.log(`${'='.repeat(50)}`);
  console.log(`Cases to look up: ${toProcess.length}`);
  console.log(`Portal: portal.njcourts.gov\n`);

  let browser = null;
  let page = null;
  let found = 0, notFound = 0, errors = 0;
  let closedCount = 0, openCount = 0;

  try {
    browser = await launchBrowser();
    page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
    await page.setViewport({ width: 1280, height: 900 });

    // Login
    const loggedIn = await loginToNJCourts(page, username, password);
    if (!loggedIn) {
      console.error('❌ Could not log in to NJ Courts. Aborting status enrichment.');
      await browser.close();
      return data;
    }

    // Process each case
    for (let i = 0; i < toProcess.length; i++) {
      const c = toProcess[i];
      const prefix = `  ${i + 1}/${toProcess.length}`;

      // Batch pause
      if (i > 0 && i % CONFIG.batchSize === 0) {
        console.log(`  ⏸ Batch pause (${CONFIG.batchPause / 1000}s)...`);
        await delay(CONFIG.batchPause);
      }

      const defendant = parseDefendantName(c.primaryDefendant);
      if (!defendant) {
        console.log(`${prefix} ⚠ ${c.instrumentNumber} - No defendant name to search`);
        c.courtStatus = 'UNKNOWN';
        c.courtStatusNote = 'No defendant name available';
        errors++;
        continue;
      }

      try {
        await delay(CONFIG.requestDelay);

        // Navigate back to search page for each search
        await page.goto(CONFIG.searchUrl, { waitUntil: 'networkidle2', timeout: 20000 });
        await delay(1500);

        // Search by defendant last name
        const searchResults = await searchByPartyName(page, defendant.lastName);

        if (searchResults.length === 0) {
          console.log(`${prefix} ❌ ${c.instrumentNumber} ${defendant.lastName} → No results`);
          c.courtStatus = 'NOT_FOUND';
          c.courtStatusNote = `No court records found for ${defendant.lastName}`;
          notFound++;
          continue;
        }

        // Find best match
        const match = findBestMatch(searchResults, c);

        if (!match) {
          console.log(`${prefix} ❌ ${c.instrumentNumber} ${defendant.lastName} → ${searchResults.length} results, no Camden foreclosure match`);
          c.courtStatus = 'NOT_FOUND';
          c.courtStatusNote = `${searchResults.length} results but no matching Camden foreclosure`;
          notFound++;
          continue;
        }

        // Get detailed case info
        const details = await getCaseDetails(page, match);

        // Update the case
        c.courtStatus = normalizeStatus(details.caseStatus);
        c.courtDisposition = details.caseDisposition || '';
        c.courtDocketNumber = details.docketNumber || '';
        c.courtCaseCaption = details.caseCaption || '';
        c.courtCaseType = details.caseType || '';
        c.courtFiledDate = details.filedDate || '';
        c.courtMatchScore = match.matchScore;
        c.courtStatusEnrichedAt = new Date().toISOString();

        const statusEmoji = c.courtStatus === 'CLOSED' ? '🔴' : c.courtStatus === 'OPEN' ? '🟢' : '⚪';
        if (c.courtStatus === 'CLOSED') closedCount++;
        else if (c.courtStatus === 'OPEN') openCount++;

        const dispNote = c.courtDisposition ? ` (${c.courtDisposition})` : '';
        console.log(`${prefix} ${statusEmoji} ${c.instrumentNumber} ${defendant.lastName} → ${details.docketNumber} ${c.courtStatus}${dispNote} [match:${match.matchScore}]`);
        found++;

      } catch (err) {
        console.log(`${prefix} ⚠ ${c.instrumentNumber} ${defendant.lastName} → Error: ${err.message.slice(0, 50)}`);
        c.courtStatus = 'ERROR';
        c.courtStatusNote = err.message;
        errors++;
      }
    }

  } catch (err) {
    console.error(`Court status enrichment error: ${err.message}`);
  } finally {
    if (browser) await browser.close();
  }

  // Update enrichment summary
  data.courtStatusSummary = {
    enrichedAt: new Date().toISOString(),
    source: 'NJ Courts eCourts Portal',
    casesSearched: toProcess.length,
    matched: found,
    notFound,
    errors,
    openCases: openCount,
    closedCases: closedCount
  };

  console.log(`\n${'='.repeat(50)}`);
  console.log(`⚖️ COURT STATUS SUMMARY`);
  console.log(`  Matched: ${found} ✅`);
  console.log(`  Not found: ${notFound} ❌`);
  console.log(`  Errors: ${errors}`);
  console.log(`  Open: ${openCount} 🟢 | Closed: ${closedCount} 🔴`);

  return data;
}

/**
 * Normalize case status to OPEN/CLOSED/UNKNOWN
 */
function normalizeStatus(statusText) {
  if (!statusText) return 'UNKNOWN';
  const upper = statusText.toUpperCase();
  if (upper.includes('CLOSED') || upper.includes('DISMISSED') || 
      upper.includes('DISPOSED') || upper.includes('RESOLVED') ||
      upper.includes('SETTLED') || upper.includes('TERMINATED')) {
    return 'CLOSED';
  }
  if (upper.includes('OPEN') || upper.includes('ACTIVE') || upper.includes('PENDING')) {
    return 'OPEN';
  }
  return 'UNKNOWN';
}

module.exports = {
  enrichCourtStatus,
  parseDefendantName,
  parsePlaintiffForMatch,
  findBestMatch,
  normalizeStatus,
  CONFIG
};
