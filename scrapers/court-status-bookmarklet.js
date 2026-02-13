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
  const DELAY = 1200; // Slightly longer delay between cases

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
    <h3>⚖️ Court Status Checker v2</h3>
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

    // Check if it's a business entity
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
  // CRITICAL FIX: Search directly on the MAIN page, not in an iframe
  // The iframe approach has cross-origin issues. Instead, we'll 
  // manipulate the current page directly since we're already on it.
  // ─────────────────────────────────────────────────────────────

  // Helper to set input value with proper JSF events
  function setInputValue(input, value) {
    if (!input) return false;
    
    // Clear first
    input.value = '';
    input.dispatchEvent(new Event('focus', { bubbles: true }));
    
    // Set new value
    input.value = value;
    
    // Fire all necessary events for JSF
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('blur', { bubbles: true }));
    
    return true;
  }

  // Click the Search By Party Name tab
  async function clickPartyNameTab() {
    // Find the tab - it might be a link or a tab element
    const tabs = document.querySelectorAll('a, li, span, div');
    for (const tab of tabs) {
      const text = (tab.textContent || '').trim();
      if (text === 'Search By Party Name' || text.includes('Party Name')) {
        tab.click();
        await wait(500);
        return true;
      }
    }
    
    // Try clicking by href
    const tabLink = document.querySelector('a[href*="tabs-2"], a[href*="partyName"]');
    if (tabLink) {
      tabLink.click();
      await wait(500);
      return true;
    }
    
    return false;
  }

  // Click the Individual radio button
  async function selectIndividualMode() {
    // Find the Individual radio button
    const radios = document.querySelectorAll('input[type="radio"]');
    for (const radio of radios) {
      const label = radio.parentElement?.textContent || '';
      const id = radio.id || '';
      if (label.includes('Individual') || id.includes('individual') || id.includes('Individual')) {
        if (!radio.checked) {
          radio.click();
          await wait(300);
        }
        return true;
      }
    }
    
    // Try by label
    const labels = document.querySelectorAll('label');
    for (const label of labels) {
      if (label.textContent.includes('Individual')) {
        label.click();
        await wait(300);
        return true;
      }
    }
    
    return false;
  }

  // Find name input fields
  function findNameFields() {
    // Try various ID patterns for Last Name field
    const lastPatterns = ['partyLName', 'lastName', 'lname', 'last'];
    const firstPatterns = ['partyFName', 'firstName', 'fname', 'first'];
    const midPatterns = ['partyMName', 'middleName', 'mname', 'middle', 'mi'];
    
    let lastField = null, firstField = null, midField = null;
    
    const inputs = document.querySelectorAll('input[type="text"]');
    
    for (const input of inputs) {
      const id = (input.id || '').toLowerCase();
      const name = (input.name || '').toLowerCase();
      const placeholder = (input.placeholder || '').toLowerCase();
      
      // Check for Last name field
      if (!lastField) {
        for (const p of lastPatterns) {
          if (id.includes(p.toLowerCase()) || name.includes(p.toLowerCase()) || placeholder.includes('last')) {
            lastField = input;
            break;
          }
        }
      }
      
      // Check for First name field  
      if (!firstField) {
        for (const p of firstPatterns) {
          if (id.includes(p.toLowerCase()) || name.includes(p.toLowerCase()) || placeholder.includes('first')) {
            firstField = input;
            break;
          }
        }
      }
      
      // Check for Middle name field
      if (!midField) {
        for (const p of midPatterns) {
          if (id.includes(p.toLowerCase()) || name.includes(p.toLowerCase()) || placeholder.includes('middle') || placeholder.includes('mi')) {
            midField = input;
            break;
          }
        }
      }
    }
    
    // Fallback: look for inputs near "Last", "First", "MI" labels
    if (!lastField || !firstField) {
      const allLabels = document.querySelectorAll('label, span, div');
      for (const lbl of allLabels) {
        const txt = (lbl.textContent || '').trim();
        if (txt === 'Last' || txt === '*Last') {
          const nearbyInput = lbl.parentElement?.querySelector('input') || 
                              lbl.nextElementSibling?.querySelector('input') ||
                              document.querySelector('input[id*="Last"], input[id*="last"]');
          if (nearbyInput && !lastField) lastField = nearbyInput;
        }
        if (txt === 'First' || txt === '*First') {
          const nearbyInput = lbl.parentElement?.querySelector('input') ||
                              lbl.nextElementSibling?.querySelector('input') ||
                              document.querySelector('input[id*="First"], input[id*="first"]');
          if (nearbyInput && !firstField) firstField = nearbyInput;
        }
      }
    }
    
    return { lastField, firstField, midField };
  }

  // Find and click search button
  function findSearchButton() {
    const buttons = document.querySelectorAll('button, input[type="submit"], input[type="button"], a.btn');
    for (const btn of buttons) {
      const text = (btn.textContent || btn.value || '').trim().toLowerCase();
      if (text === 'search' || text === 'find' || text === 'submit') {
        return btn;
      }
    }
    
    // Look for button by ID
    const byId = document.querySelector('[id*="search" i][id*="btn" i], [id*="search" i][id*="button" i], button[id*="search" i]');
    if (byId) return byId;
    
    return null;
  }

  // Wait for results table to appear
  async function waitForResults(timeout = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      // Look for results table
      const tables = document.querySelectorAll('table');
      for (const t of tables) {
        const txt = (t.innerText || '').toUpperCase();
        if (txt.includes('DOCKET NUMBER') && txt.includes('CASE CAPTION')) {
          return t;
        }
      }
      
      // Check for "no results" message
      const bodyText = document.body.innerText;
      if (bodyText.includes('No cases found') || bodyText.includes('0 records') || bodyText.includes('no matching')) {
        return null;
      }
      
      await wait(500);
    }
    return null;
  }

  // Perform a search
  async function doSearch(last, first, mid) {
    log(`  🔍 Searching: ${last}, ${first} ${mid}`, 'i');
    
    // Step 1: Make sure we're on Party Name tab
    await clickPartyNameTab();
    await wait(300);
    
    // Step 2: Select Individual mode (not Business)
    await selectIndividualMode();
    await wait(300);
    
    // Step 3: Find the name fields
    const { lastField, firstField, midField } = findNameFields();
    
    if (!lastField) {
      log('  ❌ Could not find Last Name field', 'err');
      return null;
    }
    
    log(`  📝 Found fields: Last=${!!lastField}, First=${!!firstField}, Mid=${!!midField}`, 'i');
    
    // Step 4: Clear and fill fields
    setInputValue(lastField, last);
    await wait(100);
    
    if (firstField && first) {
      setInputValue(firstField, first);
      await wait(100);
    }
    
    if (midField && mid) {
      setInputValue(midField, mid);
      await wait(100);
    }
    
    // Step 5: Find and click search button
    const searchBtn = findSearchButton();
    if (!searchBtn) {
      log('  ❌ Could not find Search button', 'err');
      return null;
    }
    
    log('  🖱️ Clicking search...', 'i');
    searchBtn.click();
    
    // Step 6: Wait for results
    await wait(1000);
    const resultsTable = await waitForResults(15000);
    
    if (!resultsTable) {
      log('  ❌ No results table found', 'w');
      return null;
    }
    
    log('  ✅ Got results table', 'ok');
    return resultsTable;
  }

  function getRows(table) {
    return Array.from(table.querySelectorAll('tbody tr, tr')).filter(row => {
      // Skip header rows
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
    // Try to find a Back button
    const buttons = document.querySelectorAll('a, button, input[type="button"]');
    for (const btn of buttons) {
      const text = (btn.textContent || btn.value || '').trim().toLowerCase();
      if (text === 'back' || text === '< back' || text === '« back') {
        btn.click();
        await wait(1500);
        return;
      }
    }
    // Fallback to browser back
    window.history.back();
    await wait(1500);
  }

  async function chooseBestByOpeningJackets(resultsTable, caseObj) {
    const rows = getRows(resultsTable);
    if (!rows.length) return { notFound: true, reason: 'No rows in table' };

    const defName = getDefendant(caseObj);
    const plaintiff = getPlaintiff(caseObj);
    const csvDate = getFilingDate(caseObj);

    // Score rows without clicking first
    const scored = rows.map((row, idx) => {
      const txt = rowText(row);
      const defSim = dice(defName, txt);
      const plSim = dice(plaintiff, txt);
      const score = (0.65 * defSim) + (0.35 * plSim);
      return { idx, row, score };
    }).sort((a, b) => b.score - a.score);

    // Only open top candidates
    const top = scored.slice(0, Math.min(5, scored.length));
    let best = null;

    for (const cand of top) {
      if (window._cscStop) break;

      const link = docketLinkInRow(cand.row);
      if (!link) continue;

      log(`  📂 Opening case ${cand.idx + 1}...`, 'i');
      link.click();
      await wait(2000);

      const jacket = extractJacket();
      const initDt = parseAnyDate(jacket.caseInitiationDate);
      const cap = jacket.caseCaption || '';

      const defSim2 = Math.max(cand.score, dice(defName, cap));
      const plSim2 = dice(plaintiff, cap);
      const dScore = dateScore(csvDate, initDt);

      const finalScore = (0.55 * defSim2) + (0.25 * plSim2) + (0.20 * dScore);

      log(`    Score: ${(finalScore * 100).toFixed(0)}% (def:${(defSim2*100).toFixed(0)} pl:${(plSim2*100).toFixed(0)} dt:${(dScore*100).toFixed(0)})`, 'i');

      if (!best || finalScore > best.finalScore) {
        best = { finalScore, jacket };
      }

      await clickBack();
      await wait(500);
    }

    if (!best) return { notFound: true, reason: 'Could not open any jackets' };
    return { notFound: false, best };
  }

  // ─────────────────────────────────────────────────────────────
  // Main - runs directly on the page (no iframe)
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

  // Filter to only unchecked cases
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

  // Make sure we start on Party Name tab
  await clickPartyNameTab();
  await wait(500);

  for (let i = 0; i < cases.length; i++) {
    if (window._cscStop) { log('⏹ Stopped by user', 'w'); break; }

    const c = cases[i];
    const instr = getInstrument(c);
    const defName = getDefendant(c);
    const plaintiff = getPlaintiff(c);
    const csvDate = getFilingDate(c);

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

    // For businesses, search differently
    if (parsed.isBusiness) {
      log(`  ℹ️ Business entity - searching by name only`, 'i');
    }

    const table = await doSearch(parsed.last, parsed.first, parsed.mid);
    if (!table) {
      S.e++; S.done++; upd();
      log('  ❌ Search returned no results', 'err');
      await save(instr, { 
        courtStatus: 'ERROR', 
        courtStatusNote: 'Search returned no results'
      });
      // Reload page to reset form state
      window.location.reload();
      await wait(3000);
      continue;
    }

    const choice = await chooseBestByOpeningJackets(table, c);
    if (choice.notFound) {
      S.n++; S.done++; upd();
      log(`  ❌ No matching case found (${choice.reason})`, 'w');
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
      courtMatchScore: choice.best.finalScore || null,
      courtStatusNote: `Matched with score ${(choice.best.finalScore * 100).toFixed(0)}%`
    });

    await wait(DELAY);
  }

  log('\n🎉 Done!', 'ok');
})();
