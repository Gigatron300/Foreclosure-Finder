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
      #csc-panel { position:fixed;top:8px;right:8px;width:410px;z-index:99999;background:#0f172a;color:#e2e8f0;border-radius:10px;padding:14px;font-family:system-ui,sans-serif;font-size:12px;box-shadow:0 4px 24px rgba(0,0,0,.6);border:1px solid #334155;max-height:85vh;display:flex;flex-direction:column; }
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
  // Helpers
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
    return cleanText(s).split(' ').filter(t => t && t.length > 1 && !stop.has(t));
  }

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

    const m = str.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
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

  function dateScore(csvDate, siteDate) {
    const d = daysBetween(csvDate, siteDate);
    if (d === null) return 0.15;
    const cap = 120;
    const x = Math.min(d, cap);
    return 1 - x / cap;
  }

function classifyStatus(caseStatusRaw, caseDispositionRaw) {
  const s = String(caseStatusRaw || '').toUpperCase();
  const d = String(caseDispositionRaw || '').toUpperCase();
  const combined = `${s} ${d}`;

  // Discard (dead cases)
  if (/(DISMISSED|DISPOSED|SETTLED|TERMINATED|CLOSED|WITH PREJUDICE|WITHOUT PREJUDICE|FINAL JUDGMENT|JUDGMENT|VACATED)/.test(combined)) {
    return { normalized: 'CLOSED', useful: false };
  }

  // Keep (still actionable / ongoing)
  // NJ courts often shows "Active", "Open", "Pending", or "Defaulted"
  if (/(OPEN|ACTIVE|PENDING|DEFAULTED|IN PROGRESS|UNRESOLVED)/.test(combined)) {
    return { normalized: 'OPEN', useful: true };
  }

  // Unknown → not useful by default (you can later change this to "review")
  return { normalized: 'UNKNOWN', useful: false };
}

  // Parse defendant search name for NJ Courts "Individual"
  function parseDef(name) {
    const s = cleanText(name);
    if (!s) return null;

    const cleaned = s
      .replace(/\bET AL\b/g, '')
      .replace(/\bHIS WIFE\b|\bHER HUSBAND\b/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (!cleaned) return null;

    // entity
    if (/\b(LLC|INC|CORP|CORPORATION|CO|COMPANY|BANK|TRUST|AGENCY|AUTHORITY|MORTGAGE|FINANCE|ASSOCIATION|ASSN|HOUSING|SERVICING|SERVICES)\b/.test(cleaned)) {
      return { last: cleaned, first: '', mid: '' };
    }

    if (cleaned.includes(',')) {
      const [lastPart, rest] = cleaned.split(',', 2);
      const restParts = (rest || '').trim().split(' ').filter(Boolean);
      return { last: lastPart.trim(), first: restParts[0] || '', mid: restParts[1] || '' };
    }

    // Camden “LAST FIRST”
    const parts = cleaned.split(' ').filter(Boolean);
    if (parts.length === 1) return { last: parts[0], first: '', mid: '' };
    return { last: parts[0], first: parts[1] || '', mid: parts[2] || '' };
  }

  // Server object shape
  function getInstrument(c) {
    return c.instrumentNumber || c.instrument || c.instrNum || '';
  }
  function getDefendant(c) {
    return c.primaryDefendant || (Array.isArray(c.allDefendants) ? c.allDefendants[0] : '') || '';
  }
  function getPlaintiff(c) {
    return c.primaryPlaintiff || (Array.isArray(c.plaintiffs) ? c.plaintiffs[0] : '') || '';
  }
  function getFilingDate(c) {
    return parseAnyDate(c.filingDateISO) || parseAnyDate(c.filingDate) || null;
  }

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
  // Hidden iframe (all NJ Courts interaction happens here)
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

  // Wait for either navigation load OR DOM mutation
  function waitForFrameSettle(timeout = 30000) {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };

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

        setTimeout(() => {
          try { obs.disconnect(); } catch {}
          finish();
        }, timeout);
        return;
      }

      setTimeout(finish, timeout);
    });
  }

  // Click “Search By Party Name” (this is NOT a tab-2 anchor in your UI)
  function clickPartySearchMode() {
    const d = docNow();
    if (!d) return;

    // Prefer the exact button label shown in your screenshot
    const buttons = Array.from(d.querySelectorAll('a,button,input[type="button"],input[type="submit"]'));
    const btn = buttons.find(el => /search by party name/i.test((el.textContent || el.value || '').trim()));
    if (btn) btn.click();
  }

  function findResultsTable() {
    const d = docNow();
    if (!d) return null;

    // Find a table that includes these header labels (matches your screenshot)
    const tables = Array.from(d.querySelectorAll('table'));
    for (const t of tables) {
      const txt = cleanText(t.innerText);
      if (txt.includes('DOCKET NUMBER') && txt.includes('CASE CAPTION') && txt.includes('CASE INITIATION DATE')) {
        return t;
      }
    }
    return null;
  }

  function findDocketLinkInRow(row) {
    if (!row) return null;
    const links = Array.from(row.querySelectorAll('a'));
    // docket pattern like F-000161-26 / SWC F 000161 - 26 etc
    const docketRe = /\b([A-Z]{1,4}\s*)?F[-\s]?\d{3,7}[-\s]?\d{2}\b/i;

    // Prefer link whose visible text matches docket format
    for (const a of links) {
      const t = (a.textContent || '').trim();
      if (docketRe.test(t)) return a;
    }
    // fallback: any link that looks like docket-ish
    return links[0] || null;
  }

  function extractRowText(row) {
    return cleanText(row ? row.innerText : '');
  }

  async function ensureResultsPage() {
    // make sure we are in party search mode UI
    clickPartySearchMode();
    await wait(350);
  }

  async function searchInFrame(last, first, mid) {
    await ensureResultsPage();

    let d = docNow();
    const w = frame.contentWindow;
    if (!d || !w) return null;

    // Force Individual radio if present
    const indiv = d.querySelector('input[type="radio"][value="I"]');
    if (indiv && !indiv.checked) {
      indiv.click();
      await waitForFrameSettle(20000);
      d = docNow();
    }

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

    setVal(lf, '');
    setVal(ff, '');
    setVal(mf, '');
    await wait(100);

    setVal(lf, last);
    setVal(ff, first);
    setVal(mf, mid || '');
    await wait(150);

    // Search button (JSF id varies); find by label/value
    const buttons = Array.from(d.querySelectorAll('button,input[type="submit"],input[type="button"]'));
    const searchBtn = buttons.find(el => /search/i.test((el.textContent || el.value || '').trim()));
    if (!searchBtn) return null;

    searchBtn.click();
    await waitForFrameSettle(30000);
    await wait(350);

    // Find results table by header text
    return findResultsTable();
  }

  async function goBackToResultsInFrame() {
    let d = docNow();
    if (!d) return;

    const candidates = Array.from(d.querySelectorAll('a,button,input[type="button"],input[type="submit"]'));
    const backBtn =
      candidates.find(el => /^back$/i.test((el.textContent || el.value || '').trim())) ||
      candidates.find(el => /back to/i.test((el.textContent || el.value || '').trim()));

    if (backBtn) {
      backBtn.click();
      await waitForFrameSettle(25000);
      await wait(250);
      return;
    }

    try { frame.contentWindow.history.back(); } catch {}
    await waitForFrameSettle(25000);
    await wait(250);
  }

  // From the docket/case jacket page, extract Case Status & Case Disposition
  function extractCaseJacketStatus() {
    const d = docNow();
    const text = d && d.body ? d.body.innerText : '';

    const pick = (re) => {
      const m = text.match(re);
      return m ? (m[1] || '').trim() : '';
    };

    const caseStatus = pick(/Case Status:\s*([^\n\r]+)/i);
    const caseDisposition = pick(/Case Disposition:\s*([^\n\r]+)/i);
    const caseCaption = pick(/Case Caption:\s*([^\n\r]+)/i);
    const caseType = pick(/Case Type:\s*([^\n\r]+)/i);
    const caseInitiationDate = pick(/Case Initiation Date:\s*(\d{1,2}\/\d{1,2}\/\d{4})/i);
    const dispositionDate = pick(/Disposition Date:\s*(\d{1,2}\/\d{1,2}\/\d{4})/i);

    return {
      caseStatus,
      caseDisposition,
      caseCaption,
      caseType,
      caseInitiationDate,
      dispositionDate
    };
  }

  async function clickBestRowAndReadJacket(resultsTable, caseObj) {
    const defName = getDefendant(caseObj) || '';
    const plaintiff = getPlaintiff(caseObj) || '';
    const csvDate = getFilingDate(caseObj);

    // Find body rows
    const rows = Array.from(resultsTable.querySelectorAll('tbody tr'));
    if (!rows.length) return { notFound: true, reason: 'No rows' };

    // Score rows using row text, including plaintiff + date proximity
    const scored = rows.map((row, idx) => {
      const txt = extractRowText(row);
      const dates = txt.match(/\d{1,2}\/\d{1,2}\/\d{4}/g) || [];
      const firstDate = dates.length ? parseAnyDate(dates[0]) : null;

      const defSim = dice(defName, txt);
      const plSim = dice(plaintiff, txt);
      const dScore = dateScore(csvDate, firstDate);

      const score = (0.55 * defSim) + (0.30 * plSim) + (0.15 * dScore);
      return { idx, row, score };
    }).sort((a, b) => b.score - a.score);

    const best = scored[0];
    if (!best || best.score < 0.20) {
      return { notFound: true, reason: `Low score (${best ? best.score.toFixed(3) : 'n/a'})` };
    }

    // Click docket hyperlink in the best row
    const link = findDocketLinkInRow(best.row);
    if (!link) return { notFound: true, reason: 'No docket link found in row' };

    link.click();
    await waitForFrameSettle(30000);
    await wait(350);

    // Now we’re on the jacket page
    const jacket = extractCaseJacketStatus();
    return { notFound: false, jacket, matchScore: best.score };
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
      headers: { 'X-Auth-Token': TOKEN }
    });
    const data = await r.json();
    cases = (data.cases || []);
  } catch (e) {
    log(`❌ Could not fetch cases: ${e.message}`, 'err');
    return;
  }

  // Only check those without status (or not found/error)
  cases = cases.filter(c => {
    const cs = c.courtStatus || c.court_status || c.court?.status || '';
    return !cs || cs === 'NOT_FOUND' || cs === 'ERROR';
  });

  if (TEST_MODE) cases = cases.slice(0, 10);

  S.total = cases.length;
  upd();
  log(`✅ Loaded ${cases.length} cases to check`, 'ok');

  for (let i = 0; i < cases.length; i++) {
    if (window._cscStop) { log('⏹ Stopped by user', 'w'); break; }

    const c = cases[i];
    const instr = getInstrument(c);
    const defName = getDefendant(c);
    const plaintiff = getPlaintiff(c);
    const csvDate = getFilingDate(c);

    log(`\n🔎 [${i + 1}/${cases.length}] ${instr}`, 's');
    log(`  Defendant: ${defName || '(missing)'}`, 'i');
    log(`  Plaintiff: ${plaintiff || '(missing)'}`, 'i');
    if (csvDate) log(`  Filing date: ${csvDate.toLocaleDateString()}`, 'i');

    const parsed = parseDef(defName);
    if (!parsed || !parsed.last) {
      S.e++; S.done++; upd();
      log('  ❌ Could not parse defendant name', 'err');
      await save(instr, { status: 'ERROR', message: 'Could not parse defendant name', primaryDefendant: defName, primaryPlaintiff: plaintiff });
      continue;
    }

    const resultsTable = await searchInFrame(parsed.last, parsed.first, parsed.mid);
    if (!resultsTable) {
      S.e++; S.done++; upd();
      log('  ❌ Search failed (results table not found)', 'err');
      await save(instr, { status: 'ERROR', message: 'Search failed (results table not found)' });
      continue;
    }

    const read = await clickBestRowAndReadJacket(resultsTable, c);
    if (!read || read.notFound) {
      S.n++; S.done++; upd();
      log(`  ❌ NOT_FOUND (${read && read.reason ? read.reason : 'no match'})`, 'w');
      await save(instr, {
        status: 'NOT_FOUND',
        message: read && read.reason ? read.reason : 'No match',
        primaryDefendant: defName,
        primaryPlaintiff: plaintiff,
        filingDate: csvDate ? csvDate.toISOString() : null
      });
      continue;
    }

    const j = read.jacket || {};
    const cls = classifyStatus(j.caseStatus, j.caseDisposition);

    if (cls.normalized === 'OPEN') S.o++;
    else if (cls.normalized === 'CLOSED') S.c++;
    else S.n++;

    S.done++; upd();

    log(`  ✅ Jacket: status="${j.caseStatus}" disposition="${j.caseDisposition}" → ${cls.normalized}`, 'ok');

    await save(instr, {
      status: cls.normalized,
      useful: cls.useful,
      rawStatus: j.caseStatus || '',
      disposition: j.caseDisposition || '',
      caseType: j.caseType || '',
      caption: j.caseCaption || '',
      initiationDate: j.caseInitiationDate || '',
      dispositionDate: j.dispositionDate || '',
      matchScore: read.matchScore || null,
      primaryDefendant: defName,
      primaryPlaintiff: plaintiff,
      filingDate: csvDate ? csvDate.toISOString() : null
    });

    // go back to results page for next search
    await goBackToResultsInFrame();
    await wait(DELAY);
  }

  log('\n🎉 Done!', 'ok');
})();
