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
const {
  lookupParcelById, parcelMatchesCase, applyParcelMatch, repairHybridLocation, verifyPostalLocation
} = require('./montco-parcel-match');

const BASE = 'https://rodviewer.montcopa.org/countyweb';
const LOGIN_URL = `${BASE}/loginDisplay.action?countyname=Montgomery`;
const SEARCH_URL = `${BASE}/search/searchMain.do?defaultType=Public`;
const DATA_DIR = process.env.DATA_DIR || './data';
const CACHE_PATH = path.join(DATA_DIR, 'montco-recorder.json');

const CONFIG = {
  maxAgeDays: 14,          // re-check a parcel at most every two weeks
  pauseMs: 2500,           // between parcel searches (kept polite: one search at a time)
  searchTimeoutMs: 45000,
  emptyStableMs: 2000,     // ignore CountyWeb's transient no-results frame while a real result page loads
  maxNameResults: 100,     // broader name searches are ambiguous and expensive to paginate
  relogEvery: 60           // fresh session every N searches
};

// Version zero-result cache entries separately. The first zero-result implementation
// could capture a transient empty search fired by the records-per-page widget.
const SEARCH_CACHE_VERSION = 2;
const PARCEL_RESOLUTION_VERSION = 4;

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

function resultNav(url) {
  const nav = decodeURIComponent((String(url || '').match(/navStateDisplay=([^&]*)/) || [])[1] || '').replace(/\+/g, ' ');
  const range = nav.match(/Displaying\s+(\d+)-(\d+)\s+of\s+(\d+)\s+Items/i);
  return range
    ? { label: nav, start: parseInt(range[1], 10), end: parseInt(range[2], 10), total: parseInt(range[3], 10) }
    : { label: nav, start: 0, end: 0, total: null };
}

async function collectResultPages(page, { maxTotal = Infinity } = {}) {
  const htmlPages = [];
  let resultFrame = frameNamed(page, 'resultFrame');
  let list = frameNamed(page, 'resultListFrame');
  if (!resultFrame || !list) throw new Error('Recorder result frames did not load.');
  try { await list.waitForFunction(() => document.readyState === 'complete', { timeout: 10000 }); } catch (e) {}

  let html = await list.content();
  htmlPages.push(html);
  let nav = resultNav(resultFrame.url());
  if (nav.total > maxTotal) {
    return { text: '', total: nav.total, truncated: true, tooBroad: true };
  }
  if (!nav.total || nav.end >= nav.total) {
    return { text: resultsHtmlToText(htmlPages.join('\n')), total: nav.total, truncated: false };
  }

  const pageSize = Math.max(1, nav.end - nav.start + 1);
  const pageCount = Math.ceil(nav.total / pageSize);
  for (let pageNumber = 2; pageNumber <= pageCount; pageNumber++) {
    const previousStart = nav.start;
    const previousHtml = html;
    await resultFrame.evaluate((number) => {
      document.resultForm.pageNumber.value = String(number);
      goToResultPage();
    }, pageNumber);

    const started = Date.now();
    let loaded = false;
    while (Date.now() - started < CONFIG.searchTimeoutMs) {
      resultFrame = frameNamed(page, 'resultFrame');
      list = frameNamed(page, 'resultListFrame');
      nav = resultNav(resultFrame ? resultFrame.url() : '');
      if (resultFrame && list && nav.start > previousStart) {
        try { await list.waitForFunction(() => document.readyState === 'complete', { timeout: 5000 }); } catch (e) {}
        html = await list.content().catch(() => '');
        if (html && html !== previousHtml) {
          htmlPages.push(html);
          loaded = true;
          break;
        }
      }
      await delay(200);
    }
    if (!loaded) throw new Error(`Recorder result page ${pageNumber} did not load.`);
  }

  return { text: resultsHtmlToText(htmlPages.join('\n')), total: nav.total, truncated: nav.end < nav.total };
}

