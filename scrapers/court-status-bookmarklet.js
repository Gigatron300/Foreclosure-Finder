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

  const DELAY = 1200;

  // EXACT FIELD IDS FROM NJ COURTS
  const FIELDS = {
    lastName: 'searchByPartyNameForm:partyLName',
    firstName: 'searchByPartyNameForm:partyFName',
    middleName: 'searchByPartyNameForm:partyMName',
    searchButton: 'searchByPartyNameForm:btnPartyNameSearch',
    individualRadio: 'searchByPartyNameForm:partyTypeRadio:0',
    businessRadio: 'searchByPartyNameForm:partyTypeRadio:1'
  };

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
    <h3>⚖️ Court Status Checker v6</h3>
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
    document.getElementById('cs-o').textContent = S.o;
    document.getElementById('cs-c').textContent = S.c;
    document.getElementById('cs-n').textContent = S.n;
    document.getElementById('cs-e').textContent = S.e;
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
    return Math.round(Math.abs(a.getTime() - b.getTime()) / (1000 * 60 * 60 * 24));
  }

  function dateScore(csvDate, siteDate) {
    const d = daysBetween(csvDate, siteDate);
    if (d === null) return 0.10;
    return 1 - Math.min(d, 180) / 180;
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

    const cleaned = s.replace(/\bET AL\b/g, '').replace(/\bHIS WIFE\b|\bHER HUSBAND\b/g, '').replace(/\s+/g, ' ').trim();
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
  // HUMAN-LIKE TYPING - bypasses CAPTCHA detection
  // ─────────────────────────────────────────────────────────────
  async function humanType(fieldId, text) {
    const field = document.getElementById(fieldId);
    if (!field) {
      log(`  ⚠️ Field not found: ${fieldId}`, 'err');
      return false;
    }

    field.focus();
    field.value = '';
    field.dispatchEvent(new Event('focus', { bubbles: true }));

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

  async function humanClear(fieldId) {
    const field = document.getElementById(fieldId);
    if (!field) return;
    field.focus();
    field.value = '';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(50);
  }

  function humanClick(elementId) {
    const el = document.getElementById(elementId);
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
  // Wait for search results
  // ─────────────────────────────────────────────────────────────
  async function waitForResults(timeout = 20000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const tables = document.querySelectorAll('table');
      for (const t of tables) {
        const text = (t.innerText || '').toUpperCase();
        if (text.includes('DOCKET NUMBER') && text.includes('CASE CAPTION') && text.includes('CASE INITIATION')) {
          return { success: true, table: t };
        }
      }

      const bodyText = document.body.innerText.toLowerCase();
      if (bodyText.includes('no cases found') || bodyText.includes('no records found') || bodyText.includes('returned 0 cases')) {
        return { success: true, table: null, noResults: true };
      }

      if (bodyText.includes('captcha verification has failed')) {
        return { success: false, error: 'CAPTCHA blocked' };
      }

      await wait(500);
    }
    return { success: false, error: 'Timeout' };
  }

  // ─────────────────────────────────────────────────────────────
  // Open docket in NEW TAB, extract data, close tab
  // This keeps the main script alive on the search results page
  // ─────────────────────────────────────────────────────────────
  async function extractJacketFromNewTab(href) {
    const newTab = window.open(href, '_blank');
    if (!newTab) {
      return { error: 'Popup blocked - please allow popups for this site' };
    }

    // Wait for page to load
    await wait(3000);

    try {
      const text = newTab.document.body.innerText || '';
      
      const pick = (re) => {
        const m = text.match(re);
        return m ? (m[1] || '').trim() : '';
      };

      const jacket = {
        caseStatus: pick(/Case Status:\s*([^\t\n\r]+)/i),
        caseDisposition: pick(/Case Disposition:\s*([^\t\n\r]+)/i),
        caseCaption: pick(/Case Caption:\s*([^\t\n\r]+)/i),
        caseType: pick(/Case Type:\s*([^\t\n\r]+)/i),
        caseInitiationDate: pick(/Case Initiation Date:\s*(\d{1,2}\/\d{1,2}\/\d{4})/i),
        dispositionDate: pick(/Disposition Date:\s*(\d{1,2}\/\d{1,2}\/\d{4})/i),
        docketNumber: pick(/Docket Number:\s*([^\t\n\r]+)/i),
        venue: pick(/Venue:\s*([^\t\n\r]+)/i)
      };

      newTab.close();
      return { success: true, jacket };
    } catch (e) {
      try { newTab.close(); } catch {}
      return { error: 'Could not read from tab: ' + e.message };
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Perform search
  // ─────────────────────────────────────────────────────────────
  async function doSearch(last, first, mid) {
    log(`  🔍 Searching: "${last}", "${first}" "${mid || ''}"`, 'i');

    const indRadio = document.getElementById(FIELDS.individualRadio);
    if (indRadio && !indRadio.checked) {
      indRadio.click();
      await wait(100);
    }

    await humanClear(FIELDS.lastName);
    await humanClear(FIELDS.firstName);
    await humanClear(FIELDS.middleName);

    log(`  ⌨️ Typing...`, 'i');
    if (!await humanType(FIELDS.lastName, last)) {
      return { success: false, error: 'Could not type last name' };
    }

    if (first) await humanType(FIELDS.firstName, first);
    if (mid) await humanType(FIELDS.middleName, mid);

    await wait(200 + Math.random() * 100);

    log(`  🖱️ Clicking search...`, 'i');
    if (!humanClick(FIELDS.searchButton)) {
      return { success: false, error: 'Could not click search' };
    }

    await wait(1000);
    const result = await waitForResults(20000);

    if (!result.success) return { success: false, error: result.error };
    if (result.noResults) return { success: true, table: null };

    log(`  ✅ Got results!`, 'ok');
    return { success: true, table: result.table };
  }

  // ─────────────────────────────────────────────────────────────
  // Find best match from results
  // ─────────────────────────────────────────────────────────────
  function getRows(table) {
    return Array.from(table.querySelectorAll('tbody tr, tr')).filter(row => row.querySelectorAll('td').length > 0);
  }

  function getLinksFromRow(row) {
    return Array.from(row.querySelectorAll('a')).filter(a => a.href && a.href.includes('civilCaseS'));
  }

  function rowText(row) {
    return cleanText(row ? row.innerText : '');
  }

  async function chooseBestMatch(resultsTable, caseObj) {
    const rows = getRows(resultsTable);
    if (!rows.length) return { notFound: true, reason: 'No rows' };

    const defName = getDefendant(caseObj);
    const plaintiff = getPlaintiff(caseObj);
    const csvDate = getFilingDate(caseObj);

    log(`  📊 ${rows.length} results found`, 'i');

    // Score rows by text matching
    const scored = rows.map((row, idx) => {
      const txt = rowText(row);
      const links = getLinksFromRow(row);
      const defSim = dice(defName, txt);
      const plSim = dice(plaintiff, txt);
      return { idx, row, links, score: (0.65 * defSim) + (0.35 * plSim) };
    }).sort((a, b) => b.score - a.score);

    // Check top candidates by opening in new tab
    const top = scored.slice(0, Math.min(5, scored.length));
    let best = null;

    for (const cand of top) {
      if (window._cscStop) break;
      if (!cand.links.length) continue;

      const href = cand.links[0].href;
      log(`  📂 Checking #${cand.idx + 1} (${(cand.score * 100).toFixed(0)}%)...`, 'i');

      const result = await extractJacketFromNewTab(href);
      
      if (result.error) {
        log(`    ⚠️ ${result.error}`, 'w');
        continue;
      }

      const jacket = result.jacket;
      const initDt = parseAnyDate(jacket.caseInitiationDate);

      const defSim2 = Math.max(cand.score, dice(defName, jacket.caseCaption || ''));
      const plSim2 = dice(plaintiff, jacket.caseCaption || '');
      const dScore = dateScore(csvDate, initDt);
      const finalScore = (0.55 * defSim2) + (0.25 * plSim2) + (0.20 * dScore);

      log(`    → ${jacket.caseStatus}/${jacket.caseDisposition} (${(finalScore * 100).toFixed(0)}%)`, 'i');

      if (!best || finalScore > best.finalScore) {
        best = { finalScore, jacket };
      }

      await wait(500); // Small delay between tabs
    }

    if (!best) return { notFound: true, reason: 'Could not evaluate results' };
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
  log(`✅ Loaded ${cases.length} cases`, 'ok');

  if (!cases.length) {
    log('ℹ️ No cases need checking', 'i');
    return;
  }

  const lastField = document.getElementById(FIELDS.lastName);
  if (!lastField) {
    log('❌ Click "Search By Party Name" tab first!', 'err');
    return;
  }
  log('✅ Ready to search', 'ok');

  for (let i = 0; i < cases.length; i++) {
    if (window._cscStop) { log('⏹ Stopped', 'w'); break; }

    const c = cases[i];
    const instr = getInstrument(c);
    const defName = getDefendant(c);

    log(`\n🔎 [${i + 1}/${cases.length}] ${instr}`, 's');
    log(`  ${defName}`, 'i');

    const parsed = parseDef(defName);
    if (!parsed || !parsed.last) {
      S.e++; S.done++; upd();
      log('  ❌ Could not parse name', 'err');
      await save(instr, { courtStatus: 'ERROR', courtStatusNote: 'Could not parse name' });
      continue;
    }

    const searchResult = await doSearch(parsed.last, parsed.first, parsed.mid);

    if (!searchResult.success) {
      S.e++; S.done++; upd();
      log(`  ❌ ${searchResult.error}`, 'err');
      await save(instr, { courtStatus: 'ERROR', courtStatusNote: searchResult.error });
      if (searchResult.error.includes('CAPTCHA')) {
        log('  ⏸️ Stopping due to CAPTCHA', 'err');
        break;
      }
      continue;
    }

    if (!searchResult.table) {
      S.n++; S.done++; upd();
      log('  ❌ No cases found', 'w');
      await save(instr, { courtStatus: 'NOT_FOUND', courtStatusNote: 'No cases found' });
      continue;
    }

    const match = await chooseBestMatch(searchResult.table, c);

    if (match.notFound) {
      S.n++; S.done++; upd();
      log(`  ❌ ${match.reason}`, 'w');
      await save(instr, { courtStatus: 'NOT_FOUND', courtStatusNote: match.reason });
      continue;
    }

    const j = match.best.jacket;
    const cls = classify(j.caseStatus, j.caseDisposition);

    if (cls.normalized === 'OPEN') S.o++;
    else if (cls.normalized === 'CLOSED') S.c++;
    else S.n++;

    S.done++; upd();

    log(`  ✅ ${cls.normalized}: ${j.caseStatus}/${j.caseDisposition}`, 'ok');

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
      courtStatusNote: `Matched ${(match.best.finalScore * 100).toFixed(0)}%`
    });

    await wait(DELAY);
  }

  log('\n🎉 Done!', 'ok');
})();
