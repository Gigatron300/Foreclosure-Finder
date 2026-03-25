// NJ Courts Case Status Checker - Bookmarklet v2
// 
// KEY INSIGHT: Incapsula blocks JS .click() on the Search button, but allows:
//   - Setting form field values via JS ✅
//   - Clicking docket number links via JS ✅  
//   - Clicking Back button via JS ✅
//   - Reading page data via JS ✅
// So we automate EVERYTHING except Search button clicks (user must click those).
//
// FLOW PER CASE:
//   1. Script fills name fields → shows big "CLICK SEARCH" prompt
//   2. User clicks Search → page reloads with results
//   3. Script reads results, finds best match, clicks docket link automatically
//   4. Script reads case status/disposition from jacket page
//   5. Script saves result to server, clicks Back, fills next name → goto 1
//
// STATE MACHINE (persisted in sessionStorage across page reloads):
//   FILL_AND_WAIT  → Fields filled, waiting for user to click Search
//   READ_RESULTS   → Results page loaded, find match and click docket
//   READ_JACKET    → Case jacket loaded, extract status
//   DONE           → All cases processed

(async function() {
  'use strict';

  const SERVER = '__SERVER_URL__';
  const TOKEN  = '__AUTH_TOKEN__';
  const TEST   = __TEST_MODE__;
  const RUN_MODE = __RUN_MODE__;
  const RESUME_MODE = __RESUME_MODE__;
  const STORAGE_KEY = 'csc_state_v2';
  const SEARCH_WINDOW_DAYS = 90;

  // ── Helpers ──────────────────────────────────────────────────
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const getState = () => {
    try { return JSON.parse(sessionStorage.getItem(STORAGE_KEY)); } catch { return null; }
  };
  const setState = s => sessionStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  const clearState = () => sessionStorage.removeItem(STORAGE_KEY);

  // ── Name parser ──────────────────────────────────────────────
  function parseName(full) {
    if (!full) return null;
    let n = full.toUpperCase().trim()
      .replace(/\b(JR|SR|II|III|IV|ESQ|MD|PHD)\b\.?/g, '').trim()
      .replace(/\s+/g, ' ');
    const p = n.split(' ').filter(x => x);
    if (!p.length) return null;
    // CSV format is "LAST FIRST MIDDLE" (defendants from Camden Clerk)
    return {
      last: p[0] || '',
      first: (p[1] || '').slice(0, 9),
      mid: p[2] || ''
    };
  }

  // ── Plaintiff keyword for matching ───────────────────────────
  function plaintiffKeyword(name) {
    if (!name) return '';
    const upper = name.toUpperCase().trim();
    // Strip common entity suffixes to get the core name
    const cleaned = upper.replace(/\b(LLC|INC|CORP|N\.?A\.?|BANK|MORTGAGE|SERVICING|TRUST|LP|L\.P\.|CO|COMPANY)\b/g, '').trim();
    const parts = cleaned.split(/\s+/).filter(p => p.length > 2);
    return parts[0] || upper.split(/\s+/)[0] || '';
  }

  // ── Date proximity scorer ────────────────────────────────────
  function dateDistanceDays(csvDate, courtDate) {
    if (!csvDate || !courtDate) return null;
    try {
      const parse = d => {
        // Handle both MM/DD/YYYY and YYYY-MM-DD
        let m = d.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
        if (m) return new Date(+m[3], +m[1]-1, +m[2]);
        m = d.match(/(\d{4})-(\d{2})-(\d{2})/);
        if (m) return new Date(+m[1], +m[2]-1, +m[3]);
        return null;
      };
      const d1 = parse(csvDate), d2 = parse(courtDate);
      if (!d1 || !d2) return null;
      return Math.abs(d1 - d2) / 86400000;
    } catch { return null; }
  }

  function dateProximity(csvDate, courtDate) {
    const days = dateDistanceDays(csvDate, courtDate);
    if (days == null) return 0;
    if (days <= 30) return 1.0;
    if (days <= SEARCH_WINDOW_DAYS) return 0.7;
    if (days <= 180) return 0.4;
    if (days <= 365) return 0.2;
    return 0;
  }

  function isWithinDateWindow(csvDate, courtDate) {
    const days = dateDistanceDays(csvDate, courtDate);
    return days != null && days <= SEARCH_WINDOW_DAYS;
  }

  // ── Find best match from results table ───────────────────────
  function findBestMatch(rows, plaintiffName, csvDate) {
    const pKey = plaintiffKeyword(plaintiffName).toUpperCase();
    let best = null, bestScore = 0;

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      let score = 0;

      // Venue = CAMDEN is a strong signal
      if ((r.venue || '').toUpperCase().includes('CAMDEN')) score += 3;

      // Plaintiff name appears in case caption
      if (pKey && (r.caption || '').toUpperCase().includes(pKey)) score += 2;

      // Only rows within the configured filing-date window are eligible.
      if (!isWithinDateWindow(csvDate, r.date)) continue;

      // Date proximity
      score += dateProximity(csvDate, r.date) * 2;

      // Foreclosure docket (F-) preferred
      if ((r.docket || '').startsWith('F-')) score += 1;

      if (score > bestScore) {
        bestScore = score;
        best = { ...r, rowIndex: i, matchScore: score };
      }
    }

    // Require minimum score of 3 for confidence
    return bestScore >= 3 ? best : null;
  }

  // ── Classify status ──────────────────────────────────────────
  function classify(status, disposition) {
    const combined = ((status || '') + ' ' + (disposition || '')).toUpperCase();
    if (/CLOSED|DISMISSED|DISPOSED|RESOLVED|SETTLED|TERMINATED/.test(combined)) return 'CLOSED';
    if (/OPEN|ACTIVE|PENDING|DEFAULTED|STAY|STAYED/.test(combined)) return 'OPEN';
    return 'UNKNOWN';
  }

  function buildStatusNote(reason, extra = '') {
    const parts = [reason];
    if (extra) parts.push(extra);
    return parts.join(' | ');
  }

  // ── Save result to server ────────────────────────────────────
  async function saveToServer(instrumentNumber, courtData) {
    try {
      await fetch(SERVER + '/api/camden/court-status-update', {
        method: 'POST',
        headers: { 'X-Auth-Token': TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ instrumentNumber, courtData })
      });
    } catch (e) { console.error('Save failed:', e); }
  }

  async function advanceRefreshBatch(instrumentNumber, status) {
    if (RUN_MODE !== 'refresh') return null;
    const currentState = getState();
    const batchId = currentState && currentState.batch ? currentState.batch.batchId : '';
    if (!batchId) return null;

    try {
      const resp = await fetch(SERVER + '/api/camden/court-status-refresh/advance', {
        method: 'POST',
        headers: { 'X-Auth-Token': TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ batchId, instrumentNumber, status })
      });
      if (!resp.ok) return null;
      const data = await resp.json();
      return data && data.batch ? data.batch : null;
    } catch (e) {
      console.error('Advance batch failed:', e);
      return null;
    }
  }

  async function saveAndAdvance(instrumentNumber, courtData, currentState) {
    await saveToServer(instrumentNumber, courtData);
    const batch = await advanceRefreshBatch(instrumentNumber, courtData && courtData.courtStatus ? courtData.courtStatus : '');
    if (batch && currentState) {
      currentState.batch = batch;
      setState(currentState);
    }
  }

  // ── Detect current page ──────────────────────────────────────
  function detectPage() {
    if (document.getElementById('searchByPartyNameForm:partyLName')) {
      // Check if results table exists
      const tables = document.querySelectorAll('table');
      for (const t of tables) {
        if ((t.innerText || '').includes('Docket Number') && (t.innerText || '').includes('Case Caption')) {
          return 'RESULTS';
        }
      }
      return 'SEARCH';
    }
    const body = document.body.innerText || '';
    if (body.includes('Case Status:') && body.includes('Docket Number:')) return 'JACKET';
    return 'UNKNOWN';
  }

  // ── Parse results table ──────────────────────────────────────
  function parseResultsTable() {
    const rows = [];
    const tables = document.querySelectorAll('table');
    for (const t of tables) {
      const header = (t.innerText || '').toUpperCase();
      if (!header.includes('DOCKET NUMBER') || !header.includes('CASE CAPTION')) continue;
      const trs = t.querySelectorAll('tbody tr');
      trs.forEach((tr, idx) => {
        const tds = tr.querySelectorAll('td');
        if (tds.length >= 5) {
          rows.push({
            name: (tds[0].textContent || '').trim(),
            venue: (tds[1].textContent || '').trim(),
            docket: (tds[2].textContent || '').trim(),
            caption: (tds[3].textContent || '').trim(),
            date: (tds[4].textContent || '').trim(),
            rowIndex: idx
          });
        }
      });
      break; // only first matching table
    }
    return rows;
  }

  // ── Extract case jacket data ─────────────────────────────────
  function extractJacket() {
    const text = document.body.innerText || '';
    const pick = re => { const m = text.match(re); return m ? (m[1] || '').trim() : ''; };
    return {
      caseStatus: pick(/Case Status:\s*([^\t\n\r]+)/i),
      caseDisposition: pick(/Case Disposition:\s*([^\t\n\r]+)/i),
      caseCaption: pick(/Case Caption:\s*([^\t\n\r]+)/i),
      caseType: pick(/Case Type:\s*([^\t\n\r]+)/i),
      caseInitDate: pick(/Case Initiation Date:\s*(\d{1,2}\/\d{1,2}\/\d{4})/i),
      docketNumber: pick(/Docket Number:\s*([^\t\n\r]+)/i),
      dispositionDate: pick(/Disposition Date:\s*(\d{1,2}\/\d{1,2}\/\d{4})/i)
    };
  }

  function uniqueNames(names) {
    return Array.from(new Set((names || []).map(name => (name || '').trim()).filter(Boolean)));
  }

  function getSearchNames(c) {
    return uniqueNames([
      ...(Array.isArray(c && c.searchNames) ? c.searchNames : []),
      ...(Array.isArray(c && c.allDefendants) ? c.allDefendants : []),
      c && c.defendant ? c.defendant : ''
    ]);
  }

  function ensureCaseSearchState(state) {
    const c = state && state.cases ? state.cases[state.currentIndex] : null;
    if (!c) return [];
    const names = getSearchNames(c);
    c.searchNames = names;
    if (typeof state.nameIndex !== 'number' || state.nameIndex < 0) state.nameIndex = 0;
    if (!Array.isArray(state.nameAttempts)) state.nameAttempts = [];
    return names;
  }

  function getCurrentSearchName(state) {
    const c = state && state.cases ? state.cases[state.currentIndex] : null;
    const names = ensureCaseSearchState(state);
    return names[state.nameIndex] || (c ? c.defendant : '') || '';
  }

  function recordAttempt(state, reason) {
    const name = getCurrentSearchName(state);
    if (!name) return;
    if (!Array.isArray(state.nameAttempts)) state.nameAttempts = [];
    state.nameAttempts.push({ name, reason });
  }

  function moveToNextSearchName(state, reason) {
    const names = ensureCaseSearchState(state);
    recordAttempt(state, reason);
    state.nameIndex += 1;
    state.lastMatch = null;
    return state.nameIndex < names.length;
  }

  function summarizeAttempts(state) {
    return (state.nameAttempts || [])
      .map(a => `${a.name}: ${a.reason}`)
      .join(' ; ')
      .slice(0, 500);
  }

  function resetCaseSearchState(state) {
    state.nameIndex = 0;
    state.nameAttempts = [];
    state.lastMatch = null;
  }

  async function finalizeCaseAndMoveNext(state, update, counterKey) {
    const c = state.cases[state.currentIndex];
    await saveAndAdvance(c.instrumentNumber, update, state);
    if (counterKey === 'open') state.open++;
    else if (counterKey === 'closed') state.closed++;
    else if (counterKey === 'notFound') state.notFound++;
    else if (counterKey === 'errors') state.errors++;
    state.done++;
    state.currentIndex++;
    resetCaseSearchState(state);
  }

  async function finalizeExhaustedSearch(state, fallbackReason) {
    const details = summarizeAttempts(state) || fallbackReason;
    await finalizeCaseAndMoveNext(state, {
      courtStatus: 'RECHECK',
      courtStatusNote: buildStatusNote('RECHECK_REASON:ALL_NAMES_EXHAUSTED', details)
    }, 'notFound');
  }

  async function handleDateMismatch(state, filingDate, courtDate, dayDiff) {
    const reason = `filing=${filingDate} court=${courtDate} diffDays=${Math.round(dayDiff)}`;
    if (moveToNextSearchName(state, `date mismatch ${reason}`)) {
      state.step = 'FILL_AND_WAIT';
      setState(state);
      showPanel(state);
      setStatus(`Date mismatch for current name, trying next receiving party...`);
      await wait(500);
      window.location.href = 'https://portal.njcourts.gov/webcivilcj/CIVILCaseJacketWeb/pages/civilCaseSearch.faces';
      return true;
    }

    await finalizeExhaustedSearch(state, reason);
    if (state.currentIndex < state.cases.length) {
      state.step = 'FILL_AND_WAIT';
      setState(state);
      showPanel(state);
      await wait(500);
      window.location.href = 'https://portal.njcourts.gov/webcivilcj/CIVILCaseJacketWeb/pages/civilCaseSearch.faces';
    } else {
      state.step = 'DONE';
      setState(state);
      showPanel(state);
      setStatus('🎉 All done!');
      clearState();
    }
    return true;
  }

  // ── UI Panel ─────────────────────────────────────────────────
  function showPanel(state) {
    let panel = document.getElementById('csc-panel');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'csc-panel';
      document.body.appendChild(panel);
    }
    const pct = state.total > 0 ? Math.round((state.done / state.total) * 100) : 0;
    const current = state.cases[state.currentIndex];
    const nameDisplay = current ? getCurrentSearchName(state) : '—';
    
    panel.innerHTML = `
      <style>
        #csc-panel { position:fixed;top:10px;right:10px;width:380px;z-index:99999;
          background:#0f172a;color:#e2e8f0;border-radius:12px;padding:16px;
          font-family:system-ui,sans-serif;font-size:13px;
          box-shadow:0 8px 32px rgba(0,0,0,.7);border:1px solid #334155; }
        #csc-panel h3 { margin:0 0 8px;color:#38bdf8;font-size:15px; }
        .csc-bar { height:6px;background:#1e293b;border-radius:3px;margin:8px 0;overflow:hidden; }
        .csc-fill { height:100%;background:linear-gradient(90deg,#38bdf8,#818cf8);border-radius:3px;
          transition:width .3s; }
        .csc-stats { display:flex;gap:12px;margin:8px 0;font-size:12px; }
        .csc-stat { text-align:center; }
        .csc-stat b { display:block;font-size:16px; }
        .csc-name { color:#94a3b8;font-size:12px;margin:4px 0; }
        .csc-status { margin:8px 0;padding:8px;background:#1e293b;border-radius:6px;font-size:12px; }
        .csc-stop { margin-top:8px;background:#ef4444;color:#fff;border:none;padding:6px 14px;
          border-radius:6px;cursor:pointer;font-size:12px;font-weight:600; }
        .csc-stop:hover { background:#dc2626; }
      </style>
      <h3>⚖️ Court Status Checker</h3>
      <div class="csc-bar"><div class="csc-fill" style="width:${pct}%"></div></div>
      <div class="csc-stats">
        <div class="csc-stat"><b>${state.done}</b>of ${state.total}</div>
        <div class="csc-stat" style="color:#4ade80"><b>${state.open}</b>Open</div>
        <div class="csc-stat" style="color:#f87171"><b>${state.closed}</b>Closed</div>
        <div class="csc-stat" style="color:#fbbf24"><b>${state.notFound}</b>N/F</div>
        <div class="csc-stat" style="color:#fb923c"><b>${state.errors}</b>Err</div>
      </div>
      <div class="csc-name">Current: <b>${nameDisplay}</b></div>
      <div class="csc-status" id="csc-status">Initializing...</div>
      <button class="csc-stop" onclick="sessionStorage.removeItem('${STORAGE_KEY}');location.reload();">⏹ Stop</button>
    `;
  }

  function setStatus(msg) {
    const el = document.getElementById('csc-status');
    if (el) el.innerHTML = msg;
  }

  // ══════════════════════════════════════════════════════════════
  // MAIN STATE MACHINE
  // ══════════════════════════════════════════════════════════════

  let state = getState();
  const page = detectPage();

  // ── First run: fetch cases from server ───────────────────────
  if (!state) {
    if (page !== 'SEARCH' && page !== 'RESULTS') {
      alert('Navigate to the NJ Courts "Search By Party Name" page first!');
      return;
    }

    showPanel({ done:0, total:0, open:0, closed:0, notFound:0, errors:0, cases:[], currentIndex:0 });
    setStatus('📡 Fetching cases from server...');

    let payload;
    try {
      let url = SERVER + '/api/camden/court-status-cases?token=' + TOKEN + (TEST ? '&test=true' : '');
      if (RUN_MODE === 'refresh') {
        url += '&mode=refresh&resume=' + (RESUME_MODE ? 'true' : 'false');
      }
      const resp = await fetch(url);
      payload = await resp.json();
    } catch (e) {
      setStatus('❌ Failed to fetch cases: ' + e.message);
      return;
    }

    const cases = Array.isArray(payload) ? payload : (payload && Array.isArray(payload.cases) ? payload.cases : []);
    const batch = payload && !Array.isArray(payload) ? payload.batch || null : null;

    if (!cases || !cases.length) {
      const msg = payload && payload.message ? payload.message : '✅ No cases need court status lookup.';
      setStatus(msg);
      return;
    }

    state = {
      cases: cases,
      batch,
      currentIndex: 0,
      nameIndex: 0,
      nameAttempts: [],
      step: 'FILL_AND_WAIT',
      done: 0, total: cases.length,
      open: 0, closed: 0, notFound: 0, errors: 0,
      lastResult: null
    };
    setState(state);
  }

  showPanel(state);

  // ── STEP: FILL_AND_WAIT ──────────────────────────────────────
  // Fill the search form and wait for user to click Search
  if (state.step === 'FILL_AND_WAIT') {
    if (page !== 'SEARCH' && page !== 'RESULTS') {
      setStatus('⚠️ Navigate to the Search page');
      return;
    }

    const c = state.cases[state.currentIndex];
    ensureCaseSearchState(state);
    const currentName = getCurrentSearchName(state);
    const parsed = parseName(currentName);

    if (!parsed || !parsed.last) {
      if (moveToNextSearchName(state, 'could not parse name')) {
        state.step = 'FILL_AND_WAIT';
      } else {
        await finalizeExhaustedSearch(state, 'all receiving-party names failed to parse');
        state.step = state.currentIndex < state.cases.length ? 'FILL_AND_WAIT' : 'DONE';
      }
      setState(state);
      showPanel(state);
      await wait(300);
      location.reload();
      return;
    }

    // Fill form fields
    const lastField = document.getElementById('searchByPartyNameForm:partyLName');
    const firstField = document.getElementById('searchByPartyNameForm:partyFName');
    const midField = document.getElementById('searchByPartyNameForm:partyMName');

    if (lastField) lastField.value = parsed.last;
    if (firstField) firstField.value = (parsed.first || '').slice(0, 9);
    if (midField) midField.value = parsed.mid;

    // Update state to expect results on next page load
    state.step = 'READ_RESULTS';
    setState(state);

    setStatus(`
      <div style="text-align:center">
        <div style="font-size:14px;margin-bottom:8px">
          Searching: <b>${parsed.last}, ${parsed.first}</b>
        </div>
        <div style="font-size:20px;padding:12px;background:#1d4ed8;border-radius:8px;color:#fff;font-weight:700;cursor:default;animation:pulse 1.5s infinite">
          👆 CLICK THE SEARCH BUTTON 👆
        </div>
        <style>@keyframes pulse{0%,100%{opacity:1}50%{opacity:.7}}</style>
      </div>
    `);
    return; // Wait for user to click Search
  }

  // ── STEP: READ_RESULTS ───────────────────────────────────────
  // Page reloaded after search - read results and click into match
  if (state.step === 'READ_RESULTS') {
    const c = state.cases[state.currentIndex];
    ensureCaseSearchState(state);
    const currentName = getCurrentSearchName(state);

    if (page === 'SEARCH') {
      // No results returned (search came back empty)
      setStatus(`No results found for ${currentName}`);
      if (moveToNextSearchName(state, 'no rows returned')) {
        state.step = 'FILL_AND_WAIT';
        setState(state);
        showPanel(state);
        await wait(500);
        location.reload();
        return;
      }

      await finalizeExhaustedSearch(state, 'no receiving-party searches returned results');
      await wait(500);

      if (state.currentIndex < state.cases.length) {
        state.step = 'FILL_AND_WAIT';
        setState(state);
        showPanel(state);
        await wait(500);
        location.reload();
      } else {
        state.step = 'DONE';
        setState(state);
        showPanel(state);
        setStatus('🎉 All done!');
        clearState();
      }
      return;
    }

    if (page === 'RESULTS') {
      const rows = parseResultsTable();
      setStatus(`Found ${rows.length} results, matching...`);
      await wait(500);

      const match = findBestMatch(rows, c.plaintiff, c.filingDate);

      if (!match) {
        const reason = `${rows.length} results scanned, none within ${SEARCH_WINDOW_DAYS} days`;
        if (moveToNextSearchName(state, reason)) {
          state.step = 'FILL_AND_WAIT';
          setState(state);
          window.location.href = 'https://portal.njcourts.gov/webcivilcj/CIVILCaseJacketWeb/pages/civilCaseSearch.faces';
          return;
        }

        await finalizeExhaustedSearch(state, reason);

        if (state.currentIndex < state.cases.length) {
          state.step = 'FILL_AND_WAIT';
          setState(state);
          // Navigate back to clean search
          window.location.href = 'https://portal.njcourts.gov/webcivilcj/CIVILCaseJacketWeb/pages/civilCaseSearch.faces';
        } else {
          state.step = 'DONE';
          setState(state);
          showPanel(state);
          setStatus('🎉 All done!');
          clearState();
        }
        return;
      }

      setStatus(`✅ Match: ${match.docket} (score: ${match.matchScore}) — opening jacket...`);
      state.step = 'READ_JACKET';
      state.lastMatch = match;
      setState(state);
      await wait(800);

      // Click the docket link — this works via JS!
      const table = document.querySelectorAll('table');
      let clicked = false;
      for (const t of table) {
        if (!(t.innerText || '').includes('Docket Number')) continue;
        const trs = t.querySelectorAll('tbody tr');
        if (trs[match.rowIndex]) {
          const link = trs[match.rowIndex].querySelector('td:nth-child(3) a');
          if (link) { link.click(); clicked = true; break; }
        }
      }

      if (!clicked) {
        // Fallback: try by link ID
        const linkId = 'searchByPartyNameForm:idPartyTable:' + match.rowIndex + ':lnkSrchByDocNum';
        const link = document.getElementById(linkId);
        if (link) { link.click(); clicked = true; }
      }

      if (!clicked) {
        // Couldn't click - mark error and move on
        await finalizeCaseAndMoveNext(state, { courtStatus: 'ERROR', courtStatusNote: 'Could not click docket link' }, 'errors');
        state.step = state.currentIndex < state.cases.length ? 'FILL_AND_WAIT' : 'DONE';
        setState(state);
        window.location.href = 'https://portal.njcourts.gov/webcivilcj/CIVILCaseJacketWeb/pages/civilCaseSearch.faces';
      }
      return; // Page will navigate to jacket
    }

    // Unexpected page - try going back to search
    setStatus('⚠️ Unexpected page, resetting...');
    state.step = 'FILL_AND_WAIT';
    setState(state);
    window.location.href = 'https://portal.njcourts.gov/webcivilcj/CIVILCaseJacketWeb/pages/civilCaseSearch.faces';
    return;
  }

  // ── STEP: READ_JACKET ────────────────────────────────────────
  // Case jacket page loaded - extract status and save
  if (state.step === 'READ_JACKET') {
    if (page !== 'JACKET') {
      // Still loading or wrong page - wait and retry
      await wait(2000);
      if (detectPage() !== 'JACKET') {
        setStatus('⚠️ Jacket page not detected, retrying...');
        await wait(3000);
        if (detectPage() !== 'JACKET') {
          // Give up on this one
          const c = state.cases[state.currentIndex];
          await finalizeCaseAndMoveNext(state, { courtStatus: 'ERROR', courtStatusNote: 'Jacket page did not load' }, 'errors');
          state.step = state.currentIndex < state.cases.length ? 'FILL_AND_WAIT' : 'DONE';
          setState(state);
          window.location.href = 'https://portal.njcourts.gov/webcivilcj/CIVILCaseJacketWeb/pages/civilCaseSearch.faces';
          return;
        }
      }
    }

    const jacket = extractJacket();
    const c = state.cases[state.currentIndex];
    const status = classify(jacket.caseStatus, jacket.caseDisposition);
    const match = state.lastMatch || {};
    let dateMismatchDays = null;

    if (c.filingDate && jacket.caseInitDate) {
      const days = dateDistanceDays(c.filingDate, jacket.caseInitDate);
      if (days != null && days > SEARCH_WINDOW_DAYS) {
        dateMismatchDays = days;
      }
    }

    if (dateMismatchDays != null) {
      const handled = await handleDateMismatch(state, c.filingDate, jacket.caseInitDate, dateMismatchDays);
      if (handled) return;
    }

    setStatus(`${status === 'OPEN' ? '🟢' : status === 'CLOSED' ? '🔴' : '⚪'} ${jacket.docketNumber}: ${jacket.caseStatus} / ${jacket.caseDisposition}`);

    await finalizeCaseAndMoveNext(state, {
      courtStatus: status,
      courtStatusRaw: jacket.caseStatus,
      courtDisposition: jacket.caseDisposition,
      courtCaseType: jacket.caseType,
      courtCaseCaption: jacket.caseCaption,
      courtFiledDate: jacket.caseInitDate,
      courtDocketNumber: jacket.docketNumber,
      courtDispositionDate: jacket.dispositionDate,
      courtMatchScore: match.matchScore || 0,
      courtStatusNote: buildStatusNote('MATCHED', `${getCurrentSearchName(state)} | score ${match.matchScore || 0}`)
    }, status === 'OPEN' ? 'open' : status === 'CLOSED' ? 'closed' : null);

    setState(state);
    showPanel(state);
    await wait(1500); // Brief pause to see the result

    if (state.currentIndex < state.cases.length) {
      state.step = 'FILL_AND_WAIT';
      setState(state);
      // Click Back to return to results, then navigate to fresh search
      const backBtn = document.querySelector('input[value="Back"]');
      if (backBtn) {
        backBtn.click();
        // After back loads, we'll need to go to clean search - the page reload will re-trigger the script
        await wait(2000);
        // Navigate to clean search page
        window.location.href = 'https://portal.njcourts.gov/webcivilcj/CIVILCaseJacketWeb/pages/civilCaseSearch.faces';
      } else {
        window.location.href = 'https://portal.njcourts.gov/webcivilcj/CIVILCaseJacketWeb/pages/civilCaseSearch.faces';
      }
    } else {
      state.step = 'DONE';
      setState(state);
      showPanel(state);
      setStatus(`
        <div style="text-align:center;padding:8px">
          <div style="font-size:18px;margin-bottom:8px">🎉 All Done!</div>
          <div>✅ ${state.done} cases checked</div>
          <div>🟢 Open: ${state.open} | 🔴 Closed: ${state.closed}</div>
          <div>❌ Not Found: ${state.notFound} | ⚠️ Errors: ${state.errors}</div>
        </div>
      `);
      clearState();
    }
    return;
  }

  // ── STEP: DONE ───────────────────────────────────────────────
  if (state.step === 'DONE') {
    showPanel(state);
    setStatus('🎉 All done! Refresh page to clear panel.');
    clearState();
  }

})();
