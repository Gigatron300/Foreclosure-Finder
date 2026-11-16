#!/usr/bin/env node
// court-docs-helper.js
// Runs on the PC that holds the PROPERTIES folder and the NJ Courts login. The Camden page's
// "Pull court docs" button talks to it at http://127.0.0.1:47613 and it pulls the ticked cases
// with pull-court-docs.js. Start it with "Start Court Docs Helper.bat"; leave the window open.
//
//   GET  /status   is the helper there, and what is it doing
//   POST /pull     { cases: [{ id, docket, folderHint }] }   add cases to the queue
//
// Only the Foreclosure Finder site (hosted or local) may call it; see ALLOWED_ORIGINS.

const http = require('http');
const fs = require('fs');
const { PROPERTIES_DIR, parseDocket, connectBrowser, openSearch, pullCase, pause } = require('./pull-court-docs');

const PORT = 47613;
const ALLOWED_ORIGINS = [
  /^https:\/\/foreclosure-finder\.onrender\.com$/,
  /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/,
  ...String(process.env.COURT_DOCS_ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean)
    .map(o => new RegExp('^' + o.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'))
];

// One batch at a time: items stay listed until a new batch starts on an idle helper.
const state = { items: [], running: false, waitingForLogin: false };

const publicState = () => ({
  ok: true, propertiesDir: PROPERTIES_DIR, running: state.running, waitingForLogin: state.waitingForLogin,
  items: state.items.map(({ docket, folderHint, ...rest }) => ({ ...rest, docket: docket.label }))
});

async function work() {
  if (state.running) return;
  state.running = true;
  let browser = null, page = null;
  try {
    browser = await connectBrowser();
    for (let item; (item = state.items.find(i => i.state === 'queued'));) {
      item.state = 'running';
      try {
        page = await openSearch(browser, page, waiting => { state.waitingForLogin = waiting; });
        const r = await pullCase(page, { ...item.docket, folderHint: item.folderHint }, {
          out: PROPERTIES_DIR, all: false,
          onProgress: p => Object.assign(item, { property: p.property, folder: p.folder, saved: p.saved, already: p.already, total: p.total })
        });
        if (r.failed) Object.assign(item, { state: 'failed', message: r.failed });
        else {
          Object.assign(item, {
            state: r.errors.length ? 'partial' : 'done', property: r.property, folder: r.folder,
            saved: r.saved, already: r.already, skipped: r.skipped.length, errors: r.errors,
            fileCount: fs.readdirSync(r.folder).filter(n => /\.pdf$/i.test(n) && !n.startsWith('_')).length,
            message: r.errors.length ? `${r.errors.length} filing(s) failed; pull again to retry them` : ''
          });
          if (r.blocked) {
            state.items.filter(i => i.state === 'queued').forEach(i => Object.assign(i, { state: 'failed', message: 'The court portal stopped returning documents. Try again in a while.' }));
          }
        }
      } catch (e) {
        Object.assign(item, { state: 'failed', message: e.message });
        console.log(`${item.docket.label}  FAILED: ${e.message}\n`);
      }
      item.finishedAt = new Date().toISOString();
      await pause();
    }
  } catch (e) {
    state.items.filter(i => i.state === 'queued' || i.state === 'running')
      .forEach(i => Object.assign(i, { state: 'failed', message: `Could not open the NJ Courts window: ${e.message}` }));
  } finally {
    if (browser) browser.disconnect();
    state.running = false;
    state.waitingForLogin = false;
  }
}

function addCases(cases) {
  if (!Array.isArray(cases) || !cases.length) return { error: 'No cases given' };
  if (cases.length > 60) return { error: 'Too many cases in one go (limit 60)' };
  if (!state.running) state.items = [];
  let added = 0;
  for (const c of cases) {
    const docket = parseDocket(c && c.docket);
    const id = String((c && c.id) || '').slice(0, 60);
    if (!docket || !id) { state.items.push({ id: id || '?', docket: { label: String((c && c.docket) || '?').slice(0, 30) }, state: 'failed', message: 'Not a foreclosure docket number' }); continue; }
    if (state.items.some(i => i.id === id && (i.state === 'queued' || i.state === 'running'))) continue;
    state.items = state.items.filter(i => i.id !== id);
    state.items.push({ id, docket, folderHint: String(c.folderHint || '').slice(0, 120), state: 'queued', saved: 0, already: 0 });
    added++;
  }
  if (added) work();
  return { added };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; if (raw.length > 200000) { reject(new Error('Request too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(new Error('Bad JSON')); } });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || '';
  const allowed = ALLOWED_ORIGINS.some(re => re.test(origin));
  const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };

  if (allowed) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
  }
  if (req.method === 'OPTIONS') { res.writeHead(allowed ? 204 : 403); return res.end(); }
  // A page from any other site (or no site at all) gets nothing.
  if (!allowed) return send(403, { error: 'Not allowed from this page' });

  const url = req.url.split('?')[0];
  if (req.method === 'GET' && url === '/status') return send(200, publicState());
  if (req.method === 'POST' && url === '/pull') {
    try {
      const result = addCases((await readBody(req)).cases);
      return send(result.error ? 400 : 200, { ...result, ...publicState() });
    } catch (e) { return send(400, { error: e.message }); }
  }
  send(404, { error: 'Not found' });
});

server.on('error', e => {
  console.error(e.code === 'EADDRINUSE' ? 'The Court Docs Helper is already running in another window.' : `ERROR: ${e.message}`);
  process.exit(1);
});

if (!fs.existsSync(PROPERTIES_DIR)) { console.error(`PROPERTIES folder not found: ${PROPERTIES_DIR}`); process.exit(1); }
server.listen(PORT, '127.0.0.1', () => {
  console.log('Court Docs Helper is running. Leave this window open.');
  console.log(`Saving into: ${PROPERTIES_DIR}`);
  console.log('Tick cards on the Camden Pipeline page and press "Pull court docs".\n');
});
