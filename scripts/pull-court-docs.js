#!/usr/bin/env node
// pull-court-docs.js
// Saves the filings of NJ foreclosure cases from the eCourts Civil Case Jacket into the
// property's folder, ready to hand to the payoff analysis:
//
//   PROPERTIES / 36 HAINES AVE, BERLIN, NJ / Court Docs F-000743-26 / *.pdf
//
// A property folder that already exists is reused (matched on house number and street);
// otherwise one is created as "STREET, TOWN, NJ".
//
//   node scripts/pull-court-docs.js F-000743-26 F-014046-25
//   node scripts/pull-court-docs.js SWCF000743-26 --all
//   node scripts/pull-court-docs.js "F-000743-26=36 HAINES AVE, BERLIN, NJ"   (name the folder yourself)
//
// Options:
//   --all          also save the routine documents (service, mailing, notices) into "Other filings"
//   --out <dir>    the folder holding the property folders (default: PROPERTIES_DIR below)
//
// It drives a separate Chrome window with its own profile. NJ Courts needs a person to log
// in (and pass the CAPTCHA), so the first run of a session opens the window and waits for
// that; afterwards everything runs unattended. Re-running a case only fetches what is new.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const puppeteer = require('puppeteer');

const { TOWN_TO_MUN_CODE } = require('../scrapers/camden-enrichment');

const PROPERTIES_DIR = process.env.PROPERTIES_DIR || path.join(require('os').homedir(), 'OneDrive', 'Documents', 'Real Estate', 'FORECLOSURES', 'PROPERTIES');
const PORT = 9333;
const PROFILE_DIR = path.join(process.env.LOCALAPPDATA || require('os').homedir(), 'foreclosure-finder', 'njcourts-chrome');
const PORTAL_URL = 'https://portal.njcourts.gov';
const SEARCH_URL = 'https://portal.njcourts.gov/webcivilcj/CIVILCaseJacketWeb/pages/civilCaseSearch.faces';
const LOGIN_WAIT_MS = 15 * 60 * 1000;

// Which documents a payoff needs. The rule is "everything except what is known to be routine",
// so an unusual filing is downloaded rather than missed. Routine documents are not downloaded
// (or, with --all, go to the "Other filings" subfolder). The key documents of one filing are saved as a single PDF.
//
// ROUTINE: whole filings, matched against the start of the docket text.
const ROUTINE = new RegExp('^\\s*(' + [
  'CERTIFICATION OF MAILING', 'CERTIFICATION OF SERVICE', 'RETURN OF SERVICE', 'PROOF OF (MAILING|SERVICE)',
  'AFFIDAVIT OF SERVICE', 'SUMMONS', 'NOTICE OF APPEARANCE', 'SUBSTITUTION OF ATTORNEY', 'TRACK ASSIGNMENT',
  'DEFICIENCY NOTICE', 'REQUEST FOR DEFAULT', 'REQUEST TO ENTER DEFAULT', 'CERTIFICATION OF NON-?MILITARY',
  'CERTIFICATION - Certification of Unknown Spouse', 'CERTIFICATION OF DILIGENT INQUIRY',
  'Foreclosure .{0,30}Notice', "Administrative Clerk'?s Order for Status", 'Order Signed-ADMINISTRATIVE TRANSFER',
  'CERTIFICATION OF EXCEPTIONAL CIRCUMSTANCES'
].join('|') + ')\\b', 'i');
// ROUTINE_PART: single documents inside a filing that is otherwise kept (a motion's notice
// and its service papers), matched against the document's own name.
const ROUTINE_PART = /^notice of motion$|\b(service|mailing|military|non-?mil|publication|pub|spouse|diligent inquiry|codi)\b/i;
const OTHER_DIR = 'Other filings';
const MANIFEST = '_pulled.json';

const sleep = ms => new Promise(r => setTimeout(r, ms));
// Gap between requests to the portal. It has bot protection and the limit is not known:
// 1.5-3s ran clean for weeks of testing; this is the first step down. Raise it again if the
// portal starts showing CAPTCHAs or refusing documents.
const pause = () => sleep(700 + Math.random() * 500);

