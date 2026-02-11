// NJ Courts Case Status Enrichment
// Logs into NJ eCourts portal, searches by defendant name,
// matches foreclosure cases by plaintiff + date proximity,
// and extracts case status (Open/Closed) and disposition.
//
// Credentials: Set NJ_COURTS_USER and NJ_COURTS_PASS env vars on Render
// Portal: https://portal.njcourts.gov/webcivilcj/CIVILCaseJacketWeb/pages/civilCaseSearch.faces

const puppeteerExtra = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

// Apply stealth plugin BEFORE any browser launch
puppeteerExtra.use(StealthPlugin());

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
  console.log('  🚀 Launching browser with stealth plugin...');
  
  return puppeteerExtra.launch({
    headless: 'new',
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-blink-features=AutomationControlled',
      '--js-flags=--max-old-space-size=256',
      '--window-size=1920,1080'
    ]
  });
}

async function loginToNJCourts(page, username, password) {
  console.log('  🔑 Logging into NJ Courts portal...');

  // Additional anti-detection measures
  await page.evaluateOnNewDocument(() => {
    // Override webdriver property
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    // Override languages
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    // Fix Chrome object
    window.chrome = { runtime: {} };
    // Fix permissions
    const originalQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (parameters) =>
      parameters.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission })
        : originalQuery(parameters);
    // Remove automation indicators
    delete window.cdc_adoQpoasnfa76pfcZLmcfl_Array;
    delete window.cdc_adoQpoasnfa76pfcZLmcfl_Promise;
    delete window.cdc_adoQpoasnfa76pfcZLmcfl_Symbol;
  });

  // Set extra headers to look more like a real browser
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
  });

  // Navigate to the civil case search - it will redirect to login
  console.log('  Navigating to portal...');
  await page.goto(CONFIG.loginUrl, { waitUntil: 'networkidle2', timeout: 60000 });
  await delay(8000);  // Longer wait for Incapsula challenge to complete

  let currentUrl = page.url();
  console.log(`  Current URL: ${currentUrl}`);

  // ---- RAW HTML DUMP for diagnostics ----
  const rawHtml = await page.content();
  console.log(`  Raw HTML length: ${rawHtml.length}`);
  console.log(`  HTML first 500 chars: ${rawHtml.substring(0, 500)}`);

  // Check for Incapsula/bot block
  if (rawHtml.includes('Incapsula') || rawHtml.includes('_Incapsula') || rawHtml.includes('visid_incap')) {
    console.log('  ⚠ Incapsula challenge detected, waiting longer for it to resolve...');
    
    // Wait for Incapsula challenge to complete (it usually auto-redirects)
    for (let i = 0; i < 10; i++) {
      await delay(3000);
      const newHtml = await page.content();
      console.log(`  Challenge attempt ${i+1}/10, HTML length: ${newHtml.length}`);
      
      if (!newHtml.includes('Incapsula') && !newHtml.includes('_Incapsula')) {
        console.log('  ✅ Incapsula challenge passed!');
        break;
      }
      
      // Check if we got redirected
      const newUrl = page.url();
      if (newUrl !== currentUrl) {
        console.log(`  Redirected to: ${newUrl}`);
        currentUrl = newUrl;
      }
    }
  }

  // Check for meta refresh redirect
  const metaRefresh = rawHtml.match(/<meta[^>]*http-equiv=["']refresh["'][^>]*content=["']([^"']+)["']/i);
  if (metaRefresh) {
    console.log(`  Meta refresh found: ${metaRefresh[1]}`);
    const urlMatch = metaRefresh[1].match(/url=(.+)/i);
    if (urlMatch) {
      console.log(`  Following meta refresh to: ${urlMatch[1]}`);
      await page.goto(urlMatch[1], { waitUntil: 'networkidle2', timeout: 30000 });
      await delay(5000);
      console.log(`  After redirect URL: ${page.url()}`);
    }
  }

  // Wait for content to render (JS SPA)
  let hasContent = false;
  for (let attempt = 0; attempt < 12; attempt++) {
    const check = await page.evaluate(() => ({
      inputs: document.querySelectorAll('input').length,
      bodyLen: document.body.innerHTML.length,
      hasText: document.body.innerText.trim().length > 50,
      frames: document.querySelectorAll('iframe, frame').length,
      hasIncapsula: document.body.innerHTML.includes('Incapsula')
    }));

    if ((check.inputs > 0 || check.hasText) && !check.hasIncapsula) {
      console.log(`  Content loaded (attempt ${attempt + 1}): ${check.inputs} inputs, bodyLen=${check.bodyLen}, frames=${check.frames}`);
      hasContent = true;
      break;
    }
    
    if (attempt === 5) {
      // After a few tries, check if we need to navigate somewhere else
      const curUrl = page.url();
      console.log(`  Still waiting at attempt ${attempt + 1}. URL: ${curUrl}`);
      
      // Try the portal root
      if (curUrl.includes('civilCaseSearch') || curUrl.includes('Incapsula')) {
        console.log('  Trying portal root instead...');
        await page.goto('https://portal.njcourts.gov/', { waitUntil: 'networkidle2', timeout: 30000 });
        await delay(5000);
        const rootHtml = await page.content();
        console.log(`  Portal root HTML length: ${rootHtml.length}`);
        console.log(`  Portal root first 500: ${rootHtml.substring(0, 500)}`);
      }
    }

    console.log(`  Waiting for content (attempt ${attempt + 1}/12)...`);
    await delay(3000);
  }

  // Full diagnostic dump
  const pageInfo = await page.evaluate(() => ({
    title: document.title,
    url: window.location.href,
    forms: Array.from(document.querySelectorAll('form')).map(f => ({ action: f.action, method: f.method, id: f.id })),
    inputs: Array.from(document.querySelectorAll('input')).map(i => ({ type: i.type, name: i.name, id: i.id, placeholder: i.placeholder })),
    bodyText: document.body.innerText.substring(0, 500),
    bodyHtmlLen: document.body.innerHTML.length,
    iframes: Array.from(document.querySelectorAll('iframe, frame')).map(f => ({ src: f.src, id: f.id })),
    scripts: Array.from(document.querySelectorAll('script[src]')).map(s => s.src).slice(0, 5)
  }));

  console.log(`  Page title: "${pageInfo.title}"`);
  console.log(`  Body text: "${pageInfo.bodyText.substring(0, 300)}"`);
  console.log(`  Forms: ${pageInfo.forms.length}, Inputs: ${pageInfo.inputs.length}`);
  pageInfo.inputs.forEach(i => console.log(`    Input: type=${i.type} name="${i.name}" id="${i.id}"`));
  pageInfo.forms.forEach(f => console.log(`    Form: action=${f.action} method=${f.method}`));
  console.log(`  Iframes: ${pageInfo.iframes.length}`);
  pageInfo.iframes.forEach(f => console.log(`    Iframe: src=${f.src} id=${f.id}`));
  console.log(`  Scripts: ${pageInfo.scripts.join(', ')}`);

  // Check iframes for login form
  const allFrames = page.frames();
  for (const frame of allFrames) {
    if (frame === page.mainFrame()) continue;
    try {
      const fInfo = await frame.evaluate(() => ({
        url: window.location.href,
        inputs: Array.from(document.querySelectorAll('input')).map(i => ({ type: i.type, name: i.name, id: i.id })),
        bodyText: document.body.innerText.substring(0, 200)
      }));
      if (fInfo.inputs.length > 0) {
        console.log(`  Frame ${fInfo.url}: ${fInfo.inputs.length} inputs found`);
        fInfo.inputs.forEach(i => console.log(`    Input: type=${i.type} name="${i.name}" id="${i.id}"`));
      }
    } catch (e) {
      console.log(`  Frame [cross-origin]: ${frame.url()}`);
    }
  }

  // ---- Already on search page? ----
  if (pageInfo.bodyText.includes('Party Name') || pageInfo.bodyText.includes('Case Search')) {
    console.log('  ✅ Already logged in!');
    return true;
  }

  // ---- Attempt login ----
  if (pageInfo.inputs.length === 0) {
    // No inputs found anywhere - the page is blocked or completely JS-rendered
    console.error('  ❌ No login form found. Site may still be blocking headless browser.');
    console.error('  Full HTML dump:');
    const fullHtml = await page.content();
    // Log in chunks to avoid truncation
    for (let i = 0; i < Math.min(fullHtml.length, 3000); i += 500) {
      console.log(`  HTML[${i}]: ${fullHtml.substring(i, i + 500)}`);
    }
    return false;
  }

  // Fill login fields
  const loginResult = await page.evaluate((user, pass) => {
    const allInputs = Array.from(document.querySelectorAll('input'));
    let userInput = null, passInput = null;
    
    // Try by name
    userInput = document.querySelector('input[name="username"]');
    passInput = document.querySelector('input[name="password"]');
    if (!userInput) userInput = document.querySelector('input[name="userid"]') || document.querySelector('input[name="j_username"]');
    if (!passInput) passInput = document.querySelector('input[name="j_password"]') || document.querySelector('input[type="password"]');
    
    // Try by ID
    if (!userInput) userInput = document.querySelector('input[id*="user" i]') || document.querySelector('input[id*="login" i]');
    
    // Fallback
    if (!userInput) userInput = allInputs.find(i => (i.type === 'text' || i.type === '') && i.offsetParent !== null);
    if (!passInput) passInput = allInputs.find(i => i.type === 'password');
    
    if (!userInput || !passInput) return { success: false };
    
    // Use native value setter to bypass JSF input interception
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(userInput, user);
    userInput.dispatchEvent(new Event('input', { bubbles: true }));
    userInput.dispatchEvent(new Event('change', { bubbles: true }));
    
    setter.call(passInput, pass);
    passInput.dispatchEvent(new Event('input', { bubbles: true }));
    passInput.dispatchEvent(new Event('change', { bubbles: true }));
    
    return { success: true, userField: userInput.name || userInput.id, passField: passInput.name || passInput.id };
  }, username, password);

  if (!loginResult.success) {
    console.error('  ❌ Could not find login form fields');
    return false;
  }

  console.log(`  Filled login: user=${loginResult.userField}, pass=${loginResult.passField}`);
  await delay(500);

  // Click submit
  const clicked = await page.evaluate(() => {
    const btns = document.querySelectorAll('button, input[type="submit"], input[type="button"], a');
    for (const btn of btns) {
      const text = (btn.textContent || btn.value || '').toLowerCase();
      if (text.includes('log in') || text.includes('login') || text.includes('sign in') || text.includes('submit')) {
        btn.click();
        return true;
      }
    }
    // Fallback: submit the form
    const form = document.querySelector('form');
    if (form) { form.submit(); return true; }
    return false;
  });

  if (!clicked) {
    console.error('  ❌ Could not find submit button');
    return false;
  }

  console.log('  Submitted login, waiting for redirect...');
  await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
  await delay(CONFIG.loginWait);

  // Check if we landed on search page
  const afterLogin = await page.evaluate(() => ({
    url: window.location.href,
    text: document.body.innerText.substring(0, 500)
  }));

  console.log(`  After login URL: ${afterLogin.url}`);
  console.log(`  After login text: ${afterLogin.text.substring(0, 200)}`);

  if (afterLogin.text.includes('Party Name') || afterLogin.text.includes('Case Search') || afterLogin.url.includes('civilCaseSearch')) {
    console.log('  ✅ Login successful (on search page)');
    return true;
  }

  if (afterLogin.text.includes('Invalid') || afterLogin.text.includes('incorrect') || afterLogin.text.includes('failed')) {
    console.error('  ❌ Login failed - invalid credentials');
    return false;
  }

  // May need to navigate to search page after login
  if (!afterLogin.url.includes('civilCaseSearch')) {
    console.log('  Navigating to search page after login...');
    await page.goto(CONFIG.searchUrl, { waitUntil: 'networkidle2', timeout: 20000 });
    await delay(3000);
    const searchCheck = await page.evaluate(() => document.body.innerText.includes('Party Name'));
    if (searchCheck) { console.log('  ✅ Login successful (after redirect)'); return true; }
  }

  console.error('  ❌ Login failed');
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
          detailLink: linkHref
        });
      }
    }

    return rows;
  });

  return results;
}

