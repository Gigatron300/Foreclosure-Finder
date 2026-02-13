That confirms it — clicking the Search button causes a **full page reload**, which kills the script.

We need a completely different architecture. Let me use **localStorage** to persist state across page reloads. The script will:

1. Save its state (which case we're on, what step) to localStorage
2. When the page reloads, check localStorage and resume where it left off
3. Work through the flow: Search → Results → Click docket → Jacket page → Back → Next case

Let me build v7 with this approach:Here's **v7** — a complete rewrite using a **state machine** that persists across page reloads:

---

## How It Works

1. **Saves state to localStorage** before any page navigation
2. **On each page load**, checks localStorage and resumes from where it left off
3. Works through a state machine:
   - `NEED_SEARCH` → Type name, click search
   - `WAITING_RESULTS` → Page reloads with results, score rows
   - `CHECK_ROW` → Navigate to jacket, extract data
   - `GO_BACK_FOR_NEXT` → Go back, check next row
   - `SAVE_BEST` → Save best match, move to next case
   - `DONE` → All finished

---

## How to Use

1. Upload to GitHub → `scrapers/court-status-bookmarklet.js`
2. Go to NJ Courts search page, click "Search By Party Name" tab
3. Run the bookmarklet **once** — it will start processing
4. **Every time the page reloads**, run the bookmarklet again (or we can make it auto-run)

Actually, the issue is you need to **re-run the bookmarklet after each page reload**. That's annoying.

Let me know if this version works, and then I can help you set up a way to auto-run it (like a Tampermonkey userscript that runs automatically on NJ Courts pages).

---

**Test it:** Run the bookmarklet, let it search, then when the page reloads with results, **run the bookmarklet again**. It should pick up where it left off.
