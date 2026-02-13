/* court-status-bookmarklet.js
 *
 * This runs in YOUR browser on the NJ Courts search page.
 * It pulls Camden cases from your server and searches them one-by-one.
 *
 * IMPORTANT: CAPTCHA cannot be bypassed. This script:
 *  - avoids hidden iframes (common cause of captcha failure)
 *  - pauses when captcha/session invalidation is detected
 *  - lets user solve captcha manually then resume
 */

/* global __SERVER_URL__, __AUTH_TOKEN__, __TEST_MODE__ */

(function () {
  const SERVER_URL = "__SERVER_URL__";
  const AUTH_TOKEN = "__AUTH_TOKEN__";
  const TEST_MODE = "__TEST_MODE__" === "true";

  // ---- Tunables (slower = less CAPTCHA risk) ----
  const DELAY_BETWEEN_CASES_MS = 2500;   // base delay
  const JITTER_MS = 1500;               // random extra delay
  const MAX_CONSECUTIVE_CAPTCHA_HITS = 2;

  // ---- UI overlay helpers ----
  function ensureOverlay() {
    let el = document.getElementById("njcs-overlay");
    if (el) return el;

    el = document.createElement("div");
    el.id = "njcs-overlay";
    el.style.cssText = `
      position: fixed; z-index: 999999;
      top: 16px; right: 16px;
      width: 360px;
      background: rgba(20,20,20,0.95);
      color: #fff; font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial;
      border: 1px solid rgba(255,255,255,0.15);
      border-radius: 12px;
      padding: 14px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.35);
    `;
    el.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;">
        <div style="font-weight:700;">NJ Court Status Runner</div>
        <button id="njcs-close" style="background:transparent;color:#fff;border:1px solid rgba(255,255,255,0.25);border-radius:10px;padding:6px 10px;cursor:pointer;">Close</button>
      </div>
      <div id="njcs-status" style="margin-top:10px;line-height:1.35;font-size:13px;"></div>
      <div id="njcs-actions" style="margin-top:12px;display:flex;gap:10px;flex-wrap:wrap;"></div>
      <div id="njcs-log" style="margin-top:12px;max-height:220px;overflow:auto;font-size:12px;opacity:0.9;"></div>
    `;
    document.body.appendChild(el);

    document.getElementById("njcs-close").onclick = () => el.remove();
    return el;
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

  // ---- Server calls ----
  async function apiGetCases() {
    const url = `${SERVER_URL}/api/camden?sortBy=daysSinceFiling&sortOrder=desc${TEST_MODE ? "&test=true" : ""}`;
    const res = await fetch(url, {
      headers: { "x-auth-token": AUTH_TOKEN }
    });
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

  // ---- NJ Courts page interaction (generic, DOM-based) ----
  // Because NJ Courts pages vary, we use a best-effort strategy:
  // 1) find likely inputs for case/docket/party
  // 2) fill defendant (or docket if present)
  // 3) click a Search button
  // 4) detect either "captcha/session invalid" or read a results table/text
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

  function pageHasCaptchaFailure() {
    const bodyText = (document.body?.innerText || "").toLowerCase();
    return (
      bodyText.includes("captcha verification has failed") ||
      bodyText.includes("captcha") && bodyText.includes("failed for this session") ||
      bodyText.includes("system is available") && bodyText.includes("captcha")
    );
  }

  function readBestEffortResultSummary() {
    // Try to find anything that looks like a results table
    const table = document.querySelector("table");
    if (table) {
      const txt = table.innerText.replace(/\s+/g, " ").trim();
      if (txt.length) return txt.slice(0, 500);
    }
    // Fallback: look for common “no results” text
    const bodyText = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
    if (/no results|no records|not found/i.test(bodyText)) return "No results found";
    return bodyText.slice(0, 400);
  }

  async function runSearchOnPage({ docketNumber, defendantName }) {
    // Try docket/case input first; else try party/defendant field
    const docketInput = findInputByHints(["docket", "case", "case number", "casenumber"]);
    const partyInput = findInputByHints(["defendant", "party", "name", "last name", "business"]);

    const searchBtn = findButtonByText(["search", "submit", "find", "go"]);

    if (!searchBtn || (!docketInput && !partyInput)) {
      return {
        courtStatus: "ERROR",
        courtDisposition: "Could not find search fields/buttons on this page. Open the NJ Courts search screen first."
      };
    }

    // Clear + fill
    if (docketInput && docketNumber) {
      docketInput.focus();
      docketInput.value = "";
      docketInput.dispatchEvent(new Event("input", { bubbles: true }));
      docketInput.value = docketNumber;
      docketInput.dispatchEvent(new Event("input", { bubbles: true }));
    } else if (partyInput && defendantName) {
      partyInput.focus();
      partyInput.value = "";
      partyInput.dispatchEvent(new Event("input", { bubbles: true }));
      partyInput.value = defendantName;
      partyInput.dispatchEvent(new Event("input", { bubbles: true }));
    }

    // Click search
    searchBtn.click();

    // Wait a bit for results to load
    await sleep(1200);

    if (pageHasCaptchaFailure()) {
      return { courtStatus: "CAPTCHA", courtDisposition: "Captcha verification has failed for this session" };
    }

    const summary = readBestEffortResultSummary();
    // Minimal mapping (customize later once you confirm what the page shows)
    const isFound = summary && !/no results|no records|not found/i.test(summary);

    return {
      courtStatus: isFound ? "FOUND" : "NOT_FOUND",
      courtDisposition: summary
    };
  }

  // ---- Runner state (resume support) ----
  const STATE_KEY = "njcs_runner_state_v1";
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

  let paused = false;
  let shouldStop = false;

  async function main() {
    ensureOverlay();
    setStatus("Starting… fetching cases from your server.");
    setActions([{ label: "Stop", kind: "secondary", onClick: () => (shouldStop = true) }]);

    let payload;
    try {
      payload = await apiGetCases();
    } catch (e) {
      setStatus(`❌ Failed to fetch cases.<br><code>${escapeHtml(e.message)}</code><br><br>Double-check your token/password.`);
      log("Fetch cases failed: " + e.message);
      return;
    }

    let cases = payload.cases || [];
    if (TEST_MODE) cases = cases.slice(0, 10);

    if (!cases.length) {
      setStatus("No cases returned from server. (Check upload + auth token.)");
      return;
    }

    const saved = loadState();
    let startIndex = saved?.index || 0;

    setStatus(`✅ Loaded ${cases.length} cases.<br>Starting at #${startIndex + 1}.`);

    let captchaHits = 0;

    for (let i = startIndex; i < cases.length; i++) {
      if (shouldStop) {
        setStatus("Stopped.");
        saveState({ index: i });
        return;
      }

      const c = cases[i];
      const instrumentNumber = c.instrumentNumber || c.caseNumber || `idx-${i}`;
      const defendantName = c.primaryDefendant || c.defendant || "";
      const docketNumber = c.courtDocketNumber || c.docketNumber || ""; // if you ever have it

      saveState({ index: i });

      setStatus(`🔎 [${i + 1}/${cases.length}] ${instrumentNumber}<br><small>${escapeHtml(defendantName || "")}</small>`);
      log(`Searching ${instrumentNumber}…`);

      const result = await runSearchOnPage({ docketNumber, defendantName });

      if (result.courtStatus === "CAPTCHA") {
        captchaHits++;
        log("CAPTCHA/session invalid detected.");

        if (captchaHits >= MAX_CONSECUTIVE_CAPTCHA_HITS) {
          paused = true;
          setStatus(`⚠️ CAPTCHA failed for this session.<br><br>
            1) Solve the CAPTCHA on this page (or refresh and solve it).<br>
            2) Click Resume.<br><br>
            <small>We paused to avoid burning the session.</small>`);

          await new Promise((resolve) => {
            setActions([
              { label: "Resume", kind: "primary", onClick: () => { paused = false; captchaHits = 0; resolve(); } },
              { label: "Stop", kind: "secondary", onClick: () => { shouldStop = true; resolve(); } }
            ]);
          });

          if (shouldStop) {
            setStatus("Stopped.");
            return;
          }
        } else {
          // Short wait then continue (maybe it was a transient message)
          await sleep(3000);
        }

        // Retry this same case after resume/short wait
        i--;
        continue;
      }

      // Post update back to your server
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

  // Small HTML escape for overlay rendering
  function escapeHtml(s) {
    return String(s || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  // Start
  main().catch(err => {
    ensureOverlay();
    setStatus(`❌ Unexpected error: <code>${escapeHtml(err.message)}</code>`);
    log("Unexpected error: " + err.stack);
  });

})();