/**
 * Match search results to a specific lis pendens case
 * Uses venue (Camden), case type (Foreclosure), defendant name in caption, and date proximity
 * 
 * RELAXED MATCHING: We searched by defendant last name, so if we find a Camden foreclosure
 * case with that defendant in the caption, it's very likely the right case.
 */
function findBestMatch(searchResults, lispendenCase) {
  const plaintiffKeyword = parsePlaintiffForMatch(lispendenCase.plaintiff || lispendenCase.primaryPlaintiff);
  const defendantParts = parseDefendantName(lispendenCase.primaryDefendant);
  const lisPendensDate = lispendenCase.filingDate ? new Date(lispendenCase.filingDate) : null;

  const candidates = [];

  for (const result of searchResults) {
    let matchScore = 0;
    const caption = (result.caseCaption || '').toUpperCase();
    const venue = (result.venue || '').toUpperCase();
    const caseType = (result.caseType || '').toUpperCase();
    const docket = (result.docketNumber || '').toUpperCase();

    // Must be Camden venue (check both venue field and docket prefix)
    const isCamden = venue.includes('CAMDEN') || docket.includes('CAM-') || docket.startsWith('F-');
    if (!isCamden) {
      console.log(`      Skipping non-Camden: ${docket} venue=${venue}`);
      continue;
    }
    matchScore += 10;

    // Must be foreclosure case (docket starts with F- or contains -F-)
    const isForeclosure = docket.includes('-F-') || docket.startsWith('F-') || caseType.includes('FORECLOSURE');
    if (!isForeclosure) {
      console.log(`      Skipping non-foreclosure: ${docket} type=${caseType}`);
      continue;
    }
    matchScore += 20;

    // Defendant name in caption - THIS IS KEY since we searched by defendant
    if (defendantParts) {
      if (caption.includes(defendantParts.lastName)) {
        matchScore += 25;  // Strong match - defendant last name in caption
        if (defendantParts.firstName && caption.includes(defendantParts.firstName)) {
          matchScore += 10;  // Even better - first name too
        }
      } else {
        // Defendant name not in caption - skip this result
        console.log(`      Skipping - defendant ${defendantParts.lastName} not in caption: ${caption}`);
        continue;
      }
    }

    // Plaintiff name in caption (bonus points, not required)
    if (plaintiffKeyword && caption.includes(plaintiffKeyword)) {
      matchScore += 15;
    }

    // Date proximity - lis pendens is usually 1-8 weeks after case filing (bonus points)
    if (lisPendensDate && result.filedDate) {
      try {
        const caseDate = new Date(result.filedDate);
        const daysDiff = Math.abs((lisPendensDate - caseDate) / (1000 * 60 * 60 * 24));
        
        if (daysDiff <= 14) matchScore += 15;       // Within 2 weeks - strong match
        else if (daysDiff <= 60) matchScore += 10;  // Within 2 months - good match
        else if (daysDiff <= 180) matchScore += 5;  // Within 6 months - possible
      } catch (e) {}
    }

    // If we get here, we have a Camden foreclosure with defendant name - that's a match!
    console.log(`      ✓ Candidate: ${docket} "${caption}" score=${matchScore}`);
    candidates.push({ ...result, matchScore });
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

  // Skip cases already permanently marked as CLOSED (dismissed cases never need re-checking)
  const toProcess = skipAlreadyEnriched
    ? cases.filter(c => !c.courtStatus || (c.courtStatus !== 'CLOSED'))
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
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1920, height: 1080 });

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
