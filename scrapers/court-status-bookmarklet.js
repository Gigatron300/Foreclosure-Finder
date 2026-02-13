(async function () {
  'use strict';

  const SERVER = '__SERVER_URL__';
  const TOKEN = '__AUTH_TOKEN__';
  const TEST_MODE = __TEST_MODE__;

  const HOST_OK =
    window.location.href.includes('njcourts.gov') &&
    window.location.href.toLowerCase().includes('civilcasesearch');

  if (!HOST_OK) {
    alert('❌ Navigate to NJ Courts "Search Civil and Foreclosure Cases" first!');
    return;
  }

  const SEARCH_URL = window.location.href.split('?')[0];
  const DELAY = 1200;

  // ─────────────────────────────────────────────────────────────
  // UI Panel
  // ─────────────────────────────────────────────────────────────
  if (document.getElementById('csc-panel')) document.getElementById('csc-panel').remove();

  const panel = document.createElement('div');
  panel.id = 'csc-panel';
  panel.innerHTML = `
    <style>
      #csc-panel { position:fixed;top:8px;right:8px;width:420px;z-index:99999;background:#0f172a;color:#e2e8f0;border-radius:10px;padding:14px;font-family:system-ui,sans-serif;font-size:12px;box-shadow:0 4px 24px rgba(0,0,0,.6);border:1px solid #334155;max-height:85vh;display:flex;flex-direction:column; }
      #csc-panel h3{margin:0 0 6px;color:#38bdf8;font-size:14px}
      #csc-bar{height:5px;background:#1e293b;border-radius:3px;margin:6px 0;overflow:hidden}
      #csc-fill{height:100%;width:0%;background:linear-gradient(90deg,#38bdf8,#818cf8);border-radius:3px;transition:width .3s}
      #csc-stats{display:flex;gap:10px;color:#94a3b8;margin:4px 0;flex-wrap:wrap}
      #csc-stats b.g{color:#4ade80} #csc-stats b.r{color:#f87171} #csc-stats b.y{color:#fbbf24}
      #csc-log{background:#0a0f1a;border-radius:6px;padding:8px;flex:1;overflow-y:auto;font-family:monospace;font-size:11px;line-height:1.5;margin-top:6px;max-height:55vh}
      .l-ok{color:#4ade80}.l-err{color:#f87171}.l-w{color:#fbbf24}.l-i{color:#94a3b8}.l-s{color:#38bdf8}
      #csc-btns{margin-top:6px;display:flex;gap:6px;align-items:center}
      #csc-btns button{border:none;padding:4px 12px;border-radius:4px;font-size:11px;font-weight:600;cursor:pointer}
      .csc-stop{background:#f87171;color:#fff}.csc-close{background:#334155;color:#94a3b8}
    </style>
    <h3>⚖️ Court Status Checker v3</h3>
    <div id="csc-status">Preparing...</div>
    <div id="csc-bar"><div id="csc-fill"></div></div>
    <div id="csc-stats">🟢<b class="g" id="cs-o">0</b> 🔴<b class="r" id="cs-c">0</b> ❌<b class="y" id="cs-n">0</b> ⚠<b id="cs-e">0</b></div>
    <div id="csc-btns">
      <button class="csc-stop" onclick="window._cscStop=true">⏹ Stop</button>
      <button class="csc-close" onclick="document.getElementById('csc-panel').remove();window._cscStop=true">✕ Close</button>
    </div>
    <div id="csc-log"></div>
  `;
  document.body.appendChild(panel);

  window._cscStop = false;

  const S = { o: 0, c: 0, n: 0, e: 0, done: 0, total: 0 };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  const log = (m, cls = 'i') => {
    const d = document.getElementById('csc-log');
    if (!d) return;
    d.innerHTML += `<div class="l-${cls}">${m}</div>`;
    d.scrollTop = d.scrollHeight;
  };

  const upd = () => {
    const p = S.total > 0 ? Math.round((S.done / S.total) * 100) : 0;
    const fill = document.getElementById('csc-fill');
    const status = document.getElementById('csc-status');
    if (fill) fill.style.width = `${p}%`;
    if (status) status.textContent = `${S.done} / ${S.total} (${p}%)`;
    const eo = document.getElementById('cs-o');
    const ec = document.getElementById('cs-c');
    const en = document.getElementById('cs-n');
    const ee = document.getElementById('cs-e');
    if (eo) eo.textContent = S.o;
    if (ec) ec.textContent = S.c;
    if (en) en.textContent = S.n;
    if (ee) ee.textContent = S.e;
  };

  // ─────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────
  const cleanText = (s) => (s || '').replace(/\s+/g, ' ').trim().toUpperCase();

  function dice(a, b) {
    const sa = cleanText(a), sb = cleanText(b);
    if (!sa || !sb) return 0;
    const bigrams = (s) => { const r = []; for (let i = 0; i < s.length - 1; i++) r.push(s.slice(i, i + 2)); return r; };
    const ba = bigrams(sa), bb = bigrams(sb);
    const setA = new Set(ba), setB = new Set(bb);
    let inter = 0;
    setA.forEach((x) => { if (setB.has(x)) inter++; });
    return (2 * inter) / (ba.length + bb.length);
  }

  function parseAnyDate(val) {
    if (!val) return null;
    if (val instanceof Date) return isNaN(val) ? null : val;
    const s = String(val).trim();
    const mdy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (mdy) {
      const dt = new Date(+mdy[3], +mdy[1] - 1, +mdy[2]);
      return isNaN(dt) ? null : dt;
    }
    const dt = new Date(s);
    return isNaN(dt) ? null : dt;
  }

  function daysBetween(a, b) {
    if (!a || !b) return null;
    const ms = Math.abs(a.getTime() - b.getTime());
    return Math.round(ms / (1000 * 60 * 60 * 24));
  }

  function dateScore(csvDate, siteDate) {
    const d = daysBetween(csvDate, siteDate);
    if (d === null) return 0.10;
    const cap = 180;
    const x = Math.min(d, cap);
    return 1 - x / cap;
  }

  function classify(caseStatusRaw, caseDispositionRaw) {
    const s = String(caseStatusRaw || '').toUpperCase();
    const d = String(caseDispositionRaw || '').toUpperCase();
    const combined = `${s} ${d}`;

    if (/(DISMISSED|DISPOSED|SETTLED|TERMINATED|CLOSED|WITH PREJUDICE|WITHOUT PREJUDICE|FINAL JUDGMENT|JUDGMENT|VACATED)/.test(combined)) {
      return { normalized: 'CLOSED', useful: false };
    }

    if (/(OPEN|ACTIVE|PENDING|DEFAULTED|IN PROGRESS|UNRESOLVED)/.test(combined)) {
      return { normalized: 'OPEN', useful: true };
    }

    return { normalized: 'UNKNOWN', useful: false };
  }

  function parseDef(name) {
    const s = cleanText(name);
    if (!s) return null;

    const cleaned = s
      .replace(/\bET AL\b/g, '')
      .replace(/\bHIS WIFE\b|\bHER HUSBAND\b/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (!cleaned) return null;

    if (/\b(LLC|INC|CORP|CORPORATION|CO|COMPANY|BANK|TRUST|AGENCY|AUTHORITY|MORTGAGE|FINANCE|ASSOCIATION|ASSN|HOUSING|SERVICING|SERVICES)\b/.test(cleaned)) {
      return { last: cleaned, first: '', mid: '', isBusiness: true };
    }

    if (cleaned.includes(',')) {
      const [lastPart, rest] = cleaned.split(',', 2);
      const restParts = (rest || '').trim().split(' ').filter(Boolean);
      return { last: lastPart.trim(), first: restParts[0] || '', mid: restParts[1] || '', isBusiness: false };
    }

    const parts = cleaned.split(' ').filter(Boolean);
    if (parts.length === 1) return { last: parts[0], first: '', mid: '', isBusiness: false };
    return { last: parts[0], first: parts[1] || '', mid: parts[2] || '', isBusiness: false };
  }

  function getInstrument(c) { return c.instrumentNumber || ''; }
  function getDefendant(c) { return c.primaryDefendant || ''; }
  function getPlaintiff(c) { return c.primaryPlaintiff || ''; }
  function getFilingDate(c) { return parseAnyDate(c.filingDateISO) || parseAnyDate(c.filingDate) || null; }

  async function save(instrumentNumber, courtData) {
    try {
      await fetch(`${SERVER}/api/camden/court-status-update`, {
        method: 'POST',
        headers: { 'X-Auth-Token': TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ instrumentNumber, courtData })
      });
    } catch {}
  }

  // ─────────────────────────────────────────────────────────────
  // JSF Form Handling - CRITICAL for NJ Courts
  // ─────────────────────────────────────────────────────────────

  // Check if we're on the Party Name form (not Docket Number form)
  function isPartyNameFormVisible() {
    // Look for the Individual/Business radio buttons OR the Last Name field
    // These only exist on the Party Name tab
    const hasIndividualRadio = !!document.querySelector('input[type="radio"][id*="individual" i], label:contains("Individual")');
    const hasLastNameField = !!document.querySelector('input[id*="partyLName" i], input[id*="lastName" i]');
    const hasLastLabel = Array.from(document.querySelectorAll('label, span')).some(el => el.textContent.trim() === '*Last' || el.textContent.trim() === 'Last');
    
    return hasLastNameField || hasLastLabel;
  }

  // Check if we're on the Docket Number form
  function isDocketFormVisible() {
    const hasDocketField = !!document.querySelector('input[id*="docketNumber" i], input[id*="docketSeq" i]');
    const hasDocketYearField = !!document.querySelector('input[id*="docketYear" i]');
    return hasDocketField || hasDocketYearField;
  }

  // Click the Party Name tab and WAIT for the form to actually change
  async function switchToPartyNameTab() {
    log('  🔄 Switching to Party Name tab...', 'i');
    
    // If already on Party Name form, we're good
    if (isPartyNameFormVisible() && !isDocketFormVisible()) {
      log('  ✅ Already on Party Name form', 'ok');
      return true;
    }

    // Find and click the Party Name tab
    const allClickables = document.querySelectorAll('a, li, span, div, button');
    let tabClicked = false;
    
    for (const el of allClickables) {
      const text = (el.textContent || '').trim();
      if (text === 'Search By Party Name') {
        log('  🖱️ Clicking "Search By Party Name" tab...', 'i');
        el.click();
        tabClicked = true;
        break;
      }
    }

    if (!tabClicked) {
      // Try by href
      const tabLink = document.querySelector('a[href*="tabs-2"], a[href*="party"]');
      if (tabLink) {
        log('  🖱️ Clicking tab link...', 'i');
        tabLink.click();
        tabClicked = true;
      }
    }

    if (!tabClicked) {
      log('  ❌ Could not find Party Name tab', 'err');
      return false;
    }

    // CRITICAL: Wait for the form to actually change
    // JSF may do an AJAX update or full page reload
    log('  ⏳ Waiting for form to load...', 'i');
    
    for (let i = 0; i < 30; i++) {  // Wait up to 15 seconds
      await wait(500);
      
      if (isPartyNameFormVisible()) {
        log('  ✅ Party Name form loaded', 'ok');
        await wait(300);  // Extra buffer for JS to finish
        return true;
      }
    }

    log('  ❌ Party Name form did not load', 'err');
    return false;
  }

  // Find the Last Name input field
  function findLastNameField() {
    // Try by ID patterns
    const byId = document.querySelector(
      'input[id*="partyLName" i], input[id*="partylname" i], ' +
      'input[id*="lastName" i], input[id*="lastname" i], ' +
      'input[id*="lname" i], input[id*="LName" i]'
    );
    if (byId) return byId;

    // Try by looking near "*Last" label
    const labels = document.querySelectorAll('label, span, td');
    for (const lbl of labels) {
      const txt = (lbl.textContent || '').trim();
      if (txt === '*Last' || txt === 'Last') {
        // Look for nearby input
        const parent = lbl.closest('tr, div, td');
        if (parent) {
          const input = parent.querySelector('input[type="text"]');
          if (input) return input;
        }
        // Try next sibling
        let next = lbl.nextElementSibling;
        while (next) {
          if (next.tagName === 'INPUT') return next;
          const inp = next.querySelector('input');
          if (inp) return inp;
          next = next.nextElementSibling;
        }
      }
    }

    return null;
  }

  // Find the First Name input field
  function findFirstNameField() {
    const byId = document.querySelector(
      'input[id*="partyFName" i], input[id*="partyfname" i], ' +
      'input[id*="firstName" i], input[id*="firstname" i], ' +
      'input[id*="fname" i], input[id*="FName" i]'
    );
    if (byId) return byId;

    const labels = document.querySelectorAll('label, span, td');
    for (const lbl of labels) {
      const txt = (lbl.textContent || '').trim();
      if (txt === '*First' || txt === 'First') {
        const parent = lbl.closest('tr, div, td');
        if (parent) {
          const input = parent.querySelector('input[type="text"]');
          if (input) return input;
        }
      }
    }

    return null;
  }

  // Find the Middle Name/MI input field
  function findMiddleNameField() {
    const byId = document.querySelector(
      'input[id*="partyMName" i], input[id*="partymname" i], ' +
      'input[id*="middleName" i], input[id*="middlename" i], ' +
      'input[id*="mname" i], input[id*="MName" i]'
    );
    if (byId) return byId;

    const labels = document.querySelectorAll('label, span, td');
    for (const lbl of labels) {
      const txt = (lbl.textContent || '').trim();
      if (txt === 'MI-Optional' || txt === 'MI' || txt === 'Middle') {
        const parent = lbl.closest('tr, div, td');
        if (parent) {
          const input = parent.querySelector('input[type="text"]');
          if (input) return input;
        }
      }
    }

    return null;
  }

  // Set input value with proper JSF events
  function setFieldValue(input, value) {
    if (!input) return false;

    // Focus the field
    input.focus();
    input.dispatchEvent(new Event('focus', { bubbles: true }));

    // Clear existing value
    input.value = '';

    // Set new value character by character (more realistic)
    input.value = value;

    // Fire all the events JSF might need
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
    input.dispatchEvent(new Event('blur', { bubbles: true }));

    return input.value === value;
  }

  // Find the Search button
  function findSearchButton() {
    // Look for button/input with "Search" text
    const allButtons = document.querySelectorAll('button, input[type="submit"], input[type="button"]');
    for (const btn of allButtons) {
      const text = (btn.textContent || btn.value || '').trim();
      if (text.toLowerCase() === 'search') {
        return btn;
      }
    }

    // Look by ID
    const byId = document.querySelector(
      'button[id*="search" i], input[id*="search" i][type="submit"], ' +
      'input[id*="search" i][type="button"]'
    );
    if (byId) return byId;

    return null;
  }

  // Wait for results table or error
  async function waitForSearchResults(timeout = 20000) {
    const start = Date.now();

    while (Date.now() - start < timeout) {
      // Check for results table
      const tables = document.querySelectorAll('table');
      for (const t of tables) {
        const text = (t.innerText || '').toUpperCase();
        if (text.includes('DOCKET NUMBER') && text.includes('CASE CAPTION') && text.includes('CASE INITIATION')) {
          return { success: true, table: t };
        }
      }

      // Check for "no results" message
      const bodyText = document.body.innerText.toLowerCase();
      if (bodyText.includes('no cases found') || bodyText.includes('no records found') || bodyText.includes('0 cases')) {
        return { success: true, table: null, noResults: true };
      }

      // Check for validation errors (means form didn't submit properly)
      const errors = document.querySelectorAll('.error, .errorMessage, [class*="error"]');
      for (const err of errors) {
        const errText = (err.textContent || '').toLowerCase();
        if (errText.includes('required') || errText.includes('invalid')) {
          return { success: false, error: err.textContent };
        }
      }

      await wait(500);
    }

    return { success: false, error: 'Timeout waiting for results' };
  }

  // Perform a search
  async function doSearch(last, first, mid) {
    log(`  🔍 Searching: "${last}", "${first}" "${mid || ''}"`, 'i');

    // Step 1: Make sure we're on Party Name tab
    const tabOk = await switchToPartyNameTab();
    if (!tabOk) {
      return { success: false, error: 'Could not switch to Party Name tab' };
    }

    // Step 2: Find the form fields
    const lastField = findLastNameField();
    const firstField = findFirstNameField();
    const midField = findMiddleNameField();

    log(`  📝 Fields found: Last=${!!lastField}, First=${!!firstField}, Mid=${!!midField}`, 'i');

    if (!lastField) {
      return { success: false, error: 'Could not find Last Name field' };
    }

    // Step 3: Fill in the fields
    log(`  ✏️ Filling: Last="${last}"`, 'i');
    setFieldValue(lastField, last);
    await wait(200);

    if (firstField && first) {
      log(`  ✏️ Filling: First="${first}"`, 'i');
      setFieldValue(firstField, first);
      await wait(200);
    }

    if (midField && mid) {
      log(`  ✏️ Filling: Mid="${mid}"`, 'i');
      setFieldValue(midField, mid);
      await wait(200);
    }

    // Step 4: Find and click Search
    const searchBtn = findSearchButton();
    if (!searchBtn) {
      return { success: false, error: 'Could not find Search button' };
    }

    log('  🖱️ Clicking Search button...', 'i');
    searchBtn.click();

    // Step 5: Wait for results
    const result = await waitForSearchResults(20000);

    if (!result.success) {
      log(`  ❌ Search failed: ${result.error}`, 'err');
      return { success: false, error: result.error };
    }

    if (result.noResults) {
      log('  ℹ️ No cases found for this name', 'w');
      return { success: true, table: null };
    }

    log('  ✅ Got results!', 'ok');
    return { success: true, table: result.table };
  }

  function getRows(table) {
    return Array.from(table.querySelectorAll('tbody tr, tr')).filter(row => {
      const cells = row.querySelectorAll('td');
      return cells.length > 0;
    });
  }

  function docketLinkInRow(row) {
    const links = Array.from(row.querySelectorAll('a'));
    const docketRe = /\b([A-Z]{1,4}[-\s]?)?F[-\s]?\d{3,7}[-\s]?\d{2}\b/i;
    for (const a of links) {
      const t = (a.textContent || '').trim();
      if (docketRe.test(t)) return a;
    }
    return links[0] || null;
  }

  function rowText(row) {
    return cleanText(row ? row.innerText : '');
  }

  function extractJacket() {
    const text = document.body.innerText || '';
    const pick = (re) => {
      const m = text.match(re);
      return m ? (m[1] || '').trim() : '';
    };
    return {
      caseStatus: pick(/Case Status:\s*([^\n\r]+)/i),
      caseDisposition: pick(/Case Disposition:\s*([^\n\r]+)/i),
      caseCaption: pick(/Case Caption:\s*([^\n\r]+)/i),
      caseType: pick(/Case Type:\s*([^\n\r]+)/i),
      caseInitiationDate: pick(/Case Initiation Date:\s*(\d{1,2}\/\d{1,2}\/\d{4})/i),
      dispositionDate: pick(/Disposition Date:\s*(\d{1,2}\/\d{1,2}\/\d{4})/i),
      docketNumber: pick(/Docket Number:\s*([^\n\r]+)/i)
    };
  }

  async function clickBack() {
    const buttons = document.querySelectorAll('a, button, input[type="button"]');
    for (const btn of buttons) {
      const text = (btn.textContent || btn.value || '').trim().toLowerCase();
      if (text === 'back' || text === '< back' || text === '« back' || text.includes('back to')) {
        btn.click();
        await wait(2000);
        return;
      }
    }
    window.history.back();
    await wait(2000);
  }

  async function chooseBestMatch(resultsTable, caseObj) {
    const rows = getRows(resultsTable);
    if (!rows.length) return { notFound: true, reason: 'No rows in results' };

    const defName = getDefendant(caseObj);
    const plaintiff = getPlaintiff(caseObj);
    const csvDate = getFilingDate(caseObj);

    log(`  📊 Found ${rows.length} results, scoring...`, 'i');

    const scored = rows.map((row, idx) => {
      const txt = rowText(row);
      const defSim = dice(defName, txt);
      const plSim = dice(plaintiff, txt);
      const score = (0.65 * defSim) + (0.35 * plSim);
      return { idx, row, score };
    }).sort((a, b) => b.score - a.score);

    const top = scored.slice(0, Math.min(5, scored.length));
    let best = null;

    for (const cand of top) {
      if (window._cscStop) break;

      const link = docketLinkInRow(cand.row);
      if (!link) continue;

      log(`  📂 Opening result #${cand.idx + 1} (score ${(cand.score * 100).toFixed(0)}%)...`, 'i');
      link.click();
      await wait(2500);

      const jacket = extractJacket();
      const initDt = parseAnyDate(jacket.caseInitiationDate);
      const cap = jacket.caseCaption || '';

      const defSim2 = Math.max(cand.score, dice(defName, cap));
      const plSim2 = dice(plaintiff, cap);
      const dScore = dateScore(csvDate, initDt);

      const finalScore = (0.55 * defSim2) + (0.25 * plSim2) + (0.20 * dScore);

      log(`    → Score: ${(finalScore * 100).toFixed(0)}%`, 'i');

      if (!best || finalScore > best.finalScore) {
        best = { finalScore, jacket };
      }

      await clickBack();
      await wait(1000);
    }

    if (!best) return { notFound: true, reason: 'Could not evaluate any results' };
    return { notFound: false, best };
  }

  // ─────────────────────────────────────────────────────────────
  // Main
  // ─────────────────────────────────────────────────────────────
  log('📡 Fetching cases from server...', 's');

  let cases = [];
  try {
    const r = await fetch(`${SERVER}/api/camden?sortBy=daysSinceFiling&sortOrder=desc`, {
      headers: { 'X-Auth-Token': TOKEN }
    });
    const data = await r.json();
    cases = (data.cases || []);
  } catch (e) {
    log(`❌ Could not fetch cases: ${e.message}`, 'err');
    return;
  }

  cases = cases.filter(c => {
    const cs = c.courtStatus || '';
    return !cs || cs === 'NOT_FOUND' || cs === 'ERROR';
  });

  if (TEST_MODE) cases = cases.slice(0, 10);

  S.total = cases.length;
  upd();
  log(`✅ Loaded ${cases.length} cases to check`, 'ok');

  if (cases.length === 0) {
    log('ℹ️ No cases need checking', 'i');
    return;
  }

  // Initial setup - switch to Party Name tab
  const initialTab = await switchToPartyNameTab();
  if (!initialTab) {
    log('❌ Could not switch to Party Name tab. Please click it manually and re-run.', 'err');
    return;
  }

  for (let i = 0; i < cases.length; i++) {
    if (window._cscStop) { log('⏹ Stopped by user', 'w'); break; }

    const c = cases[i];
    const instr = getInstrument(c);
    const defName = getDefendant(c);

    log(`\n🔎 [${i + 1}/${cases.length}] ${instr}`, 's');
    log(`  Defendant: ${defName}`, 'i');

    const parsed = parseDef(defName);
    if (!parsed || !parsed.last) {
      S.e++; S.done++; upd();
      log('  ❌ Could not parse defendant name', 'err');
      await save(instr, {
        courtStatus: 'ERROR',
        courtStatusNote: 'Could not parse defendant name'
      });
      continue;
    }

    const searchResult = await doSearch(parsed.last, parsed.first, parsed.mid);

    if (!searchResult.success) {
      S.e++; S.done++; upd();
      log(`  ❌ Search error: ${searchResult.error}`, 'err');
      await save(instr, {
        courtStatus: 'ERROR',
        courtStatusNote: searchResult.error
      });
      // Reload page to reset
      log('  🔄 Reloading page to reset...', 'i');
      window.location.reload();
      await wait(5000);
      continue;
    }

    if (!searchResult.table) {
      S.n++; S.done++; upd();
      log('  ❌ No matching cases found', 'w');
      await save(instr, {
        courtStatus: 'NOT_FOUND',
        courtStatusNote: 'No cases found for this defendant name'
      });
      continue;
    }

    const match = await chooseBestMatch(searchResult.table, c);

    if (match.notFound) {
      S.n++; S.done++; upd();
      log(`  ❌ No good match: ${match.reason}`, 'w');
      await save(instr, {
        courtStatus: 'NOT_FOUND',
        courtStatusNote: match.reason
      });
      continue;
    }

    const j = match.best.jacket;
    const cls = classify(j.caseStatus, j.caseDisposition);

    if (cls.normalized === 'OPEN') S.o++;
    else if (cls.normalized === 'CLOSED') S.c++;
    else S.n++;

    S.done++; upd();

    log(`  ✅ ${cls.normalized}: "${j.caseStatus}" / "${j.caseDisposition}"`, 'ok');

    await save(instr, {
      courtStatus: cls.normalized,
      courtStatusRaw: j.caseStatus || '',
      courtDisposition: j.caseDisposition || '',
      courtCaseType: j.caseType || '',
      courtCaseCaption: j.caseCaption || '',
      courtFiledDate: j.caseInitiationDate || '',
      courtDispositionDate: j.dispositionDate || '',
      courtDocketNumber: j.docketNumber || '',
      courtMatchScore: match.best.finalScore || null,
      courtStatusNote: `Matched with score ${(match.best.finalScore * 100).toFixed(0)}%`
    });

    await wait(DELAY);
  }

  log('\n🎉 Done!', 'ok');
})();
