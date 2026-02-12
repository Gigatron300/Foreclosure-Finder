// NJ Courts Case Status Enrichment - REWRITTEN
// Based on actual browser observation of portal.njcourts.gov navigation flow
//
// FLOW (observed Feb 2026):
// 1. Navigate to https://portal.njcourts.gov → redirects to Enterprise Portal dashboard
// 2. Dashboard has tiles: "eCourts Home", "Find a Case - Public Access", etc.
// 3. Clicking "Find a Case - Public Access" opens dropdown with options:
//    - "Search Civil and Foreclosure Cases" ← this is what we need
// 4. That opens new tab to: https://portal.njcourts.gov/webcivilcj/CIVILCaseJacketWeb/pages/civilCaseSearch.faces
// 5. Search page has tabs: "Search By Docket Number" and "Search By Party Name"
// 6. Party Name form fields (exact IDs from DOM):
//    - Last:   searchByPartyNameForm:partyLName
//    - First:  searchByPartyNameForm:partyFName
//    - Middle: searchByPartyNameForm:partyMName
//    - Search: searchByPartyNameForm:btnPartyNameSearch
// 7. Results table ID: searchByPartyNameForm:idPartyTable
//    Columns: Name | Venue | Docket Number | Case Caption | Case Initiation Date
// 8. Docket link uses JSF: myfaces.oam.submitForm('searchByPartyNameForm','searchByPartyNameForm:idPartyTable:{row}:lnkSrchByDocNum')
// 9. Case jacket page shows: Case Status (Active/etc), Case Disposition (Open/Dismissed/etc)
//
// Credentials: Set NJ_COURTS_USER and NJ_COURTS_PASS env vars on Render

const puppeteerExtra = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

// Apply stealth plugin BEFORE any browser launch
puppeteerExtra.use(StealthPlugin());

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const CONFIG = {
  // The portal home page - after login, this is the dashboard with tiles
  portalUrl: 'https://portal.njcourts.gov',
  // Direct URL to the civil case search page (works if session is already authenticated)
  searchUrl: 'https://portal.njcourts.gov/webcivilcj/CIVILCaseJacketWeb/pages/civilCaseSearch.faces',
  // Alternative search URL (sometimes the path changes slightly after navigation)
  searchUrlAlt: 'https://portal.njcourts.gov/CIVILCaseJacketWeb/pages/civilCaseSearch.faces',
  requestDelay: 2000,
  loginWait: 5000,
  pageLoadWait: 3000,
  batchSize: 10,
  batchPause: 5000,
  maxRetries: 2,
};

// ============================================================
// Name parsing helpers
// ============================================================

function parseDefendantName(fullName) {
  if (!fullName) return null;
  let name = fullName.toUpperCase().trim();
  name = name.replace(/\b(JR|SR|II|III|IV|ESQ|MD|PHD)\b\.?/g, '').trim();
  name = name.replace(/\s+/g, ' ');
  const parts = name.split(' ').filter(p => p.length > 0);
  if (parts.length === 0) return null;
  return {
    lastName: parts[0],
    firstName: parts.length > 1 ? parts[1] : '',
    middleName: parts.length > 2 ? parts[2] : '',
    fullParts: parts,
    searchName: parts[0]
  };
}

function parsePlaintiffForMatch(plaintiffName) {
  if (!plaintiffName) return '';
  const upper = plaintiffName.toUpperCase().trim();
  const cleaned = upper.replace(/\b(LLC|INC|CORP|N\.?A\.?|BANK|MORTGAGE|SERVICING|TRUST|LP|L\.P\.)\b/g, '').trim();
  const parts = cleaned.split(/\s+/).filter(p => p.length > 2);
  return parts[0] || upper.split(/\s+/)[0] || '';
}

// ============================================================
// Browser launch
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

// ============================================================
// Login - handles the Enterprise Portal (Pega) flow
// ============================================================

