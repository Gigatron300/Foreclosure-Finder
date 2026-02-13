/* court-status-bookmarklet.js
 *
 * Goal: reliably run case lookups on NJ Courts WITHOUT triggering CAPTCHA as often.
 * Key change: Safe Mode (default) fills fields but you manually click Search.
 * Also: configurable selectors via overlay UI + better waiting for results.
 */

/* global __SERVER_URL__, __AUTH_TOKEN__, __TEST_MODE__ */

(function () {
  const SERVER_URL = "__SERVER_URL__";
  const AUTH_TOKEN = "__AUTH_TOKEN__";
  const TEST_MODE = "__TEST_MODE__" === "true";

  // ---- Tunables ----
  const DELAY_BETWEEN_CASES_MS = 3500;  // slower
  const JITTER_MS = 2500;
  const MAX_WAIT_FOR_RESULTS_MS = 12000;

  // ---- Persisted UI config ----
  const CFG_KEY = "njcs_cfg_v2";
  const STATE_KEY = "njcs_runner_state_v2";

  const defaultCfg = {
    safeMode: true,               // IMPORTANT: default ON
    useLastNameOnly: true,        // helps matching
    docketInputSelector: "",      // optional override
    partyInputSelector: "",       // optional override
    searchButtonSelector: "",     // optional override
    resultsSelector: "",          // optional override (highly recommended)
    noResultsRegex: "no results|no records|not found",
    captchaRegex: "captcha verification has failed|system is available.*captcha|captcha.*failed for this session",
  };

  function loadCfg() {
    try {
      return { ...defaultCfg, ...(JSON.parse(localStorage.getItem(CFG_KEY) || "null") || {}) };
    } catch {
      return { ...defaultCfg };
    }
  }
  function saveCfg(cfg) {
    localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
  }

  // ---- Overlay UI ----
  function ensureOverlay() {
    let el = document.getElementById("njcs-overlay");
    if (el) return el;

    el = document.createElement("div");
    el.id = "njcs-overlay";
    el.style.cssText = `
      position: fixed; z-index: 999999;
      top: 16px; right: 16px;
      width: 420px;
      background: rgba(20,20,20,0.95);
      color: #fff; font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial;
      border: 1px solid rgba(255,255,255,0.15);
      border-radius: 14px;
      padding: 14px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.35);
    `;

    el.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;">
        <div style="font-weight:800;">NJ Court Status Runner</div>
        <button id="njcs-close" style="background:transparent;color:#fff;border:1px solid rgba(255,255,255,0.25);border-radius:10px;padding:6px 10px;cursor:pointer;">Close</button>
      </div>

      <div id="njcs-status" style="margin-top:10px;line-height:1.35;font-size:13px;"></div>

      <div id="njcs-actions" style="margin-top:12px;display:flex;gap:10px;flex-wrap:wrap;"></div>

      <details style="margin-top:12px;border-top:1px solid rgba(255,255,255,0.12);padding-top:10px;">
        <summary style="cursor:pointer;opacity:0.9;">Advanced settings (recommended once)</summary>
        <div style="margin-top:10px;font-size:12px;opacity:0.95;">
          <label style="display:flex;gap:8px;align-items:center;margin-bottom:8px;">
            <input type="checkbox" id="njcs-safeMode" />
            <span><b>Safe Mode</b> (fills fields, YOU click Search)</span>
          </label>

          <label style="display:flex;gap:8px;align-items:center;margin-bottom:10px;">
            <input type="checkbox" id="njcs-lastNameOnly" />
            <span>Use last-name-only for defendant</span>
          </label>

          <div style="display:grid;grid-template-columns: 1fr; gap:8px;">
            <input id="njcs-partySel" placeholder="Party input CSS selector (optional)" style="width:100%;padding:8px;border-radius:10px;border:1px solid rgba(255,255,255,0.2);background:rgba(255,255,255,0.06);color:#fff;" />
            <input id="njcs-docketSel" placeholder="Docket input CSS selector (optional)" style="width:100%;padding:8px;border-radius:10px;border:1px solid rgba(255,255,255,0.2);background:rgba(255,255,255,0.06);color:#fff;" />
            <input id="njcs-searchSel" placeholder="Search button CSS selector (optional)" style="width:100%;padding:8px;border-radius:10px;border:1px solid rgba(255,255,255,0.2);background:rgba(255,255,255,0.06);color:#fff;" />
            <input id="njcs-resultsSel" placeholder="RESULTS container selector (strongly recommended)" style="width:100%;padding:8px;border-radius:10px;border:1px solid rgba(255,255,255,0.2);background:rgba(255,255,255,0.06);color:#fff;" />
          </div>

          <div style="margin-top:10px;display:flex;gap:10px;flex-wrap:wrap;">
            <button id="njcs-saveCfg" style="cursor:pointer;border-radius:10px;padding:8px 10px;border:1px solid rgba(255,255,255,0.2);background:rgba(80,160,255,0.9);color:#fff;">Save settings</button>
            <button id="njcs-testFind" style="cursor:pointer;border-radius:10px;padding:8px 10px;border:1px solid rgba(255,255,255,0.2);background:rgba(255,255,255,0.08);color:#fff;">Test find fields</button>
            <button id="njcs-resetCfg" style="cursor:pointer;border-radius:10px;padding:8px 10px;border:1px solid rgba(255,255,255,0.2);background:rgba(255,255,255,0.08);color:#fff;">Reset settings</button>
          </div>

          <div style="margin-top:10px;opacity:0.8;line-height:1.35;">
            Tip: To get a selector, right-click the input/button → Inspect → right-click the highlighted HTML → Copy → Copy selector.
          </div>
        </div>
      </details>

      <div id="njcs-log" style="margin-top:12px;max-height:220px;overflow:auto;font-size:12px;opacity:0.9;"></div>
    `;

    document.body.appendChild(el);
    document.getElementById("njcs-close").onclick = () => el.remove();

    // bind settings UI
    const cfg = loadCfg();
    setCfgUI(cfg);

    document.getElementById("njcs-saveCfg").onclick = () => {
      const next = getCfgFromUI();
      saveCfg(next);
      log("✅ Saved settings.");
    };

    document.getElementById("njcs-resetCfg").onclick = () => {
      saveCfg({ ...defaultCfg });
      setCfgUI(loadCfg());
      log("✅ Reset settings to default.");
    };

    document.getElementById("njcs-testFind").onclick = () => {
      const testCfg = getCfgFromUI();
      const found = locateFields(testCfg);
      log(`Test find:
- partyInput: ${found.partyInput ? "✅" : "❌"}
- docketInput: ${found.docketInput ? "✅" : "❌"}
- searchBtn: ${found.searchBtn ? "✅" : "❌"}
- resultsEl: ${found.resultsEl ? "✅" : "❌ (set results selector)"}`);
      // highlight found items briefly
      [found.partyInput, found.docketInput, found.searchBtn, found.resultsEl].filter(Boolean).forEach(flashOutline);
    };

    return el;
  }

  function setCfgUI(cfg) {
    document.getElementById("njcs-safeMode").checked = !!cfg.safeMode;
    document.getElementById("njcs-lastNameOnly").checked = !!cfg.useLastNameOnly;
    document.getElementById("njcs-partySel").value = cfg.partyInputSelector || "";
    document.getElementById("njcs-docketSel").value = cfg.docketInputSelector || "";
    document.getElementById("njcs-searchSel").value = cfg.searchButtonSelector || "";
    document.getElementById("njcs-resultsSel").value = cfg.resultsSelector || "";
  }

  function getCfgFromUI() {
    const cfg = loadCfg();
    cfg.safeMode = document.getElementById("njcs-safeMode").checked;
    cfg.useLastNameOnly = document.getElementById("njcs-lastNameOnly").checked;
    cfg.partyInputSelector = document.getElementById("njcs-partySel").value.trim();
    cfg.docketInputSelector = document.getElementById("njcs-docketSel").value.trim();
    cfg.searchButtonSelector = document.getElementById("njcs-searchSel").value.trim();
    cfg.resultsSelector = document.getElementById("njcs-resultsSel").value.trim();
    return cfg;
  }

  function setStatus(html) {
    ensureOverlay();
    document.getElementById("njcs-status").innerHTML = html;
  }

  function setActions(buttons) {
    ensureOverlay();
    const wrap = document.getElementById("njcs-actions");
    wrap.innerHTML = "";
    buttons.forEach(({ label, onClick, kind }) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.style.cssText = `
        cursor:pointer;
        border-radius:10px;
        padding:8px 10px;
        border: 1px solid rgba(255,255,255,0.2);
        background: ${kind === "primary" ? "rgba(80,160,255,0.9)" : "rgba(255,255,255,0.08)"};
        color:#fff;
      `;
      b.onclick = onClick;
      wrap.appendChild(b);
    });
  }

  function log(line) {
    ensureOverlay();
    const box = document.getElementById("njcs-log");
    const p = document.createElement("div");
    p.textContent = line;
    p.style.cssText = "margin-bottom:6px;";
    box.prepend(p);
  }

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }
  function jitterDelay() {
    return DELAY_BETWEEN_CASES_MS + Math.floor(Math.random() * JITTER_MS);
  }

  function flashOutline(el) {
    const prev = el.style.outline;
    el.style.outline = "3px solid rgba(80,160,255,0.9)";
    setTimeout(() => (el.style.outline = prev), 900);
  }

  // ---- Server calls ----
  async function apiGetCases() {
    const url = `${SERVER_URL}/api/camden?sortBy=daysSinceFiling&sortOrder=desc${TEST_MODE ? "&test=true" : ""}`;
    const res = await fetch(url, { headers: { "x-auth-token": AUTH_TOKEN } });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(`Server /api/camden failed (${res.status}): ${t.slice(0, 200)}`);
    }
    return res.json();
  }

  async function apiPostUpdate(instrumentNumber, courtData) {
    const url = `${SERVER_URL}/api/camden/court-status-update`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-auth-token": AUTH_TOKEN
      },
      body: JSON.stringify({ instrumentNumber, courtData })
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(`Server update failed (${res.status}): ${t.slice(0, 200)}`);
    }
    return res.json();
  }

  // ---- DOM locating helpers ----
  function findInputByHints(hints) {
    const inputs = Array.from(document.querySelectorAll("input, textarea"));
    const lower = (s) => (s || "").toLowerCase();
    return inputs.find(inp => {
      const id = lower(inp.id);
      const name = lower(inp.name);
      const aria = lower(inp.getAttribute("aria-label"));
      const ph = lower(inp.getAttribute("placeholder"));
      const hay = `${id} ${name} ${aria} ${ph}`;
      return hints.some(h => hay.includes(h));
    });
  }

  function findButtonByText(textHints) {
    const buttons = Array.from(document.querySelectorAll("button, input[type='submit'], a"));
    const lower = (s) => (s || "").toLowerCase();
    return buttons.find(b => {
      const t = lower(b.textContent || b.value || "");
      return textHints.some(h => t.includes(h));
    });
  }

  function locateFields(cfg) {
    const partyInput = cfg.partyInputSelector
      ? document.querySelector(cfg.partyInputSelector)
      : findInputByHints(["defendant", "party", "last name", "name"]);

    const docketInput = cfg.docketInputSelector
      ? document.querySelector(cfg.docketInputSelector)
      : findInputByHints(["docket", "case", "case number", "casenumber"]);

    const searchBtn = cfg.searchButtonSelector
      ? document.querySelector(cfg.searchButtonSelector)
      : findButtonByText(["search", "submit", "find", "go"]);

    const resultsEl = cfg.resultsSelector ? document.querySelector(cfg.resultsSelector) : null;

    return { partyInput, docketInput, searchBtn, resultsEl };
  }

  function pageHasCaptchaFailure(cfg) {
    const bodyText = (document.body?.innerText || "").toLowerCase();
    const re = new RegExp(cfg.captchaRegex, "i");
    // also catch common captcha widgets
    const hasWidget =
      !!document.querySelector("iframe[src*='recaptcha']") ||
      !!document.querySelector("[id*='captcha'], [class*='captcha']");
    return re.test(bodyText) || hasWidget;
  }

  function escapeHtml(s) {
    return String(s || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function normalizeDefendantName(name, useLastNameOnly) {
    const n = String(name || "").trim();
    if (!n) return "";
    if (!useLastNameOnly) return n;

    // common formats: "LAST FIRST", "LAST, FIRST", "LAST FIRST M"
    // pick the first token before comma/space.
    const beforeComma = n.split(",")[0].trim();
    const firstToken = beforeComma.split(/\s+/)[0].trim();
    return firstToken || beforeComma || n;
  }

  function getResultsSnapshot(cfg, found) {
    // Prefer the configured results container if provided
    if (found.resultsEl) {
      const txt = found.resultsEl.innerText.replace(/\s+/g, " ").trim();
      return txt.slice(0, 800);
    }

    // fallback: any table, but this is unreliable
    const table = document.querySelector("table");
    if (table) {
      const txt = table.innerText.replace(/\s+/g, " ").trim();
      if (txt) return txt.slice(0, 600);
    }

    const bodyText = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
    return bodyText.slice(0, 400);
  }

  async function waitForResultsOrCaptcha(cfg, found) {
    const start = Date.now();

    // quick checks
    if (pageHasCaptchaFailure(cfg)) return { kind: "captcha" };
    if (found.resultsEl && found.resultsEl.innerText.trim()) return { kind: "results" };

    return await new Promise((resolve) => {
      const done = (kind) => {
        try { obs.disconnect(); } catch {}
        resolve({ kind });
      };

      const obs = new MutationObserver(() => {
        if (pageHasCaptchaFailure(cfg)) return done("captcha");
        if (found.resultsEl && found.resultsEl.innerText.trim().length > 0) return done("results");
        if (Date.now() - start > MAX_WAIT_FOR_RESULTS_MS) return done("timeout");
      });

      obs.observe(document.documentElement, { childList: true, subtree: true, characterData: true });

      // safety timeout
      setTimeout(() => done("timeout"), MAX_WAIT_FOR_RESULTS_MS + 200);
    });
  }

  async function runSearchOnPage(cfg, { docketNumber, defendantName }, found) {
    if (!found.searchBtn || (!found.docketInput && !found.partyInput)) {
      return {
        courtStatus: "ERROR",
        courtDisposition:
          "Could not locate search fields/buttons on this page. Use Advanced settings → Test find fields, then set CSS selectors."
      };
    }

    // fill
    const cleanDef = normalizeDefendantName(defendantName, cfg.useLastNameOnly);

    if (found.docketInput && docketNumber) {
      found.docketInput.focus();
      found.docketInput.value = "";
      found.docketInput.dispatchEvent(new Event("input", { bubbles: true }));
      found.docketInput.value = docketNumber;
      found.docketInput.dispatchEvent(new Event("input", { bubbles: true }));
    } else if (found.partyInput && cleanDef) {
      found.partyInput.focus();
      found.partyInput.value = "";
      found.partyInput.dispatchEvent(new Event("input", { bubbles: true }));
      found.partyInput.value = cleanDef;
      found.partyInput.dispatchEvent(new Event("input", { bubbles: true }));
    }

    flashOutline(found.searchBtn);

    if (cfg.safeMode) {
      // Human click
      return {
        courtStatus: "NEEDS_USER_SEARCH",
        courtDisposition: `Filled fields for defendant: "${cleanDef}". Click Search on the page, then press "Capture Results".`
      };
    }

    // Auto click (more CAPTCHA risk)
    found.searchBtn.click();

    const wait = await waitForResultsOrCaptcha(cfg, found);
    if (wait.kind === "captcha") {
      return { courtStatus: "CAPTCHA", courtDisposition: "Captcha/session invalid detected. Solve captcha and resume." };
    }
    if (wait.kind === "timeout") {
      const snap = getResultsSnapshot(cfg, found);
      return { courtStatus: "TIMEOUT", courtDisposition: `Timed out waiting for results. Snapshot: ${snap}` };
    }

    const summary = getResultsSnapshot(cfg, found);
    const noRe = new RegExp(cfg.noResultsRegex, "i");
    const isFound = summary && !noRe.test(summary);

    return { courtStatus: isFound ? "FOUND" : "NOT_FOUND", courtDisposition: summary };
  }

  // ---- Runner state ----
  function saveState(state) {
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
  }
  function loadState() {
    try { return JSON.parse(localStorage.getItem(STATE_KEY) || "null"); }
    catch { return null; }
  }
  function clearState() {
    localStorage.removeItem(STATE_KEY);
  }

  let shouldStop = false;

  async function main() {
    ensureOverlay();
    const cfg = loadCfg();

    setStatus("Starting… fetching cases from your server.");
    setActions([{ label: "Stop", kind: "secondary", onClick: () => (shouldStop = true) }]);

    let payload;
    try {
      payload = await apiGetCases();
    } catch (e) {
      setStatus(`❌ Failed to fetch cases.<br><code>${escapeHtml(e.message)}</code><br><br>Check: Render env SITE_PASSWORD = "${escapeHtml(AUTH_TOKEN)}"`);
      log("Fetch cases failed: " + e.message);
      return;
    }

    let cases = payload.cases || [];
    if (TEST_MODE) cases = cases.slice(0, 10);

    if (!cases.length) {
      setStatus("No cases returned from server.");
      return;
    }

    const saved = loadState();
    let startIndex = saved?.index || 0;

    setStatus(`✅ Loaded ${cases.length} cases.<br>Starting at #${startIndex + 1}.<br><small>Safe Mode: ${cfg.safeMode ? "ON" : "OFF"}</small>`);
    log(`Safe Mode is ${cfg.safeMode ? "ON (recommended)" : "OFF (higher CAPTCHA risk)"}`);

    for (let i = startIndex; i < cases.length; i++) {
      if (shouldStop) {
        setStatus("Stopped.");
        saveState({ index: i });
        return;
      }

      const c = cases[i];
      const instrumentNumber = c.instrumentNumber || c.caseNumber || `idx-${i}`;
      const defendantName = c.primaryDefendant || c.defendant || "";
      const docketNumber = c.courtDocketNumber || c.docketNumber || "";

      saveState({ index: i });

      const cfgNow = loadCfg(); // reload in case user changed settings mid-run
      const found = locateFields(cfgNow);

      setStatus(`🔎 [${i + 1}/${cases.length}] ${escapeHtml(instrumentNumber)}<br><small>${escapeHtml(defendantName)}</small>`);
      log(`Preparing search for ${instrumentNumber}…`);

      const result = await runSearchOnPage(cfgNow, { docketNumber, defendantName }, found);

      // If Safe Mode, you click Search, then we capture results on demand
      if (result.courtStatus === "NEEDS_USER_SEARCH") {
        setStatus(`🧍 Manual step required (Safe Mode).<br>${escapeHtml(result.courtDisposition)}`);

        await new Promise((resolve) => {
          setActions([
            {
              label: "Capture Results",
              kind: "primary",
              onClick: async () => {
                const freshCfg = loadCfg();
                const freshFound = locateFields(freshCfg);
                const wait = await waitForResultsOrCaptcha(freshCfg, freshFound);
                if (wait.kind === "captcha") {
                  setStatus("⚠️ CAPTCHA detected. Solve it on the page, then click Capture Results again.");
                  log("CAPTCHA detected during capture.");
                  return;
                }
                const summary = getResultsSnapshot(freshCfg, freshFound);
                const noRe = new RegExp(freshCfg.noResultsRegex, "i");
                const isFound = summary && !noRe.test(summary);
                const finalRes = { courtStatus: isFound ? "FOUND" : "NOT_FOUND", courtDisposition: summary };

                try {
                  await apiPostUpdate(instrumentNumber, finalRes);
                  log(`✅ ${instrumentNumber} → ${finalRes.courtStatus}`);
                } catch (e) {
                  log(`❌ Update failed for ${instrumentNumber}: ${e.message}`);
                }

                resolve();
              }
            },
            { label: "Skip", kind: "secondary", onClick: () => resolve() },
            { label: "Stop", kind: "secondary", onClick: () => { shouldStop = true; resolve(); } }
          ]);
        });

        if (shouldStop) {
          setStatus("Stopped.");
          return;
        }

        await sleep(jitterDelay());
        continue;
      }

      // If CAPTCHA detected in auto mode
      if (result.courtStatus === "CAPTCHA") {
        setStatus(`⚠️ CAPTCHA/session invalid.<br>1) Solve CAPTCHA or refresh page and solve it.<br>2) Click Resume.`);
        log("CAPTCHA/session invalid detected.");
        await new Promise((resolve) => {
          setActions([
            { label: "Resume", kind: "primary", onClick: () => resolve() },
            { label: "Stop", kind: "secondary", onClick: () => { shouldStop = true; resolve(); } }
          ]);
        });
        if (shouldStop) return;
        i--; // retry same case
        continue;
      }

      // Normal auto-mode posting
      try {
        await apiPostUpdate(instrumentNumber, result);
        log(`✅ ${instrumentNumber} → ${result.courtStatus}`);
      } catch (e) {
        log(`❌ Update failed for ${instrumentNumber}: ${e.message}`);
      }

      await sleep(jitterDelay());
    }

    clearState();
    setStatus("🎉 Done! All cases processed.");
    setActions([{ label: "Close", kind: "secondary", onClick: () => document.getElementById("njcs-overlay")?.remove() }]);
  }

  main().catch(err => {
    ensureOverlay();
    setStatus(`❌ Unexpected error: <code>${escapeHtml(err.message)}</code>`);
    log("Unexpected error: " + (err.stack || err.message));
  });

})();