// ---------- arguments ----------

function parseArgs(argv) {
  const opts = { all: false, out: PROPERTIES_DIR, dockets: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') opts.all = true;
    else if (a === '--out') opts.out = path.resolve(argv[++i]);
    else {
      const eq = a.indexOf('=');
      const d = parseDocket(eq < 0 ? a : a.slice(0, eq));
      if (d && eq >= 0) d.folderName = a.slice(eq + 1).trim();
      if (!d) { console.error(`Not a foreclosure docket number: ${a}  (expected e.g. F-000743-26)`); process.exit(2); }
      opts.dockets.push(d);
    }
  }
  if (!fs.existsSync(opts.out)) { console.error(`Folder not found: ${opts.out}`); process.exit(2); }
  if (!opts.dockets.length) {
    console.error('Usage: node scripts/pull-court-docs.js F-000743-26 [more dockets] [--all] [--out <dir>]');
    process.exit(2);
  }
  return opts;
}

// Accepts F-000743-26, F-743-26, F00074326, SWCF000743-26, SWC-F-000743-26.
function parseDocket(raw) {
  const m = String(raw).toUpperCase().replace(/\s+/g, '').match(/(?:SWC-?)?F-?(\d{1,6})-?(\d{2})$/);
  if (!m) return null;
  const num = m[1].padStart(6, '0');
  return { num, year: m[2], label: `F-${num}-${m[2]}` };
}

// ---------- browser ----------

function debugPortAlive() {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/json/version', timeout: 2000 }, res => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function chromePath() {
  const candidates = [
    path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe')
  ];
  return candidates.find(p => fs.existsSync(p)) || puppeteer.executablePath();
}

async function connectBrowser() {
  if (!(await debugPortAlive())) {
    console.log('Opening the NJ Courts Chrome window...');
    fs.mkdirSync(PROFILE_DIR, { recursive: true });
    spawn(chromePath(), [
      `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE_DIR}`,
      '--no-first-run', '--no-default-browser-check', '--new-window', PORTAL_URL
    ], { detached: true, stdio: 'ignore' }).unref();
    for (let i = 0; i < 30 && !(await debugPortAlive()); i++) await sleep(500);
  }
  return puppeteer.connect({ browserURL: `http://127.0.0.1:${PORT}`, defaultViewport: null });
}

const onSearchForm = page => page.$('#searchByDocForm\\:idCivilDocketNum').then(Boolean).catch(() => false);

async function loggedInSomewhere(browser) {
  for (const p of await browser.pages()) {
    const text = await p.evaluate(() => (document.body ? document.body.innerText.slice(0, 3000) : '')).catch(() => '');
    if (/Portal Home Page|Find a Case|Search For Case/i.test(text)) return true;
  }
  return false;
}