async function loginToNJCourts(page, username, password) {
  console.log('  🔑 Logging into NJ Courts portal...');

  // Anti-detection
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    window.chrome = { runtime: {} };
  });

  // Step 1: Navigate to portal - it may redirect to login or straight to dashboard
  console.log('  → Navigating to portal.njcourts.gov...');
  await page.goto(CONFIG.portalUrl, { waitUntil: 'networkidle2', timeout: 45000 });
  await delay(3000);

  let currentUrl = page.url();
  console.log(`  Current URL: ${currentUrl}`);

  // Check if we landed on the dashboard (already authenticated via session)
  let pageText = await page.evaluate(() => document.body.innerText.substring(0, 1000));
  
  if (pageText.includes('Find a Case') || pageText.includes('Portal Home Page')) {
    console.log('  ✅ Already on portal dashboard (session active)');
    return await navigateToSearchPage(page);
  }

  // Check if we landed on the search page directly
  if (pageText.includes('Party Name') || pageText.includes('Search For Case') || pageText.includes('Docket Number')) {
    console.log('  ✅ Already on search page');
    return true;
  }

  // We're on a login page - find and fill the form
  console.log('  📋 Looking for login form...');
  
  // Wait for page to fully render (may have JS-rendered login form)
  for (let attempt = 0; attempt < 10; attempt++) {
    const formInfo = await page.evaluate(() => {
      const inputs = document.querySelectorAll('input');
      const inputList = [];
      inputs.forEach(i => {
        if (i.type !== 'hidden') {
          inputList.push({ type: i.type, name: i.name, id: i.id });
        }
      });
      return {
        url: window.location.href,
        title: document.title,
        bodyTextSnippet: document.body.innerText.substring(0, 300),
        visibleInputs: inputList
      };
    });

    console.log(`  Attempt ${attempt + 1}: ${formInfo.visibleInputs.length} visible inputs, title="${formInfo.title}"`);

    if (formInfo.visibleInputs.length >= 2) {
      // Found a login form
      break;
    }

    // Check for Incapsula/bot block
    if (formInfo.bodyTextSnippet.includes('Request unsuccessful') || formInfo.bodyTextSnippet.includes('Incapsula')) {
      console.error('  ❌ Blocked by Incapsula/Imperva bot detection');
      return false;
    }

    await delay(3000);
  }

  // Fill login form
  const loginResult = await page.evaluate((user, pass) => {
    // IBM WebSEAL PKMS login uses 'username' and 'password' field names
    let userInput = document.querySelector('input[name="username"]');
    let passInput = document.querySelector('input[name="password"]');
    
    // Fallback selectors
    if (!userInput) userInput = document.querySelector('input[name="userid"]') || document.querySelector('input[name="j_username"]');
    if (!passInput) passInput = document.querySelector('input[name="j_password"]') || document.querySelector('input[type="password"]');
    
    // Last resort: find by type
    if (!userInput) {
      const allInputs = Array.from(document.querySelectorAll('input'));
      userInput = allInputs.find(i => (i.type === 'text' || i.type === '') && i.offsetParent !== null);
    }
    if (!passInput) {
      passInput = document.querySelector('input[type="password"]');
    }

    if (!userInput || !passInput) {
      return { success: false, error: 'Could not find login fields' };
    }

    // Use native setter to bypass JSF input interception
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
    console.error(`  ❌ ${loginResult.error}`);
    const htmlSnippet = await page.evaluate(() => document.body.innerHTML.substring(0, 2000));
    console.error(`  Page HTML: ${htmlSnippet}`);
    return false;
  }

  console.log(`  Filled login: user=${loginResult.userField}, pass=${loginResult.passField}`);
  await delay(500);

  // Submit login form
  const submitted = await page.evaluate(() => {
    // Try standard submit buttons
    const btns = document.querySelectorAll('button, input[type="submit"], input[type="button"], a');
    for (const btn of btns) {
      const text = (btn.textContent || btn.value || '').toLowerCase();
      if (text.includes('log in') || text.includes('login') || text.includes('sign in') || text.includes('submit')) {
        btn.click();
        return true;
      }
    }
    // Fallback: submit the form containing the password field
    const passField = document.querySelector('input[type="password"]');
    if (passField) {
      const form = passField.closest('form');
      if (form) { form.submit(); return true; }
    }
    return false;
  });

  if (!submitted) {
    console.error('  ❌ Could not find submit button');
    return false;
  }

  console.log('  Submitted login, waiting for redirect...');
  await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
  await delay(CONFIG.loginWait);

  // Check where we landed
  currentUrl = page.url();
  pageText = await page.evaluate(() => document.body.innerText.substring(0, 1000));
  console.log(`  After login URL: ${currentUrl}`);
  console.log(`  After login text snippet: ${pageText.substring(0, 200)}`);

  if (pageText.includes('Invalid') || pageText.includes('incorrect') || pageText.includes('failed')) {
    console.error('  ❌ Login failed - invalid credentials');
    return false;
  }

  // If we're on the portal dashboard, navigate to search
  if (pageText.includes('Find a Case') || pageText.includes('Portal Home Page')) {
    console.log('  ✅ Login successful - on portal dashboard');
    return await navigateToSearchPage(page);
  }

  // If we're already on search page
  if (pageText.includes('Party Name') || pageText.includes('Search For Case')) {
    console.log('  ✅ Login successful - on search page');
    return true;
  }

  // Try navigating directly to search page (session should be active now)
  console.log('  ⚠ Not on expected page, trying direct navigation to search...');
  return await navigateToSearchPage(page);
}