async function openSearch(page) {
  const body = frameNamed(page, 'bodyframe');
  if (!body) throw new Error('Recorder search frame is unavailable.');
  await body.goto(SEARCH_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  let criteria = await waitForFrame(page, 'criteriaframe', (u) => /dynCriteria/.test(u));
  const dyn = await waitForFrame(page, 'dynSearchFrame', (u) => /searchCriteria/.test(u));
  // CountyWeb remembers the last search type in the session. Return explicitly to
  // All Names, whose criteria form contains both the name and parcel fields.
  if (!/searchType=allNames/i.test(criteria.url())) {
    await dyn.waitForSelector('#searchTypes tr[datagrid-row-index="2"]', { timeout: 20000 });
    await dyn.click('#searchTypes tr[datagrid-row-index="2"]');
    criteria = await waitForFrame(page, 'criteriaframe', (u) => /searchType=allNames/i.test(u));
  }
  return { criteria, dyn };
}

async function waitForSearchResults(page, options = {}) {
  const start = Date.now();
  let noResultsSince = 0;
  while (Date.now() - start < CONFIG.searchTimeoutMs) {
    const resultFrame = frameNamed(page, 'resultFrame');
    const rf = resultFrame ? resultFrame.url() : '';
    const list = frameNamed(page, 'resultListFrame');
    if (list && /SearchResultList/i.test(list.url()) && /SearchResultsView/i.test(rf)) {
      return collectResultPages(page, options);
    }

    // CountyWeb renders its no-match notice in different nested frames depending
    // on the search response. Require the official notice to remain stable so a
    // transient frame cannot win a race with the real result table.
    let noResultsVisible = false;
    for (const frame of page.frames()) {
      const text = await frame.evaluate(() => document.body ? document.body.innerText : '').catch(() => '');
      if (NO_RESULTS_RE.test(text)) {
        noResultsVisible = true;
        break;
      }
    }
    if (noResultsVisible) {
      if (!noResultsSince) noResultsSince = Date.now();
      if (Date.now() - noResultsSince >= CONFIG.emptyStableMs) {
        return { text: '', total: 0, truncated: false, emptyVerified: true };
      }
    } else {
      noResultsSince = 0;
    }
    await delay(500);
  }
  throw new Error('Recorder search timed out.');
}

// One parcel search in an already logged-in page. Returns { text, total, truncated }.
async function searchParcel(page, rawParcel) {
  const parcel = formatParcel(rawParcel);
  if (!parcel) throw new Error(`Bad parcel number: ${rawParcel}`);

  const { criteria } = await openSearch(page);
  await criteria.waitForFunction(() => window.$ && $('#PARCELNUM').length && typeof executeSearch === 'function', { timeout: 20000 });

  // Submit with the site's default page size, then follow its own pagination.
  // Changing the records-per-page widget fires a second search and caused the
  // false zero-result race this function is designed to avoid.
  await criteria.evaluate((v) => { $('#PARCELNUM').textbox('setValue', v); executeSearch(); }, parcel);
  try {
    return { parcel, ...(await waitForSearchResults(page)) };
  } catch (error) {
    if (/timed out/i.test(error.message)) throw new Error(`Recorder search timed out for ${parcel}`);
    throw error;
  }
}

async function searchBookPage(page, book, pageNumber) {
  const { dyn } = await openSearch(page);
  await dyn.waitForSelector('#searchTypes tr[datagrid-row-index="4"]', { timeout: 20000 });
  await dyn.click('#searchTypes tr[datagrid-row-index="4"]');
  const criteria = await waitForFrame(page, 'criteriaframe', (u) => /searchType=bookPage/i.test(u));
  await criteria.waitForFunction(() => window.$ && $('#VOLUME').length && $('#BOOK').length && $('#PAGE').length &&
    typeof executeSearch === 'function', { timeout: 20000 });
  await criteria.evaluate(({ bookValue, pageValue }) => {
    $('#VOLUME').combobox('setValue', 'MTG');
    $('#BOOK').textbox('setValue', String(bookValue));
    $('#PAGE').textbox('setValue', String(pageValue));
    executeSearch();
  }, { bookValue: book, pageValue: pageNumber });
  return { book: String(book), page: String(pageNumber), ...(await waitForSearchResults(page)) };
}

async function searchName(page, rawName) {
  const name = String(rawName || '').trim();
  if (!name) return { name, text: '', total: 0, truncated: false, emptyVerified: true };
  const { criteria } = await openSearch(page);
  await criteria.waitForFunction(() => window.$ && $('#allNames').length && typeof executeSearch === 'function', { timeout: 20000 });
  await criteria.evaluate((value) => { $('#allNames').textbox('setValue', value); executeSearch(); }, name);
  return { name, ...(await waitForSearchResults(page, { maxTotal: CONFIG.maxNameResults })) };
}

function extractParcelIds(text) {
  const ids = String(text || '').match(/\b\d{2}-\d{2}-\d{5}-\d{2}-\d\b/g) || [];
  return [...new Set(ids.map(formatParcel).filter(Boolean))];
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
  // Recheck only old zero-document entries; successful cached pulls remain valid.
  if (entry.total === 0 && entry.searchVersion !== SEARCH_CACHE_VERSION) return true;
  return (Date.now() - new Date(entry.fetchedAt).getTime()) > maxAgeDays * 86400000;
}

const CLOSED_RE = /CLOS|DISPOS|SETTL|DISMISS|WITHDRAW|SATISF|DISCONTINU/;
function caseIsOpen(c) {
  if (c.liveClosed) return false;
  const s = String(c.liveStatus || c.status || '').toUpperCase();
  return !(CLOSED_RE.test(s) && !/OPEN|ACTIVE|PENDING/.test(s));
}

function needsParcelResolution(c) {
  if (!caseIsOpen(c)) return false;
  if (c.recorderParcelResolution?.version === PARCEL_RESOLUTION_VERSION &&
      ['unresolved', 'skipped'].includes(c.recorderParcelResolution?.status) && c.recorderParcelResolution.checkedAt) {
    const age = Date.now() - new Date(c.recorderParcelResolution.checkedAt).getTime();
    if (Number.isFinite(age) && age < CONFIG.maxAgeDays * 86400000) return false;
  }
  const key = parcelKey(c.parcelNumber);
  return !key || key.length !== 12 || c.parcelValidationStatus === 'not-found' ||
    c.parcelMatchStatus === 'address';
}

function recorderNameForCase(c) {
  return String(c.defendant || '')
    .split(/[;\n]/)[0]
    .replace(/\s+ET\s+AL\b.*$/i, '')
    .trim()
    .slice(0, 50);
}

async function confirmedParcelCandidates(c, parcelIds, gisCache,
  { requireAddress = true, requireOwner = true } = {}) {
  const confirmed = [];
  for (const parcel of parcelIds) {
    const key = parcelKey(parcel);
    let match = gisCache.get(key);
    if (match === undefined) {
      match = await lookupParcelById(parcel);
      gisCache.set(key, match || null);
    }
    const evidence = parcelMatchesCase(match, {
      street: c.propertyAddress,
      zip: c.propertyZip,
      defendant: c.defendant
    });
    // Exact book/page supplies instrument evidence, while a name search supplies
    // party evidence. Require the independent GIS fact appropriate to each source.
    if (match && (!requireOwner || evidence.ownerMatch) && (!requireAddress || evidence.addressMatch)) {
      confirmed.push({ match, evidence });
    }
  }
  return confirmed;
}

async function applyRecorderParcelResolution(c, resolved, source, details = {}) {
  const originalParcel = c.courtParcelNumber || c.parcelNumber || '';
  const caseZip = String(c.propertyZip || '').trim().slice(0, 5);
  if (originalParcel && !c.courtParcelNumber) c.courtParcelNumber = originalParcel;
  const locationAudit = await repairHybridLocation(c, resolved.match);
  resolved.match = locationAudit.match;
  resolved.match = (await verifyPostalLocation(c, resolved.match)).match;
  applyParcelMatch(c, resolved.match);
  // A court mailing ZIP and the parcel layer's location ZIP can disagree even when
  // the parcel is otherwise confirmed. Preserve the case ZIP for display and retain
  // both values in the correction audit.
  if (!resolved.match.locationCorrection && !resolved.match.locationRollback && !resolved.match.postalLocationCorrection &&
      !resolved.evidence.zipMatch && caseZip) c.propertyZip = caseZip;
  c.parcelValidationStatus = originalParcel ? 'corrected' : 'resolved';
  const sourceLabel = source === 'recorder-book-page'
    ? `Recorder mortgage Bk ${details.book} / Pg ${details.page}`
    : `Recorder defendant-name search for ${details.name}`;
  const confirmationLabel = source === 'recorder-book-page'
    ? 'the unique Recorder instrument and county GIS owner'
    : 'the Recorder defendant-name results and unique matching GIS street address';
  c.parcelCorrection = {
    originalParcel,
    correctedParcel: resolved.match.parcel,
    reason: `${originalParcel ? `Court parcel ${originalParcel} was not found` : 'The court parcel was blank'}; ${sourceLabel} returned one parcel confirmed by ${confirmationLabel}` +
      (!resolved.evidence.zipMatch ? ` (court ZIP ${caseZip || 'blank'}; GIS ZIP ${resolved.match.zip || 'blank'})` : ''),
    source,
    sourceBook: details.book || '',
    sourcePage: details.page || '',
    sourceName: details.name || '',
    matchedAddress: [resolved.match.street, resolved.match.city, resolved.match.zip].filter(Boolean).join(', '),
    matchedOwner: resolved.match.owner,
    caseZip,
    gisZip: resolved.match.zip || '',
    zipMatch: resolved.evidence.zipMatch,
    correctedAt: new Date().toISOString()
  };
  c.recorderParcelResolution = {
    version: PARCEL_RESOLUTION_VERSION,
    status: 'confirmed', source, parcel: resolved.match.parcel,
    addressMatch: resolved.evidence.addressMatch,
    ownerMatch: resolved.evidence.ownerMatch,
    zipMatch: resolved.evidence.zipMatch,
    resolvedAt: c.parcelCorrection.correctedAt
  };
}

async function resolveCaseParcel(c, runSearch, gisCache) {
  if (c.mortgageBook && c.mortgagePage) {
    const result = await runSearch(
      `book:${c.mortgageBook}/${c.mortgagePage}`,
      (page) => searchBookPage(page, c.mortgageBook, c.mortgagePage)
    );
    const parcelIds = extractParcelIds(result.text);
    const confirmed = result.total === 1 && parcelIds.length === 1
      ? await confirmedParcelCandidates(c, parcelIds, gisCache, { requireAddress: false })
      : [];
    if (confirmed.length === 1) {
      await applyRecorderParcelResolution(c, confirmed[0], 'recorder-book-page', {
        book: c.mortgageBook, page: c.mortgagePage
      });
      return true;
    }
  }

  const name = recorderNameForCase(c);
  if (name) {
    const result = await runSearch(`name:${name.toUpperCase()}`, (page) => searchName(page, name));
    if (result.tooBroad) {
      c.recorderParcelResolution = {
        version: PARCEL_RESOLUTION_VERSION,
        status: 'skipped', checkedAt: new Date().toISOString(),
        reason: `Recorder name search returned ${result.total} results, above the safe limit of ${CONFIG.maxNameResults}`
      };
      return false;
    }
    const confirmed = await confirmedParcelCandidates(c, extractParcelIds(result.text), gisCache, {
      requireAddress: true,
      requireOwner: false
    });
    if (confirmed.length === 1) {
      await applyRecorderParcelResolution(c, confirmed[0], 'recorder-name', { name });
      return true;
    }
  }

  c.recorderParcelResolution = {
    version: PARCEL_RESOLUTION_VERSION,
    status: 'unresolved', checkedAt: new Date().toISOString(),
    reason: 'No single Recorder parcel satisfied the source-specific GIS confirmation checks'
  };
  return false;
}

// Parcels worth a lookup: any parcel with at least one open case.
function parcelsToRefresh(cases, cache, maxAgeDays = CONFIG.maxAgeDays) {
  const keys = new Map();
  for (const c of cases || []) {
    // Do not attach documents to a court parcel the county GIS rejected or to an
    // address-only tentative match. The resolver must confirm it first.
    if (c.parcelValidationStatus === 'not-found' || c.parcelMatchStatus === 'address') continue;
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
  const unresolvedCases = (cases || []).filter(needsParcelResolution);
  let todo = parcelsToRefresh(cases, cache, maxAgeDays);
  if (limit > 0) todo = todo.slice(0, limit);
  const result = {
    checked: 0, failed: 0, corrected: 0, resolutionChecked: 0, resolutionFailed: 0,
    resolutionTotal: unresolvedCases.length, total: todo.length, remaining: todo.length
  };
  if (!unresolvedCases.length && !todo.length) return result;

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

  try {
    await open();
    const searchCache = new Map();
    const gisCache = new Map();
    const runSearch = async (key, search) => {
      if (searchCache.has(key)) return searchCache.get(key);
      if (sinceLogin >= CONFIG.relogEvery) await open();
      const value = await search(page);
      sinceLogin++;
      searchCache.set(key, value);
      await delay(CONFIG.pauseMs);
      return value;
    };

    if (unresolvedCases.length) {
      console.log(`   Recorder: resolving ${unresolvedCases.length} blank or invalid parcel(s)`);
      for (let i = 0; i < unresolvedCases.length; i++) {
        if (shouldStop()) break;
        const c = unresolvedCases[i];
        const caseLabel = c.caseNumber || c.defendant || '(case)';
        const sourcePlan = c.mortgageBook && c.mortgagePage
          ? `book ${c.mortgageBook}/${c.mortgagePage}, then name if needed`
          : 'defendant name';
        console.log(`   [${i + 1}/${unresolvedCases.length}] ${caseLabel}: resolving parcel via ${sourcePlan}`);
        onProgress({
          ...result, phase: 'parcel-resolution', resolved: i,
          resolutionTotal: unresolvedCases.length, currentCase: caseLabel, parcel: c.parcelNumber || ''
        });
        try {
          if (await resolveCaseParcel(c, runSearch, gisCache)) {
            result.corrected++;
            console.log(`   [${i + 1}/${unresolvedCases.length}] ${caseLabel}: corrected to ${formatParcel(c.parcelNumber)} via ${c.parcelCorrection.source}`);
          } else {
            const resolution = c.recorderParcelResolution || {};
            console.log(`   [${i + 1}/${unresolvedCases.length}] ${caseLabel}: ${resolution.status || 'unresolved'} — ${resolution.reason || 'no confirmed parcel'}`);
          }
        } catch (e) {
          result.resolutionFailed++;
          c.recorderParcelResolution = {
            version: PARCEL_RESOLUTION_VERSION,
            status: 'error', error: e.message, checkedAt: new Date().toISOString()
          };
          console.log(`   [${i + 1}/${unresolvedCases.length}] ${caseLabel}: error — ${e.message}`);
          try { await open(); } catch (e2) { throw e2; }
        }
        result.resolutionChecked++;
        onProgress({
          ...result, phase: 'parcel-resolution', resolved: i + 1,
          resolutionTotal: unresolvedCases.length, currentCase: caseLabel, parcel: c.parcelNumber || ''
        });
      }
    }

    // Corrections above feed directly into the normal parcel pull. Recompute the
    // queue so a newly resolved parcel gets its Recorder documents in this run.
    todo = parcelsToRefresh(cases, cache, maxAgeDays);
    if (limit > 0) todo = todo.slice(0, limit);
    result.total = todo.length;
    result.remaining = todo.length;
    console.log(`   Recorder: ${todo.length} parcel(s) to look up after parcel resolution`);
    for (const p of todo) {
      if (shouldStop()) break;
      if (sinceLogin >= CONFIG.relogEvery) await open();
      const t0 = Date.now();
      try {
        const r = await searchParcel(page, p.raw);
        console.log(`   📚 ${r.parcel}: ${r.total ?? 0} documents (${Math.round((Date.now() - t0) / 1000)}s) [${result.checked + result.failed + 1}/${todo.length}]`);
        cache[p.key] = {
          parcel: r.parcel,
          fetchedAt: new Date().toISOString(),
          total: r.total,
          truncated: r.truncated,
          text: r.text,
          searchVersion: SEARCH_CACHE_VERSION,
          emptyVerified: r.total === 0 ? !!r.emptyVerified : undefined
        };
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
  login, launch, searchParcel, searchBookPage, searchName, extractParcelIds,
  resolveCaseParcel, refreshRecorderIndex, readCache, parcelKey, formatParcel,
  hasCredentials, parcelsToRefresh, describeFrames, CONFIG, CACHE_PATH, SEARCH_CACHE_VERSION
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
      if (r.resolutionChecked > 0) {
        await fs.writeFile(path.join(DATA_DIR, 'pipeline.json'), JSON.stringify(data, null, 2));
      }
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
