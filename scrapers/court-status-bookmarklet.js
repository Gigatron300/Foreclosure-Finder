(async function () {
  'use strict';

  const SERVER = '__SERVER_URL__';
  const TOKEN = '__AUTH_TOKEN__';
  const TEST_MODE = __TEST_MODE__;

  // Safety check: only run on NJ Courts Civil Case Search page
  const HOST_OK =
    window.location.href.includes('njcourts.gov') &&
    window.location.href.toLowerCase().includes('civilcasesearch');

  if (!HOST_OK) {
    alert('❌ Navigate to NJ Courts "Search Civil and Foreclosure Cases" first!');
    return;
  }

  const SEARCH_URL = window.location.href.split('?')[0];
  const DELAY = 1500;

  // ─────────────────────────────────────────────────────────────
  // UI Panel (lives on the main page; will not disappear)
  // ─────────────────────────────────────────────────────────────
  if (document.getElementById('csc-panel')) document.getElementById('csc-panel').remove();

  const panel = document.createElement('div');
  panel.id = 'csc-panel';
  panel.innerHTML = `
    <style>
      #csc-panel { position:fixed;top:8px;right:8px;width:380px;z-index:99999;background:#0f172a;color:#e2e8f0;border-radius:10px;padding:14px;font-family:system-ui,sans-serif;font-size:12px;box-shadow:0 4px 24px rgba(0,0,0,.6);border:1px solid #334155;max-height:85vh;display:flex;flex-direction:column; }
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
    if (fill) fill.style.width = p + '%';
    if (status) status.textContent = `${S.done}/${S.total} (${p}%)`;
    const o = document.getElementById('cs-o');
    const c = document.getElementById('cs-c');
    const n = document.getElementById('cs-n');
    const e = document.getElementById('cs-e');
    if (o) o.textContent = S.o;
    if (c) c.textContent = S.c;
    if (n) n.textContent = S.n;
    if (e) e.textContent = S.e;
  };

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // ─────────────────────────────────────────────────────────────
  // Text utilities + matching
  // ─────────────────────────────────────────────────────────────
  function cleanText(s) {
    return String(s || '')
      .toUpperCase()
      .replace(/&/g, ' AND ')
      .replace(/[^\w\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function tokens(s) {
    const stop = new Set([
      'THE','A','AN','OF','AND','OR','TO','IN','ON','FOR','AT','BY','WITH',
      'LLC','INC','CORP','CORPORATION','CO','COMPANY','N','A','NA','FKA','AKA'
    ]);
    return cleanText(s)
      .split(' ')
      .filter(t => t && t.length > 1 && !stop.has(t));
  }

  // Dice coefficient (0..1)
  function dice(a, b) {
    const A = tokens(a);
    const B = tokens(b);
    if (!A.length || !B.length) return 0;
    const setB = new Set(B);
    let inter = 0;
    for (const t of A) if (setB.has(t)) inter++;
    return (2 * inter) / (A.length + B.length);
  }

  function parseAnyDate(s) {
    if (!s) return null;
    const str = String(s);

    const m = str.match(/(\d{2})\/(\d{2})\/(\d{4})/);
    if (m) {
      const mm = Number(m[1]), dd = Number(m[2]), yy = Number(m[3]);
      const dt = new Date(yy, mm - 1, dd);
      return isNaN(dt.getTime()) ? null : dt;
    }

    const i = str.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (i) {
      const yy = Number(i[1]), mm = Number(i[2]), dd = Number(i[3]);
      const dt = new Date(yy, mm - 1, dd);
      return isNaN(dt.getTime()) ? null : dt;
    }

    return null;
  }

  function daysBetween(a, b) {
    if (!a || !b) return null;
    const ms = Math.abs(a.getTime() - b.getTime());
    return Math.round(ms / (1000 * 60 * 60 * 24));
  }

  // Date proximity score (tolerant up to 120d)
  function dateScore(csvDate, siteDate) {
    const d = daysBetween(csvDate, siteDate);
    if (d === null) return 0.15; // small non-zero if missing
    const cap = 120;
    const x = Math.min(d, cap);
    return 1 - x / cap;
  }

  function normStatus(s) {
    if (!s) return 'UNKNOWN';
    const u = String(s).toUpperCase();
    if (/CLOSED|DISMISSED|DISPOSED|SETTLED|TERMINATED/.test(u)) return 'CLOSED';
    if (/OPEN|ACTIVE|PENDING/.test(u)) return 'OPEN';
    return 'UNKNOWN';
  }

  // Robust defendant parsing for NJ Courts Party Name tab.
  // Your CSV recipient names are often "LAST FIRST" (no comma).
  function parseDef(name) {
    const s = cleanText(name);
    if (!s) return null;

    const cleaned = s
      .replace(/\bET AL\b/g, '')
      .replace(/\bHIS WIFE\b|\bHER HUSBAND\b/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (!cleaned) return null;

    // Entity: search with whole string in last-name field
    if (/\b(LLC|INC|CORP|CORPORATION|CO|COMPANY|BANK|TRUST|AGENCY|AUTHORITY|MORTGAGE|FINANCE|ASSOCIATION|ASSN|HOUSING|SERVICING|SERVICES)\b/.test(cleaned)) {
      return { last: cleaned, first: '', mid: '' };
    }

    // "LAST, FIRST"
    if (cleaned.includes(',')) {
      const [lastPart, rest] = cleaned.split(',', 2);
      const restParts = (rest || '').trim().split(' ').filter(Boolean);
      return { last: lastPart.trim(), first: restParts[0] || '', mid: restParts[1] || '' };
    }

    // "LAST FIRST" (your CSV convention)
    const parts = cleaned.split(' ').filter(Boolean);
    if (parts.length === 1) return { last: parts[0], first: '', mid: '' };
    return { last: parts[0], first: parts[1] || '', mid: parts[2] || '' };
  }

  // ─────────────────────────────────────────────────────────────
  // CSV-row grouping using your Party Code rule:
  // R = recipient (defendant)
  // D = serving party (plaintiff)
  // Group by Instr#
  // ─────────────────────────────────────────────────────────────
  function getInstrumentNumber(row) {
    return (
      row.instrumentNumber ||
      row.instrument_number ||
      row.instrument ||
      row['Instr#'] ||
      row['Instr #'] ||
      row['Instr'] ||
      ''
    );
  }

  function getPartyCode(row) {
    return String(row['Party Code'] || row.partyCode || row.party_code || '').trim().toUpperCase();
  }

  function getRowName(row) {
    return String(row['Name'] || row.name || '').trim();
  }

  function getRowCrossName(row) {
    return String(row['Cross Name'] || row.crossName || row.cross_name || '').trim();
  }

  function getRowDate(row) {
    return parseAnyDate(row['Date'] || row.date || row.filingDate || row.filing_date || null);
  }

  function uniqJoin(names) {
    const out = [];
    const seen = new Set();
    for (const n of (names || []).map(x => (x || '').trim()).filter(Boolean)) {
      const key = cleanText(n);
      if (!seen.has(key)) {
        seen.add(key);
        out.push(n);
      }
    }
    return out.join(' | ');
  }

  function groupRowsToCases(rawRows) {
    const byInstr = new Map();

    for (const row of rawRows || []) {
      const instr = getInstrumentNumber(row);
      if (!instr) continue;

      if (!byInstr.has(instr)) {
        byInstr.set(instr, {
          instrumentNumber: instr,
          filingDate: null,
          defendants: [],
          plaintiffs: [],
          _rows: []
        });
      }

      const grp = byInstr.get(instr);
      grp._rows.push(row);

      const pc = getPartyCode(row);
      const name = getRowName(row);
      const cross = getRowCrossName(row);

      // Per your confirmed rule:
      if (pc === 'R') {
        if (name) grp.defendants.push(name);
        // cross may contain plaintiff in some row formats; keep as optional extra signal
        if (cross) grp.plaintiffs.push(cross);
      } else if (pc === 'D') {
        // Serving party often appears in Cross Name on your file
        if (cross) grp.plaintiffs.push(cross);
        if (name) grp.plaintiffs.push(name);
      }

      const dt = getRowDate(row);
      if (!grp.filingDate && dt) grp.filingDate = dt;
    }

    const cases = [];
    for (const grp of byInstr.values()) {
      cases.push({
        instrumentNumber: grp.instrumentNumber,
        filingDate: grp.filingDate,
        defendantName: uniqJoin(grp.defendants),
        plaintiffName: uniqJoin(grp.plaintiffs),
        _rows: grp._rows
      });
    }
    return cases;
  }

  // ─────────────────────────────────────────────────────────────
  // Server save
  // ─────────────────────────────────────────────────────────────
  async function save(instrumentNumber, courtData) {
    try {
      await fetch(`${SERVER}/api/camden/court-status-update`, {
        method: 'POST',
        headers: { 'X-Auth-Token': TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ instrumentNumber, courtData })
      });
    } catch (e) {
      log(`  ⚠ Save fail: ${e.message}`, 'w');
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Hidden IFRAME: all NJ Courts navigation happens here
  // (so the dock never disappears)
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

  const waitFrameReady = () =>
    new Promise((resolve, reject) => {
      const t0 = Date.now();
      const tick = () => {
        if (Date.now() - t0 > 25000) return reject(new Error('Iframe timed out loading NJ Courts page'));
        const w = frame.contentWindow;
        const d = frame.contentDocument;
        if (w && d && d.body && d.readyState === 'complete') return resolve();
        setTimeout(tick, 200);
      };
      tick();
    });

  function waitForFrameUpdate(timeout = 25000) {
    return new Promise((resolve) => {
      const d = frame.contentDocument;
      if (!d || !d.body) return resolve();

      let done = false;
      const finish = () => {
        if (!done) {
          done = true;
          resolve();
        }
      };

      const obs = new MutationObserver((mutations) => {
        for (const m of mutations) {
          if (m.addedNodes.length > 3 || m.removedNodes.length > 3) {
            obs.disconnect();
            setTimeout(finish, 1200);
            return;
          }
        }
      });

      obs.observe(d.body, { childList: true, subtree: true });
      setTimeout(() => {
        try { obs.disconnect(); } catch {}
        finish();
      }, timeout);
    });
  }

  function clickPartyTabInFrame() {
    const d = frame.contentDocument;
    const t = d && d.querySelector('a[href="#tabs-2"]');
    if (t) t.click();
  }

  async function goBackToResultsInFrame() {
    const d = frame.contentDocument;
    if (!d) return;

    const candidates = Array.from(d.querySelectorAll('a,button,input[type="button"],input[type="submit"]'));
    const backBtn =
      candidates.find((el) => /back to search results/i.test((el.textContent || el.value || '').trim())) ||
      candidates.find((el) => /search results/i.test((el.textContent || el.value || '').trim()) && /back/i.test((el.textContent || el.value || '').trim())) ||
      candidates.find((el) => /^back$/i.test((el.textContent || el.value || '').trim()));

    if (backBtn) {
      backBtn.click();
      await waitForFrameUpdate();
      await wait(800);
      return;
    }

    try { frame.contentWindow.history.back(); } catch {}
    await waitForFrameUpdate();
    await wait(800);
  }

  async function searchInFrame(last, first, mid) {
    const d = frame.contentDocument;
    const w = frame.contentWindow;
    if (!d || !w) return null;

    clickPartyTabInFrame();
    await wait(800);

    const lf = d.getElementById('searchByPartyNameForm:partyLName');
    const ff = d.getElementById('searchByPartyNameForm:partyFName');
    const mf = d.getElementById('searchByPartyNameForm:partyMName');
    if (!lf) return null;

    const setter = Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, 'value').set;

    const setVal = (el, val) => {
      setter.call(el, val);
      el.dispatchEvent(new w.Event('input', { bubbles: true }));
      el.dispatchEvent(new w.Event('change', { bubbles: true }));
    };

    setVal(lf, '');
    setVal(ff, '');
    setVal(mf, '');
    await wait(150);

    setVal(lf, last);
    setVal(ff, first);
    setVal(mf, mid || '');
    await wait(500);

    const btn = d.getElementById('searchByPartyNameForm:btnPartyNameSearch');
    if (!btn) return null;

    btn.click();

    // May trigger full navigation inside iframe
    await wait(250);
    await waitForFrameUpdate(25000);
    await wait(800);

    return d.getElementById('searchByPartyNameForm:idPartyTable');
  }

  function extractRowSignals(rowEl) {
    const t = cleanText(rowEl ? rowEl.innerText : '');
    const dates = t.match(/\d{2}\/\d{2}\/\d{4}/g) || [];
    const firstDate = dates.length ? parseAnyDate(dates[0]) : null;
    return { rowText: t, caption: t, firstDate };
  }

  async function getDetailsInFrame(rowIdx) {
    const d = frame.contentDocument;
    if (!d) return null;

    const linkId = `searchByPartyNameForm:idPartyTable:${rowIdx}:lnkSrchByDocNum`;
    const link = d.getElementById(linkId);
    if (!link) return null;

    link.click();
    await waitForFrameUpdate(25000);
    await wait(500);

    const text = d.body ? d.body.innerText : '';
    const gm = (p) => {
      const m = text.match(p);
      return m ? (m[1] || '').trim() : '';
    };

    const details = {
      status: gm(/Case Status:\s*(\S+)/),
      disposition: gm(/Case Disposition:\s*(.+?)(?:\n|Case|Court|Venue|$)/),
      caseType: gm(/Case Type:\s*(.+?)(?:\n|Case|$)/),
      caption: gm(/Case Caption:\s*(.+?)(?:\n|Court|$)/),
      initDate: gm(/Case Initiation Date:\s*(\d{2}\/\d{2}\/\d{4})/),
      dispDate: gm(/Disposition Date:\s*(\d{2}\/\d{2}\/\d{4})/)
    };

    await goBackToResultsInFrame();
    clickPartyTabInFrame();
    await wait(500);

    return details;
  }

  // Best-match selection based on:
  // - Defendant similarity
  // - Plaintiff similarity
  // - Date proximity (CSV filing date vs NJ Courts initiation date)
  async function pickBestMatch(table, caseObj) {
    const d = frame.contentDocument;
    if (!d || !table) return null;

    const rows = Array.from(table.querySelectorAll('tbody tr'));
    if (!rows.length) return null;

    const defName = caseObj.defendantName || '';
    const plaintiff = caseObj.plaintiffName || '';
    const csvDate = caseObj.filingDate || null;

    // 1) quick scoring from row text
    const prelim = rows
      .map((row, idx) => {
        const sig = extractRowSignals(row);
        const defSim = dice(defName, sig.caption);
        const plSim = dice(plaintiff, sig.caption);
        const dScore = dateScore(csvDate, sig.firstDate);
        const score = (0.55 * defSim) + (0.30 * plSim) + (0.15 * dScore);
        return { idx, score, defSim, plSim, dScore, firstDate: sig.firstDate };
      })
      .sort((a, b) => b.score - a.score);

    const topK = Math.min(6, prelim.length);
    const candidates = prelim.slice(0, topK);

    log(`  🔎 ${rows.length} results → checking top ${topK} jackets`, 'i');

    // 2) refine by opening jackets
    let best = null;

    for (const cand of candidates) {
      if (window._cscStop) break;

      const details = await getDetailsInFrame(cand.idx);
      if (!details) continue;

      const cap = details.caption || '';
      const initDt = parseAnyDate(details.initDate) || null;

      const defSim2 = Math.max(cand.defSim, dice(defName, cap));
      const plSim2 = Math.max(cand.plSim, dice(plaintiff, cap));
      const dScore2 = dateScore(csvDate, initDt);

      const finalScore = (0.55 * defSim2) + (0.30 * plSim2) + (0.15 * dScore2);

      log(
        `  • row ${cand.idx + 1}: score=${finalScore.toFixed(3)} (def=${defSim2.toFixed(2)} pl=${plSim2.toFixed(2)} date=${dScore2.toFixed(2)})`,
        'i'
      );

      if (!best || finalScore > best.finalScore) {
        best = { rowIdx: cand.idx, details, finalScore };
      }
    }

    if (!best) return null;

    // Low-confidence cutoff (adjust if you want it to always pick something)
    if (best.finalScore < 0.32) {
      return { notFound: true, best };
    }

    return { notFound: false, best };
  }

  // ─────────────────────────────────────────────────────────────
  // Main: fetch rows → group by instrument → search NJ Courts
  // ─────────────────────────────────────────────────────────────
  log('🧱 Loading hidden NJ Courts session (iframe)...', 's');

  try {
    await waitFrameReady();
  } catch (e) {
    log(`❌ Iframe failed: ${e.message}`, 'err');
    return;
  }

  log('📡 Fetching cases from your server...', 's');

  let rawRows = [];
  try {
    const r = await fetch(`${SERVER}/api/camden?sortBy=daysSinceFiling&sortOrder=desc`, {
      headers: { 'X-Auth-Token': TOKEN }
    });
    const data = await r.json();
    rawRows = (data.cases || []);
  } catch (e) {
    log(`❌ Could not fetch cases: ${e.message}`, 'err');
    return;
  }

  // Group by Instr# using Party Code rule
  let cases = groupRowsToCases(rawRows);

  // (Optional) only keep ones missing status — but if server doesn’t store status on grouped,
  // this won’t filter anything. Keeping them all is safe; you can re-enable if your server stores.
  cases = cases.filter(c => c.instrumentNumber);

  if (TEST_MODE) cases = cases.slice(0, 10);

  S.total = cases.length;
  upd();

  log(`✅ Loaded ${cases.length} instrument groups to check`, 'ok');

  for (let i = 0; i < cases.length; i++) {
    if (window._cscStop) {
      log('⏹ Stopped by user', 'w');
      break;
    }

    const c = cases[i];
    const instr = c.instrumentNumber;
    const defName = c.defendantName || '';
    const plaintiff = c.plaintiffName || '';
    const csvDate = c.filingDate || null;

    log(`\n🔎 [${i + 1}/${cases.length}] ${instr}`, 's');
    log(`  Defendant (R): ${defName || '(missing)'}`, 'i');
    log(`  Plaintiff (D): ${plaintiff || '(missing)'}`, 'i');
    if (csvDate) log(`  CSV Date: ${csvDate.toLocaleDateString()}`, 'i');

    // If multiple defendants, search using first (NJ Courts search works best this way)
    const primaryDef = (defName.split('|')[0] || '').trim();
    const parsed = parseDef(primaryDef);

    if (!parsed || !parsed.last) {
      S.e++; S.done++; upd();
      log('  ❌ Could not parse defendant name (R)', 'err');
      await save(instr, { status: 'ERROR', message: 'Could not parse defendant name (R)', defendantName: defName, plaintiffName: plaintiff });
      continue;
    }

    const table = await searchInFrame(parsed.last, parsed.first, parsed.mid);
    if (!table) {
      S.e++; S.done++; upd();
      log('  ❌ Search failed (table not found)', 'err');
      await save(instr, { status: 'ERROR', message: 'Search failed (table not found)' });
      continue;
    }

    const rows = table.querySelectorAll('tbody tr');
    if (!rows || rows.length === 0) {
      S.n++; S.done++; upd();
      log('  ❌ No results found', 'w');
      await save(instr, { status: 'NOT_FOUND', defendantName: defName, plaintiffName: plaintiff, filingDate: csvDate ? csvDate.toISOString() : null });
      continue;
    }

    const pick = await pickBestMatch(table, c);
    if (!pick) {
      S.e++; S.done++; upd();
      log('  ❌ Could not evaluate candidates', 'err');
      await save(instr, { status: 'ERROR', message: 'Could not evaluate candidates' });
      continue;
    }

    if (pick.notFound) {
      S.n++; S.done++; upd();
      log(`  ⚠ Low-confidence match (best score=${pick.best.finalScore.toFixed(3)}) → NOT_FOUND`, 'w');
      await save(instr, {
        status: 'NOT_FOUND',
        message: `Low-confidence match score=${pick.best.finalScore.toFixed(3)}`,
        defendantName: defName,
        plaintiffName: plaintiff,
        filingDate: csvDate ? csvDate.toISOString() : null
      });
      continue;
    }

    const details = pick.best.details;
    const normalized = normStatus(details.status);

    if (normalized === 'OPEN') S.o++;
    else if (normalized === 'CLOSED') S.c++;
    else S.n++;

    S.done++; upd();

    log(`  ✅ Best match score=${pick.best.finalScore.toFixed(3)} → ${normalized}`, 'ok');

    await save(instr, {
      status: normalized,
      rawStatus: details.status || '',
      disposition: details.disposition || '',
      caseType: details.caseType || '',
      caption: details.caption || '',
      initiationDate: details.initDate || '',
      dispositionDate: details.dispDate || '',
      matchScore: pick.best.finalScore,
      defendantName: defName,
      plaintiffName: plaintiff,
      filingDate: csvDate ? csvDate.toISOString() : null
    });

    await wait(DELAY);
  }

  log('\n🎉 Done!', 'ok');
})();