// ============================================================
// Navigate from dashboard to search page
// ============================================================

async function navigateToSearchPage(page) {
  console.log('  📍 Navigating to Civil Case Search page...');

  // Try direct URL first (faster if session cookies are set)
  await page.goto(CONFIG.searchUrl, { waitUntil: 'networkidle2', timeout: 30000 });
  await delay(3000);

  let pageText = await page.evaluate(() => document.body.innerText.substring(0, 500));
  
  if (pageText.includes('Search For Case') || pageText.includes('Party Name') || pageText.includes('Docket Number')) {
    console.log('  ✅ On search page (direct URL)');
    return true;
  }

  // Try alternative URL
  await page.goto(CONFIG.searchUrlAlt, { waitUntil: 'networkidle2', timeout: 30000 });
  await delay(3000);

  pageText = await page.evaluate(() => document.body.innerText.substring(0, 500));
  
  if (pageText.includes('Search For Case') || pageText.includes('Party Name') || pageText.includes('Docket Number')) {
    console.log('  ✅ On search page (alt URL)');
    return true;
  }

  // Last resort: go to portal dashboard and click the tile
  console.log('  ⚠ Direct URL failed, trying portal dashboard tile click...');
  await page.goto(CONFIG.portalUrl, { waitUntil: 'networkidle2', timeout: 30000 });
  await delay(3000);

  // Click "Find a Case - Public Access" tile
  const tileClicked = await page.evaluate(() => {
    const allLinks = document.querySelectorAll('a, button, div, span');
    for (const el of allLinks) {
      if (el.textContent.includes('Find a Case')) {
        el.click();
        return true;
      }
    }
    return false;
  });

  if (tileClicked) {
    await delay(2000);
    // Click "Search Civil and Foreclosure Cases" from the dropdown
    const searchClicked = await page.evaluate(() => {
      const allLinks = document.querySelectorAll('a, li, span, div');
      for (const el of allLinks) {
        if (el.textContent.includes('Search Civil and Foreclosure')) {
          el.click();
          return true;
        }
      }
      return false;
    });

    if (searchClicked) {
      // Wait for new tab/page to load
      await delay(5000);
      
      // Check if a new page opened (the portal opens it in a new tab)
      const pages = await page.browser().pages();
      for (const p of pages) {
        const pUrl = p.url();
        if (pUrl.includes('civilCaseSearch') || pUrl.includes('CIVILCaseJacket')) {
          // Switch to this page
          console.log('  ✅ Found search page in new tab');
          return true; // The caller will need to use this page
        }
      }
    }
  }

  console.error('  ❌ Could not navigate to search page');
  console.error(`  Final URL: ${page.url()}`);
  return false;
}

