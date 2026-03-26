(function(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.CourtStatusCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';

  function parseFlexibleDate(value) {
    if (!value) return null;
    let match = value.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (match) return new Date(+match[3], +match[1] - 1, +match[2]);
    match = value.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (match) return new Date(+match[1], +match[2] - 1, +match[3]);
    return null;
  }

  function parseName(full) {
    const parts = normalizeNameParts(full);
    if (!parts.length) return null;
    return {
      last: parts[0] || '',
      first: (parts[1] || '').slice(0, 9),
      mid: (parts[2] || '').slice(0, 1)
    };
  }

  function normalizeNameParts(full) {
    if (!full) return [];
    return full.toUpperCase().trim()
      .replace(/\b(JR|SR|II|III|IV|ESQ|MD|PHD)\b\.?/g, '')
      .trim()
      .replace(/\s+/g, ' ')
      .split(' ')
      .filter(Boolean);
  }

  function isSkippableBridgeToken(token) {
    return ['DA', 'DE', 'DEL', 'DELA', 'DI', 'DO', 'DOS', 'DU', 'LA', 'LE', 'VAN', 'VON'].includes((token || '').toUpperCase());
  }

  function buildSearchName(last, first, mid) {
    return [last, first, mid].filter(Boolean).join(' ').trim();
  }

  function expandSearchName(name) {
    const parts = normalizeNameParts(name);
    if (parts.length < 2) return [];

    const variants = [];
    const add = (last, first, mid) => {
      const full = buildSearchName(last, first, mid);
      if (full) variants.push(full);
    };

    const last = parts[0];
    const first = parts[1];
    const middle = parts[2] || '';

    add(last, first, middle);
    if (middle) add(last, first, middle.slice(0, 1));
    add(last, first, '');

    if (parts.length >= 4 && isSkippableBridgeToken(parts[1])) {
      const altFirst = parts[2];
      const altMiddle = parts[3] || '';
      add(last, altFirst, altMiddle);
      if (altMiddle) add(last, altFirst, altMiddle.slice(0, 1));
      add(last, altFirst, '');
    }

    return uniqueNames(variants);
  }

  function plaintiffKeyword(name) {
    if (!name) return '';
    const upper = name.toUpperCase().trim();
    const cleaned = upper
      .replace(/\b(LLC|INC|CORP|N\.?A\.?|BANK|MORTGAGE|SERVICING|TRUST|LP|L\.P\.|CO|COMPANY)\b/g, '')
      .trim();
    const parts = cleaned.split(/\s+/).filter(part => part.length > 2);
    return parts[0] || upper.split(/\s+/)[0] || '';
  }

  function dateDistanceDays(csvDate, courtDate) {
    if (!csvDate || !courtDate) return null;
    try {
      const d1 = parseFlexibleDate(csvDate);
      const d2 = parseFlexibleDate(courtDate);
      if (!d1 || !d2) return null;
      return Math.abs(d1 - d2) / 86400000;
    } catch {
      return null;
    }
  }

  function dateProximity(csvDate, courtDate, windowDays) {
    const days = dateDistanceDays(csvDate, courtDate);
    if (days == null) return 0;
    if (days <= 30) return 1.0;
    if (days <= windowDays) return 0.7;
    if (days <= 180) return 0.4;
    if (days <= 365) return 0.2;
    return 0;
  }

  function isWithinDateWindow(csvDate, courtDate, windowDays) {
    const days = dateDistanceDays(csvDate, courtDate);
    return days != null && days <= windowDays;
  }

  function findBestMatch(rows, plaintiffName, csvDate, windowDays) {
    const pKey = plaintiffKeyword(plaintiffName).toUpperCase();
    let best = null;
    let bestScore = 0;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      let score = 0;

      if ((row.venue || '').toUpperCase().includes('CAMDEN')) score += 3;
      if (pKey && (row.caption || '').toUpperCase().includes(pKey)) score += 2;
      if (!isWithinDateWindow(csvDate, row.date, windowDays)) continue;
      score += dateProximity(csvDate, row.date, windowDays) * 2;
      if ((row.docket || '').startsWith('F-')) score += 1;

      if (score > bestScore) {
        bestScore = score;
        best = { ...row, rowIndex: i, matchScore: score };
      }
    }

    return bestScore >= 3 ? best : null;
  }

  function classify(status, disposition) {
    const combined = ((status || '') + ' ' + (disposition || '')).toUpperCase();
    if (/BANKRUPTCY STAY|AUTOMATIC STAY|STAYED|CASE STAYED|\bSTAY\b/.test(combined)) return 'STAY';
    if (/CLOSED|DISMISSED|DISPOSED|RESOLVED|SETTLED|TERMINATED/.test(combined)) return 'CLOSED';
    if (/OPEN|ACTIVE|PENDING|DEFAULTED/.test(combined)) return 'OPEN';
    return 'UNKNOWN';
  }

  function buildStatusNote(reason, extra) {
    const parts = [reason];
    if (extra) parts.push(extra);
    return parts.join(' | ');
  }

  function uniqueNames(names) {
    return Array.from(new Set((names || []).map(name => (name || '').trim()).filter(Boolean)));
  }

  function getSearchSkipWholeWords() {
    return Array.isArray(globalThis.__CSC_SEARCH_SKIP_WHOLE_WORDS__)
      ? globalThis.__CSC_SEARCH_SKIP_WHOLE_WORDS__
      : [];
  }

  function escapeRegex(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function normalizeNameForSkipMatch(name) {
    return String(name || '')
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, ' ')
      .trim()
      .replace(/\s+/g, ' ');
  }

  function shouldSkipCourtSearchName(name) {
    const normalizedName = normalizeNameForSkipMatch(name);
    if (!normalizedName) return true;
    return getSearchSkipWholeWords().some(phrase => {
      const normalizedPhrase = normalizeNameForSkipMatch(phrase);
      if (!normalizedPhrase) return false;
      const re = new RegExp(`(?:^|\\s)${escapeRegex(normalizedPhrase)}(?:\\s|$)`);
      return re.test(normalizedName);
    });
  }

  function getSearchNames(c) {
    return getSearchCandidates(c).map(candidate => candidate.name);
  }

  function uniqueCandidateKey(candidate) {
    return [
      candidate && candidate.name ? candidate.name : '',
      candidate && candidate.mode ? candidate.mode : '',
      candidate && candidate.partyCode ? candidate.partyCode : '',
      candidate && candidate.dateWindowDays ? candidate.dateWindowDays : ''
    ].join('|');
  }

  function uniqueCandidates(candidates) {
    const seen = new Set();
    const out = [];
    (candidates || []).forEach(candidate => {
      if (!candidate || !candidate.name || shouldSkipCourtSearchName(candidate.name)) return;
      const key = uniqueCandidateKey(candidate);
      if (seen.has(key)) return;
      seen.add(key);
      out.push(candidate);
    });
    return out;
  }

  function getSearchCandidates(c) {
    if (Array.isArray(c && c.searchCandidates) && c.searchCandidates.length) {
      const standard = [];
      c.searchCandidates.forEach(candidate => {
        const baseName = candidate && candidate.name ? candidate.name : '';
        if (!baseName) return;
        expandSearchName(baseName).forEach(name => {
          standard.push({
            name,
            partyCode: candidate.partyCode || '',
            mode: 'standard',
            dateWindowDays: 90
          });
        });
      });
      return uniqueCandidates(standard);
    }

    const sourceNames = uniqueNames([
      ...(Array.isArray(c && c.searchNames) ? c.searchNames : []),
      ...(Array.isArray(c && c.allDefendants) ? c.allDefendants : []),
      c && c.defendant ? c.defendant : ''
    ]);
    const expanded = [];
    sourceNames.filter(name => !shouldSkipCourtSearchName(name)).forEach(name => {
      expandSearchName(name).forEach(variant => {
        expanded.push({ name: variant, partyCode: '', mode: 'standard', dateWindowDays: 90 });
      });
    });
    return uniqueCandidates(expanded.length ? expanded : sourceNames.filter(name => !shouldSkipCourtSearchName(name)).map(name => ({
      name,
      partyCode: '',
      mode: 'standard',
      dateWindowDays: 90
    })));
  }

  function evaluateJacketMatch(params) {
    const filingDate = params && params.filingDate ? params.filingDate : '';
    const jacketDate = params && params.jacketDate ? params.jacketDate : '';
    const currentNameIndex = params && typeof params.currentNameIndex === 'number' ? params.currentNameIndex : 0;
    const names = uniqueNames(params && Array.isArray(params.names) ? params.names : []);
    const windowDays = params && params.windowDays ? params.windowDays : 90;
    const hasLockedDocket = !!(params && params.hasLockedDocket);

    const daysDiff = dateDistanceDays(filingDate, jacketDate);
    if (daysDiff == null || daysDiff <= windowDays || hasLockedDocket) {
      return { action: 'accept', daysDiff };
    }

    const nextNameIndex = currentNameIndex + 1;
    if (nextNameIndex < names.length) {
      return {
        action: 'next-name',
        daysDiff,
        nextNameIndex,
        reason: buildStatusNote('RECHECK_REASON:DATE_MISMATCH', `filing=${filingDate} court=${jacketDate} diffDays=${Math.round(daysDiff)}`)
      };
    }

    return {
      action: 'recheck',
      daysDiff,
      reason: buildStatusNote('RECHECK_REASON:DATE_MISMATCH', `filing=${filingDate} court=${jacketDate} diffDays=${Math.round(daysDiff)}`)
    };
  }

  return {
    parseFlexibleDate,
    parseName,
    plaintiffKeyword,
    dateDistanceDays,
    dateProximity,
    isWithinDateWindow,
    findBestMatch,
    classify,
    buildStatusNote,
    uniqueNames,
    getSearchCandidates,
    getSearchNames,
    evaluateJacketMatch
  };
});


