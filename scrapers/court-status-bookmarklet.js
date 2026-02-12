(async function () {
  'use strict';

  const SERVER = '__SERVER_URL__';
  const TOKEN = '__AUTH_TOKEN__';
  const TEST_MODE = __TEST_MODE__;

  const HOST_OK =
    window.location.href.includes('njcourts.gov') &&
    window.location.href.includes('civilCaseSearch');

  if (!HOST_OK) {
    alert('❌ Navigate to "Search Civil and Foreclosure Cases" on NJ Courts first!');
    return;
  }

  const SEARCH_URL = window.location.href.split('?')[0];
  const DELAY = 2000;

  // ─────────────────────────────────────────────────────────────
  // UI Panel (lives on the main page and never disappears now)
  // ─────────────────────────────────────────────────────────────
  if (document.getElementById('csc-panel')) document.getElementById('csc-panel').remove();

  const panel = document.createElement('div');
  panel.id = 'csc-panel';
  panel.innerHTML = `
    <style>
      #csc-panel { position:fixed;top:8px;right:8px;width:360px;z-index:99999;background:#0f172a;color:#e2e8f0;border-radius:10px;padding:14px;font-family:system-ui,sans-serif;font-size:12px;box-shadow:0 4px 24px rgba(0,0,0,.6);border:1px solid #334155;max-height:85vh;display:flex;flex-direction:column; }
      #csc-panel h3{margin:0 0 6px;color:#38bdf8;font-size:14px}
      #csc-bar{height:5px;background:#1e293b;border-radius:3px;margin:6px 0;overflow:hidden}
      #csc-fill{height:100%;width:0%;background:linear-gradient(90deg,#38bdf8,#818cf8);border-radius:3px;transition:width .3s}
      #csc-stats{display:flex;gap:10px;color:#94a3b8;margin:4px 0;flex-wrap:wrap}
      #csc-stats b.g{color:#4ade80} #csc-stats b.r{color:#f87171} #csc-stats b.y{color:#fbbf24}
      #csc-log{background:#0a0f1a;border-radius:6px;padding:8px;flex:1;overflow-y:auto;font-family:monospace;font-size:11px;line-height:1.5;margin-top:6px;max-height:50vh}
      .l-ok{color:#4ade80}.l-err{color:#f87171}.l-w{color:#fbbf24}.l-i{color:#94a3b8}.l-s{color:#38bdf8}
      #csc-btns{margin-top:6px;display:flex;gap:6px}
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
    d.innerHTML += `<div class="l-${cls}">${m}</div>`;
    d.scrollTop = d.scrollHeight;
  };

  const upd = () => {
    const p = S.total > 0 ? Math.round((S.done / S.total) * 100) : 0;
    document.getElementById('csc-fill').style.width = p + '%';
    document.getElementById('csc-status').textContent = `${S.done}/${S.total} (${p}%)`;
    document.getElementById('cs-o').textContent = S.o;
    document.getElementById('cs-c').textContent = S.c;
    document.getElementById('cs-n').textContent = S.n;
    document.getElementById('cs-e').textContent = S.e;
  };

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // ─────────────────────────────────────────────────────────────
  // Hidden IFRAME (all NJ Courts navigation happens here)
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
        if (Date.now() - t0 > 20000) return reject(new Error('Iframe timed out loading NJ Courts page'));
        const w = frame.contentWindow;
        const d = frame.contentDocument;
        if (w && d && d.body && d.readyState === 'complete') return resolve();
        setTimeout(tick, 200);
      };
      tick();
    });

  function waitForFrameUpdate(timeout = 15000) {
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

  function parseDef(name) {
    if (!name) return null;
    const p = name
      .toUpperCase()
      .replace(/\b(JR|SR|II|III|IV)\b\.?/g, '')
      .trim()
      .split(/\s+/)
      .filter((x) => x);
    return p.length ? { last: p[0], first: p[1] || '', mid: p[2] || '' } : null;
  }

  function normStatus(s) {
    if (!s) return 'UNKNOWN';
    const u = String(s).toUpperCase();
    if (/CLOSED|DISMISSED|DISPOSED|SETTLED|TERMINATED/.test(u)) return 'CLOSED';
    if (/OPEN|ACTIVE|PENDING/.test(u)) return 'OPEN';
    return 'UNKNOWN';
  }

  async function save(instrNum, data) {
    try {
      await fetch(`${SERVER}/api/camden/court-status-update`, {
        method: 'POST',
        headers: { 'X-Auth-Token': TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ instrumentNumber: instrNum, courtData: data }),
      });
    } catch (e) {
      log(`  ⚠ Save fail: ${e.message}`, 'w');
    }
  }

  // More reliable than history.back() in JSF land: click real "Back" control if it exists
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

    // fallback
    try {
      frame.contentWindow.history.back();
    } catch {}
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

    // clear
    setter.call(lf, '');
    lf.dispatchEvent(new w.Event('change', { bubbles: true }));
    setter.call(ff, '');
    ff.dispatchEvent(new w.Event('change', { bubbles: true }));
    setter.call(mf, '');
    mf.dispatchEvent(new w.Event('change', { bubbles: true }));
    await wait(150);

    // fill
    setter.call(lf, last);
    lf.dispatchEvent(new w.Event('input', { bubbles: true }));
    lf.dispatchEvent(new w.Event('change', { bubbles: true }));
    setter.call(ff, first);
    ff.dispatchEvent(new w.Event('input', { bubbles: true }));
    ff.dispatchEvent(new w.Event('change', { bubbles: true }));
    setter.call(mf, mid || '');
    mf.dispatchEvent(new w.Event('input', { bubbles: true }));
    mf.dispatchEvent(new w.Event('change', { bubbles: true }));

    await wait(500);

    const btn = d.getElementById('searchByPartyNameForm:btnPartyNameSearch');
    if (!btn) return null;

    btn.click();

    // IMPORTANT: this may trigger a full navigation *inside the iframe*.
    // Wait for iframe to settle post-search.
    await wait(250);
    await waitForFrameUpdate(20000);
    await wait(800);

    const table = d.getElementById('searchByPartyNameForm:idPartyTable');
    return table;
  }

  async function getDetailsInFrame(rowIdx) {
    const d = frame.contentDocument;
    if (!d) return null;

    const linkId = `searchByPartyNameForm:idPartyTable:${rowIdx}:lnkSrchByDocNum`;
    const link = d.getElementById(linkId);
    if (!link) return null;

    link.click();
    await waitForFrameUpdate(20000);
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
      dispDate: gm(/Disposition Date:\s*(\d{2}\/\d{2}\/\d{4})/),
    };

    await goBackToResultsInFrame();
    clickPartyTabInFrame();
    await wait(500);

    return details;
  }

  // ─────────────────────────────────────────────────────────────
  // Main
  // ─────────────────────────────────────────────────────────────
  log('🧱 Loading hidden NJ Courts session (iframe)...', 's');

  try {
    await waitFrameReady();
  } catch (e) {
    log(`❌ Iframe failed: ${e.message}`, 'err');
    return;
  }

  log('📡 Fetching cases from your server...', 's');

  let cases = [];
  try {
    const r = await fetch(`${SERVER}/api/camden?sortBy=daysSinceFiling&sortOrder=desc`, {
      headers: { 'X-Auth-Token': TOKEN },
    });
    const data = await r.json();
    cases = (data.cases || []).filter(
      (c) => !c.courtStatus || c.courtStatus === 'NOT_FOUND' || c.courtStatus === 'ERROR'
    );
  } catch (e) {
    log(`❌ Could not fetch cases: ${e.message}`, 'err');
    return;
  }

  if (TEST_MODE) cases = cases.slice(0, 10);

  S.total = cases.length;
  upd();

  log(`✅ Loaded ${cases.length} cases to check`, 'ok');

  for (let i = 0; i < cases.length; i++) {
    if (window._cscStop) {
      log('⏹ Stopped by user', 'w');
      break;
    }

    const c = cases[i];
    const instr = c.instrumentNumber || c.instrument_number || c.instrument || '';
    const defName = c.defendantName || c.defendant || c.name || '';

    log(`\n🔎 [${i + 1}/${cases.length}] ${instr} — ${defName}`, 's');

    const def = parseDef(defName);
    if (!def) {
      S.e++;
      S.done++;
      upd();
      log('  ❌ Could not parse defendant name', 'err');
      await save(instr, { status: 'ERROR', message: 'Could not parse defendant name' });
      continue;
    }

    // Run search inside iframe (no panel disappearance now)
    const table = await searchInFrame(def.last, def.first, def.mid);

    if (!table) {
      S.e++;
      S.done++;
      upd();
      log('  ❌ Search failed (table not found)', 'err');
      await save(instr, { status: 'ERROR', message: 'Search failed (table not found)' });
      continue;
    }

    const d = frame.contentDocument;
    const rows = table.querySelectorAll('tbody tr');
    if (!rows || rows.length === 0) {
      S.n++;
      S.done++;
      upd();
      log('  ❌ No results found', 'w');
      await save(instr, { status: 'NOT_FOUND' });
      continue;
    }

    // Take first result (same behavior as your existing flow)
    // If you want “best match” logic (by name similarity), tell me and I’ll add it.
    const details = await getDetailsInFrame(0);

    if (!details) {
      S.e++;
      S.done++;
      upd();
      log('  ❌ Could not open jacket / extract details', 'err');
      await save(instr, { status: 'ERROR', message: 'Could not open jacket / extract' });
      continue;
    }

    const normalized = normStatus(details.status);

    if (normalized === 'OPEN') S.o++;
    else if (normalized === 'CLOSED') S.c++;
    else S.n++;

    S.done++;
    upd();

    log(`  ✅ ${normalized} — ${details.status || 'UNKNOWN'}`, 'ok');

    await save(instr, {
      status: normalized,
      rawStatus: details.status || '',
      disposition: details.disposition || '',
      caseType: details.caseType || '',
      caption: details.caption || '',
      initiationDate: details.initDate || '',
      dispositionDate: details.dispDate || '',
    });

    await wait(DELAY);
  }

  log('\n🎉 Done!', 'ok');
})();