// ============================================================
// Get the active search page (may be in a different tab)
// ============================================================

async function getSearchPage(browser) {
  const pages = await browser.pages();
  for (const p of pages) {
    const url = p.url();
    if (url.includes('civilCaseSearch') || url.includes('CIVILCaseJacket')) {
      return p;
    }
  }
  return pages[pages.length - 1]; // fallback to last page
}

// ============================================================
// Search by party name using exact JSF form IDs
// ============================================================

async function searchByPartyName(page, defendant) {
  const { lastName, firstName, middleName } = defendant;
  
  // Make sure we're on the search page
  const onSearchPage = await page.evaluate(() => {
    return document.getElementById('searchByPartyNameForm:partyLName') !== null;
  });

  if (!onSearchPage) {
    // Try navigating back to search
    const searchUrls = [CONFIG.searchUrl, CONFIG.searchUrlAlt];
    for (const url of searchUrls) {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });
      await delay(2000);
      const found = await page.evaluate(() => document.getElementById('searchByPartyNameForm:partyLName') !== null);
      if (found) break;
    }
  }

  // CRITICAL: Click "Search By Party Name" tab first
  // The page defaults to "Search By Docket Number" tab, so we MUST switch tabs
  // before the party name form fields become active/visible
  const tabClicked = await page.evaluate(() => {
    // Method 1: Find the tab link by href
    const tabLink = document.querySelector('a[href="#tabs-2"]');
    if (tabLink) { tabLink.click(); return 'href-tabs-2'; }

    // Method 2: Find by text content
    const allLinks = document.querySelectorAll('a, li');
    for (const el of allLinks) {
      if (el.textContent.trim() === 'Search By Party Name') {
        el.click();
        return 'text-match';
      }
    }

    // Method 3: Find the tab containing "Party Name" and click it
    const tabItems = document.querySelectorAll('li[role="tab"], li.ui-tabs-header, .ui-tabs-nav li');
    for (const li of tabItems) {
      if (li.textContent.includes('Party Name')) {
        const link = li.querySelector('a') || li;
        link.click();
        return 'tab-role';
      }
    }

    return 'not-found';
  });
  console.log(`     Tab click result: ${tabClicked}`);
  
  // Wait for tab content to render (JSF tabs may need time to swap content)
  await delay(1500);

  // Verify the party name form is now visible
  const formReady = await page.evaluate(() => {
    const lastField = document.getElementById('searchByPartyNameForm:partyLName');
    if (!lastField) return { ready: false, reason: 'partyLName field not found' };
    // Check if field is visible (not hidden by tab)
    const rect = lastField.getBoundingClientRect();
    return { ready: rect.height > 0, reason: `field height=${rect.height}` };
  });
  console.log(`     Party name form ready: ${JSON.stringify(formReady)}`);

  if (!formReady.ready) {
    // Try jQuery-based tab activation (many JSF sites use jQuery UI tabs)
    await page.evaluate(() => {
      if (typeof jQuery !== 'undefined') {
        jQuery('#tabs').tabs('option', 'active', 1); // 0=Docket, 1=Party Name
      }
      // Also try clicking the second tab directly
      const tabHeaders = document.querySelectorAll('.ui-tabs-anchor, [role="tab"] a, .ui-tabs-nav a');
      if (tabHeaders.length >= 2) tabHeaders[1].click();
    });
    await delay(1500);
  }

  // Clear and fill the form using EXACT field IDs
  await page.evaluate(({ last, first, middle }) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    
    const lastField = document.getElementById('searchByPartyNameForm:partyLName');
    const firstField = document.getElementById('searchByPartyNameForm:partyFName');
    const middleField = document.getElementById('searchByPartyNameForm:partyMName');

    if (lastField) {
      setter.call(lastField, last);
      lastField.dispatchEvent(new Event('input', { bubbles: true }));
      lastField.dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (firstField) {
      setter.call(firstField, first);
      firstField.dispatchEvent(new Event('input', { bubbles: true }));
      firstField.dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (middleField) {
      setter.call(middleField, middle || '');
      middleField.dispatchEvent(new Event('input', { bubbles: true }));
      middleField.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }, { last: lastName, first: firstName, middle: middleName || '' });

  await delay(300);

  // Click the Search button using exact ID
  await page.evaluate(() => {
    const searchBtn = document.getElementById('searchByPartyNameForm:btnPartyNameSearch');
    if (searchBtn) {
      searchBtn.click();
      return true;
    }
    // Fallback: try the dummy button
    const dummyBtn = document.getElementById('searchByPartyNameForm:searchBtnDummy');
    if (dummyBtn) {
      dummyBtn.click();
      return true;
    }
    return false;
  });

  // Wait for page to reload with results (JSF form submission)
  await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
  await delay(CONFIG.pageLoadWait);

  // Extract results from the known table ID
  const results = await page.evaluate(() => {
    const table = document.getElementById('searchByPartyNameForm:idPartyTable');
    if (!table) return [];

    const rows = table.querySelectorAll('tbody tr');
    const data = [];

    rows.forEach((row, index) => {
      const cells = row.querySelectorAll('td');
      if (cells.length < 5) return;

      // Check if this is a "No data available" row
      const rowText = row.textContent.trim();
      if (rowText.includes('No data available') || rowText.includes('No matching records')) return;

      data.push({
        rowIndex: index,
        name: cells[0] ? cells[0].textContent.trim() : '',
        venue: cells[1] ? cells[1].textContent.trim() : '',
        docketNumber: cells[2] ? cells[2].textContent.trim() : '',
        caseCaption: cells[3] ? cells[3].textContent.trim() : '',
        filedDate: cells[4] ? cells[4].textContent.trim() : ''
      });
    });

    return data;
  });

  console.log(`     Found ${results.length} search results`);
  
  // If no results, log diagnostic info about page state
  if (results.length === 0) {
    const diagnostics = await page.evaluate(() => {
      const table = document.getElementById('searchByPartyNameForm:idPartyTable');
      const lastField = document.getElementById('searchByPartyNameForm:partyLName');
      const bodyText = document.body.innerText.substring(0, 800);
      
      // Check if we see "No data available" or other messages
      const tableText = table ? table.textContent.trim().substring(0, 200) : 'TABLE NOT FOUND';
      const lastValue = lastField ? lastField.value : 'FIELD NOT FOUND';
      
      // Check which tab is active
      const activeTab = document.querySelector('.ui-tabs-active a, .ui-state-active a, li[aria-selected="true"] a');
      const activeTabText = activeTab ? activeTab.textContent.trim() : 'unknown';
      
      // Check if there's an error message
      const errorMsgs = document.querySelectorAll('.error, .errorMessage, .ui-messages-error');
      const errors = Array.from(errorMsgs).map(e => e.textContent.trim());
      
      return {
        tableText,
        lastNameValue: lastValue,
        activeTab: activeTabText,
        errors,
        pageSnippet: bodyText.substring(0, 400)
      };
    });
    console.log(`     Diagnostics: tab="${diagnostics.activeTab}", lastName="${diagnostics.lastNameValue}"`);
    console.log(`     Table content: ${diagnostics.tableText.substring(0, 100)}`);
    if (diagnostics.errors.length > 0) console.log(`     Errors: ${diagnostics.errors.join('; ')}`);
    console.log(`     Page snippet: ${diagnostics.pageSnippet.substring(0, 200)}`);
  }
  results.forEach((r, i) => {
    console.log(`       ${i + 1}. ${r.docketNumber} | ${r.venue} | ${r.caseCaption.substring(0, 50)}... | ${r.filedDate}`);
  });

  return results;
}

// ============================================================
// Click into a case jacket to get status details
// ============================================================

async function getCaseDetails(page, result) {
  const rowIndex = result.rowIndex;

  // Click the docket number link using JSF's form submission pattern
  const clicked = await page.evaluate((idx) => {
    // The link ID pattern: searchByPartyNameForm:idPartyTable:{rowIndex}:lnkSrchByDocNum
    const linkId = `searchByPartyNameForm:idPartyTable:${idx}:lnkSrchByDocNum`;
    const link = document.getElementById(linkId);
    if (link) {
      link.click();
      return { clicked: true, method: 'directId' };
    }

    // Fallback: find the link in the row
    const table = document.getElementById('searchByPartyNameForm:idPartyTable');
    if (table) {
      const rows = table.querySelectorAll('tbody tr');
      if (rows[idx]) {
        const docketLink = rows[idx].querySelector('td:nth-child(3) a');
        if (docketLink) {
          docketLink.click();
          return { clicked: true, method: 'rowQuery' };
        }
      }
    }

    // Last fallback: use JSF's submitForm directly
    if (typeof myfaces !== 'undefined' && myfaces.oam && myfaces.oam.submitForm) {
      myfaces.oam.submitForm('searchByPartyNameForm', linkId);
      return { clicked: true, method: 'jsfSubmit' };
    }

    return { clicked: false };
  }, rowIndex);

  if (!clicked.clicked) {
    console.log(`     ⚠ Could not click docket link for row ${rowIndex}`);
    return null;
  }

  console.log(`     Clicked docket link (method: ${clicked.method}), waiting for case jacket...`);

  // Wait for navigation to case jacket page
  await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
  await delay(2000);

  // Extract case details from the case jacket page
  const details = await page.evaluate(() => {
    const getText = (labelText) => {
      // Find a label element containing the text, then get the next sibling's text
      const allElements = document.querySelectorAll('td, th, span, div, label');
      for (const el of allElements) {
        const text = el.textContent.trim();
        if (text === labelText || text === labelText + ':') {
          // Get the next sibling element
          let next = el.nextElementSibling;
          if (next) return next.textContent.trim();
          
          // Try parent's next sibling (for table layout)
          const parent = el.parentElement;
          if (parent && parent.nextElementSibling) {
            return parent.nextElementSibling.textContent.trim();
          }
        }
      }
      return '';
    };

    // The case jacket has a table with label:value pairs
    // Based on actual DOM observation:
    // "Case Status:" followed by value (e.g., "Active")
    // "Case Disposition:" followed by value (e.g., "Open")
    // "Case Caption:" followed by value
    // "Case Type:" followed by value
    // "Venue:" followed by value

    // More reliable: scan all text content for known patterns
    const bodyText = document.body.innerText;
    
    let caseStatus = '';
    let caseDisposition = '';
    let caseCaption = '';
    let caseType = '';
    let venue = '';
    let dispositionDate = '';
    let caseInitDate = '';

    // Look for these patterns in the page text
    const statusMatch = bodyText.match(/Case Status:\s*(\S+)/);
    if (statusMatch) caseStatus = statusMatch[1].trim();

    const dispMatch = bodyText.match(/Case Disposition:\s*(.+?)(?:\n|Case|Court|Venue|$)/);
    if (dispMatch) caseDisposition = dispMatch[1].trim();

    const captionMatch = bodyText.match(/Case Caption:\s*(.+?)(?:\n|Court|$)/);
    if (captionMatch) caseCaption = captionMatch[1].trim();

    const typeMatch = bodyText.match(/Case Type:\s*(.+?)(?:\n|Case|$)/);
    if (typeMatch) caseType = typeMatch[1].trim();

    const venueMatch = bodyText.match(/Venue:\s*(\S+)/);
    if (venueMatch) venue = venueMatch[1].trim();

    const initDateMatch = bodyText.match(/Case Initiation Date:\s*(\d{2}\/\d{2}\/\d{4})/);
    if (initDateMatch) caseInitDate = initDateMatch[1];

    const dispDateMatch = bodyText.match(/Disposition Date:\s*(\d{2}\/\d{2}\/\d{4})/);
    if (dispDateMatch) dispositionDate = dispDateMatch[1];

    // Also get the docket number from the page header
    const docketMatch = bodyText.match(/Docket Number:\s*(.*?)(?:\n|$)/);
    const docketNumber = docketMatch ? docketMatch[1].trim() : '';

    return {
      docketNumber,
      caseStatus,
      caseDisposition,
      caseCaption,
      caseType,
      venue,
      dispositionDate,
      caseInitDate,
      pageUrl: window.location.href,
      // Debug info
      bodySnippet: bodyText.substring(0, 500)
    };
  });

  console.log(`     Case Status: ${details.caseStatus}, Disposition: ${details.caseDisposition}`);

  // Navigate back to search page for next search
  await page.evaluate(() => {
    const backBtn = document.querySelector('button[type="button"]');
    if (backBtn && (backBtn.textContent.includes('Back') || backBtn.value === 'Back')) {
      backBtn.click();
      return true;
    }
    return false;
  });
  await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }).catch(() => {});
  await delay(1500);

  return details;
}

