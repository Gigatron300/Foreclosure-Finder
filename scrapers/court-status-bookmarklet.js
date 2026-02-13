/* court-status-bookmarklet.js
 * Safe mode + robust NJ eCourts "Last" field detection
 */

/* global __SERVER_URL__, __AUTH_TOKEN__, __TEST_MODE__ */

(function () {
  const SERVER_URL = "__SERVER_URL__";
  const AUTH_TOKEN = "__AUTH_TOKEN__";
  const TEST_MODE = "__TEST_MODE__" === "true";

  const DELAY_BETWEEN_CASES_MS = 3500;
  const JITTER_MS = 2500;
  const MAX_WAIT_FOR_RESULTS_MS = 12000;

  const CFG_KEY = "njcs_cfg_v3";
  const STATE_KEY = "njcs_runner_state_v3";

  const defaultCfg = {
    safeMode: true,
    useLastNameOnly: true,
    docketInputSelector: "",
    partyInputSelector: "",
    searchButtonSelector: "",
    resultsSelector: "",
    noResultsRegex: "no results|no records|not found",
    captchaRegex: "captcha verification has failed|system is available.*captcha|captcha.*failed for this session",
  };

  function loadCfg() {
    try { return { ...defaultCfg, ...(JSON.parse(localStorage.getItem(CFG_KEY) || "null") || {}) }; }
    catch { return { ...defaultCfg }; }
  }
  function saveCfg(cfg) { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); }

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
            <input id="njcs-partySel" placeholder="Party (Last Name) input CSS selector (optional)" style="width:100%;padding:8px;border-radius:10px;border:1px solid rgba(255,255,255,0.2);background:rgba(255,255,255,0.06);color:#fff;" />
            <input id="njcs-docketSel" placeholder="Docket input CSS selector (optional)" style="width:100%;padding:8px;border-radius:10px;border:1px solid rgba(255,255,255,0.2);background:rgba(255,255,255,0.06);color:#fff;" />
            <input id="njcs-searchSel" placeholder="Search button CSS selector (optional)" style="width:100%;padding:8px;border-radius:10px;border:1px solid rgba(255,255,255,0.2);background:rgba(255,255,255,0.06);color:#fff;" />
            <input id="njcs-resultsSel" placeholder="RESULTS container selector (recommended)" style="width:100%;padding:8px;border-radius:10px;border:1px solid rgba(255,255,255,0.2);background:rgba(255,255,255,0.06);color:#fff;" />
          </div>

          <div style="margin-top:10px;display:flex;gap:10px;flex-wrap:wrap;">
            <button id="njcs-saveCfg" style="cursor:pointer;border-radius:10px;padding:8px 10px;border:1px solid rgba(255,255,255,0.2);background:rgba(80,160,255,0.9);color:#fff;">Save settings</button>
            <button id="njcs-testFind" style="cursor:pointer;border-radius:10px;padding:8px 10px;border:1px solid rgba(255,255,255,0.2);background:rgba(255,255,255,0.08);color:#fff;">Test find fields</button>
            <button id="njcs-resetCfg" style="cursor:pointer;border-radius:10px;padding:8px 10px;border:1px solid rgba(255,255,255,0.2);background:rgba(255,255,255,0.08);color:#fff;">Reset settings</button>
          </div>

          <div style="margin-top:10px;opacity:0.8;line-height:1.35;">
            Tip: Right-click the Last name box → Inspect → right-click &lt;input&gt; → Copy → Copy selector.
          </div>
        </div>
      </details>

      <div id="njcs-log" style="margin-top:12px;max-height:220px;overflow:auto;font-size:12px;opacity:0.9;"></div>
    `;
    document.body.appendChild(el);
    document.getElementById("njcs-close").onclick = () => el.remove();

    const cfg = loadCfg();
    setCfgUI(cfg);

    document.getElementById("njcs-saveCfg").onclick = () => { saveCfg(getCfgFromUI()); log("✅ Saved settings."); };
    document.getElementById("njcs-resetCfg").onclick = () => { saveCfg({ ...defaultCfg }); setCfgUI(loadCfg()); log("✅ Reset settings."); };
    document.getElementById("njcs-testFind").onclick = () => {
      const testCfg = getCfgFromUI();
      const found = locateFields(testCfg);
      log(`Test find:
- partyInput (Last): ${found.partyInput ? "✅" : "❌"}
- docketInput: ${found.docketInput ? "✅" : "❌"}
- searchBtn: ${found.searchBtn ? "✅" : "❌"}
- resultsEl: ${found.resultsEl ? "✅" : "❌ (set results selector if needed)"}`);
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

  function setStatus(html) { ensureOverlay(); document.getElementById("njcs-status").innerHTML = html; }
  function setActions(buttons) {
    ensureOverlay();
    const wrap = document.getElementById("njcs-actions");
    wrap.innerHTML = "";
    buttons.forEach(({ label, onClick, kind }) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.style.cssText = `
        cursor:pointer;border-radius:10px;padding:8px 10px;
        border: 1px solid rgba(255,255,255,0.2);
        background: ${kind === "primary" ? "rgba(80,160,255,0.9)" : "rgba(255,255,255,0.08)"};
        color:#fff;`;
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

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
  function jitterDelay() { return 3500 + Math.floor(Math.random() * 2500); }

  function flashOutline(el) {
    const prev = el.style.outline;
    el.style.outline = "3px solid rgba(80,160,255,0.9)";
    setTimeout(() => (el.style.outline = prev), 900);
  }

  async function apiGetCases() {
    const url = `${SERVER_URL}/api/camden?sortBy=daysSinceFiling&sortOrder=desc${TEST_MODE ? "&test=true" : ""}`;
    const res = await fetch(url, { headers: { "x-auth-token": AUTH_TOKEN } });
    if (!res.ok) throw new Error(`Server /api/camden failed (${res.status})`);
    return res.json();
  }
  async function apiPostUpdate(instrumentNumber, courtData) {
    const url = `${SERVER_URL}/api/camden/court-status-update`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-auth-token": AUTH_TOKEN },
      body: JSON.stringify({ instrumentNumber, courtData })
    });
    if (!res.ok) throw new Error(`Server update failed (${res.status})`);
    return res.json();
  }

  // ---------- IMPORTANT PART: find the Last-name input ----------
  function isVisible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.bottom >= 0 && r.right >= 0;
  }

  function findInputNearExactText(exactText) {
    const want = exactText.trim().toLowerCase();
    const candidates = Array.from(document.querySelectorAll("label, td, th, span, div"))
      .filter(n => (n.textContent || "").trim().toLowerCase() === want);

    for (const node of candidates) {
      // 1) input inside same cell/node
      const inside = node.querySelector?.("input, textarea");
      if (inside && isVisible(inside)) return inside;

      // 2) input in same parent
      const parent = node.parentElement;
      if (parent) {
        const inp = parent.querySelector("input, textarea");
        if (inp && isVisible(inp)) return inp;
      }

      // 3) input in next sibling cell
      const next = node.nextElementSibling;
      if (next) {
        const inp = next.querySelector("input, textarea");
        if (inp && isVisible(inp)) return inp;
      }
    }
    return null;
  }

  function findButtonByText(textHints) {
    const buttons = Array.from(document.querySelectorAll("button, input[type='submit'], input[type='button'], a"));
    const lower = (s) => (s || "").toLowerCase();
    return buttons.find(b => {
      const t = lower(b.textContent || b.value || "");
      return textHints.some(h => t.includes(h));
    });
  }

  function locateFields(cfg) {
    const partyInput =
      (cfg.partyInputSelector && document.querySelector(cfg.partyInputSelector)) ||
      // NJ eCourts page: the visible field is literally labeled "Last"
      findInputNearExactText("Last") ||
      null;

    const docketInput =
      (cfg.docketInputSelector && document.querySelector(cfg.docketInputSelector)) ||
      null;

    const searchBtn =
      (cfg.searchButtonSelector && document.querySelector(cfg.searchButtonSelector)) ||
      findButtonByText(["search"]) ||
      null;

    const resultsEl = cfg.resultsSelector ? document.querySelector(cfg.resultsSelector) : null;
    return { partyInput, docketInput, searchBtn, resultsEl };
  }

  function pageHasCaptchaFailure(cfg) {
    const bodyText = (document.body?.innerText || "").toLowerCase();
    const re = new RegExp(cfg.captchaRegex, "i");
    const hasWidget =
      !!document.querySelector("iframe[src*='recaptcha']") ||
      !!document.querySelector("[id*='captcha'], [class*='captcha']");
    return re.test(bodyText) || hasWidget;
  }

  function escapeHtml(s) {
    return String(s || "")
      .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;").replaceAll("'", "&#039;");
  }

  function normalizeDefendantName(name, useLastNameOnly) {
    const n = String(name || "").trim();
    if (!n) return "";
    if (!useLastNameOnly) return n;
    const beforeComma = n.split(",")[0].trim();
    const firstToken = beforeComma.split(/\s+/)[0].trim();
    return firstToken || beforeComma || n;
  }

  async function main() {
    ensureOverlay();
    const cfg = loadCfg();

    setStatus("Starting… fetching cases from your server.");
    setActions([{ label: "Stop", kind: "secondary", onClick: () => (window.__njcsStop = true) }]);

    const payload = await apiGetCases();
    let cases = payload.cases || [];
    if (TEST_MODE) cases = cases.slice(0, 10);

    if (!cases.length) {
      setStatus("No cases returned from server.");
      return;
    }

    const saved = (() => { try { return JSON.parse(localStorage.getItem(STATE_KEY) || "null"); } catch { return null; } })();
    let startIndex = saved?.index || 0;

    setStatus(`✅ Loaded ${cases.length} cases.<br>Starting at #${startIndex + 1}.<br><small>Safe Mode: ${cfg.safeMode ? "ON" : "OFF"}</small>`);

    for (let i = startIndex; i < cases.length; i++) {
      if (window.__njcsStop) {
        setStatus("Stopped.");
        localStorage.setItem(STATE_KEY, JSON.stringify({ index: i }));
        return;
      }

      const c = cases[i];
      const instrumentNumber = c.instrumentNumber || c.caseNumber || `idx-${i}`;
      const defendantName = c.primaryDefendant || c.defendant || "";
      const cfgNow = loadCfg();
      const found = locateFields(cfgNow);

      setStatus(`🔎 [${i + 1}/${cases.length}] ${escapeHtml(instrumentNumber)}<br><small>${escapeHtml(defendantName)}</small>`);

      if (pageHasCaptchaFailure(cfgNow)) {
        setStatus(`⚠️ CAPTCHA/session message detected.<br>Solve CAPTCHA (or refresh & solve), then click Resume.`);
        await new Promise((resolve) => {
          setActions([
            { label: "Resume", kind: "primary", onClick: () => resolve() },
            { label: "Stop", kind: "secondary", onClick: () => { window.__njcsStop = true; resolve(); } }
          ]);
        });
        i--;
        continue;
      }

      if (!found.partyInput || !found.searchBtn) {
        setStatus(`❌ Could not find the "Last" field or Search button.<br>
          Open Advanced settings → Test find fields. If partyInput is ❌, copy the selector for the Last field and paste it into Party selector.`);
        return;
      }

      // Fill LAST name
      const last = normalizeDefendantName(defendantName, cfgNow.useLastNameOnly);
      found.partyInput.focus();
      found.partyInput.value = "";
      found.partyInput.dispatchEvent(new Event("input", { bubbles: true }));
      found.partyInput.value = last;
      found.partyInput.dispatchEvent(new Event("input", { bubbles: true }));
      flashOutline(found.partyInput);
      flashOutline(found.searchBtn);

      if (cfgNow.safeMode) {
        setStatus(`🧍 Manual step (Safe Mode). Filled Last name: "<b>${escapeHtml(last)}</b>".<br>
          Click <b>Search</b> on the page, then click <b>Capture Results</b>.`);

        await new Promise((resolve) => {
          setActions([
            {
              label: "Capture Results",
              kind: "primary",
              onClick: async () => {
                if (pageHasCaptchaFailure(cfgNow)) {
                  setStatus("⚠️ CAPTCHA detected. Solve it, then click Capture Results again.");
                  return;
                }
                // We don’t have a perfect results parser yet without a resultsSelector.
                // For now, just snapshot body text.
                const snap = (document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 900);
                const noRe = new RegExp(cfgNow.noResultsRegex, "i");
                const isFound = snap && !noRe.test(snap);
                const finalRes = { courtStatus: isFound ? "FOUND" : "NOT_FOUND", courtDisposition: snap };

                await apiPostUpdate(instrumentNumber, finalRes);
                resolve();
              }
            },
            { label: "Skip", kind: "secondary", onClick: () => resolve() },
            { label: "Stop", kind: "secondary", onClick: () => { window.__njcsStop = true; resolve(); } }
          ]);
        });

        await sleep(jitterDelay());
        continue;
      }

      // Auto click (higher CAPTCHA risk)
      found.searchBtn.click();
      await sleep(1500);

      if (pageHasCaptchaFailure(cfgNow)) {
        i--;
        continue;
      }

      const snap = (document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 900);
      const noRe = new RegExp(cfgNow.noResultsRegex, "i");
      const isFound = snap && !noRe.test(snap);
      await apiPostUpdate(instrumentNumber, { courtStatus: isFound ? "FOUND" : "NOT_FOUND", courtDisposition: snap });

      await sleep(jitterDelay());
    }

    localStorage.removeItem(STATE_KEY);
    setStatus("🎉 Done!");
    setActions([{ label: "Close", kind: "secondary", onClick: () => document.getElementById("njcs-overlay")?.remove() }]);
  }

  main().catch(err => {
    ensureOverlay();
    setStatus(`❌ Unexpected error: <code>${escapeHtml(err.message)}</code>`);
    log(err.stack || err.message);
  });
})();
