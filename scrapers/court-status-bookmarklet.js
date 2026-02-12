(async function() {
  'use strict';

  const SERVER = '__SERVER_URL__';
  const TOKEN = '__AUTH_TOKEN__';
  const TEST_MODE = __TEST_MODE__;
  const SEARCH_URL = window.location.href.split('?')[0]; // Current page without params
  const DELAY = 2000;

  // ── Verify we're on the right page ──
  if (!window.location.href.includes('njcourts.gov') || !window.location.href.includes('civilCaseSearch')) {
    alert('❌ Navigate to "Search Civil and Foreclosure Cases" on NJ Courts first!');
    return;
  }

  // ── UI Panel ──
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
    <div id="csc-status">Loading cases...</div>
    <div id="csc-bar"><div id="csc-fill"></div></div>
    <div id="csc-stats">🟢<b class="g" id="cs-o">0</b> 🔴<b class="r" id="cs-c">0</b> ❌<b class="y" id="cs-n">0</b> ⚠<b id="cs-e">0</b></div>
    <div id="csc-btns"><button class="csc-stop" onclick="window._cscStop=true">⏹ Stop</button><button class="csc-close" onclick="document.getElementById('csc-panel').remove();window._cscStop=true">✕ Close</button></div>
    <div id="csc-log"></div>
  `;
  document.body.appendChild(panel);
  window._cscStop = false;

  const S = { o:0, c:0, n:0, e:0, done:0, total:0 };
  const log = (m, cls='i') => { const d=document.getElementById('csc-log'); d.innerHTML+=`<div class="l-${cls}">${m}</div>`; d.scrollTop=d.scrollHeight; };
  const upd = () => {
    const p = S.total>0 ? Math.round(S.done/S.total*100) : 0;
    document.getElementById('csc-fill').style.width=p+'%';
    document.getElementById('csc-status').textContent=`${S.done}/${S.total} (${p}%)`;
    document.getElementById('cs-o').textContent=S.o;
    document.getElementById('cs-c').textContent=S.c;
    document.getElementById('cs-n').textContent=S.n;
    document.getElementById('cs-e').textContent=S.e;
  };
  const wait = ms => new Promise(r=>setTimeout(r,ms));
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;

  // ── Helpers ──
  function parseDef(name) {
    if (!name) return null;
    const p = name.toUpperCase().replace(/\b(JR|SR|II|III|IV)\b\.?/g,'').trim().split(/\s+/).filter(x=>x);
    return p.length ? { last:p[0], first:p[1]||'', mid:p[2]||'' } : null;
  }

  function normStatus(s) {
    if (!s) return 'UNKNOWN';
    const u = s.toUpperCase();
    if (/CLOSED|DISMISSED|DISPOSED|SETTLED|TERMINATED/.test(u)) return 'CLOSED';
    if (/OPEN|ACTIVE|PENDING/.test(u)) return 'OPEN';
    return 'UNKNOWN';
  }

  async function save(instrNum, data) {
    try {
      await fetch(`${SERVER}/api/camden/court-status-update`, {
        method:'POST',
        headers:{'X-Auth-Token':TOKEN,'Content-Type':'application/json'},
        body:JSON.stringify({instrumentNumber:instrNum, courtData:data})
      });
    } catch(e) { log(`  ⚠ Save fail: ${e.message}`,'w'); }
  }

  // Wait for JSF page navigation (form submission reloads the page)
  function waitForPageUpdate(timeout=15000) {
    return new Promise(resolve => {
      let resolved = false;
      const done = () => { if(!resolved){resolved=true;resolve();} };
      
      // Method 1: Watch for significant DOM changes
      const obs = new MutationObserver((mutations) => {
        for (const m of mutations) {
          if (m.addedNodes.length > 3 || m.removedNodes.length > 3) {
            obs.disconnect();
            setTimeout(done, 2000); // Wait for rendering to settle
            return;
          }
        }
      });
      obs.observe(document.body, { childList:true, subtree:true });
      
      // Method 2: Timeout fallback
      setTimeout(() => { obs.disconnect(); done(); }, timeout);
    });
  }

  // ── Switch to Party Name tab ──
  function clickPartyTab() {
    const t = document.querySelector('a[href="#tabs-2"]');
    if (t) t.click();
  }

  // ── Search ──
  async function search(last, first, mid) {
    clickPartyTab();
    await wait(800);

    const lf = document.getElementById('searchByPartyNameForm:partyLName');
    const ff = document.getElementById('searchByPartyNameForm:partyFName');
    const mf = document.getElementById('searchByPartyNameForm:partyMName');
    if (!lf) { log('  ❌ Form not found!','err'); return null; }

    // Clear fields first
    setter.call(lf, ''); lf.dispatchEvent(new Event('change',{bubbles:true}));
    setter.call(ff, ''); ff.dispatchEvent(new Event('change',{bubbles:true}));
    setter.call(mf, ''); mf.dispatchEvent(new Event('change',{bubbles:true}));
    await wait(200);

    // Fill fields
    setter.call(lf, last); lf.dispatchEvent(new Event('input',{bubbles:true})); lf.dispatchEvent(new Event('change',{bubbles:true}));
    setter.call(ff, first); ff.dispatchEvent(new Event('input',{bubbles:true})); ff.dispatchEvent(new Event('change',{bubbles:true}));
    setter.call(mf, mid||''); mf.dispatchEvent(new Event('input',{bubbles:true})); mf.dispatchEvent(new Event('change',{bubbles:true}));

    await wait(500); // Let JSF process the input events

    const btn = document.getElementById('searchByPartyNameForm:btnPartyNameSearch');
    if (!btn) { log('  ❌ Search button not found!','err'); return null; }
    btn.click();

    await waitForPageUpdate();
    await wait(1000); // Extra breathing room

    // Parse results - don't check for CAPTCHA banner text since it persists from session start
    // Instead, check if the results table has actual data rows
    const table = document.getElementById('searchByPartyNameForm:idPartyTable');
    if (!table) {
      // No table at all - might be a real CAPTCHA block or page didn't load
      const pageText = document.body.innerText.substring(0, 500);
      if (pageText.includes('Captcha') && !pageText.includes('Search For Case')) {
        log('  ⚠ CAPTCHA blocked session. Refresh the page and re-run.','w');
        return null;
      }
      return [];
    }

    const rows = table.querySelectorAll('tbody tr');
    const results = [];
    rows.forEach((row,i) => {
      const cells = row.querySelectorAll('td');
      if (cells.length<5 || row.textContent.includes('No data')) return;
      results.push({
        idx:i,
        name:cells[0].textContent.trim(),
        venue:cells[1].textContent.trim(),
        docket:cells[2].textContent.trim(),
        caption:cells[3].textContent.trim(),
        filed:cells[4].textContent.trim()
      });
    });
    return results;
  }

  // ── Match best result ──
  function bestMatch(results, plaintiff, lpDate) {
    const pltWord = (plaintiff||'').toUpperCase().replace(/\b(LLC|INC|CORP|N\.?A\.?|BANK|MORTGAGE|SERVICING|TRUST)\b/g,'').trim().split(/\s+/).filter(x=>x.length>2)[0] || '';
    let best=null, bestScore=0;
    for (const r of results) {
      let score=0;
      if (r.venue.toUpperCase().includes('CAMDEN')) score+=10; else continue;
      if (r.docket.startsWith('F-')) score+=10;
      if (pltWord && r.caption.toUpperCase().includes(pltWord)) score+=15;
      if (lpDate && r.filed) {
        try {
          const diff = Math.abs((new Date(lpDate)-new Date(r.filed))/86400000);
          if (diff<=14) score+=15; else if(diff<=60) score+=10; else if(diff<=180) score+=5;
        } catch(e){}
      }
      if (score>bestScore) { best={...r,score}; bestScore=score; }
    }
    return bestScore>=20 ? best : null;
  }

  // ── Get case details (click into jacket, extract, come back) ──

async function goBackToResults() {
  // Try to click a real "Back to Search Results" control (more reliable than history.back)
  const candidates = Array.from(document.querySelectorAll('a,button,input[type="button"],input[type="submit"]'));

  const backBtn =
    candidates.find(el => /back to search results/i.test((el.textContent || el.value || '').trim())) ||
    candidates.find(el => /search results/i.test((el.textContent || el.value || '').trim()) && /back/i.test((el.textContent || el.value || '').trim())) ||
    candidates.find(el => /back/i.test((el.textContent || el.value || '').trim()));

  if (backBtn) {
    backBtn.click();
    await waitForPageUpdate();
    await wait(800);
  } else {
    // fallback
    window.history.back();
    await waitForPageUpdate();
    await wait(800);
  }

  // If we're still not back on the search form, try navigating to the search page URL directly
  const lf = document.getElementById('searchByPartyNameForm:partyLName');
  if (!lf) {
    log('  ⚠ Still on jacket page — forcing return to search page…','w');
    window.location.href = SEARCH_URL;
    // NOTE: This will reload the page and stop the script run.
    // If you want auto-resume after reload, we can add sessionStorage resume logic.
  }
}

  async function getDetails(rowIdx) {
    // Click the docket link
    const linkId = `searchByPartyNameForm:idPartyTable:${rowIdx}:lnkSrchByDocNum`;
    const link = document.getElementById(linkId);
    if (!link) {
      // Fallback: find link in row
      const table = document.getElementById('searchByPartyNameForm:idPartyTable');
      const rows = table ? table.querySelectorAll('tbody tr') : [];
      const a = rows[rowIdx] ? rows[rowIdx].querySelector('td:nth-child(3) a') : null;
      if (a) a.click(); else return null;
    } else {
      link.click();
    }

    await waitForPageUpdate();

    // Extract from case jacket
    const text = document.body.innerText;
    const gm = p => { const m=text.match(p); return m?m[1].trim():''; };
    const details = {
      status: gm(/Case Status:\s*(\S+)/),
      disposition: gm(/Case Disposition:\s*(.+?)(?:\n|Case|Court|Venue|$)/),
      caseType: gm(/Case Type:\s*(.+?)(?:\n|Case|$)/),
      caption: gm(/Case Caption:\s*(.+?)(?:\n|Court|$)/),
      initDate: gm(/Case Initiation Date:\s*(\d{2}\/\d{2}\/\d{4})/),
      dispDate: gm(/Disposition Date:\s*(\d{2}\/\d{2}\/\d{4})/)
    };
// Navigate back to search results
await goBackToResults();

// Re-click party name tab after going back
clickPartyTab();
await wait(500);

return details;
  }

  // ── Fetch cases ──
  log('📡 Fetching cases...','s');
  let cases;
  try {
    const r = await fetch(`${SERVER}/api/camden?sortBy=daysSinceFiling&sortOrder=desc`,{headers:{'X-Auth-Token':TOKEN}});
    const data = await r.json();
    cases = (data.cases||[]).filter(c => !c.courtStatus || c.courtStatus==='NOT_FOUND' || c.courtStatus==='ERROR');
    if (TEST_MODE) cases = cases.slice(0,10);
    S.total = cases.length;
    log(`✅ ${cases.length} cases to check${TEST_MODE?' (test)':''}`, 'ok');
    upd();
  } catch(e) {
    log(`❌ Failed: ${e.message}`,'err');
    return;
  }

  // ── Process ──
  for (let i=0; i<cases.length; i++) {
    if (window._cscStop) { log('⏹ Stopped','w'); break; }
    const c = cases[i];
    S.done = i+1;

    if (i>0 && i%15===0) { log('⏸ Batch pause (3s)...','i'); await wait(3000); }

    const def = parseDef(c.primaryDefendant || (c.defendantNames&&c.defendantNames[0]) || '');
    const plt = c.primaryPlaintiff || (c.plaintiffNames&&c.plaintiffNames[0]) || '';

    if (!def) { log(`${i+1}/${S.total} ⚠ Bad name: skip`,'w'); upd(); continue; }

    log(`${i+1}/${S.total} 🔍 ${def.last}, ${def.first}`,'s');

    const results = await search(def.last, def.first, def.mid);

    if (results===null) { S.e++; upd(); await wait(DELAY); continue; } // CAPTCHA or error
    if (results.length===0) {
      log(`  ❌ No results`,'err');
      S.n++;
      await save(c.instrumentNumber, {courtStatus:'NOT_FOUND', courtStatusNote:'No search results'});
      upd(); await wait(DELAY); continue;
    }

    log(`  ${results.length} result(s)`,'i');
    const match = bestMatch(results, plt, c.filingDate);

    if (!match) {
      log(`  ❌ No match`,'w');
      S.n++;
      await save(c.instrumentNumber, {courtStatus:'NOT_FOUND', courtStatusNote:`${results.length} results, no confident match`});
      upd(); await wait(DELAY); continue;
    }

    log(`  → ${match.docket} (score:${match.score})`,'i');

    // Get case details
    const det = await getDetails(match.idx);

    if (!det || !det.status) {
      log(`  ⚠ Couldn't read jacket`,'w');
      await save(c.instrumentNumber, {
        courtDocketNumber:match.docket, courtStatus:'UNKNOWN',
        courtCaseCaption:match.caption, courtFiledDate:match.filed,
        courtStatusNote:'Could not load case jacket'
      });
      S.e++; upd(); await wait(DELAY); continue;
    }

    const status = normStatus(det.status + ' ' + det.disposition);
    await save(c.instrumentNumber, {
      courtDocketNumber:match.docket, courtStatus:status,
      courtStatusRaw:det.status, courtDisposition:det.disposition,
      courtCaseType:det.caseType, courtCaseCaption:det.caption||match.caption,
      courtFiledDate:det.initDate||match.filed, courtDispositionDate:det.dispDate,
      courtStatusNote:`Browser score:${match.score}`
    });

    if (status==='OPEN') { S.o++; log(`  🟢 OPEN — ${det.disposition}`,'ok'); }
    else if (status==='CLOSED') { S.c++; log(`  🔴 CLOSED — ${det.disposition}`,'err'); }
    else { log(`  ⚪ ${status}`,'i'); }

    upd();
    await wait(DELAY);
  }

  log('','i');
  log(`═══ DONE: ${S.o} open, ${S.c} closed, ${S.n} not found, ${S.e} errors ═══`,'ok');
  document.getElementById('csc-status').textContent = '✅ Complete!';
  upd();
})();