// ============================================================
// Match best result from search results
// ============================================================

function findBestMatch(results, plaintiff, lisPendensDateStr) {
  if (!results || results.length === 0) return null;

  const plaintiffKeyword = parsePlaintiffForMatch(plaintiff);
  let lisPendensDate = null;
  if (lisPendensDateStr) {
    try { lisPendensDate = new Date(lisPendensDateStr); } catch (e) {}
  }

  console.log(`     Matching: plaintiff="${plaintiffKeyword}", LP date=${lisPendensDateStr}`);

  const candidates = [];

  for (const result of results) {
    let matchScore = 0;
    const caption = (result.caseCaption || '').toUpperCase();
    const venue = (result.venue || '').toUpperCase();
    const docket = result.docketNumber || '';

    // Must be Camden venue
    if (venue.includes('CAMDEN')) matchScore += 10;
    else continue; // Skip non-Camden results

    // Must be a foreclosure docket (starts with F-)
    if (docket.startsWith('F-')) matchScore += 10;

    // Plaintiff name in caption
    if (plaintiffKeyword && caption.includes(plaintiffKeyword)) {
      matchScore += 15;
    }

    // Date proximity
    if (lisPendensDate && result.filedDate) {
      try {
        const caseDate = new Date(result.filedDate);
        const daysDiff = Math.abs((lisPendensDate - caseDate) / (1000 * 60 * 60 * 24));
        if (daysDiff <= 14) matchScore += 15;
        else if (daysDiff <= 60) matchScore += 10;
        else if (daysDiff <= 180) matchScore += 5;
        else if (daysDiff <= 365) matchScore += 2;
      } catch (e) {}
    }

    console.log(`       Candidate: ${docket} "${caption.substring(0, 40)}..." score=${matchScore}`);
    candidates.push({ ...result, matchScore });
  }

  candidates.sort((a, b) => b.matchScore - a.matchScore);

  if (candidates.length > 0 && candidates[0].matchScore >= 20) {
    console.log(`     ✅ Best match: ${candidates[0].docketNumber} (score: ${candidates[0].matchScore})`);
    return candidates[0];
  }

  console.log('     ❌ No confident match found');
  return null;
}

