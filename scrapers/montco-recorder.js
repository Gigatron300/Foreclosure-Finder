// montco-recorder.js
// Logs into the Montgomery County Recorder of Deeds public access system
// (rodviewer.montcopa.org, GovOS CountyWeb) with the user's FREE account and
// pulls the document index (deeds, mortgages, satisfactions, assignments) for a
// parcel. The payoff estimate reads these to find every open mortgage.
//
// Credentials come from the environment (RECORDER_USER / RECORDER_PASS) — .env
// locally, the host's environment settings in production. The account holder
// has accepted the site's disclaimer; the script accepts it on each login.
//
// Lookups are paced (one at a time, a pause between parcels) and cached, and only
// parcels in the pipeline are looked up.
//
//   node scrapers/montco-recorder.js --parcel 02-00-03396-00-4   one lookup, print rows
//   node scrapers/montco-recorder.js --refresh                   refresh stale parcels in data/pipeline.json
//   node scrapers/montco-recorder.js --explore                   dump post-login pages (dev aid)

const puppeteer = require('puppeteer');
const fs = require('fs').promises;
const path = require('path');

const BASE = 'https://rodviewer.montcopa.org/countyweb';
const LOGIN_URL = `${BASE}/loginDisplay.action?countyname=Montgomery`;
const SEARCH_URL = `${BASE}/search/searchMain.do?defaultType=Public`;
const DATA_DIR = process.env.DATA_DIR || './data';
const CACHE_PATH = path.join(DATA_DIR, 'montco-recorder.json');

const CONFIG = {
  maxAgeDays: 14,          // re-check a parcel at most every two weeks
  pauseMs: 2500,           // between parcel searches (kept polite: one search at a time)
  searchTimeoutMs: 45000,
  relogEvery: 60           // fresh session every N searches
};

const delay = (ms) => new Promise(r => setTimeout(r, ms));
const NO_RESULTS_RE = /no (records|results|documents) (were )?found|0 items/i;

function hasCredentials() {
  return !!(process.env.RECORDER_USER && process.env.RECORDER_PASS);
}

function credentials() {
  const user = process.env.RECORDER_USER;
  const pass = process.env.RECORDER_PASS;
  if (!user || !pass) throw new Error('RECORDER_USER and RECORDER_PASS must be set (in .env locally, or the server environment).');
  return { user, pass };
}

// "020003396004" / "02-00-03396-00-4" -> "02-00-03396-00-4" (the Recorder's format).
function formatParcel(raw) {
  const first = String(raw || '').split(',')[0].trim();
  const digits = first.replace(/\D/g, '');
  if (digits.length !== 12) return first || null;
  return `${digits.slice(0, 2)}-${digits.slice(2, 4)}-${digits.slice(4, 9)}-${digits.slice(9, 11)}-${digits.slice(11)}`;
}

// Cache key: digits only, so either format finds the same entry.
function parcelKey(raw) {
  const first = String(raw || '').split(',')[0].trim();
  return first.replace(/\D/g, '') || null;
}

async function launch() {
  const opts = {
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
      '--disable-extensions', '--js-flags=--max-old-space-size=512']
  };
  if (process.env.CHROME_PATH) opts.executablePath = process.env.CHROME_PATH;
  return puppeteer.launch(opts);
}

const frameNamed = (page, name) => page.frames().find(f => f.name() === name) || null;

async function waitForFrame(page, name, urlTest, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const f = frameNamed(page, name);
    if (f && urlTest(f.url())) {
      try { await f.waitForFunction(() => document.readyState === 'complete', { timeout: 10000 }); } catch (e) {}
      return f;
    }
    await delay(250);
  }
  throw new Error(`Recorder frame "${name}" did not load in time.`);
}

async function login(page) {
  const { user, pass } = credentials();
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('form[name="loginform"] input[name="username"]', { timeout: 30000 });
  await page.type('form[name="loginform"] input[name="username"]', user);
  await page.type('form[name="loginform"] input[name="password"]', pass);
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {}),
    page.evaluate(() => document.loginform.submit())
  ]);
  await delay(1500);
  if (/loginDisplay|login\.action/i.test(page.url()) && !frameNamed(page, 'bodyframe')) {
    throw new Error('Recorder login failed. Check RECORDER_USER / RECORDER_PASS.');
  }
  // Disclaimer: accepted by the account holder; shown on every login.
  const body = await waitForFrame(page, 'bodyframe', (u) => !/blank\.jsp/.test(u)).catch(() => null);
  if (body && /disclaimer/i.test(body.url())) {
    await body.evaluate(() => executeCommand('Accept'));
    await waitForFrame(page, 'bodyframe', (u) => !/disclaimer|blank\.jsp/i.test(u));
  }
  return page.url();
}

// Results HTML -> plain text the payoff parser understands.
function resultsHtmlToText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<(td|tr|br|div|p)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

