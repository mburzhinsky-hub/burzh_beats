/* Shared helpers for the browser regression tests. */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const DOCS = path.join(__dirname, '..', 'docs');
const FIXTURES = path.join(__dirname, 'fixtures');
const OUT = path.join(__dirname, 'out');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml' };

/* Static server for docs/ (the real app files; /media/ is answered by the mock in the page route). */
function startServer() {
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p.endsWith('/')) p += 'index.html';
      const f = path.join(DOCS, p);
      if (!f.startsWith(DOCS) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      fs.createReadStream(f).pipe(res);
    });
    srv.listen(0, '127.0.0.1', () => resolve({ url: 'http://127.0.0.1:' + srv.address().port + '/', close: () => srv.close() }));
  });
}

function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  try {
    const dir = fs.readdirSync(base).filter(d => /^chromium-\d+$/.test(d)).sort().pop();
    if (dir) {
      const p = path.join(base, dir, 'chrome-linux', 'chrome');
      if (fs.existsSync(p)) return p;
    }
  } catch (e) { /* fall through */ }
  return undefined;   // use Playwright's own browser (npx playwright-core install chromium)
}

let browser = null;
async function getBrowser() {
  if (!browser) {
    const exe = chromePath();
    browser = await chromium.launch(exe ? { executablePath: exe, args: ['--autoplay-policy=no-user-gesture-required'] } : { args: ['--autoplay-policy=no-user-gesture-required'] });
  }
  return browser;
}
async function closeBrowser() { if (browser) { await browser.close(); browser = null; } }

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms = 8000, step = 150) {
  const t0 = Date.now();
  let v;
  while (Date.now() - t0 < ms) { v = await fn(); if (v) return v; await sleep(step); }
  return v;
}

/* Open the app with mocked audio. `media` is a fixture name; `policy(req)` can fail or hang requests:
 *   req = { n, fx, url, type }  ->  undefined | 'hang' | { status }   (n = number of src assignments so far) */
async function open(server, opts = {}) {
  const b = await getBrowser();
  const ctx = await b.newContext({
    viewport: opts.viewport || { width: 932, height: 430 },
    hasTouch: !!opts.touch, isMobile: !!opts.touch, deviceScaleFactor: opts.scale || 1,
    permissions: opts.geolocation ? ['geolocation'] : [], geolocation: opts.geolocation
  });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push('pageerror: ' + e.message));
  p.on('console', m => { if (m.type() === 'error' && !(opts.allowNetworkErrors && /Failed to load resource|net::ERR|MEDIA_ELEMENT/.test(m.text()))) errs.push('console: ' + m.text()); });
  if (opts.settings) {
    // Seed saved settings before the page starts (only when nothing is saved yet, so reloads keep what a test changed).
    await p.addInitScript(([key, value]) => { try { if (!localStorage.getItem(key)) localStorage.setItem(key, value); } catch (e) { /* ignore */ } },
      ['burzh.radio.settings.v1', JSON.stringify(Object.assign({ v: 2 }, opts.settings))]);
  }
  await p.addInitScript(() => {
    window.__srcSets = [];
    const d = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
    Object.defineProperty(HTMLMediaElement.prototype, 'src', { get() { return d.get.call(this); }, set(v) { window.__srcSets.push(String(v)); d.set.call(this, v); } });
  });
  const mock = fs.readFileSync(path.join(FIXTURES, opts.media || 'mock.ogg'));
  await p.route('**/media/**', async r => {
    const req = r.request();
    const n = await p.evaluate(() => window.__srcSets.length).catch(() => 0);
    const fx = await p.evaluate(() => { try { return window.BURZH.debug().fx; } catch (e) { return false; } }).catch(() => false);
    const kind = req.resourceType();
    const verdict = opts.policy && (kind === 'media' || kind === 'fetch') ? opts.policy({ n, fx, url: req.url(), type: kind }) : undefined;
    if (verdict === 'hang') { await sleep(60000); return r.abort().catch(() => {}); }
    if (verdict && verdict.status) return r.fulfill({ status: verdict.status, body: 'nope' });
    const h = (await req.allHeaders())['range'];
    if (h) {
      const m = /bytes=(\d*)-(\d*)/.exec(h);
      const a = m[1] ? +m[1] : 0, e = m[2] ? Math.min(+m[2], mock.length - 1) : mock.length - 1;
      return r.fulfill({ status: 206, headers: { 'Content-Type': 'audio/ogg', 'Content-Range': `bytes ${a}-${e}/${mock.length}`, 'Accept-Ranges': 'bytes' }, body: mock.subarray(a, e + 1) });
    }
    return r.fulfill({ status: 200, headers: { 'Content-Type': 'audio/ogg', 'Accept-Ranges': 'bytes' }, body: mock });
  });
  await p.route('**/stations.json', async r => {
    const j = await (await r.fetch()).json();
    j.stations.forEach(st => st.items.forEach(it => { it.duration = opts.duration || 60; }));
    // Deterministic clock: every station starts a few seconds into its mix, far from the end of the 60 s fixture.
    j.epoch = new Date(Math.floor(Date.now() / 1000) * 1000 - 120 * 10000 * 1000 - (opts.startOffset || 5) * 1000).toISOString();
    r.fulfill({ json: j });
  });
  await p.route('**/api.open-meteo.com/**', r => r.fulfill({ json: { timezone: 'Europe/Moscow', current: { temperature_2m: 5.4, weather_code: 2 } } }));
  await p.route('**/api.bigdatacloud.net/**', r => r.fulfill({ json: { city: 'Moscow' } }));
  await p.goto(server.url);
  await waitFor(() => p.evaluate(() => !!(window.BURZH && window.BURZH.stations().length)), 8000);
  await sleep(400);

  const t = {
    p, ctx, errs,
    dbg: () => p.evaluate(() => window.BURZH.debug()),
    srcs: () => p.evaluate(() => window.__srcSets.slice()),
    play: async () => { await p.locator('.play-toggle:visible').first().click(); },
    live: (ms = 8000) => waitFor(async () => { const d = await t.dbg(); return d.phase === 'live' && !d.paused && d.time > 0.3 ? d : null; }, ms),
    openSettings: async () => { await p.locator('[data-open]:visible').first().click(); await sleep(350); },
    shot: async name => { fs.mkdirSync(OUT, { recursive: true }); await p.screenshot({ path: path.join(OUT, name) }); },
    close: async () => { await ctx.close().catch(() => {}); }
  };
  return t;
}

module.exports = { startServer, open, closeBrowser, sleep, waitFor };