// ============================================================
// Normalize status
// ============================================================

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

// ============================================================
// Main enrichment function
// ============================================================

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
  let searchPage = null;
  let found = 0, notFound = 0, errors = 0;
  let closedCount = 0, openCount = 0;

  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1920, height: 1080 });

    // Login
    const loggedIn = await loginToNJCourts(page, username, password);
    if (!loggedIn) {
      console.error('❌ Could not log in to NJ Courts. Aborting.');
      return data;
    }

    // Get the search page (might be in a different tab after portal navigation)
    searchPage = await getSearchPage(browser);

    // Process each case
    for (let i = 0; i < toProcess.length; i++) {
      const c = toProcess[i];
      const prefix = `${i + 1}/${toProcess.length}`;

      // Batch pause
      if (i > 0 && i % CONFIG.batchSize === 0) {
        console.log(`  ⏸ Batch pause (${CONFIG.batchPause / 1000}s)...`);
        await delay(CONFIG.batchPause);
      }

      try {
        // Parse defendant name from the case
        // Case objects from parseCamdenCSV have: primaryDefendant, primaryPlaintiff, defendantNames[], plaintiffNames[]
        const defendantName = c.primaryDefendant || (c.defendantNames && c.defendantNames[0]) || '';
        const plaintiffName = c.primaryPlaintiff || (c.plaintiffNames && c.plaintiffNames[0]) || '';

        const defendant = parseDefendantName(defendantName);
        if (!defendant) {
          console.log(`${prefix} ⚠ Could not parse defendant name: ${defendantName}`);
          c.courtStatus = 'SKIP';
          c.courtStatusNote = 'Could not parse name';
          continue;
        }

        console.log(`\n${prefix} 🔍 Searching: ${defendant.lastName}, ${defendant.firstName} (plaintiff: ${plaintiffName})`);

        // Search by party name
        const results = await searchByPartyName(searchPage, defendant);
        await delay(CONFIG.requestDelay);

        if (!results || results.length === 0) {
          console.log(`${prefix} ❌ No results for ${defendant.lastName}`);
          c.courtStatus = 'NOT_FOUND';
          c.courtStatusNote = 'No search results';
          notFound++;
          continue;
        }

        // Find best matching result
        const match = findBestMatch(results, plaintiffName, c.filingDate || c.date);

        if (!match) {
          console.log(`${prefix} ❌ No confident match for ${defendant.lastName}`);
          c.courtStatus = 'NOT_FOUND';
          c.courtStatusNote = `${results.length} results, no match`;
          notFound++;
          continue;
        }

        // Click into the case jacket to get detailed status
        const details = await getCaseDetails(searchPage, match);

        if (!details) {
          console.log(`${prefix} ⚠ Could not load case details for ${match.docketNumber}`);
          c.courtStatus = 'ERROR';
          c.courtStatusNote = 'Could not load case jacket';
          errors++;
          continue;
        }

        // Update case with court status
        c.courtDocketNumber = match.docketNumber;
        c.courtStatus = normalizeStatus(details.caseStatus + ' ' + details.caseDisposition);
        c.courtStatusRaw = details.caseStatus;
        c.courtDisposition = details.caseDisposition;
        c.courtCaseType = details.caseType;
        c.courtCaseCaption = details.caseCaption || match.caseCaption;
        c.courtFiledDate = details.caseInitDate || match.filedDate;
        c.courtDispositionDate = details.dispositionDate;
        c.courtStatusNote = `Matched: score ${match.matchScore}`;

        const statusEmoji = c.courtStatus === 'CLOSED' ? '🔴' : c.courtStatus === 'OPEN' ? '🟢' : '⚪';
        if (c.courtStatus === 'CLOSED') closedCount++;
        else if (c.courtStatus === 'OPEN') openCount++;

        const dispNote = c.courtDisposition ? ` (${c.courtDisposition})` : '';
        console.log(`${prefix} ${statusEmoji} ${c.instrumentNumber} ${defendant.lastName} → ${match.docketNumber} ${c.courtStatus}${dispNote} [score:${match.matchScore}]`);
        found++;

      } catch (err) {
        console.log(`${prefix} ⚠ Error: ${err.message.slice(0, 80)}`);
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

module.exports = {
  enrichCourtStatus,
  parseDefendantName,
  parsePlaintiffForMatch,
  findBestMatch,
  normalizeStatus,
  CONFIG
};