// Returns a tab sitting on the docket search form, waiting for a manual login if needed.
async function openSearch(browser, page, onLoginWait = () => {}) {
  if (!page || page.isClosed()) {
    page = (await browser.pages()).find(p => /CIVILCaseJacketWeb/.test(p.url())) || await browser.newPage();
  }
  await page.goto(SEARCH_URL, { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
  if (await onSearchForm(page)) return page;

  console.log('\n>>> Log in to NJ Courts in the Chrome window that just opened. Waiting...');
  onLoginWait(true);
  await page.goto(PORTAL_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await page.bringToFront().catch(() => {});
  const deadline = Date.now() + LOGIN_WAIT_MS;
  try {
    while (Date.now() < deadline) {
      await sleep(4000);
      if (await loggedInSomewhere(browser)) {
        if (page.isClosed()) page = await browser.newPage();
        await page.goto(SEARCH_URL, { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
        if (await onSearchForm(page)) { console.log('Logged in.\n'); return page; }
      }
    }
  } finally {
    onLoginWait(false);
  }
  throw new Error('Timed out waiting for the NJ Courts login.');
}

// ---------- case jacket ----------

async function openCase(page, docket) {
  // Fill the form through the DOM, not with simulated mouse and keys: those wait on the page
  // being painted and hang for minutes when the Chrome window is minimised or covered.
  await page.evaluate((num, year) => {
    const set = (id, value) => {
      const el = document.getElementById(id);
      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    set('searchByDocForm:docketType', 'F');
    set('searchByDocForm:idCivilDocketNum', num);
    set('searchByDocForm:idCivilDocketYear', year);
  }, docket.num, docket.year);
  await sleep(300);
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {}),
    page.evaluate(() => {
      const btn = ['searchByDocForm:btnSearch', 'searchByDocForm:searchBtnDummy']
        .map(id => document.getElementById(id)).find(e => e && e.offsetParent);
      btn.click();
    })
  ]);
  // Go on as soon as the filings table is built (or the page has settled without one, which
  // means the case did not open), rather than waiting a fixed time.
  await page.waitForFunction(
    () => document.getElementById('caseActionTbId2_info') || (document.readyState === 'complete' && !document.getElementById('caseActionTbId2')),
    { timeout: 20000 }
  ).catch(() => {});
  await sleep(300);

  const jacket = await page.evaluate(() => {
    const body = document.body.innerText;
    if (!document.getElementById('caseActionTbId2')) return { error: body.slice(0, 400) };

    // The filings table can be paged; make sure every row is in the page before reading it.
    try { jQuery('#caseActionTbId2').DataTable().page.len(-1).draw(); } catch (e) {
      try {
        const t = jQuery('#caseActionTbId2').dataTable();
        t.fnSettings()._iDisplayLength = -1; t.fnDraw();
      } catch (e2) { /* not paged */ }
    }
    const info = (document.getElementById('caseActionTbId2_info') || {}).innerText || '';
    const total = +(info.match(/of\s+([\d,]+)\s+entries/i) || [])[1]?.replace(/,/g, '') || null;

    const rows = [...document.querySelectorAll('#caseActionTbId2 tbody tr')].map(tr => {
      const c = [...tr.cells].map(td => td.innerText.trim());
      const link = tr.querySelector('a[id$=":filingLink"], a[id$=":singleFilingLink"]');
      return { filed: c[0], text: (c[2] || '').replace(/\s+/g, ' '), trans: c[3] || '', linkId: link ? link.id : null,
               multi: link ? /:filingLink$/.test(link.id) : false };
    }).filter(r => r.filed || r.text);

    const tabs = [...document.querySelectorAll('[id^="tabs-"]')].map(t => {
      const clone = t.cloneNode(true);
      clone.querySelectorAll('script, style').forEach(s => s.remove());
      return clone.textContent.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
    }).filter(Boolean);

    return {
      docketLine: (body.match(/Docket Number:\s*(\S+)/) || [])[1] || '',
      caption: (body.match(/Case Caption:\s*(.+)/) || [])[1] || '',
      venue: (body.match(/Venue:\s*([A-Za-z ]+?)\s+Case Initiation/) || [])[1] || '',
      address: (tabs.join('\n').match(/Street Address:\s*(.+?)\s*County:/) || [])[1] || '',
      total, rows, body, tabs
    };
  });
  return jacket;
}

// Replays one of the page's own form posts and returns the response body.
function postForm(page, formId, linkId) {
  return page.evaluate(async (formId, linkId) => {
    const form = document.getElementById(formId);
    const fd = new URLSearchParams();
    for (const el of form.elements) {
      if (!el.name || el.disabled || el.type === 'submit' || el.type === 'button') continue;
      if ((el.type === 'checkbox' || el.type === 'radio') && !el.checked) continue;
      fd.append(el.name, el.value);
    }
    fd.set(formId + ':_idcl', linkId);
    const r = await fetch(form.action, { method: 'POST', body: fd, credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    const buf = new Uint8Array(await r.arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return { status: r.status, isPdf: bin.startsWith('%PDF'), snippet: bin.startsWith('%PDF') ? '' : bin.slice(0, 600), b64: btoa(bin) };
  }, formId, linkId);
}

// A filing with several documents opens a picker first. Returns each document's name and its
// own link; they are fetched one by one because the "save selected" button only honours
// boxes the server was told about, and separate files are easier to name anyway.
async function openPicker(page, linkId) {
  await page.evaluate(() => document.querySelectorAll('#documentDetails a').forEach(a => { a.dataset.old = '1'; }));
  const answered = page.waitForResponse(r => r.request().method() === 'POST' && /civilCaseSummary/.test(r.url()), { timeout: 30000 }).catch(() => null);
  await page.evaluate(id => document.getElementById(id).click(), linkId);
  await answered;
  await page.waitForFunction(() =>
    [...document.querySelectorAll('#documentDetails a')].some(a => !a.dataset.old && a.id !== 'documentDetails:savePrintLnk'),
    { timeout: 20000 });
  await sleep(300);
  return page.evaluate(() => [...document.querySelectorAll('#documentDetails a')]
    .filter(a => a.id !== 'documentDetails:savePrintLnk')
    .map(a => ({ name: a.innerText.trim(), idcl: ((a.getAttribute('onclick') || '').match(/submitForm\('documentDetails','([^']+)'/) || [])[1] }))
    .filter(d => d.idcl));
}

// Ticks the wanted documents in the open picker and uses the court's own "Save/Print Selected",
// which returns them as one PDF: a single download per filing. Each tick has to reach the
// server (the page does that itself on change) or the download comes back empty.
async function courtCombined(page, indexes) {
  // The per-document boxes (the "Select All" box has no row number in its name).
  const tick = i => {
    const b = [...document.querySelectorAll('#documentDetails input[type=checkbox]')].filter(x => /:\d+:/.test(x.name))[i];
    if (!b) return 'missing';
    if (b.checked) return 'already';
    b.click();
    return 'clicked';
  };
  const countTicked = () => [...document.querySelectorAll('#documentDetails input[type=checkbox]')]
    .filter(x => /:\d+:/.test(x.name) && x.checked).length;
  for (const i of indexes) {
    const answered = page.waitForResponse(r => r.request().method() === 'POST' && /civilCaseSummary/.test(r.url()), { timeout: 20000 });
    answered.catch(() => {});
    const ticked = await page.evaluate(tick, i);
    if (ticked === 'missing') throw new Error('tick box not found');
    if (ticked === 'clicked') { await answered; await sleep(300); }
  }
  const checked = await page.evaluate(countTicked);
  if (checked !== indexes.length) throw new Error(`${checked} of ${indexes.length} boxes ticked`);
  const res = await postForm(page, 'documentDetails', 'documentDetails:savePrintLnk');
  if (!res.isPdf) throw new Error('the court returned no PDF');
  return res;
}

const closePicker = page => page.evaluate(() => { try { cancelPopUp(); } catch (e) { /* not open */ } }).catch(() => {});

// The portal drops the odd request; one retry after a short wait clears it.
async function twice(fn) {
  try { return await fn(); } catch (e) { await sleep(4000); return fn(); }
}

// ---------- files ----------

const clean = s => String(s).replace(/[<>:"/\\|?*\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim();
const isoDate = d => { const m = String(d).match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/); return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : 'undated'; };
const shortTitle = text => clean(text.split(/\s+submitted by\s+/i)[0]).slice(0, 70).trim() || 'Filing';

// "36 Haines Avenue" and "36 HAINES AVE" are the same street: compare on normalised words.
const STREET_WORDS = { AVENUE: 'AVE', STREET: 'ST', ROAD: 'RD', DRIVE: 'DR', LANE: 'LN', BOULEVARD: 'BLVD', COURT: 'CT',
  PLACE: 'PL', TERRACE: 'TER', CIRCLE: 'CIR', HIGHWAY: 'HWY', PARKWAY: 'PKWY', MOUNT: 'MT', PARK: 'PK',
  NORTH: 'N', NO: 'N', SOUTH: 'S', SO: 'S', EAST: 'E', WEST: 'W' };
const streetWords = s => String(s).toUpperCase().split(',')[0].replace(/[^A-Z0-9 -]/g, ' ').split(/\s+/).filter(Boolean)
  .map(w => STREET_WORDS[w] || w);
function sameStreet(a, b) {
  const x = streetWords(a), y = streetWords(b);
  if (x.length < 2 || y.length < 2 || x[0] !== y[0]) return false;   // house number must match
  const n = Math.min(x.length, y.length);                             // "1154 LANGHAM" = "1154 LANGHAM AVE"
  return x.slice(0, n).join(' ') === y.slice(0, n).join(' ');
}

function townName(jacket) {
  const m = jacket.tabs.join(' ').match(/Municipality:\s*(\d{4})(?:\s*-\s*([A-Za-z .']+?))?\s*(?:Property Type|Block|$)/);
  if (!m) return '';
  return (m[2] || Object.keys(TOWN_TO_MUN_CODE).find(k => TOWN_TO_MUN_CODE[k] === m[1]) || '').toUpperCase().trim();
}

// The property's folder (existing or new), and inside it one subfolder per docket.
function caseFolder(outDir, docket, jacket) {
  const sub = `Court Docs ${docket.label}`;
  const dirs = fs.readdirSync(outDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
  let name = docket.folderName;
  let how = 'named on the command line';
  // docket.folderHint is the address as the website shows it ("36 HAINES AVENUE, BERLIN, NJ"):
  // it helps find an existing folder and names a new one the way the cards read.
  const hint = clean(docket.folderHint || '').replace(/\.+$/, '').toUpperCase();
  if (!name && (jacket.address || hint)) {
    const matches = dirs.filter(d => (jacket.address && sameStreet(d, jacket.address)) || (hint && sameStreet(d, hint)));
    const town = townName(jacket);
    const core = town.replace(/ (TWP|BORO|BOROUGH|CITY)$/, '');
    const pick = matches.length === 1 ? matches[0] : matches.find(d => core && d.toUpperCase().includes(core));
    if (pick) { name = pick; how = 'existing folder'; }
    else {
      name = hint || clean([jacket.address.toUpperCase(), town, 'NJ'].filter(Boolean).join(', '));
      how = matches.length ? `new folder: ${matches.length} existing folders share this street and none names ${town || 'the town'}` : 'new folder';
    }
  }
  if (!name) { name = clean(`${docket.label} ${jacket.caption}`).slice(0, 80); how = 'new folder: the court lists no street address'; }
  return { folder: path.join(outDir, name, sub), property: name, how };
}

// True when every part of a filing is already in the folder (parts are named "1of3" etc).
function alreadySaved(have, trans) {
  const mine = have.filter(n => n.includes(`(${trans})`) || n.includes(`(${trans} `));
  if (!mine.length) return false;
  const parts = mine[0].match(/ \d+of(\d+)\)/);
  return mine.length >= (parts ? +parts[1] : 1);
}

function docketSheetText(docket, jacket, notDownloaded) {
  return [
    `${docket.label}   (${jacket.docketLine})`,
    `Captured ${new Date().toISOString().slice(0, 16).replace('T', ' ')} from the NJ eCourts Civil Case Jacket`,
    '', '===== CASE SUMMARY AND DOCKET =====', jacket.body.trim(),
    '', '===== PARTIES, PROPERTY, DOCUMENTS, FEES =====', ...jacket.tabs.map(t => t + '\n'),
    '===== ROUTINE DOCUMENTS NOT INCLUDED (service, mailing, notices; available on the case jacket) =====',
    ...(notDownloaded.length ? notDownloaded : ['none'])
  ].join('\n');
}

// What earlier pulls finished, so a re-pull only fetches new filings: { transactionId: { all, skipped[] } }.
function readManifest(folder) {
  try { return JSON.parse(fs.readFileSync(path.join(folder, MANIFEST), 'utf8')); } catch (e) { return {}; }
}

// A saved file is routine if its filing is, or if it is a routine document inside a kept filing.
function isRoutineFile(name) {
  const stem = name.replace(/^\d{4}-\d{2}-\d{2} |^undated /, '').replace(/ \([^()]*\)\.pdf$/i, '');
  if (ROUTINE.test(stem)) return true;
  return / \d+of\d+\)\.pdf$/i.test(name) && stem.includes(' - ') && ROUTINE_PART.test(stem.slice(stem.lastIndexOf(' - ') + 3));
}

// Routine documents left at the top level by an earlier pull move aside, so the top level is
// exactly what goes to GPT.
function tidyFolder(folder) {
  for (const name of fs.readdirSync(folder)) {
    if (!/\.pdf$/i.test(name) || name.startsWith('_') || !isRoutineFile(name)) continue;
    fs.mkdirSync(path.join(folder, OTHER_DIR), { recursive: true });
    fs.renameSync(path.join(folder, name), path.join(folder, OTHER_DIR, name));
  }
}

// The key documents of one filing become a single PDF, in the order the court lists them.
async function mergePdfs(buffers) {
  const { PDFDocument } = require('pdf-lib');
  const out = await PDFDocument.create();
  for (const buf of buffers) {
    const doc = await PDFDocument.load(buf, { ignoreEncryption: true });
    (await out.copyPages(doc, doc.getPageIndices())).forEach(p => out.addPage(p));
  }
  return Buffer.from(await out.save());
}

// The court pads a combined PDF with empty pages (for double-sided printing). Drop pages that
// have no content at all; on any doubt the file is left exactly as the court sent it.
async function dropBlankPages(buffer) {
  try {
    const { PDFDocument, PDFArray, PDFName } = require('pdf-lib');
    const doc = await PDFDocument.load(buffer, { ignoreEncryption: true });
    const blank = doc.getPages().map(pg => {
      const c = pg.node.Contents();
      let bytes = 0;
      if (c instanceof PDFArray) for (let k = 0; k < c.size(); k++) bytes += ((doc.context.lookup(c.get(k)) || {}).contents || []).length;
      else if (c) bytes += (c.contents || []).length;
      const res = pg.node.Resources();
      return bytes === 0 && !(res && res.lookup(PDFName.of('XObject')));
    });
    if (!blank.includes(true) || !blank.includes(false)) return buffer;
    for (let i = blank.length - 1; i >= 0; i--) if (blank[i]) doc.removePage(i);
    return Buffer.from(await doc.save());
  } catch (e) { return buffer; }
}

// Filings saved part by part ("... 2of5).pdf") by an earlier pull are merged the same way,
// once every part is accounted for here or in "Other filings".
async function mergeSavedParts(folder, manifest) {
  const partOf = n => n.match(/^(\d{4}-\d{2}-\d{2}|undated) (.*) \((\S+) (\d+)of(\d+)\)\.pdf$/i);
  const otherDir = path.join(folder, OTHER_DIR);
  const here = fs.readdirSync(folder).map(n => ({ n, m: partOf(n) })).filter(x => x.m);
  const aside = fs.existsSync(otherDir) ? fs.readdirSync(otherDir).map(n => ({ n, m: partOf(n) })).filter(x => x.m) : [];
  for (const id of new Set(here.map(x => x.m[3]))) {
    const mine = here.filter(x => x.m[3] === id).sort((x, y) => x.m[4] - y.m[4]);
    const all = mine.concat(aside.filter(x => x.m[3] === id));
    const notDownloaded = ((manifest[id] || {}).skipped || []).length;
    if (all.length + notDownloaded < +mine[0].m[5]) continue;                       // an incomplete filing is re-pulled instead
    const stems = all.map(x => x.m[2]);
    let title = stems.reduce((p, st) => { let i = 0; while (i < p.length && p[i] === st[i]) i++; return p.slice(0, i); });
    title = title.replace(/[\s-]+$/, '') || stems[0];
    try {
      const merged = await mergePdfs(mine.map(x => fs.readFileSync(path.join(folder, x.n))));
      fs.writeFileSync(path.join(folder, `${mine[0].m[1]} ${title} (${id}).pdf`), merged);
      mine.forEach(x => fs.unlinkSync(path.join(folder, x.n)));
    } catch (e) { /* leave the parts as they are */ }
  }
}

// ---------- main ----------

async function pullCase(page, docket, opts) {
  const jacket = await openCase(page, docket);
  if (jacket.error) return { docket, failed: `case did not open: ${jacket.error.replace(/\s+/g, ' ').slice(0, 160)}` };

  const { folder, property, how } = caseFolder(opts.out, docket, jacket);
  fs.mkdirSync(folder, { recursive: true });
  tidyFolder(folder);
  const manifest = readManifest(folder);
  await mergeSavedParts(folder, manifest);
  const otherDir = path.join(folder, OTHER_DIR);
  console.log(`${docket.label}  ${jacket.caption}  [${jacket.venue}]  ${jacket.address}`);
  console.log(`  property folder: ${property}  (${how})`);
  if (jacket.total && jacket.total !== jacket.rows.length) {
    console.log(`  ! the docket lists ${jacket.total} entries but only ${jacket.rows.length} could be read`);
  }

  const have = fs.readdirSync(folder).concat(fs.existsSync(otherDir) ? fs.readdirSync(otherDir) : []);
  const tally = { saved: 0, already: 0, skipped: [], noDoc: 0, errors: [] };
  const progress = () => { if (opts.onProgress) opts.onProgress({ property, folder, total: jacket.rows.length, ...tally }); };
  progress();

  for (const row of jacket.rows) {
    const title = shortTitle(row.text);
    if (!row.linkId) { tally.noDoc++; continue; }
    const routineRow = ROUTINE.test(row.text);
    if (routineRow && !opts.all) { tally.skipped.push(`${row.filed} ${title}`); continue; }

    // Finished by an earlier pull? (Folders from before the manifest existed fall back to counting files.)
    const before = row.trans && manifest[row.trans];
    if ((before && (before.all || !opts.all)) || (!before && row.trans && alreadySaved(have, row.trans))) {
      tally.already++;
      if (before && !opts.all) tally.skipped.push(...before.skipped);
      continue;
    }

    const errorsBefore = tally.errors.length;
    const skippedHere = [];
    const fail = (what, res) => {
      const why = res.snippet.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 140);
      tally.errors.push(`${row.filed} ${what}: no PDF returned (HTTP ${res.status}) ${why}`);
      if (/incapsula|captcha|sign in|log ?in/i.test(res.snippet)) tally.blocked = true;
    };
    const save = (file, res, routine) => {
      if (routine) fs.mkdirSync(otherDir, { recursive: true });
      fs.writeFileSync(path.join(routine ? otherDir : folder, file), Buffer.from(res.b64, 'base64'));
      tally.saved++;
      console.log(`  saved  ${routine ? OTHER_DIR + '/' : ''}${file}`);
    };

    try {
      const id = row.trans || 'no id';
      if (row.multi) {
        let docs = await twice(() => openPicker(page, row.linkId));
        const partName = d => clean(d.name).slice(0, 35).trim();
        const wanted = docs.map((d, i) => i).filter(i => !(routineRow || ROUTINE_PART.test(partName(docs[i]))));
        let combined = null;
        if (!opts.all && wanted.length > 1) {
          try { combined = await courtCombined(page, wanted); }
          catch (e) { console.log(`  (combined download failed for ${title}: ${e.message}; fetching its documents one by one)`); docs = await twice(() => openPicker(page, row.linkId)); }
        }
        if (combined) {
          docs.forEach((d, i) => { if (!wanted.includes(i)) skippedHere.push(`${row.filed} ${title} - ${partName(d)}`); });
          const file = `${isoDate(row.filed)} ${title} (${id}).pdf`;
          fs.writeFileSync(path.join(folder, file), await dropBlankPages(Buffer.from(combined.b64, 'base64')));
          tally.saved++;
          console.log(`  saved  ${file}   [${wanted.length} documents: ${wanted.map(i => partName(docs[i])).join('; ')}]`);
          fs.readdirSync(folder).filter(n => n.includes(`(${id} `) && /\d+of\d+\)\.pdf$/i.test(n)).forEach(n => fs.unlinkSync(path.join(folder, n)));
          await pause();
        }
        const key = [];               // fallback: this filing's key documents, fetched singly and merged here
        for (let i = 0; !combined && i < docs.length && !tally.blocked; i++) {
          const part = clean(docs[i].name).slice(0, 35).trim();
          const name = title.toLowerCase().endsWith(part.toLowerCase()) ? title : `${title} - ${part}`;
          const routine = routineRow || ROUTINE_PART.test(part);
          if (routine && !opts.all) { skippedHere.push(`${row.filed} ${name}`); continue; }
          const res = await twice(() => postForm(page, 'documentDetails', docs[i].idcl));
          const file = `${isoDate(row.filed)} ${name} (${id} ${i + 1}of${docs.length}).pdf`;
          if (!res.isPdf) fail(name, res);
          else if (routine) save(file, res, true);
          else key.push({ file, res, part });
          await pause();
        }
        await closePicker(page);
        const complete = tally.errors.length === errorsBefore && !tally.blocked;
        let merged = null;
        if (complete && key.length > 1) {
          try { merged = await mergePdfs(key.map(k => Buffer.from(k.res.b64, 'base64'))); } catch (e) { /* save separately */ }
        }
        if (combined) { /* already saved */ }
        else if (merged || (complete && key.length === 1)) {
          const file = `${isoDate(row.filed)} ${title} (${id}).pdf`;
          fs.writeFileSync(path.join(folder, file), merged || Buffer.from(key[0].res.b64, 'base64'));
          tally.saved++;
          console.log(`  saved  ${file}${key.length > 1 ? `   [${key.length} documents: ${key.map(k => k.part).join('; ')}]` : ''}`);
          // parts left by an earlier, interrupted pull of this filing are now redundant
          fs.readdirSync(folder).filter(n => n.includes(`(${id} `) && /\d+of\d+\)\.pdf$/i.test(n)).forEach(n => fs.unlinkSync(path.join(folder, n)));
        } else {
          key.forEach(k => save(k.file, k.res, false));
        }
      } else {
        const res = await twice(() => postForm(page, 'caseActions', row.linkId));
        if (!res.isPdf) fail(title, res);
        else save(`${isoDate(row.filed)} ${title} (${id}).pdf`, res, routineRow);
        await pause();
      }
    } catch (e) {
      tally.errors.push(`${row.filed} ${title}: ${e.message}`);
      await closePicker(page);
    }
    tally.skipped.push(...skippedHere);
    if (row.trans && tally.errors.length === errorsBefore && !tally.blocked) {
      manifest[row.trans] = { all: !!opts.all, skipped: skippedHere };
      fs.writeFileSync(path.join(folder, MANIFEST), JSON.stringify(manifest, null, 1));
    }
    progress();
    if (tally.blocked) break;
  }

  const sheet = docketSheetText(docket, jacket, tally.skipped);
  fs.writeFileSync(path.join(folder, '_docket.txt'), sheet);

  console.log(`  ${tally.saved} saved, ${tally.already} already there, ${tally.skipped.length} routine not downloaded, ${tally.noDoc} entries without a document`);
  tally.errors.forEach(s => console.log(`    FAILED:  ${s}`));
  console.log(`  -> ${folder}\n`);
  return { docket, folder, property, ...tally };
}

module.exports = { PROPERTIES_DIR, parseDocket, connectBrowser, openSearch, pullCase, pause };

if (require.main === module) (async () => {
  const opts = parseArgs(process.argv.slice(2));
  const browser = await connectBrowser();
  let page = null;
  const results = [];
  try {
    for (const docket of opts.dockets) {
      page = await openSearch(browser, page);
      const r = await pullCase(page, docket, opts).catch(e => ({ docket, failed: e.message }));
      if (r.failed) console.log(`${docket.label}  FAILED: ${r.failed}\n`);
      results.push(r);
      if (r.blocked) { console.log('The portal stopped returning documents (session ended or blocked). Stopping.'); break; }
      await pause();
    }
  } finally {
    browser.disconnect();
  }
  const bad = results.filter(r => r.failed || (r.errors && r.errors.length));
  console.log(`Done: ${results.length - bad.length} of ${opts.dockets.length} cases clean${bad.length ? `, ${bad.length} with problems (see above)` : ''}.`);
  process.exit(bad.length ? 1 : 0);
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
