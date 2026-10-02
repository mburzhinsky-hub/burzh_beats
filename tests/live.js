#!/usr/bin/env node
/* End-to-end check of the DEPLOYED site with the real audio, in real Chrome (GitHub runner, real network):
 *
 *   node live.js https://<user>.github.io/<repo>/
 *
 * Launch time, time from "Play" to the first sound (engine on and off), a second launch (saved copy)
 * and the app's own event log. Results go out as workflow annotations (::notice) and exit code 1 on failure.
 * Not part of the release gate: it measures the network, it does not judge it.
 */
'use strict';
const { chromium } = require('playwright-core');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const url = process.argv[2];
if (!url) { console.error('usage: node live.js <site url>'); process.exit(2); }
const note = (title, msg) => console.log(`::notice title=${title}::${String(msg).replace(/%/g, '%25').replace(/\r?\n/g, '%0A')}`);

async function waitFor(fn, ms, step = 200) { const t0 = Date.now(); for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(step); } }

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', args: ['--autoplay-policy=no-user-gesture-required'] });
  let failed = 0;
  const ctx = await browser.newContext({ viewport: { width: 932, height: 430 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));

  async function launch(label) {
    const t0 = Date.now();
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    const ready = await waitFor(() => page.evaluate(() => !!(window.BURZH && window.BURZH.stations().length)), 30000, 50);
    const ms = Date.now() - t0;
    const info = await page.evaluate(() => ({ v: window.BURZH && window.BURZH.version, launch: (document.getElementById('launchState') || {}).textContent, sw: !!navigator.serviceWorker.controller })).catch(() => ({}));
    note(`${label}: launch`, `${ready ? 'ready' : 'NOT READY'} in ${ms} ms · v${info.v} · app says "${info.launch}" · saved copy ${info.sw ? 'active' : 'not yet'}`);
    if (!ready) failed++;
    return ready;
  }

  async function playOnce(label, shaping) {
    await page.evaluate(on => { const k = 'burzh.radio.settings.v1'; const s = JSON.parse(localStorage.getItem(k) || '{}'); s.v = 2; s.sound = Object.assign({ preset: 'auto', custom: null }, s.sound, { on }); localStorage.setItem(k, JSON.stringify(s)); }, shaping);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitFor(() => page.evaluate(() => !!(window.BURZH && window.BURZH.stations().length)), 30000, 50);
    await sleep(500);
    const t0 = Date.now();
    await page.locator('.play-toggle:visible').first().click();
    const live = await waitFor(async () => { const d = await page.evaluate(() => window.BURZH.debug()); return d.phase === 'live' && !d.paused && d.time > 0.5 ? d : null; }, 90000, 100);
    const ms = Date.now() - t0;
    const d = await page.evaluate(() => window.BURZH.debug());
    note(`${label}: play`, `${live ? 'sound after ' + ms + ' ms' : 'NO SOUND after ' + ms + ' ms'} · phase ${d.phase} · engine ${d.fx} · strikes ${d.fxFails} · station ${d.station} · last start "${d.lastStart}" · problem ${d.problem || 'none'}`);
    if (!live) failed++;
    if (live) { const t1 = d.time; await sleep(4000); const d2 = await page.evaluate(() => window.BURZH.debug()); if (!(d2.time - t1 > 3)) { failed++; note(`${label}: stalled`, `time went ${t1} -> ${d2.time}`); } }
    await page.locator('.play-toggle:visible').first().click().catch(() => {});
    await sleep(500);
    return live;
  }

  await launch('first visit');
  await sleep(3000);                       // let the service worker save the app
  await launch('second visit');
  await playOnce('shaping off', false);
  await playOnce('shaping on', true);
  await playOnce('shaping on, again (warm)', true);

  const report = await page.evaluate(() => window.BURZH.report()).catch(() => '');
  note('app report', report.split('\n').slice(-45).join('\n'));
  if (errors.length) { failed++; note('page errors', errors.join('\n')); }
  await browser.close();
  console.log(failed ? `\n${failed} problem(s)` : '\nlive end-to-end OK');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
