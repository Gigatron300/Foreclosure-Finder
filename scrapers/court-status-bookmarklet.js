(async function () {
  'use strict';

  const SERVER = '__SERVER_URL__';
  const TOKEN = '__AUTH_TOKEN__';
  const TEST_MODE = __TEST_MODE__;

  const STORAGE_KEY = 'csc_state_v7';

  // ─────────────────────────────────────────────────────────────
  // State Management - survives page reloads
  // ─────────────────────────────────────────────────────────────
  function getState() {
    try {
      const s = localStorage.getItem(STORAGE_KEY);
      return s ? JSON.parse(s) : null;
    } catch { return null; }
  }

  function setState(state) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function clearState() {
    localStorage.removeItem(STORAGE_KEY);
  }

  // ─────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
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
    if (mdy) return new Date(+mdy[3], +mdy[1] - 1, +mdy[2]);
    return new Date(s);
  }

  function dateScore(csvDate, siteDate) {
    if (!csvDate || !siteDate) return 0.10;
    const d = Math.round(Math.abs(csvDate.getTime() - siteDate.getTime()) / (1000 * 60 * 60 * 24));
    return 1 - Math.min(d, 180) / 180;
  }

  function classify(caseStatusRaw, caseDispositionRaw) {
    const combined = `${caseStatusRaw || ''} ${caseDispositionRaw || ''}`.toUpperCase();
    if (/(DISMISSED|DISPOSED|SETTLED|TERMINATED|CLOSED|WITH PREJUDICE|WITHOUT PREJUDICE|FINAL JUDGMENT|JUDGMENT|VACATED)/.test(combined)) {
      return 'CLOSED';
    }
    if (/(OPEN|ACTIVE|PENDING|DEFAULTED|IN PROGRESS|UNRESOLVED)/.test(combined)) {
      return 'OPEN';
    }
    return 'UNKNOWN';
  }

  function parseDef(name) {
    const s = cleanText(name);
    if (!s) return null;
    const cleaned = s.replace(/\bET AL\b/g, '').replace(/\bHIS WIFE\b|\bHER HUSBAND\b/g, '').replace(/\s+/g, ' ').trim();
    if (!cleaned) return null;

    if (/\b(LLC|INC|CORP|CORPORATION|CO|COMPANY|BANK|TRUST|AGENCY|AUTHORITY|MORTGAGE|FINANCE|ASSOCIATION|ASSN|HOUSING|SERVICING|SERVICES)\b/.test(cleaned)) {
      return { last: cleaned, first: '', mid: '' };
    }
    if (cleaned.includes(',')) {
      const [lastPart, rest] = cleaned.split(',', 2);
      const restParts = (rest || '').trim().split(' ').filter(Boolean);
      return { last: lastPart.trim(), first: restParts[0] || '', mid: restParts[1] || '' };
    }
    const parts = cleaned.split(' ').filter(Boolean);
    if (parts.length === 1) return { last: parts[0], first: '', mid: '' };
    return { last: parts[0], first: parts[1] || '', mid: parts[2] || '' };
  }

  async function saveToServer(instrumentNumber, courtData) {
    try {
      await fetch(`${SERVER}/api/camden/court-status-update`, {
        method: 'POST',
        headers: { 'X-Auth-Token': TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ instrumentNumber, courtData })
      });
    } catch {}
  }

  // ─────────────────────────────────────────────────────────────
  // Human-like typing
  // ─────────────────────────────────────────────────────────────
  async function humanType(fieldId, text) {
    const field = document.getElementById(fieldId);
    if (!field) return false;

    field.focus();
    field.value = '';

    for (const char of text) {
      field.value += char;
      field.dispatchEvent(new KeyboardEvent('keydown', { key: char, bubbles: true }));
      field.dispatchEvent(new KeyboardEvent('keypress', { key: char, bubbles: true }));
      field.dispatchEvent(new InputEvent('input', { bubbles: true, data: char, inputType: 'insertText' }));
      field.dispatchEvent(new KeyboardEvent('keyup', { key: char, bubbles: true }));
      await wait(50 + Math.random() * 30);
    }

    field.dispatchEvent(new Event('change', { bubbles: true }));
    field.dispatchEvent(new Event('blur', { bubbles: true }));
    return true;
  }

  function humanClick(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x, clientY: y }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: x, clientY: y }));
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x, clientY: y }));
    return true;
  }

  // ─────────────────────────────────────────────────────────────
  // Page Detection
  // ─────────────────────────────────────────────────────────────
  function getCurrentPage() {
    const url = window.location.href.toLowerCase();
    const bodyText = document.body.innerText || '';

    // Check for search form (Party Name tab visible)
    if (document.getElementById('searchByPartyNameForm:partyLName')) {
      // Check if we have results table
      const tables = document.querySelectorAll('table');
      for (const t of tables) {
        const txt = (t.innerText || '').toUpperCase();
        if (txt.includes('DOCKET NUMBER') && txt.includes('CASE CAPTION')) {
          return 'RESULTS';
        }
      }
      return 'SEARCH';
    }

    // Check for case jacket page
    if (bodyText.includes('Case Status:') && bodyText.includes('Case Disposition:') && bodyText.includes('Docket Number:')) {
      return 'JACKET';
    }

    return 'UNKNOWN';
  }

  // ─────────────────────────────────────────────────────────────
  // Extract jacket data from current page
  // ─────────────────────────────────────────────────────────────
  function extractJacket() {
    const text = document.body.innerText || '';
    const pick = (re) => {
      const m = text.match(re);
      return m ? (m[1] || '').trim() : '';
    };
    return {
      caseStatus: pick(/Case Status:\s*([^\t\n\r]+)/i),
      caseDisposition: pick(/Case Disposition:\s*([^\t\n\r]+)/i),
      caseCaption: pick(/Case Caption:\s*([^\t\n\r]+)/i),
      caseType: pick(/Case Type:\s*([^\t\n\r]+)/i),
      caseInitiationDate: pick(/Case Initiation Date:\s*(\d{1,2}\/\d{1,2}\/\d{4})/i),
      docketNumber: pick(/Docket Number:\s*([^\t\n\r]+)/i)
    };
  }

  // ─────────────────────────────────────────────────────────────
  // UI Panel
  // ─────────────────────────────────────────────────────────────
  function showPanel(state) {
    if (document.getElementById('csc-panel')) document.getElementById('csc-panel').remove();

    const panel = document.createElement('div');
    panel.id = 'csc-panel';
    panel.innerHTML = `
      <style>
        #csc-panel { position:fixed;top:8px;right:8px;width:360px;z-index:99999;background:#0f172a;color:#e2e8f0;border-radius:10px;padding:14px;font-family:system-ui,sans-serif;font-size:12px;box-shadow:0 4px 24px rgba(0,0,0,.6);border:1px solid #334155; }
        #csc-panel h3{margin:0 0 6px;color:#38bdf8;font-size:14px}
        #csc-bar{height:5px;background:#1e293b;border-radius:3px;margin:6px 0;overflow:hidden}
        #csc-fill{height:100%;background:linear-gradient(90deg,#38bdf8,#818cf8);border-radius:3px;transition:width .3s}
        #csc-stats{display:flex;gap:10px;color:#94a3b8;margin:4px 0}
        #csc-stats b.g{color:#4ade80} #csc-stats b.r{color:#f87171} #csc-stats b.y{color:#fbbf24}
        #csc-info{background:#0a0f1a;border-radius:6px;padding:8px;margin-top:6px;font-family:monospace;font-size:11px;max-height:150px;overflow-y:auto}
        #csc-btns{margin-top:8px;display:flex;gap:6px}
        #csc-btns button{border:none;padding:6px 12px;border-radius:4px;font-size:11px;font-weight:600;cursor:pointer}
        .csc-stop{background:#f87171;color:#fff}.csc-done{background:#334155;color:#94a3b8}
      </style>
      <h3>⚖️ Court Status Checker</h3>
      <div id="csc-status">Processing...</div>
      <div id="csc-bar"><div id="csc-fill" style="width:${Math.round((state.done / state.total) * 100)}%"></div></div>
      <div id="csc-stats">
        🟢<b class="g">${state.open}</b> 
        🔴<b class="r">${state.closed}</b> 
        ❌<b class="y">${state.notFound}</b>
        ⚠<b>${state.errors}</b>
        | ${state.done}/${state.total}
      </div>
      <div id="csc-info">
        <div>Current: ${state.currentCase?.instrumentNumber || 'N/A'}</div>
        <div>Step: ${state.step}</div>
        <div>Defendant: ${state.currentCase?.defendant || 'N/A'}</div>
      </div>
      <div id="csc-btns">
        <button class="csc-stop" onclick="localStorage.removeItem('${STORAGE_KEY}');location.reload();">⏹ Stop & Clear</button>
      </div>
    `;
    document.body.appendChild(panel);
  }

  // ─────────────────────────────────────────────────────────────
  // Main State Machine
  // ─────────────────────────────────────────────────────────────
  let state = getState();
  const page = getCurrentPage();

  console.log('[CSC] Page:', page, 'State:', state?.step);

  // FRESH START - no state, user just ran the bookmarklet
  if (!state) {
    console.log('[CSC] Fresh start - fetching cases...');

    // Fetch cases from server
    let cases = [];
    try {
      const r = await fetch(`${SERVER}/api/camden?sortBy=daysSinceFiling&sortOrder=desc`, {
        headers: { 'X-Auth-Token': TOKEN }
      });
      const data = await r.json();
      cases = (data.cases || []).filter(c => {
        const cs = c.courtStatus || '';
        return !cs || cs === 'NOT_FOUND' || cs === 'ERROR';
      });
    } catch (e) {
      alert('Could not fetch cases: ' + e.message);
      return;
    }

    if (TEST_MODE) cases = cases.slice(0, 10);

    if (!cases.length) {
      alert('No cases need checking!');
      return;
    }

    // Initialize state
    state = {
      cases: cases.map(c => ({
        instrumentNumber: c.instrumentNumber,
        defendant: c.primaryDefendant,
        plaintiff: c.primaryPlaintiff,
        filingDate: c.filingDateISO || c.filingDate
      })),
      currentIndex: 0,
      currentCase: null,
      step: 'START',
      total: cases.length,
      done: 0,
      open: 0,
      closed: 0,
      notFound: 0,
      errors: 0,
      resultsRows: [],
      currentRowIndex: 0,
      bestMatch: null
    };

    state.currentCase = state.cases[0];
    state.step = 'NEED_SEARCH';
    setState(state);
  }

  showPanel(state);

  // ─────────────────────────────────────────────────────────────
  // State Machine Logic
  // ─────────────────────────────────────────────────────────────

  // STEP: Need to perform a search
  if (state.step === 'NEED_SEARCH') {
    if (page !== 'SEARCH' && page !== 'RESULTS') {
      document.getElementById('csc-status').textContent = '❌ Navigate to Search page first!';
      return;
    }

    const c = state.currentCase;
    const parsed = parseDef(c.defendant);

    if (!parsed || !parsed.last) {
      // Can't parse - mark as error and move on
      await saveToServer(c.instrumentNumber, { courtStatus: 'ERROR', courtStatusNote: 'Could not parse name' });
      state.errors++;
      state.done++;
      state.currentIndex++;
      if (state.currentIndex < state.cases.length) {
        state.currentCase = state.cases[state.currentIndex];
        state.step = 'NEED_SEARCH';
      } else {
        state.step = 'DONE';
      }
      setState(state);
      location.reload();
      return;
    }

    document.getElementById('csc-status').textContent = `Searching: ${parsed.last}, ${parsed.first}...`;

    // Clear and type
    const lastField = document.getElementById('searchByPartyNameForm:partyLName');
    const firstField = document.getElementById('searchByPartyNameForm:partyFName');
    const midField = document.getElementById('searchByPartyNameForm:partyMName');

    if (lastField) { lastField.value = ''; }
    if (firstField) { firstField.value = ''; }
    if (midField) { midField.value = ''; }

    await humanType('searchByPartyNameForm:partyLName', parsed.last);
    if (parsed.first) await humanType('searchByPartyNameForm:partyFName', parsed.first);
    if (parsed.mid) await humanType('searchByPartyNameForm:partyMName', parsed.mid);

    await wait(300);

    // Update state BEFORE clicking (page will reload)
    state.step = 'WAITING_RESULTS';
    setState(state);

    // Click search
    const searchBtn = document.getElementById('searchByPartyNameForm:btnPartyNameSearch');
    humanClick(searchBtn);
    return; // Page will reload
  }

  // STEP: Waiting for results (page just reloaded after search)
  if (state.step === 'WAITING_RESULTS') {
    if (page === 'RESULTS') {
      // Got results! Find rows and score them
      const table = Array.from(document.querySelectorAll('table')).find(t => 
        t.innerText.toUpperCase().includes('DOCKET NUMBER') && t.innerText.toUpperCase().includes('CASE CAPTION')
      );

      if (table) {
        const rows = Array.from(table.querySelectorAll('tbody tr, tr')).filter(r => r.querySelectorAll('td').length > 0);
        
        if (rows.length > 0) {
          // Score rows
          const c = state.currentCase;
          const scored = rows.map((row, idx) => {
            const txt = cleanText(row.innerText);
            const links = Array.from(row.querySelectorAll('a')).filter(a => a.href);
            const defSim = dice(c.defendant, txt);
            const plSim = dice(c.plaintiff, txt);
            return { idx, href: links[0]?.href, score: (0.65 * defSim) + (0.35 * plSim), text: txt.substring(0, 100) };
          }).filter(r => r.href).sort((a, b) => b.score - a.score);

          state.resultsRows = scored.slice(0, 5); // Top 5
          state.currentRowIndex = 0;
          state.bestMatch = null;
          state.step = 'CHECK_ROW';
          setState(state);

          // Click first row
          const firstHref = state.resultsRows[0]?.href;
          if (firstHref) {
            document.getElementById('csc-status').textContent = `Opening result 1/${state.resultsRows.length}...`;
            await wait(500);
            window.location.href = firstHref;
            return;
          }
        }
      }

      // No results found
      await saveToServer(state.currentCase.instrumentNumber, { courtStatus: 'NOT_FOUND', courtStatusNote: 'No cases in search results' });
      state.notFound++;
      state.done++;
      state.currentIndex++;
      if (state.currentIndex < state.cases.length) {
        state.currentCase = state.cases[state.currentIndex];
        state.step = 'NEED_SEARCH';
      } else {
        state.step = 'DONE';
      }
      setState(state);
      location.reload();
      return;
    }

    // Check for no results message or still on search page
    const bodyText = document.body.innerText.toLowerCase();
    if (bodyText.includes('no cases found') || bodyText.includes('returned 0')) {
      await saveToServer(state.currentCase.instrumentNumber, { courtStatus: 'NOT_FOUND', courtStatusNote: 'No cases found' });
      state.notFound++;
      state.done++;
      state.currentIndex++;
      if (state.currentIndex < state.cases.length) {
        state.currentCase = state.cases[state.currentIndex];
        state.step = 'NEED_SEARCH';
      } else {
        state.step = 'DONE';
      }
      setState(state);
      location.reload();
      return;
    }
  }

  // STEP: Check a result row (we're on the jacket page)
  if (state.step === 'CHECK_ROW') {
    if (page === 'JACKET') {
      const jacket = extractJacket();
      const c = state.currentCase;
      const csvDate = parseAnyDate(c.filingDate);
      const initDt = parseAnyDate(jacket.caseInitiationDate);

      const defSim = dice(c.defendant, jacket.caseCaption || '');
      const plSim = dice(c.plaintiff, jacket.caseCaption || '');
      const dScore = dateScore(csvDate, initDt);
      const finalScore = (0.55 * defSim) + (0.25 * plSim) + (0.20 * dScore);

      console.log('[CSC] Jacket score:', finalScore, jacket);

      if (!state.bestMatch || finalScore > state.bestMatch.score) {
        state.bestMatch = { score: finalScore, jacket };
      }

      // Move to next row or finish
      state.currentRowIndex++;
      if (state.currentRowIndex < state.resultsRows.length) {
        state.step = 'GO_BACK_FOR_NEXT';
        setState(state);
        // Go back to results
        window.history.back();
        return;
      } else {
        // Done checking rows - save best match
        state.step = 'SAVE_BEST';
        setState(state);
        // Small delay then process
        await wait(100);
      }
    }
  }

  // STEP: Go back to results to check next row
  if (state.step === 'GO_BACK_FOR_NEXT') {
    if (page === 'RESULTS') {
      const nextHref = state.resultsRows[state.currentRowIndex]?.href;
      if (nextHref) {
        state.step = 'CHECK_ROW';
        setState(state);
        document.getElementById('csc-status').textContent = `Opening result ${state.currentRowIndex + 1}/${state.resultsRows.length}...`;
        await wait(500);
        window.location.href = nextHref;
        return;
      }
    }
    // If we're not on results yet, wait for back to complete
    await wait(1000);
    location.reload();
    return;
  }

  // STEP: Save the best match and move to next case
  if (state.step === 'SAVE_BEST') {
    const c = state.currentCase;
    
    if (state.bestMatch && state.bestMatch.score > 0.3) {
      const j = state.bestMatch.jacket;
      const status = classify(j.caseStatus, j.caseDisposition);

      await saveToServer(c.instrumentNumber, {
        courtStatus: status,
        courtStatusRaw: j.caseStatus || '',
        courtDisposition: j.caseDisposition || '',
        courtCaseType: j.caseType || '',
        courtCaseCaption: j.caseCaption || '',
        courtFiledDate: j.caseInitiationDate || '',
        courtDocketNumber: j.docketNumber || '',
        courtMatchScore: state.bestMatch.score,
        courtStatusNote: `Matched ${(state.bestMatch.score * 100).toFixed(0)}%`
      });

      if (status === 'OPEN') state.open++;
      else if (status === 'CLOSED') state.closed++;
      else state.notFound++;
    } else {
      await saveToServer(c.instrumentNumber, { courtStatus: 'NOT_FOUND', courtStatusNote: 'No confident match' });
      state.notFound++;
    }

    state.done++;
    state.currentIndex++;

    if (state.currentIndex < state.cases.length) {
      state.currentCase = state.cases[state.currentIndex];
      state.resultsRows = [];
      state.currentRowIndex = 0;
      state.bestMatch = null;
      state.step = 'NEED_SEARCH';
      setState(state);
      
      // Navigate back to search page
      const searchUrl = 'https://portal.njcourts.gov/webcivilcj/CIVILCaseJacketWeb/pages/civilCaseSearch.faces';
      window.location.href = searchUrl;
    } else {
      state.step = 'DONE';
      setState(state);
      location.reload();
    }
    return;
  }

  // STEP: All done!
  if (state.step === 'DONE') {
    document.getElementById('csc-status').textContent = '🎉 All done!';
    document.getElementById('csc-info').innerHTML = `
      <div>✅ Completed ${state.total} cases</div>
      <div>🟢 Open: ${state.open}</div>
      <div>🔴 Closed: ${state.closed}</div>
      <div>❌ Not Found: ${state.notFound}</div>
      <div>⚠️ Errors: ${state.errors}</div>
    `;
    clearState();
  }

})();
