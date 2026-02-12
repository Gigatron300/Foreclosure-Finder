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
  const DELAY = 900;

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
    <h3>⚖️ Court Status Checker</h3>
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

  // date tolerance: CSV can be ~30-45d off; allow 180d but reward closeness
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

    // discard
    if (/(DISMISSED|DISPOSED|SETTLED|TERMINATED|CLOSED|WITH PREJUDICE|WITHOUT PREJUDICE|FINAL JUDGMENT|JUDGMENT|VACATED)/.test(combined)) {
      return { normalized: 'CLOSED', useful: false };
    }

    // keep
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

  function getInstrument(c) { return c.instrumentNumber || ''; }
  function getDefendant(c) { return c.primaryDefendant || ''; }
  function getPlaintiff(c) { return c.primaryPlaintiff || ''; }
  function getFilingDate(c) { return parseAnyDate(c.filingDateISO) || parseAnyDate(c.filingDate) || null; }

  // ─────────────────────────────────────────────────────────────
  // Save result to server
  // FIX: Use "court" prefix on all field names to match dashboard
  // ─────────────────────────────────────────────────────────────
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
  // Hidden iframe
  // ─────────────────────────────────────────────────────────────
  const oldFrame = document.getElementById('csc-hidden-frame');
  if (oldFrame) oldFrame.remove();

  const frame = document.createElement('iframe');
  frame.id = 'csc-hidden-frame';
  frame.style.position = 'fixed';
  frame.style.left = '-99999px';
  frame.style.top = '0';
  frame.style.width = '1200px';
  frame.style.height = '900px';
  frame.style.opacity = '0';
  frame.style.pointerEvents = 'none';
  frame.src = SEARCH_URL;
  document.body.appendChild(frame);

  const docNow = () => frame.contentDocument;
  const winNow = () => frame.contentWindow;

  const waitFrameReady = () =>
    new Promise((resolve, reject) => {
      const t0 = Date.now();
      const tick = () => {
        if (Date.now() - t0 > 30000) return reject(new Error('Iframe timed out loading NJ Courts page'));
        const d = docNow();
        if (d && d.body && d.readyState === 'complete') return resolve();
        setTimeout(tick, 200);
      };
      tick();
    });

  function waitForFrameSettle(timeout = 30000) {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };

      const onLoad = () => setTimeout(finish, 700);
      frame.addEventListener('load', onLoad, { once: true });

      const d = docNow();
      if (d && d.body) {
        const obs = new MutationObserver((muts) => {
          for (const m of muts) {
            if (m.addedNodes.length || m.removedNodes.length) {
              obs.disconnect();
              setTimeout(finish, 700);
              return;
            }
          }
        });
        obs.observe(d.body, { childList: true, subtree: true });
        setTimeout(() => { try { obs.disconnect(); } catch {} finish(); }, timeout);
        return;
      }

      setTimeout(finish, timeout);
    });
  }

  // Make sure Party Name mode is actually loaded before typing
  async function ensurePartyNameMode() {
    for (let attempt = 0; attempt < 4; attempt++) {
      const d = docNow();
      if (!d) { await wait(400); continue; }

      // If fields already exist, we're good
      const lf0 = d.querySelector('input[id*="partyLName"], input[id$="partyLName"]');
      if (lf0) return true;

      // Click the "Search By Party Name" button
      const buttons = Array.from(d.querySelectorAll('a,button,input[type="button"],input[type="submit"]'));
      const btn = buttons.find(el => /search by party name/i.test((el.textContent || el.value || '').trim()));
      if (btn) btn.click();

      await waitForFrameSettle(25000);
      await wait(300);
    }
    return false;
  }

  function findResultsTable() {
    const d = docNow();
    if (!d) return null;
    const tables = Array.from(d.querySelectorAll('table'));
    for (const t of tables) {
      const txt = cleanText(t.innerText);
      if (txt.includes('DOCKET NUMBER') && txt.includes('CASE CAPTION') && txt.includes('CASE INITIATION DATE')) return t;
    }
    return null;
  }

  function getRows(table) {
    return Array.from(table.querySelectorAll('tbody tr'));
  }

  function docketLinkInRow(row) {
    const links = Array.from(row.querySelectorAll('a'));
    const docketRe = /\b([A-Z]{1,4}\s*)?F[-\s]?\d{3,7}[-\s]?\d{2}\b/i;
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
    const d = docNow();
    const text = d && d.body ? d.body.innerText : '';
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
    const d = docNow();
    if (!d) return;
    const buttons = Array.from(d.querySelectorAll('a,button,input[type="button"],input[type="submit"]'));
    const backBtn =
      buttons.find(el => /^back$/i.test((el.textContent || el.value || '').trim())) ||
      buttons.find(el => /back/i.test((el.textContent || el.value || '').trim()));
    if (backBtn) backBtn.click();
    else { try { winNow().history.back(); } catch {} }
    await waitForFrameSettle(25000);
    await wait(250);
  }

  async function search(last, first, mid) {
    const ok = await ensurePartyNameMode();
    if (!ok) return null;

    let d = docNow();
    const w = winNow();
    if (!d || !w) return null;

    const lf = d.querySelector('input[id*="partyLName"], input[id$="partyLName"]');
    const ff = d.querySelector('input[id*="partyFName"], input[id$="partyFName"]');
    const mf = d.querySelector('input[id*="partyMName"], input[id$="partyMName"]');
    if (!lf || !ff || !mf) return null;

    const setter = Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, 'value').set;
    const setVal = (el, val) => {
      setter.call(el, val);
      el.dispatchEvent(new w.Event('input', { bubbles: true }));
      el.dispatchEvent(new w.Event('change', { bubbles: true }));
    };

    setVal(lf, ''); setVal(ff, ''); setVal(mf, '');
    await wait(100);

    setVal(lf, last); setVal(ff, first); setVal(mf, mid || '');
    await wait(150);

    const buttons = Array.from(d.querySelectorAll('button,input[type="submit"],input[type="button"]'));
    const searchBtn = buttons.find(el => /^search$/i.test((el.textContent || el.value || '').trim())) ||
                      buttons.find(el => /search/i.test((el.textContent || el.value || '').trim()));
    if (!searchBtn) return null;

    searchBtn.click();
    await waitForFrameSettle(30000);
    await wait(250);

    return findResultsTable();
  }

  // When multiple rows exist, click into each top row and decide using JACKET initiation date + caption
  async function chooseBestByOpeningJackets(resultsTable, caseObj) {
    const rows = getRows(resultsTable);
    if (!rows.length) return { notFound: true, reason: 'No rows' };

    const defName = getDefendant(caseObj);
    const plaintiff = getPlaintiff(caseObj);
    const csvDate = getFilingDate(caseObj);

    // initial rough rank so we only open a few
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

      link.click();
      await waitForFrameSettle(30000);
      await wait(250);

      const jacket = extractJacket();
      const initDt = parseAnyDate(jacket.caseInitiationDate);
      const cap = jacket.caseCaption || '';

      const defSim2 = Math.max(cand.score, dice(defName, cap));
      const plSim2 = dice(plaintiff, cap);
      const dScore = dateScore(csvDate, initDt);

      // FINAL score now uses jacket initiation date (fixes 2024 vs 2026)
      const finalScore = (0.55 * defSim2) + (0.25 * plSim2) + (0.20 * dScore);

      if (!best || finalScore > best.finalScore) {
        best = { finalScore, jacket };
      }

      await clickBack(); // back to results list
    }

    if (!best) return { notFound: true, reason: 'Could not open any jackets' };
    return { notFound: false, best };
  }

  // ─────────────────────────────────────────────────────────────
  // Main
  // ─────────────────────────────────────────────────────────────
  log('🧱 Loading hidden NJ Courts session (iframe)...', 's');
  try { await waitFrameReady(); }
  catch (e) { log(`❌ Iframe failed: ${e.message}`, 'err'); return; }

  log('📡 Fetching cases from your server...', 's');

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

  // Filter to only cases that haven't been checked yet
  // FIX: Check for courtStatus field (with "court" prefix)
  cases = cases.filter(c => {
    const cs = c.courtStatus || '';
    return !cs || cs === 'NOT_FOUND' || cs === 'ERROR';
  });

  if (TEST_MODE) cases = cases.slice(0, 10);

  S.total = cases.length;
  upd();
  log(`✅ Loaded ${cases.length} cases to check`, 'ok');

  for (let i = 0; i < cases.length; i++) {
    if (window._cscStop) { log('⏹ Stopped', 'w'); break; }

    const c = cases[i];
    const instr = getInstrument(c);
    const defName = getDefendant(c);
    const plaintiff = getPlaintiff(c);
    const csvDate = getFilingDate(c);

    log(`\n🔎 [${i + 1}/${cases.length}] ${instr}`, 's');
    log(`  Defendant: ${defName}`, 'i');
    log(`  Plaintiff: ${plaintiff}`, 'i');
    if (csvDate) log(`  Filing date: ${csvDate.toLocaleDateString()}`, 'i');

    const parsed = parseDef(defName);
    if (!parsed || !parsed.last) {
      S.e++; S.done++; upd();
      log('  ❌ Could not parse defendant', 'err');
      // FIX: Use courtStatus field name (with "court" prefix)
      await save(instr, { 
        courtStatus: 'ERROR', 
        courtStatusNote: 'Could not parse defendant name'
      });
      continue;
    }

    const table = await search(parsed.last, parsed.first, parsed.mid);
    if (!table) {
      S.e++; S.done++; upd();
      log('  ❌ Search failed (no results table)', 'err');
      // FIX: Use courtStatus field name (with "court" prefix)
      await save(instr, { 
        courtStatus: 'ERROR', 
        courtStatusNote: 'Search failed - no results table returned'
      });
      continue;
    }

    const choice = await chooseBestByOpeningJackets(table, c);
    if (choice.notFound) {
      S.n++; S.done++; upd();
      log(`  ❌ NOT_FOUND (${choice.reason})`, 'w');
      // FIX: Use courtStatus field name (with "court" prefix)
      await save(instr, { 
        courtStatus: 'NOT_FOUND', 
        courtStatusNote: choice.reason
      });
      continue;
    }

    const j = choice.best.jacket;
    const cls = classify(j.caseStatus, j.caseDisposition);

    if (cls.normalized === 'OPEN') S.o++;
    else if (cls.normalized === 'CLOSED') S.c++;
    else S.n++;

    S.done++; upd();

    log(`  ✅ Jacket: status="${j.caseStatus}" disposition="${j.caseDisposition}" → ${cls.normalized}`, 'ok');

    // FIX: Use "court" prefix on ALL field names to match dashboard expectations
    await save(instr, {
      courtStatus: cls.normalized,
      courtStatusRaw: j.caseStatus || '',
      courtDisposition: j.caseDisposition || '',
      courtCaseType: j.caseType || '',
      courtCaseCaption: j.caseCaption || '',
      courtFiledDate: j.caseInitiationDate || '',
      courtDispositionDate: j.dispositionDate || '',
      courtDocketNumber: j.docketNumber || '',
      courtMatchScore: choice.best.finalScore || null,
      courtStatusNote: `Matched with score ${(choice.best.finalScore * 100).toFixed(0)}%`
    });

    await wait(DELAY);
  }

  log('\n🎉 Done!', 'ok');
})();