// One parcel search in an already logged-in page. Returns { text, total, truncated }.
async function searchParcel(page, rawParcel) {
  const parcel = formatParcel(rawParcel);
  if (!parcel) throw new Error(`Bad parcel number: ${rawParcel}`);

  const body = frameNamed(page, 'bodyframe');
  await body.goto(SEARCH_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const criteria = await waitForFrame(page, 'criteriaframe', (u) => /dynCriteria/.test(u));
  const dyn = await waitForFrame(page, 'dynSearchFrame', (u) => /searchCriteria/.test(u));
  await criteria.waitForFunction(() => window.$ && $('#PARCELNUM').length && typeof executeSearch === 'function', { timeout: 20000 });

  await dyn.evaluate(() => { try { $('#RECSPERPAGE').combobox('setValue', '100'); } catch (e) {} });
  await criteria.evaluate((v) => { $('#PARCELNUM').textbox('setValue', v); executeSearch(); }, parcel);

  // Results land in resultFrame (with nav state) and resultListFrame (the table),
  // or a "no results" message.
  const start = Date.now();
  while (Date.now() - start < CONFIG.searchTimeoutMs) {
    const resultFrame = frameNamed(page, 'resultFrame');
    const rf = resultFrame ? resultFrame.url() : '';
    const list = frameNamed(page, 'resultListFrame');
    if (list && /SearchResultList/i.test(list.url()) && /SearchResultsView/i.test(rf)) {
      try { await list.waitForFunction(() => document.readyState === 'complete', { timeout: 10000 }); } catch (e) {}
      const html = await list.content();
      const nav = decodeURIComponent((rf.match(/navStateDisplay=([^&]*)/) || [])[1] || '').replace(/\+/g, ' ');
      const m = nav.match(/of\s+(\d+)\s+Items/i);
      const total = m ? parseInt(m[1], 10) : null;
      const shown = (nav.match(/\d+-(\d+)/) || [])[1];
      return { parcel, text: resultsHtmlToText(html), total, truncated: !!(total && shown && +shown < total) };
    }
    // CountyWeb renders its no-match notice in different nested frames depending
    // on the search response. Treat the official notice anywhere in the frame
    // tree as a successful zero-document lookup.
    for (const frame of page.frames()) {
      const text = await frame.evaluate(() => document.body ? document.body.innerText : '').catch(() => '');
      if (NO_RESULTS_RE.test(text)) {
        return { parcel, text: '', total: 0, truncated: false };
      }
    }
    await delay(500);
  }
  throw new Error(`Recorder search timed out for ${parcel}`);
}

async function readCache(cachePath = CACHE_PATH) {
  try { return JSON.parse(await fs.readFile(cachePath, 'utf8')); } catch (e) { return {}; }
}

async function writeCache(cache, cachePath = CACHE_PATH) {
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  const tmp = cachePath + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(cache));
  await fs.rename(tmp, cachePath);
}

function isStale(entry, maxAgeDays) {
  if (!entry || !entry.fetchedAt) return true;
  return (Date.now() - new Date(entry.fetchedAt).getTime()) > maxAgeDays * 86400000;
}

const CLOSED_RE = /CLOS|DISPOS|SETTL|DISMISS|WITHDRAW|SATISF|DISCONTINU/;
function caseIsOpen(c) {
  if (c.liveClosed) return false;
  const s = String(c.liveStatus || c.status || '').toUpperCase();
  return !(CLOSED_RE.test(s) && !/OPEN|ACTIVE|PENDING/.test(s));
}

// Parcels worth a lookup: any parcel with at least one open case.
function parcelsToRefresh(cases, cache, maxAgeDays = CONFIG.maxAgeDays) {
  const keys = new Map();
  for (const c of cases || []) {
    const key = parcelKey(c.parcelNumber);
    if (!key || key.length !== 12) continue;
    if (!keys.has(key)) keys.set(key, { key, raw: c.parcelNumber, open: false });
    if (caseIsOpen(c)) keys.get(key).open = true;
  }
  return [...keys.values()].filter(p => p.open && isStale(cache[p.key], maxAgeDays));
}

/**
 * Look up every stale pipeline parcel, one at a time, saving after each.
 * @returns {{ checked, failed, skipped, remaining }}
 */
