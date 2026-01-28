This is a much more sophisticated scoring model! Let me implement it based on GPT's framework. Looking at the docket examples, I can see the exact patterns to detect:

**Positive signals (willing to sell):**
- "MATTER SETTLED" (page 1)
- "STIPULATION OF DISMISSAL" (page 5)
- "Praecipe to Reinstate" (pages 2, 9)
- "Motion for Alternate Service" (page 2)
- "Not Found" service issues (pages 2, 6, 7, 9)
- "Withdrawal of Counsel" / "Petition To Withdraw As Counsel" (page 7)
- "STAY IS LIFTED" (pages 2, 3, 5, 7, 8, 9)
- Multiple "CONTINUED TO" entries

**Negative signals (still fighting):**
- "Answer & New Matter" (pages 3, 5, 6, 7, 8)
- "Preliminary Objections" (pages 4, 8)
- "Objection/Opposition" (page 3)
- "Motion for Summary Judgment" by defendant (pages 3, 4)
- "Reply to New Matter" (pages 3, 4, 6, 7)
- "Counterclaim" (page 8)

Let me rewrite the scoring function:Now I need to update the docket scraping to capture all the text for analysis:Now update the results to pass the docket data to the scoring function:Good, that's already there. Now let me update the results object to include the new docket fields:Now update the pipeline.html to show the better scoring breakdown with the grade interpretation:I see the issue - there was a backtick issue. Let me view the full section and rewrite it:Now add CSS for the new elements:Now copy all files:Done! Here's the comprehensive GPT-based scoring system I implemented:

## New Scoring Model (0-100 points)

### 1️⃣ Case Age (max 25 pts)
- <4 months: 0 pts (owner in denial)
- 4-6 months: +5
- 6-9 months: +12
- **9-18 months: +25** 🎯 SWEET SPOT
- 18-24 months: +18
- >24 months: +10 (zombie risk)

### 2️⃣ Docket Activity Intensity (max 20 pts)
- ≤4 entries: +2
- 5-8 entries: +8
- 9-14 entries: +14
- **≥15 entries: +20** (decision fatigue)

### 3️⃣ Delays & Continuances (max 15 pts)
- +5 per continuance (capped at 15)

### 4️⃣ Resistance vs Capitulation (-15 to +15)

**Negative (still fighting):**
- Answer & New Matter: -5
- Preliminary Objections: -5
- Objection/Opposition: -5
- Defendant's Motion for Summary Judgment: -10
- Counterclaim: -8
- Reply to New Matter: -3

**Positive (giving up):**
- Praecipe to Reinstate: +5
- Motion for Alternate Service: +5
- Service issues/Not Found: +5
- **Withdrawal of Counsel: +10** 💰
- Substitution of Counsel: +3

### 5️⃣ Settlement Signals (max 15 pts)
- "Matter Settled": +15 🤝
- Stipulation (not dismissal): +10
- Stipulation of Dismissal: +8
- Stay Lifted: +8

### 6️⃣ Recent Activity Penalty (-10 to 0)
- <30 days ago: -10 (actively fighting)
- 30-90 days: -5
- >90 days: 0 (stalled = good)

### 7️⃣ Bankruptcy Check
- Active bankruptcy: -20 🚫
- Bankruptcy DISCHARGED: +5 ✅

### Grade Interpretation
| Grade | Score | Meaning | Action |
|-------|-------|---------|--------|
| A | 80-100 | Highly willing seller | 📞 Call immediately |
| B | 65-79 | Strong candidate | 📬 Direct mail + call |
| C | 50-64 | On the fence | 🌱 Nurture |
| D | 35-49 | Low probability | 👀 Watchlist |
| F | <35 | Not ready | ⏸️ Skip for now |

### UI Updates
- Score dropdown now shows **grade meaning** (e.g., "🔥 Highly willing")
- **Action recommendation** at top of breakdown
- **Recent docket events** shown with dates
- **Days since last activity** displayed
- Neutral factors shown with "—" instead of +/-