// ==UserScript==
// @name         NJ Courts Status Checker
// @namespace    http://tampermonkey.net/
// @version      3.0
// @description  Auto-checks court case statuses from Camden pipeline data with auto-login CAPTCHA recovery
// @match        https://portal.njcourts.gov/*
// @match        https://portal-cloud.njcourts.gov/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      foreclosure-finder.onrender.com
// @connect      portal-cloud.njcourts.gov
// @connect      portal.njcourts.gov
// @run-at       document-idle
// ==/UserScript==

(async function () {
  'use strict';

  const SERVER = 'https://foreclosure-finder.onrender.com';
  const TOKEN = 'website';
  const STORAGE_KEY = 'csc_state_v2';
  const SEARCH_URL = 'https://portal.njcourts.gov/webcivilcj/CIVILCaseJacketWeb/pages/civilCaseSearch.faces';
  const LOGIN_URL = 'https://portal-cloud.njcourts.gov/prweb/PRAuth/CloudSAMLAuth?AppName=ESSO';
  const PORTAL_DASHBOARD_URL = 'https://portal-cloud.njcourts.gov/prweb/PRAuth/app/ESSOPortal/';
  const BREAK_EVERY = 0; // Disabled - cookie clearing handles CAPTCHA recovery
  const BREAK_MS = 0;
  const WATCHDOG_MS = 300001;
  const SEARCH_WINDOW_DAYS = 90;
  const Core = globalThis.CourtStatusCore;
  if (!Core) throw new Error('CourtStatusCore not loaded');
  // GM storage keys (cross-domain, shared across all @match domains)
  const GM_RECOVERY_KEY = 'csc_captcha_recovery';
  const GM_STATE_BACKUP_KEY = 'csc_state_backup';

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  let searchConfigLoaded = false;

  async function loadSearchConfig() {
    if (searchConfigLoaded) return;
    try {
      const resp = await fetch(SERVER + '/api/camden/court-search-config?token=' + encodeURIComponent(TOKEN));
      if (!resp.ok) throw new Error('Server returned ' + resp.status);
      const data = await resp.json();
      globalThis.__CSC_SEARCH_SKIP_WHOLE_WORDS__ = Array.isArray(data && data.containsWholeWords) ? data.containsWholeWords : [];
      searchConfigLoaded = true;
    } catch (e) {
      console.error('CSC config load failed:', e);
      globalThis.__CSC_SEARCH_SKIP_WHOLE_WORDS__ = Array.isArray(globalThis.__CSC_SEARCH_SKIP_WHOLE_WORDS__) ? globalThis.__CSC_SEARCH_SKIP_WHOLE_WORDS__ : [];
      searchConfigLoaded = true;
    }
  }

  // ============================================================
  // Cross-domain state helpers (GM_setValue works across all @match domains)
  // ============================================================
  function setRecoveryFlag(val) { GM_setValue(GM_RECOVERY_KEY, val); }
  function getRecoveryFlag() { return GM_getValue(GM_RECOVERY_KEY, null); }
  function clearRecoveryFlag() { GM_deleteValue(GM_RECOVERY_KEY); }

  function backupState(state) { GM_setValue(GM_STATE_BACKUP_KEY, JSON.stringify(state)); }
  function restoreState() {
    try { const s = GM_getValue(GM_STATE_BACKUP_KEY, null); return s ? JSON.parse(s) : null; } catch { return null; }
  }
  function clearBackupState() { GM_deleteValue(GM_STATE_BACKUP_KEY); }

  // ============================================================
  // localStorage helpers (per-domain, only works on portal.njcourts.gov)
  // ============================================================
  const getState = () => {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY)); } catch { return null; }
  };
  let lastProgress = Date.now();
  const setState = (s) => { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); lastProgress = Date.now(); };
  const clearState = () => localStorage.removeItem(STORAGE_KEY);

  // ============================================================
  // Detect which site we're on
  // ============================================================
  const currentHost = window.location.hostname;
  const isLoginPage = currentHost === 'portal-cloud.njcourts.gov';
  const isSearchSite = currentHost === 'portal.njcourts.gov';

  // ============================================================
  // CAPTCHA RECOVERY: Handle login page (portal-cloud.njcourts.gov)
  // ============================================================
  if (isLoginPage) {
    await wait(2000);
    const recovery = getRecoveryFlag();
    if (!recovery) return; // Not in recovery mode, do nothing on login page

    console.log('CSC: CAPTCHA recovery active on login page, flag =', recovery);

    // Check if we're on the login form or the dashboard
    const bodyText = document.body.innerText || '';
    const hasLoginForm = document.getElementById('userid') && document.getElementById('passwd');
    const isDashboard = bodyText.includes('Find a Case') || bodyText.includes('Portal Home Page') || bodyText.includes('Enterprise Portal');

    if (isDashboard) {
      // We're on the dashboard after successful login - go to search page
      console.log('CSC: Login successful, navigating to search page...');
      setRecoveryFlag('navigating_to_search');
      window.location.href = SEARCH_URL;
      return;
    }

    if (hasLoginForm) {
      console.log('CSC: On login form, fetching credentials...');

      // Show a small status indicator
      const indicator = document.createElement('div');
      indicator.style.cssText = 'position:fixed;top:10px;right:10px;z-index:99999;background:#0f172a;color:#38bdf8;padding:12px 18px;border-radius:10px;font-family:system-ui,sans-serif;font-size:13px;box-shadow:0 4px 20px rgba(0,0,0,.5);border:1px solid #334155;';
      indicator.textContent = 'Auto-login: Fetching credentials...';
      document.body.appendChild(indicator);

      try {
        // Fetch credentials from Render server
        const resp = await fetch(SERVER + '/api/nj-courts-creds?token=' + encodeURIComponent(TOKEN));
        if (!resp.ok) throw new Error('Server returned ' + resp.status);
        const creds = await resp.json();

        if (!creds.user || !creds.pass) throw new Error('Empty credentials returned');

        indicator.textContent = 'Auto-login: Filling form...';
        await wait(500);

        // Fill in login form
        const userField = document.getElementById('userid');
        const passField = document.getElementById('passwd');
        const submitBtn = document.getElementById('a');

        // Use native setter to bypass any framework interception
        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;

        nativeSetter.call(userField, creds.user);
        userField.dispatchEvent(new Event('input', { bubbles: true }));
        userField.dispatchEvent(new Event('change', { bubbles: true }));

        await wait(300);

        nativeSetter.call(passField, creds.pass);
        passField.dispatchEvent(new Event('input', { bubbles: true }));
        passField.dispatchEvent(new Event('change', { bubbles: true }));

        await wait(500);

        indicator.textContent = 'Auto-login: Submitting...';
        setRecoveryFlag('logging_in');

        // Submit the form
        if (submitBtn) {
          submitBtn.click();
        } else {
          // Fallback: submit the form directly
          const form = document.querySelector('form[name="LoginEntryForm"]') || userField.closest('form');
          if (form) form.submit();
        }

        // The page will redirect after login - the script will pick up on the dashboard
      } catch (e) {
        console.error('CSC: Auto-login failed:', e);
        indicator.style.color = '#f87171';
        indicator.textContent = 'Auto-login failed: ' + e.message + ' â€” Please log in manually. Script will resume.';
        // Don't clear recovery flag - when user logs in manually and reaches dashboard, we'll still redirect
      }
      return;
    }

    // On some intermediate redirect page - wait for it to resolve
    console.log('CSC: On intermediate page during recovery, waiting...');
    await wait(3000);
    // If we're still not on login or dashboard, the redirect might still be happening
    return;
  }

  // ============================================================
  // SEARCH SITE (portal.njcourts.gov) - Main script logic
  // ============================================================
  if (!isSearchSite) return;

  // Check if we're returning from CAPTCHA recovery
  const recoveryFlag = getRecoveryFlag();
  if (recoveryFlag) {
    console.log('CSC: Returned to search site after CAPTCHA recovery');
    clearRecoveryFlag();

    // Restore state from GM backup into localStorage
    const backedUpState = restoreState();
    if (backedUpState && backedUpState.step !== 'DONE') {
      backedUpState.isOnBreak = false;
      backedUpState.step = 'FILL_AND_SEARCH'; // Retry the current case from scratch
      backedUpState.nameIndex = 0;
      setState(backedUpState);
      clearBackupState();
      console.log('CSC: State restored, resuming from case', backedUpState.currentIndex);
    }
  }

  // Watchdog timer
  setInterval(() => {
    const st = getState();
    if (st && st.step !== 'DONE' && !st.isOnBreak && Date.now() - lastProgress > WATCHDOG_MS) {
      console.log('CSC: Watchdog triggered - reloading');
      window.location.href = SEARCH_URL;
    }
  }, 5000);

  const parseName = Core.parseName;

  function parseDocket(docket) {
    if (!docket) return null;
    const cleaned = docket.replace(/\s+/g, '').toUpperCase();
    const m = cleaned.match(/([FC])[-]?(\d{4,6})-(\d{2})$/);
    if (m) return { type: m[1], number: m[2], year: m[3] };
    const m2 = cleaned.match(/(\d{4,6})-(\d{2})$/);
    if (m2) return { type: 'F', number: m2[1], year: m2[2] };
    return null;
  }

  function setField(id, value) {
    const el = document.getElementById(id);
    if (!el) { console.log('CSC: Field not found:', id); return false; }

    el.focus();
    el.dispatchEvent(new Event('focus', { bubbles: true }));

    el.value = '';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));

    el.value = value;

    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));

    console.log('CSC: Set', id, '=', value);
    return true;
  }

  async function ensurePartyNameTab() {
    const lnameField = document.getElementById('searchByPartyNameForm:partyLName');
    if (lnameField && lnameField.offsetParent !== null) return true;

    const tabs = document.querySelectorAll('a, li');
    for (const t of tabs) {
      const text = (t.textContent || '').trim();
      if (text === 'Search By Party Name') {
        t.click();
        await wait(800);
        return true;
      }
    }
    return false;
  }

  async function ensureDocketTab() {
    const docketField = document.getElementById('searchByDocForm:idCivilDocketNum');
    if (docketField && docketField.offsetParent !== null) return true;

    const tabs = document.querySelectorAll('a, li');
    for (const t of tabs) {
      const text = (t.textContent || '').trim();
      if (text === 'Search By Docket Number') {
        t.click();
        await wait(800);
        return true;
      }
    }
    return false;
  }

  function clickSearchButton() {
    const btn = document.getElementById('searchByPartyNameForm:searchBtnDummy');
    if (btn) {
      btn.click();
      return true;
    }

    const allBtns = document.querySelectorAll('input[type="submit"], button');
    for (const b of allBtns) {
      if ((b.value || '').trim() === 'Search' && b.offsetParent !== null) {
        b.click();
        return true;
      }
    }

    // Last resort: submit the form directly
    const form = document.getElementById('searchByPartyNameForm');
    if (form) { form.submit(); return true; }
    return false;
  }

  function clickDocketSearchButton() {
    const btn = document.getElementById('searchByDocForm:searchBtnDummy');
    if (btn) {
      btn.click();
      return true;
    }

    // Fallback: find any visible Search button
    const allBtns = document.querySelectorAll('input[type="submit"], button');
    for (const b of allBtns) {
      if ((b.value || '').trim() === 'Search' && b.offsetParent !== null) {
        b.click();
        return true;
      }
    }

    // Last resort: submit the form directly
    const form = document.getElementById('searchByDocForm');
    if (form) { form.submit(); return true; }
    return false;
  }

  const dateDistanceDays = Core.dateDistanceDays;

  function findBestMatch(rows, plaintiffName, csvDate, windowDays) {
    return Core.findBestMatch(rows, plaintiffName, csvDate, windowDays || SEARCH_WINDOW_DAYS);
  }

  const classify = Core.classify;
  const buildStatusNote = Core.buildStatusNote;
  const getSearchCandidates = Core.getSearchCandidates;

  function getCurrentSearchCandidate(state) {
    const c = state && state.cases ? state.cases[state.currentIndex] : null;
    const candidates = ensureCaseSearchState(state);
    return candidates[state.nameIndex] || (c ? { name: c.defendant || '', mode: 'standard', dateWindowDays: SEARCH_WINDOW_DAYS } : null);
  }

  async function saveToServer(instrumentNumber, courtData) {
    try {
      await fetch(SERVER + '/api/camden/court-status-update?token=' + encodeURIComponent(TOKEN), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Auth-Token': TOKEN },
        body: JSON.stringify({ instrumentNumber, courtData })
      });
    } catch (e) {
      console.error('CSC save failed:', e);
    }
  }

  async function advanceRefreshBatch(instrumentNumber, status) {
    const st = getState();
    const batchId = st && st.batch ? st.batch.batchId : '';
    if (!batchId) return null;

    try {
      const resp = await fetch(SERVER + '/api/camden/court-status-refresh/advance?token=' + encodeURIComponent(TOKEN), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Auth-Token': TOKEN },
        body: JSON.stringify({ batchId, instrumentNumber, status })
      });
      if (!resp.ok) return null;
      const data = await resp.json();
      return data && data.batch ? data.batch : null;
    } catch (e) {
      console.error('CSC advance failed:', e);
      return null;
    }
  }

  async function saveAndAdvance(instrumentNumber, courtData, state) {
    await saveToServer(instrumentNumber, courtData);
    if (state && state.mode === 'refresh') {
      const batch = await advanceRefreshBatch(instrumentNumber, courtData?.courtStatus || '');
      if (batch) {
        state.batch = batch;
        setState(state);
      }
    }
  }

  async function maybeTakeBreak(state) {
    // Cooldown breaks disabled - CAPTCHA recovery via cookie clearing handles rate limits
    return;
  }

  function hasCaptchaBlock() {
    const bodyText = document.body.innerText || '';
    return (
      bodyText.includes('Captcha verification has failed') ||
      bodyText.includes('Please try again in a few minutes')
    );
  }

  function detectPage() {
    const body = document.body.innerText || '';
    if (body.includes('Case Status:') && body.includes('Docket Number:') && body.includes('Case Caption:')) return 'JACKET';

    const lnameField = document.getElementById('searchByPartyNameForm:partyLName');
    if (lnameField) {
      const tables = document.querySelectorAll('table');
      for (const t of tables) {
        const text = (t.innerText || '').toUpperCase();
        if (text.includes('DOCKET NUMBER') && text.includes('CASE CAPTION')) return 'RESULTS';
      }
      return 'SEARCH';
    }
    return 'OTHER';
  }

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
      break;
    }
    return rows;
  }

  function extractJacket() {
    const text = document.body.innerText || '';
    const pick = (re) => { const m = text.match(re); return m ? (m[1] || '').trim() : ''; };

    const caseActions = [];
    const tables = document.querySelectorAll('table');
    for (const t of tables) {
      const hdr = (t.innerText || '').toUpperCase();
      if (!hdr.includes('FILED DATE') || !hdr.includes('DOCKET TEXT')) continue;
      const rows = t.querySelectorAll('tbody tr');
      rows.forEach((tr) => {
        const tds = tr.querySelectorAll('td');
        if (tds.length < 5) return;
        const filedDate = (tds[0].textContent || '').trim();
        const docketText = (tds[2].textContent || '').trim();
        const transactionId = (tds[3].textContent || '').trim();
        const entryDate = (tds[4].textContent || '').trim();
        if (!docketText) return;
        caseActions.push({ filedDate, docketText, transactionId, entryDate });
      });
      break;
    }

    const latest = caseActions[caseActions.length - 1] || null;

    return {
      caseStatus: pick(/Case Status:\s*([^\t\n\r]+)/i),
      caseDisposition: pick(/Case Disposition:\s*([^\t\n\r]+)/i),
      caseCaption: pick(/Case Caption:\s*([^\t\n\r]+)/i),
      caseType: pick(/Case Type:\s*([^\t\n\r]+)/i),
      caseInitDate: pick(/Case Initiation Date:\s*(\d{1,2}\/\d{1,2}\/\d{4})/i),
      docketNumber: pick(/Docket Number:\s*([^\t\n\r]+)/i),
      dispositionDate: pick(/Disposition Date:\s*(\d{1,2}\/\d{1,2}\/\d{4})/i),
      courtCaseActions: caseActions,
      courtCaseActionsText: caseActions.map(a => a.docketText).join(' | '),
      courtCaseActionCount: caseActions.length,
      courtLatestActionText: latest ? latest.docketText : '',
      courtLatestActionDate: latest ? (latest.filedDate || latest.entryDate || '') : ''
    };
  }

  function ensureCaseSearchState(state) {
    const c = state && state.cases ? state.cases[state.currentIndex] : null;
    if (!c) return [];
    const candidates = getSearchCandidates(c);
    c.searchNames = candidates.map(candidate => candidate.name);
    if (typeof state.nameIndex !== 'number' || state.nameIndex < 0) state.nameIndex = 0;
    if (!Array.isArray(state.nameAttempts)) state.nameAttempts = [];
    return candidates;
  }

  function showPanel(state) {
    let panel = document.getElementById('csc-panel');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'csc-panel';
      document.body.appendChild(panel);
    }

    const pct = state.total > 0 ? Math.round((state.done / state.total) * 100) : 0;
    const current = state.cases ? state.cases[state.currentIndex] : null;
    const searchCandidates = current ? getSearchCandidates(current) : [];
    const activeCandidate = current ? (searchCandidates[state.nameIndex || 0] || { name: current.defendant || '' }) : null;
    const activeName = activeCandidate ? activeCandidate.name : '';
    const nameDisplay = activeName || '-';
    const modeText = state.mode === 'refresh'
      ? ((state.batch && state.batch.batchId) ? 'Refresh batch' : 'Refresh mode')
      : 'New cases';

    panel.innerHTML = `
      <style>
        #csc-panel {
          position: fixed; top: 10px; right: 10px; width: 390px; z-index: 99999;
          background: #0f172a; color: #e2e8f0; border-radius: 12px; padding: 16px;
          font-family: system-ui, sans-serif; font-size: 13px;
          box-shadow: 0 8px 32px rgba(0,0,0,.7); border: 1px solid #334155;
        }
        #csc-panel h3 { margin: 0 0 8px; color: #38bdf8; font-size: 15px; }
        .csc-bar { height: 6px; background: #1e293b; border-radius: 3px; margin: 8px 0; overflow: hidden; }
        .csc-fill { height: 100%; background: linear-gradient(90deg,#38bdf8,#818cf8); border-radius: 3px; transition: width .3s; }
      </style>
      <h3>Court Status Checker</h3>
      <div style="color:#93c5fd;font-size:12px;margin-bottom:6px;">${modeText}</div>
      <div class="csc-bar"><div class="csc-fill" style="width:${pct}%"></div></div>
      <div>
        Done ${state.done}/${state.total} |
        <span style="color:#4ade80">Open ${state.open}</span> |
        <span style="color:#f87171">Closed ${state.closed}</span> |
        <span style="color:#f87171">Stay ${state.stay || 0}</span> |
        <span style="color:#fbbf24">Recheck ${state.notFound}</span> |
        <span style="color:#fb923c">Err ${state.errors}</span>
      </div>
      <div style="margin-top:6px;color:#94a3b8">Current: <b>${nameDisplay}</b></div>
      <div id="csc-status" style="margin-top:8px;padding:8px;background:#1e293b;border-radius:6px;min-height:40px">Loading...</div>
      <button id="csc-stop-btn" style="margin-top:8px;border:none;padding:6px 14px;border-radius:6px;background:#ef4444;color:#fff;cursor:pointer">Stop</button>
    `;

    document.getElementById('csc-stop-btn').addEventListener('click', () => {
      clearState();
      clearRecoveryFlag();
      clearBackupState();
      panel.remove();
    });
  }

  function setStatus(msg) {
    const el = document.getElementById('csc-status');
    if (el) el.innerHTML = msg;
  }

  function setStatusByType(type, text) {
    const el = document.getElementById('csc-status');
    if (!el) return;
    const colors = {
      open: '#4ade80',
      closed: '#f87171',
      recheck: '#fbbf24',
      error: '#fb923c',
      info: '#93c5fd'
    };
    const c = colors[type] || colors.info;
    el.innerHTML = `<span style="color:${c};font-weight:600">${text}</span>`;
  }

  async function showLauncher() {
    const page = detectPage();
    if (page !== 'SEARCH' && page !== 'RESULTS') return;
    if (document.getElementById('csc-launcher')) return;

    let batchText = 'No saved batch found';
    try {
      const resp = await fetch(SERVER + '/api/camden/court-status-refresh/state?token=' + encodeURIComponent(TOKEN));
      const data = await resp.json();
      if (data.batch && data.batch.status === 'running') {
        batchText = `Saved batch: ${data.batch.remainingCount} remaining`;
      }
    } catch (e) {}

    const launcher = document.createElement('div');
    launcher.id = 'csc-launcher';
    launcher.innerHTML = `
      <div style="position:fixed;top:10px;right:10px;width:320px;z-index:99999;background:#0f172a;color:#e2e8f0;border-radius:12px;padding:16px;font-family:system-ui,sans-serif;box-shadow:0 8px 32px rgba(0,0,0,.7);border:1px solid #334155;">
        <h3 style="margin:0 0 10px;color:#38bdf8;font-size:15px;">Court Status Checker</h3>
        <div style="color:#94a3b8;font-size:12px;margin-bottom:10px;">${batchText}</div>
        <button id="csc-btn-new" style="width:100%;padding:10px;border-radius:8px;border:none;cursor:pointer;margin:4px 0;background:#2563eb;color:#fff;">New Batch</button>
        <button id="csc-btn-resume" style="width:100%;padding:10px;border-radius:8px;border:none;cursor:pointer;margin:4px 0;background:#0f766e;color:#fff;">Continue Batch</button>
        <button id="csc-btn-standard" style="width:100%;padding:10px;border-radius:8px;border:none;cursor:pointer;margin:4px 0;background:#475569;color:#fff;">New Cases</button>
        <button id="csc-btn-test" style="width:100%;padding:10px;border-radius:8px;border:none;cursor:pointer;margin:4px 0;background:#334155;color:#94a3b8;">Test Run (10)</button>
      </div>
    `;
    document.body.appendChild(launcher);

    document.getElementById('csc-btn-new').addEventListener('click', () => startRun({ testMode: false, mode: 'refresh', resume: false }));
    document.getElementById('csc-btn-resume').addEventListener('click', () => startRun({ testMode: false, mode: 'refresh', resume: true }));
    document.getElementById('csc-btn-standard').addEventListener('click', () => startRun({ testMode: false, mode: 'default', resume: false }));
    document.getElementById('csc-btn-test').addEventListener('click', () => startRun({ testMode: true, mode: 'refresh', resume: false }));
  }

  async function startRun({ testMode = false, mode = 'default', resume = false }) {
    const launcher = document.getElementById('csc-launcher');
    if (launcher) launcher.remove();

    const loadingState = { done: 0, total: 0, open: 0, closed: 0, stay: 0, notFound: 0, errors: 0, cases: [], currentIndex: 0, mode, batch: null };
    showPanel(loadingState);
    setStatus('Fetching cases from server...');

    let payload;
    try {
      let url = SERVER + '/api/camden/court-status-cases?token=' + encodeURIComponent(TOKEN) + (testMode ? '&test=true' : '');
      if (mode === 'refresh') {
        url += `&mode=refresh&resume=${resume ? 'true' : 'false'}`;
      }
      const resp = await fetch(url);
      if (!resp.ok) throw new Error('Server returned ' + resp.status);
      payload = await resp.json();
    } catch (e) {
      setStatusByType('error', 'Failed to fetch cases: ' + e.message);
      return;
    }

    const cases = Array.isArray(payload) ? payload : (payload?.cases || []);
    const batch = Array.isArray(payload) ? null : (payload?.batch || null);

    if (!cases.length) {
      setStatusByType('info', payload?.message || 'No cases available.');
      return;
    }

    const state = {
      cases,
      batch,
      mode,
      currentIndex: 0,
      step: 'FILL_AND_SEARCH',
      done: 0,
      total: cases.length,
      open: 0,
      closed: 0,
      stay: 0,
      notFound: 0,
      errors: 0,
      lastMatch: null,
      lastBreakAt: 0,
      isOnBreak: false
    };
    setState(state);
    showPanel(state);
    await processState(state);
  }

  // ============================================================
  // CAPTCHA Recovery: Clear cookies and auto-login
  // ============================================================
  async function startCaptchaRecovery(state) {
    console.log('CSC: Starting CAPTCHA recovery - clearing cookies via extension...');
    state.isOnBreak = true;
    setState(state);
    showPanel(state);
    setStatusByType('error', 'CAPTCHA hit! Clearing cookies and re-logging in...');

    // Backup state to GM storage (cross-domain) so we can restore after login
    backupState(state);
    setRecoveryFlag('clearing_cookies');

    await wait(1000);

    // Ask the Cookie Cleaner extension to clear all cookies and site data
    // Communication: Tampermonkey dispatches event via unsafeWindow.document â†’
    // content script hears it â†’ sends message to background â†’ background clears cookies â†’
    // content script sets a DOM element attribute â†’ Tampermonkey polls for it
    try {
      const pageDoc = (typeof unsafeWindow !== 'undefined') ? unsafeWindow.document : document;

      const cleared = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Extension not responding - is NJ Courts Cookie Cleaner installed?')), 8000);

        // Listen for the response event
        pageDoc.addEventListener('njcourts-cookies-cleared', () => {
          clearTimeout(timeout);
          // Check the signal element for status
          const signal = pageDoc.getElementById('njcourts-cookie-signal');
          const status = signal ? signal.getAttribute('data-status') : null;
          resolve({ success: status === 'done' });
        }, { once: true });

        // Fire the request
        pageDoc.dispatchEvent(new Event('njcourts-clear-cookies'));
      });

      if (cleared && cleared.success) {
        console.log('CSC: Cookies cleared by extension. Navigating to login...');
        setStatusByType('info', 'Cookies cleared! Logging in...');
        await wait(2000);
        window.location.href = LOGIN_URL;
      } else {
        throw new Error('Extension returned failure');
      }
    } catch (e) {
      console.error('CSC: Extension cookie clear failed:', e.message);
      // Fallback: show manual instructions
      setStatusByType('error', 'Auto-clear failed. Please clear cookies manually.');
      let panel = document.getElementById('csc-panel');
      if (panel) {
        panel.innerHTML = `
          <style>
            #csc-panel {
              position: fixed; top: 10px; right: 10px; width: 420px; z-index: 99999;
              background: #0f172a; color: #e2e8f0; border-radius: 12px; padding: 20px;
              font-family: system-ui, sans-serif; font-size: 14px;
              box-shadow: 0 8px 32px rgba(0,0,0,.7); border: 1px solid #334155;
            }
            #csc-panel h3 { margin: 0 0 12px; color: #f87171; font-size: 16px; }
          </style>
          <h3>CAPTCHA Recovery</h3>
          <div style="margin-bottom:12px;padding:10px;background:#1e293b;border-radius:8px;color:#fb923c;font-size:12px;">
            Cookie Cleaner extension not detected. Install it for fully automatic recovery.
          </div>
          <div style="margin-bottom:14px;line-height:1.6;">
            <b style="color:#fbbf24;">Step 1:</b> Press <kbd style="background:#334155;padding:2px 6px;border-radius:3px;font-size:12px;">Ctrl+Shift+Delete</kbd><br>
            <b style="color:#fbbf24;">Step 2:</b> Hit <kbd style="background:#334155;padding:2px 6px;border-radius:3px;font-size:12px;">Enter</kbd> to clear cookies<br>
            <b style="color:#fbbf24;">Step 3:</b> Click <b>Resume</b> below
          </div>
          <div style="color:#94a3b8;font-size:12px;margin-bottom:10px;">
            Done ${state.done}/${state.total} | Will resume from case ${state.currentIndex + 1}
          </div>
          <button id="csc-resume-btn" style="width:100%;padding:10px;border-radius:8px;border:none;cursor:pointer;margin:4px 0;background:#2563eb;color:#fff;font-size:14px;font-weight:600;">Resume (after clearing cookies)</button>
          <button id="csc-stop-btn" style="width:100%;padding:8px;border-radius:8px;border:none;cursor:pointer;margin:4px 0;background:#ef4444;color:#fff;font-size:12px;">Cancel Run</button>
        `;
        document.getElementById('csc-resume-btn').addEventListener('click', () => {
          setRecoveryFlag('resuming');
          window.location.href = LOGIN_URL;
        });
        document.getElementById('csc-stop-btn').addEventListener('click', () => {
          clearState();
          clearRecoveryFlag();
          clearBackupState();
          panel.remove();
        });
      }
    }
  }

  async function processState(state) {
    const page = detectPage();
    const c = state.cases[state.currentIndex];

    // ============================================================
    // CAPTCHA RECOVERY (replaces old wait-and-retry)
    // ============================================================
    if (hasCaptchaBlock()) {
      await startCaptchaRecovery(state);
      return;
    }

    if (state.step === 'FILL_AND_SEARCH') {
      if (page !== 'SEARCH' && page !== 'RESULTS') {
        setStatusByType('info', 'Navigate to NJ Courts search page');
        return;
      }

      const docket = parseDocket(c.courtDocketNumber);
      if (docket) {
        await ensureDocketTab();
        await wait(300);

        const typeSelect = document.getElementById('searchByDocForm:docketType');
        if (typeSelect) {
          typeSelect.value = docket.type;
          typeSelect.dispatchEvent(new Event('change', { bubbles: true }));
        }

        setField('searchByDocForm:idCivilDocketNum', docket.number);
        await wait(150);
        setField('searchByDocForm:idCivilDocketYear', docket.year);
        await wait(150);

        state.step = 'READ_JACKET';
        state.lastMatch = { matchScore: 10, docket: c.courtDocketNumber };
        setState(state);

        setStatusByType('info', `Docket search: ${docket.type}-${docket.number}-${docket.year}`);
        clickDocketSearchButton();
        return;
      }

      const candidate = getCurrentSearchCandidate(state);
      const currentName = candidate && candidate.name ? candidate.name : (c.defendant || '');
      const parsed = parseName(currentName);

      if (!parsed || !parsed.last) {
        await saveAndAdvance(c.instrumentNumber, { courtStatus: 'ERROR', courtStatusNote: 'Could not parse name: ' + currentName }, state);
        state.errors++; state.done++; state.currentIndex++; state.nameIndex = 0;
        await maybeTakeBreak(state);
        showPanel(state);
        if (state.currentIndex < state.cases.length) {
          state.step = 'FILL_AND_SEARCH';
          setState(state);
          await wait(400);
          await processState(state);
        } else {
          finishRun(state);
        }
        return;
      }

      await ensurePartyNameTab();
      await wait(200);

      const lastField = document.getElementById('searchByPartyNameForm:partyLName');
      const firstField = document.getElementById('searchByPartyNameForm:partyFName');
      const midField = document.getElementById('searchByPartyNameForm:partyMName');

      if (!lastField || !firstField) {
        setStatusByType('error', 'Cannot find name fields');
        return;
      }

      setField('searchByPartyNameForm:partyLName', parsed.last);
      await wait(150);
      setField('searchByPartyNameForm:partyFName', (parsed.first || '').slice(0, 9));
      await wait(150);
      if (midField) setField('searchByPartyNameForm:partyMName', parsed.mid);
      await wait(150);

      if (lastField.value !== parsed.last || firstField.value !== (parsed.first || '').slice(0, 9)) {
        lastField.value = parsed.last;
        firstField.value = (parsed.first || '').slice(0, 9);
      }

      state.step = 'READ_RESULTS';
      setState(state);
      setStatusByType('info', `Searching ${parsed.last}, ${(parsed.first || '').slice(0, 9)}`);
      clickSearchButton();
      return;
    }

    if (state.step === 'READ_RESULTS') {
      if (hasCaptchaBlock()) { await startCaptchaRecovery(state); return; }
      const bodyText = document.body.innerText || '';

      if (bodyText.includes('Party Name is invalid')) {
        const nameIndex = state.nameIndex || 0;
        const names = ensureCaseSearchState(state);
        const nextNameIndex = nameIndex + 1;

        if (nextNameIndex < names.length) {
          state.nameIndex = nextNameIndex;
          state.step = 'FILL_AND_SEARCH';
          setState(state);
          window.location.href = SEARCH_URL;
        } else {
          await saveAndAdvance(c.instrumentNumber, {
            courtStatus: 'RECHECK',
            courtStatusNote: buildStatusNote('RECHECK_REASON:ALL_NAMES_INVALID', 'names tried: ' + names.length)
          }, state);
          state.notFound++; state.done++; state.currentIndex++; state.nameIndex = 0;
          await maybeTakeBreak(state);
          showPanel(state);
          if (state.currentIndex < state.cases.length) {
            state.step = 'FILL_AND_SEARCH';
            setState(state);
            window.location.href = SEARCH_URL;
          } else {
            finishRun(state);
          }
        }
        return;
      }

      if (page === 'SEARCH') {
          const nameIndex = state.nameIndex || 0;
          const names = ensureCaseSearchState(state);
        const nextNameIndex = nameIndex + 1;

        if (nextNameIndex < names.length) {
          state.nameIndex = nextNameIndex;
          state.step = 'FILL_AND_SEARCH';
          setState(state);
          await wait(300);
          await processState(state);
        } else {
          await saveAndAdvance(c.instrumentNumber, {
            courtStatus: 'RECHECK',
            courtStatusNote: buildStatusNote('RECHECK_REASON:NO_RESULTS_ALL_NAMES', 'names tried: ' + names.length)
          }, state);
          state.notFound++; state.done++; state.currentIndex++; state.nameIndex = 0;
          await maybeTakeBreak(state);
          showPanel(state);
          if (state.currentIndex < state.cases.length) {
            state.step = 'FILL_AND_SEARCH';
            setState(state);
            window.location.href = SEARCH_URL;
          } else {
            finishRun(state);
          }
        }
        return;
      }

      if (page === 'JACKET') {
        state.step = 'READ_JACKET';
        state.lastMatch = { matchScore: 5, docket: 'single-result' };
        setState(state);
        showPanel(state);
        await processState(state);
        return;
      }

      if (page === 'RESULTS') {
        const rows = parseResultsTable();
        const candidate = getCurrentSearchCandidate(state);
        const match = findBestMatch(rows, c.plaintiff, c.filingDate, candidate && candidate.dateWindowDays);

        if (!match) {
          const nameIndex = state.nameIndex || 0;
          const names = ensureCaseSearchState(state);
          const nextNameIndex = nameIndex + 1;

          if (nextNameIndex < names.length) {
            state.nameIndex = nextNameIndex;
            state.step = 'FILL_AND_SEARCH';
            setState(state);
            window.location.href = SEARCH_URL;
          } else {
            await saveAndAdvance(c.instrumentNumber, {
              courtStatus: 'RECHECK',
              courtStatusNote: buildStatusNote('RECHECK_REASON:NO_MATCH_ALL_NAMES', `${rows.length} results scanned; names tried: ${names.length}`)
            }, state);
            state.notFound++; state.done++; state.currentIndex++; state.nameIndex = 0;
            await maybeTakeBreak(state);
            showPanel(state);
            if (state.currentIndex < state.cases.length) {
              state.step = 'FILL_AND_SEARCH';
              setState(state);
              window.location.href = SEARCH_URL;
            } else {
              finishRun(state);
            }
          }
          return;
        }

        state.step = 'READ_JACKET';
        state.lastMatch = match;
        setState(state);
        setStatusByType('info', `Match ${match.docket} (score ${match.matchScore})`);
        await wait(500);

        let clicked = false;
        const tables = document.querySelectorAll('table');
        for (const t of tables) {
          if (!(t.innerText || '').includes('Docket Number')) continue;
          const trs = t.querySelectorAll('tbody tr');
          if (trs[match.rowIndex]) {
            const link = trs[match.rowIndex].querySelector('td:nth-child(3) a');
            if (link) { link.click(); clicked = true; break; }
          }
        }

        if (!clicked) {
          const linkId = 'searchByPartyNameForm:idPartyTable:' + match.rowIndex + ':lnkSrchByDocNum';
          const link = document.getElementById(linkId);
          if (link) { link.click(); clicked = true; }
        }

        if (!clicked) {
          await saveAndAdvance(c.instrumentNumber, { courtStatus: 'ERROR', courtStatusNote: 'Could not click docket link' }, state);
          state.errors++; state.done++; state.currentIndex++;
          await maybeTakeBreak(state);
          state.step = state.currentIndex < state.cases.length ? 'FILL_AND_SEARCH' : 'DONE';
          setState(state);
          showPanel(state);
          window.location.href = SEARCH_URL;
        }
        return;
      }

      state.step = 'FILL_AND_SEARCH';
      setState(state);
      window.location.href = SEARCH_URL;
      return;
    }

    if (state.step === 'READ_JACKET') {
      if (page !== 'JACKET') {
        await wait(2000);
        if (hasCaptchaBlock()) { await startCaptchaRecovery(state); return; }
        if (detectPage() !== 'JACKET') {
          await wait(3000);
          if (hasCaptchaBlock()) { await startCaptchaRecovery(state); return; }
          if (detectPage() !== 'JACKET') {
            await saveAndAdvance(c.instrumentNumber, { courtStatus: 'ERROR', courtStatusNote: 'Jacket page did not load' }, state);
            state.errors++; state.done++; state.currentIndex++;
            await maybeTakeBreak(state);
            state.step = state.currentIndex < state.cases.length ? 'FILL_AND_SEARCH' : 'DONE';
            setState(state);
            showPanel(state);
            window.location.href = SEARCH_URL;
            return;
          }
        }
      }

      const jacket = extractJacket();
      let status = classify(jacket.caseStatus, jacket.caseDisposition);
      const match = state.lastMatch || {};
      let statusNote = buildStatusNote('MATCHED', `score ${match.matchScore || 0}`);
      let dateOk = true;

      if (c.filingDate && jacket.caseInitDate) {
        const candidate = getCurrentSearchCandidate(state);
        const jacketDecision = Core.evaluateJacketMatch({
          filingDate: c.filingDate,
          jacketDate: jacket.caseInitDate,
          currentNameIndex: state.nameIndex || 0,
          names: ensureCaseSearchState(state).map(item => item.name),
          windowDays: candidate && candidate.dateWindowDays ? candidate.dateWindowDays : SEARCH_WINDOW_DAYS,
          hasLockedDocket: !!(c.courtDocketNumber && c.courtStatus && c.courtStatus !== 'RECHECK')
        });
        if (jacketDecision.action === 'next-name') {
          state.nameIndex = jacketDecision.nextNameIndex;
          state.step = 'FILL_AND_SEARCH';
          setState(state);
          showPanel(state);
          setStatusByType('recheck', `DATE MISMATCH | trying next name (${jacketDecision.nextNameIndex + 1}/${ensureCaseSearchState(state).length})`);
          await wait(600);
          window.location.href = SEARCH_URL;
          return;
        }
        if (jacketDecision.action === 'recheck') {
          status = 'RECHECK';
          dateOk = false;
          statusNote = jacketDecision.reason || buildStatusNote('RECHECK_REASON:DATE_MISMATCH', 'date mismatch');
        }
      }

      const label = status === 'OPEN' ? 'OPEN'
        : status === 'CLOSED' ? 'CLOSED'
        : status === 'STAY' ? 'STAY'
        : status === 'RECHECK' ? 'RECHECK'
        : 'UNKNOWN';

      const tone = status === 'OPEN' ? 'open'
        : status === 'CLOSED' ? 'closed'
        : status === 'STAY' ? 'closed'
        : status === 'RECHECK' ? 'recheck'
        : 'info';

      setStatusByType(
        tone,
        `${label} | ${jacket.docketNumber} | ${jacket.caseStatus} / ${jacket.caseDisposition || '-'}${!dateOk ? ' | DATE MISMATCH' : ''}`
      );

      await saveAndAdvance(c.instrumentNumber, {
        courtStatus: status,
        courtStatusRaw: jacket.caseStatus,
        courtDisposition: jacket.caseDisposition,
        courtCaseType: jacket.caseType,
        courtCaseCaption: jacket.caseCaption,
        courtFiledDate: jacket.caseInitDate,
        courtDocketNumber: jacket.docketNumber,
        courtDispositionDate: jacket.dispositionDate,
        courtCaseActions: jacket.courtCaseActions || [],
        courtCaseActionsText: jacket.courtCaseActionsText || '',
        courtCaseActionCount: jacket.courtCaseActionCount || 0,
        courtLatestActionText: jacket.courtLatestActionText || '',
        courtLatestActionDate: jacket.courtLatestActionDate || '',
        courtMatchScore: match.matchScore || 0,
        courtStatusNote: statusNote
      }, state);

      if (status === 'OPEN') state.open++;
      else if (status === 'CLOSED') state.closed++;
      else if (status === 'STAY') state.stay++;
      else if (status === 'RECHECK') state.notFound++;

      state.done++; state.currentIndex++; state.nameIndex = 0;
      await maybeTakeBreak(state);
      setState(state);
      showPanel(state);
      await wait(600);

      if (state.currentIndex < state.cases.length) {
        state.step = 'FILL_AND_SEARCH';
        setState(state);
        window.location.href = SEARCH_URL;
      } else {
        finishRun(state);
      }
      return;
    }

    if (state.step === 'DONE') finishRun(state);
  }

  function finishRun(state) {
    state.step = 'DONE';
    setState(state);
    showPanel(state);
    setStatusByType('info', `Done. Open: ${state.open} | Closed: ${state.closed} | Stay: ${state.stay || 0} | Recheck: ${state.notFound} | Errors: ${state.errors}`);
    clearState();
    clearRecoveryFlag();
    clearBackupState();
  }

  try {
    await wait(1000);
    await loadSearchConfig();
    const state = getState();
    if (state && state.step !== 'DONE') {
      showPanel(state);
      await processState(state);
    } else {
      await showLauncher();
    }
  } catch (e) {
    console.error('CSC ERROR:', e);
  }
})();