async function refreshRecorderIndex({ cases, cachePath = CACHE_PATH, maxAgeDays = CONFIG.maxAgeDays, limit = 0,
  shouldStop = () => false, onProgress = () => {} } = {}) {
  if (!hasCredentials()) return { checked: 0, failed: 0, skipped: 'no RECORDER_USER/RECORDER_PASS', remaining: 0 };
  const cache = await readCache(cachePath);
  let todo = parcelsToRefresh(cases, cache, maxAgeDays);
  if (limit > 0) todo = todo.slice(0, limit);
  const result = { checked: 0, failed: 0, total: todo.length, remaining: todo.length };
  if (!todo.length) return result;

  let browser = null, page = null, sinceLogin = 0;
  const open = async () => {
    if (browser) await browser.close().catch(() => {});
    browser = await launch();
    page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 1000 });
    const t = Date.now();
    await login(page);
    console.log(`   📚 Recorder login ok (${Math.round((Date.now() - t) / 1000)}s)`);
    sinceLogin = 0;
  };

  console.log(`   📚 Recorder: ${todo.length} parcel(s) to look up`);
  try {
    await open();
    for (const p of todo) {
      if (shouldStop()) break;
      if (sinceLogin >= CONFIG.relogEvery) await open();
      const t0 = Date.now();
      try {
        const r = await searchParcel(page, p.raw);
        console.log(`   📚 ${r.parcel}: ${r.total ?? 0} documents (${Math.round((Date.now() - t0) / 1000)}s) [${result.checked + result.failed + 1}/${todo.length}]`);
        cache[p.key] = { parcel: r.parcel, fetchedAt: new Date().toISOString(), total: r.total, truncated: r.truncated, text: r.text };
        result.checked++;
      } catch (e) {
        result.failed++;
        console.log(`   📚 ${p.raw}: FAILED after ${Math.round((Date.now() - t0) / 1000)}s: ${e.message}`);
        cache[p.key] = { ...(cache[p.key] || {}), lastError: e.message, lastErrorAt: new Date().toISOString() };
        // A broken session fails every later search; start a fresh one.
        try { await open(); } catch (e2) { throw e2; }
      }
      sinceLogin++;
      result.remaining--;
      await writeCache(cache, cachePath);
      onProgress({ ...result, parcel: p.raw });
      await delay(CONFIG.pauseMs);
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
  return result;
}

// Dev aid: describe every frame (forms, inputs, links).
async function describeFrames(page) {
  const out = [];
  for (const f of page.frames()) {
    let info = '';
    try {
      info = await f.evaluate(() => {
        const lines = [];
        document.querySelectorAll('form').forEach(fm => lines.push(`FORM name=${fm.name} action=${fm.getAttribute('action')} method=${fm.method}`));
        document.querySelectorAll('input,select,button,textarea').forEach(i =>
          lines.push(`  ${i.tagName} type=${i.type} name=${i.name} id=${i.id} value=${String(i.value || '').slice(0, 40)}`));
        document.querySelectorAll('frame,iframe').forEach(fr => lines.push(`  FRAME name=${fr.name} src=${fr.getAttribute('src')}`));
        return lines.join('\n');
      });
    } catch (e) { info = `(unreadable: ${e.message})`; }
    out.push(`=== FRAME name=${f.name()} url=${f.url()}\n${info}`);
  }
  return out.join('\n\n');
}

module.exports = {
  login, launch, searchParcel, refreshRecorderIndex, readCache, parcelKey, formatParcel,
  hasCredentials, parcelsToRefresh, describeFrames, CONFIG, CACHE_PATH
};

if (require.main === module) {
  try { require('dotenv').config(); } catch (e) {}
  const argv = process.argv.slice(2);
  const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
  (async () => {
    if (argv.includes('--parcel')) {
      const browser = await launch();
      try {
        const page = await browser.newPage();
        await login(page);
        const r = await searchParcel(page, val('--parcel'));
        const { parseRecorderIndex } = require('./payoff-estimate');
        console.log(`${r.parcel}: ${r.total} documents${r.truncated ? ' (TRUNCATED)' : ''}`);
        for (const row of parseRecorderIndex(r.text)) {
          console.log(`  ${row.key.padEnd(16)} ${row.type.padEnd(26)} ${String(row.amount ?? '').padEnd(11)} ${row.recorded}`);
        }
      } finally { await browser.close().catch(() => {}); }
    } else if (argv.includes('--refresh')) {
      const data = JSON.parse(await fs.readFile(path.join(DATA_DIR, 'pipeline.json'), 'utf8'));
      const r = await refreshRecorderIndex({
        cases: data.cases, limit: parseInt(val('--limit') || '0', 10),
        onProgress: (p) => console.log(`  ${p.parcel}  checked ${p.checked}, failed ${p.failed}, remaining ${p.remaining}`)
      });
      console.log('Done:', r);
    } else if (argv.includes('--explore')) {
      const dir = path.join(DATA_DIR, 'recorder-explore');
      await fs.mkdir(dir, { recursive: true });
      const browser = await launch();
      try {
        const page = await browser.newPage();
        await login(page);
        await frameNamed(page, 'bodyframe').goto(SEARCH_URL, { waitUntil: 'domcontentloaded' });
        await delay(4000);
        await fs.writeFile(path.join(dir, 'search.txt'), await describeFrames(page));
        console.log('Wrote', dir);
      } finally { await browser.close().catch(() => {}); }
    } else {
      console.log('Usage: node scrapers/montco-recorder.js --parcel <id> | --refresh [--limit N] | --explore');
    }
    process.exit(0);
  })().catch(e => { console.error('❌', e.message); process.exit(1); });
}
