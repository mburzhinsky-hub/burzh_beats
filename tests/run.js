#!/usr/bin/env node
/* BURZH beats — browser regression tests.
 *
 *   cd tests && npm install && node run.js            # everything
 *   node run.js scrub fallback                        # only tests whose name contains these words
 *
 * Runs the real docs/ files in headless Chromium with mocked audio, and exercises what has broken
 * before: playback start, seamless sound switching, iOS-style pauses, silent chains, the fallback
 * ladder when the engine or the audio request fails, seeking, layouts. Exit code 1 on any failure.
 */
'use strict';
const assert = require('assert');
const { startServer, open, closeBrowser, sleep, waitFor } = require('./lib');

const tests = [];
const test = (name, fn, opts = {}) => tests.push({ name, fn, opts });
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || 'value'}: ${a} is not within ${tol} of ${b}`);

const LAND = { width: 932, height: 430 };
const PORT = { width: 390, height: 844 };

/* ---------------------------------------------------------------- playback */

test('play starts through the sound engine and time advances', async t => {
  await t.play();
  const d = await t.live();
  assert.ok(d, 'playback did not reach live');
  assert.strictEqual(d.fx, true, 'engine should be attached from the first play');
  const t0 = d.time; await sleep(1200);
  assert.ok((await t.dbg()).time - t0 > 0.8, 'time did not advance');
});

test('every station that has music plays', async t => {
  const list = await t.p.evaluate(() => window.BURZH.stations().filter(s => s.total > 0 || s.stream).map(s => s.id));
  assert.ok(list.length >= 1, 'no station has music');
  for (const id of list) {
    await t.p.locator(`button[data-station="${id}"]:visible`).first().click();
    if (!(await t.dbg()).wantPlaying) await t.play();
    const d = await waitFor(async () => { const x = await t.dbg(); return x.station === id && x.phase === 'live' && !x.paused ? x : null; }, 9000);
    assert.ok(d, `station ${id} did not play`);
  }
});

test('stop, play again, reload page: playback works each time', async t => {
  await t.play(); assert.ok(await t.live(), 'first play');
  await t.play(); await sleep(300);
  assert.strictEqual((await t.dbg()).paused, true, 'stop should pause');
  await t.play(); assert.ok(await t.live(), 'play after stop');
  await t.p.reload(); await waitFor(() => t.p.evaluate(() => !!window.BURZH), 6000); await sleep(500);
  await t.play(); assert.ok(await t.live(), 'play after reload');
});

/* ------------------------------------------------------------ sound engine */

test('sound switch and presets never touch playback (seamless)', async t => {
  await t.play(); await t.live();
  await t.p.evaluate(() => { window.__ev = []; const a = window.BURZH.audioEl(); window.__a = a; ['pause', 'emptied', 'loadstart', 'seeking', 'error'].forEach(k => a.addEventListener(k, () => window.__ev.push(k))); });
  await t.openSettings();
  let prev = (await t.dbg()).time;
  for (let i = 0; i < 4; i++) {
    await t.p.click('[data-switch="sound.on"]'); await sleep(700);
    const d = await t.dbg();
    assert.strictEqual(d.fxOn, i % 2 === 0, 'switch state');
    assert.ok(d.phase === 'live' && !d.paused, `switch ${i + 1}: playback interrupted (${d.phase})`);
    assert.ok(d.time - prev > 0.35, `switch ${i + 1}: time did not advance`);
    prev = d.time;
  }
  for (const preset of ['deep', 'club', 'warm', 'auto']) {
    await t.p.click(`.chip[data-preset="${preset}"]`); await sleep(450);
    const d = await t.dbg();
    assert.ok(d.phase === 'live' && !d.paused && d.time - prev > 0.25, `preset ${preset}: playback interrupted`);
    prev = d.time;
  }
  assert.ok(await t.p.evaluate(() => window.__a === window.BURZH.audioEl()), 'the audio element was replaced');
  assert.deepStrictEqual(await t.p.evaluate(() => window.__ev), [], 'the element fired pause/emptied/loadstart/error');
});

test('A/B compare button changes the sound while held', async t => {
  await t.play(); await t.live();
  await t.openSettings(); await t.p.click('[data-switch="sound.on"]'); await sleep(500);
  await t.p.click('.chip[data-preset="deep"]'); await sleep(700);
  const low = () => t.p.evaluate(async () => { let s = 0, n = 0; for (let k = 0; k < 12; k++) { await new Promise(r => setTimeout(r, 60)); const a = window.BURZH.spectrum(); for (let i = 0; i < 16; i++) { s += a[i]; n++; } } return s / n; });
  const shaped = await low();
  const b = await t.p.locator('#abBtn').boundingBox();
  await t.p.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await t.p.mouse.down(); await sleep(700);
  const held = await low();
  await t.p.mouse.up(); await sleep(700);
  const released = await low();
  assert.ok(shaped - held > 12, `holding should reduce the low end (shaped ${shaped.toFixed(0)}, held ${held.toFixed(0)})`);
  assert.ok(released - held > 12, 'releasing should restore the shaped sound');
});

test('iOS-style pause right after starting is recovered', async t => {
  await t.play(); await t.live(); await t.openSettings();
  await t.p.click('[data-switch="sound.on"]'); await sleep(250);
  await t.p.evaluate(() => window.BURZH.audioEl().pause());
  const d = await waitFor(async () => { const x = await t.dbg(); return x.phase === 'live' && !x.paused ? x : null; }, 3000);
  assert.ok(d, 'did not resume after a pause');
});

test('persistent pauses hand control back instead of hanging', async t => {
  await t.play(); await t.live();
  let d;
  for (let i = 0; i < 12; i++) {
    await t.p.evaluate(() => window.BURZH.audioEl().pause()); await sleep(400);
    d = await t.dbg();
    if (d.phase === 'stopped') break;
  }
  assert.strictEqual(d.phase, 'stopped', 'should give control back after repeated pauses'); assert.strictEqual(d.wantPlaying, false);
});

test('a user stop right after starting is respected', async t => {
  await t.play(); await t.live(); await sleep(300);
  await t.play(); await sleep(1200);
  const d = await t.dbg();
  assert.strictEqual(d.phase, 'stopped'); assert.strictEqual(d.paused, true);
});

test('a silent engine falls back to the original sound', async t => {
  await t.play();
  const d = await waitFor(async () => { const x = await t.dbg(); return x.fxBroken ? x : null; }, 20000, 500);
  assert.ok(d, 'did not fall back');
  assert.strictEqual(d.fx, false);
  await waitFor(async () => (await t.dbg()).phase === 'live', 6000);
  assert.strictEqual((await t.dbg()).paused, false);
}, { media: 'silent.ogg' });

/* ------------------------------------------------ never silent: fallbacks */

test('engine request fails, the plain player takes over and plays', async t => {
  await t.play();
  const d = await waitFor(async () => { const x = await t.dbg(); return x.phase === 'live' && !x.paused && x.fxBroken ? x : null; }, 14000);
  assert.ok(d, 'no playback after the engine failed: ' + JSON.stringify(await t.dbg()));
  assert.strictEqual(d.fx, false);
  assert.match(d.problem, /E\d|no sound|could not start/i, 'problem was not recorded: ' + JSON.stringify(d.problem));
}, { policy: r => (r.fx ? { status: 404 } : undefined), allowNetworkErrors: true });

test('engine request hangs, playback still starts (stall watchdog)', async t => {
  await t.play();
  const d = await waitFor(async () => { const x = await t.dbg(); return x.phase === 'live' && !x.paused ? x : null; }, 24000, 300);
  assert.ok(d, 'no playback after a hang: ' + JSON.stringify(await t.dbg()));
  assert.strictEqual(d.fxBroken, true);
}, { policy: r => (r.fx && r.type === 'media' ? 'hang' : undefined), allowNetworkErrors: true });

test('ladder: engine, plain, then no #t fragment', async t => {
  await t.play();
  const d = await waitFor(async () => { const x = await t.dbg(); return x.phase === 'live' && !x.paused ? x : null; }, 16000);
  assert.ok(d, 'never played: ' + JSON.stringify(await t.dbg()));
  const srcs = await t.srcs();
  assert.ok(srcs.length >= 3, 'expected 3 attempts, got ' + srcs.length);
  assert.ok(/#t=/.test(srcs[0]) && /#t=/.test(srcs[1]) && !/#t=/.test(srcs[2]), 'unexpected attempts: ' + srcs.join(' | '));
  const live = await t.p.evaluate(() => { const l = window.BURZH.liveAt(window.BURZH.debug().station); return l.offset; });
  near(d.time, live, 5, 'position should still match the live clock');
}, { policy: r => (r.n <= 2 ? { status: 404 } : undefined), allowNetworkErrors: true });

test('everything fails: says why, retries calmly, no crash', async t => {
  await t.play(); await sleep(11000);
  const d = await t.dbg();
  assert.strictEqual(d.phase, 'lost');
  assert.match(d.problem, /E\d|NotSupported|play\(\)/, 'media error missing in the diagnosis');
  await waitFor(async () => /HTTP 404/.test((await t.dbg()).problem), 4000);
  assert.match((await t.dbg()).problem, /HTTP 404/, 'server answer missing in the diagnosis');
  assert.ok((await t.srcs()).length <= 10, 'too many retries');
}, { policy: () => ({ status: 404 }), allowNetworkErrors: true });

/* ------------------------------------------------------------------- seek */

async function scrubFlow(t, sel, playSel, goLiveSel) {
  await t.p.locator(playSel).click(); await t.live();
  const rail = await (await t.p.$(sel + ' .live-rail')).boundingBox();
  const cy = rail.y + rail.height / 2;
  assert.ok(await waitFor(() => t.p.evaluate(s => document.querySelector(s).classList.contains('can-seek'), sel), 3000), 'rail should be seekable while playing');
  await t.p.mouse.move(rail.x + rail.width * 0.2, cy); await t.p.mouse.down();
  await t.p.mouse.move(rail.x + rail.width * 0.9, cy, { steps: 8 });
  assert.ok(await t.p.evaluate(s => document.querySelector(s).classList.contains('dragging'), sel), 'dragging class');
  const tip = await t.p.evaluate(s => document.querySelector(s + ' .seek-tip b').textContent, sel);
  assert.match(tip, /^\d+:\d\d$/, 'time bubble');
  await t.p.mouse.up(); await sleep(700);
  let d = await t.dbg();
  near(d.time, 54.7, 3, 'time after dragging to 90 % of 60 s');
  // tap on the rail jumps there
  await t.p.mouse.click(rail.x + rail.width * 0.1, cy); await sleep(500);
  near((await t.dbg()).time, 6.4, 2.5, 'tap on rail');
  // keyboard
  await t.p.focus(sel); const before = (await t.dbg()).time; await t.p.keyboard.press('ArrowRight'); await sleep(250);
  near((await t.dbg()).time - before, 10, 1.5, 'ArrowRight = +10 s');
  // a position far from the live clock: time-shifted, with a way back
  const liveNow = await t.p.evaluate(() => window.BURZH.liveAt(window.BURZH.debug().station).offset);
  await t.p.evaluate(x => window.BURZH.seekTo(x), (liveNow + 30) % 60); await sleep(400);
  d = await t.dbg();
  assert.strictEqual(d.shifted, true, 'should be time-shifted');
  assert.ok(await t.p.isVisible(goLiveSel), 'Live button should show');
  assert.match(await t.p.evaluate(() => document.querySelector('.shifted [data-bind="status"]').textContent), /TIMESHIFT/);
  await t.p.click(goLiveSel); await sleep(900);
  d = await t.dbg();
  assert.strictEqual(d.shifted, false, 'back to live');
  near(d.time, await t.p.evaluate(() => window.BURZH.liveAt(window.BURZH.debug().station).offset), 3, 'live position');
  assert.ok((await t.dbg()).phase === 'live', 'still live');
  // run into the end of the mix while shifted: the next mix starts from its beginning
  await t.p.evaluate(() => window.BURZH.seekTo(10)); await sleep(300);
  const item0 = (await t.dbg()).src;
  await t.p.evaluate(() => window.BURZH.seekTo(58.2)); await sleep(4200);
  d = await t.dbg();
  assert.ok(d.phase === 'live' && !d.paused, 'playing after the end of the mix');
  assert.strictEqual(d.shifted, true, 'continues time-shifted');
  assert.ok(d.time < 6, 'next mix should start near its beginning, at ' + d.time);
  if ((await t.p.evaluate(() => window.BURZH.stations().find(s => s.id === window.BURZH.debug().station).items.length)) > 1) assert.notStrictEqual(d.src.split('#')[0], item0.split('#')[0], 'should have moved to the other mix');
}

test('seek slider (landscape): drag, tap, keys, back to live, next mix', t => scrubFlow(t, '.l-live .seek', '.l-tools .play-toggle', '.l-live .golive'));
test('seek slider (portrait)', t => scrubFlow(t, '.p-live .seek', '.p-controls .play-toggle', '.p-live .golive'), { viewport: PORT });

test('seek slider works with touch, and the first touch on an idle screen only wakes it', async t => {
  await t.play(); await t.live();
  const box = await (await t.p.$('.l-live .live-rail')).boundingBox(); const y = box.y + 1;
  const cdp = await t.ctx.newCDPSession(t.p);
  const touch = (type, x) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
  await touch('touchStart', box.x + box.width * 0.15); await sleep(60);
  for (let i = 1; i <= 8; i++) { await touch('touchMove', box.x + box.width * (0.15 + i * 0.06)); await sleep(30); }
  assert.ok(await t.p.evaluate(() => document.querySelector('.l-live .seek').classList.contains('dragging')), 'touch drag');
  await touch('touchEnd'); await sleep(700);
  near((await t.dbg()).time, 38, 4, 'after the touch drag');
  await t.p.evaluate(() => document.documentElement.classList.add('idle'));
  const before = (await t.dbg()).time;
  await touch('touchStart', box.x + box.width * 0.3); await touch('touchEnd'); await sleep(400);
  near((await t.dbg()).time - before, 0.4, 1.2, 'an idle tap must not seek');
}, { viewport: { width: 667, height: 375 }, touch: true, scale: 2 });

/* -------------------------------------------------------------- settings */

test('settings: sound controls, EQ drag, weather by geolocation', async t => {
  await t.play(); await t.live(); await t.openSettings();
  await t.p.click('[data-switch="sound.on"]'); await sleep(900);
  await t.p.click('.chip[data-preset="deep"]'); await sleep(200);
  await t.p.locator('#eqCanvas').scrollIntoViewIfNeeded(); await sleep(200);
  const box = await t.p.locator('#eqCanvas').boundingBox();
  await t.p.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.5); await t.p.mouse.down();
  await t.p.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.25, { steps: 5 }); await t.p.mouse.up(); await sleep(200);
  const stored = await t.p.evaluate(() => JSON.parse(localStorage.getItem('burzh.radio.settings.v1')).sound);
  assert.strictEqual(stored.preset, 'custom', 'dragging a point makes a custom preset');
  assert.strictEqual(stored.on, true);
  await t.p.click('#tab-screen'); await t.p.click('[data-switch="weather"]');
  assert.ok(await waitFor(() => t.p.evaluate(() => /5°/.test(document.getElementById('weatherWidget').textContent)), 5000), 'weather widget');
  await t.p.click('#tab-about');
  assert.match(await t.p.textContent('#versionState'), /^v\d+\.\d+\.\d+$/);
  assert.ok((await t.dbg()).phase === 'live', 'music kept playing while changing settings');
}, { geolocation: { latitude: 55.7558, longitude: 37.6173 }, scale: 2 });

/* --------------------------------------------------------------- layouts */

for (const [w, h] of [[932, 430], [667, 375], [844, 390], [1180, 820], [390, 844], [375, 667]]) {
  test(`layout ${w}x${h}: fits the screen, controls visible`, async t => {
    await t.play(); await t.live(); await sleep(400);
    const m = await t.p.evaluate(() => {
      const vis = sel => { const e = [...document.querySelectorAll(sel)].find(x => x.offsetParent !== null || getComputedStyle(x).position === 'fixed'); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, r: r.right, b: r.bottom }; };
      return { sw: document.scrollingElement.scrollWidth, sh: document.scrollingElement.scrollHeight, iw: innerWidth, ih: innerHeight, play: vis('.play-toggle'), seek: vis('.seek .live-rail'), dial: vis('button[data-station]') };
    });
    assert.ok(m.sw <= m.iw + 1, `horizontal overflow ${m.sw} > ${m.iw}`);
    for (const k of ['play', 'seek', 'dial']) {
      assert.ok(m[k], k + ' is missing');
      assert.ok(m[k].x >= -1 && m[k].r <= m.iw + 1 && m[k].y >= -1 && m[k].b <= m.ih + 1, `${k} is outside the screen: ${JSON.stringify(m[k])}`);
    }
    await t.shot(`layout-${w}x${h}.png`);
  }, { viewport: { width: w, height: h } });
}

/* ---------------------------------------------------------------- runner */

(async () => {
  const words = process.argv.slice(2).map(s => s.toLowerCase());
  const pick = tests.filter(x => !words.length || words.some(w => x.name.toLowerCase().includes(w)));
  const server = await startServer();
  let failed = 0;
  const flaky = [];
  for (const { name, fn, opts } of pick) {
    let lastErr = null;
    for (let attempt = 1; attempt <= (process.env.NO_RETRY ? 1 : 2); attempt++) {     // one retry: CI machines are slower than laptops
      const t0 = Date.now();
      let t;
      try {
        t = await open(server, opts);
        await Promise.race([fn(t), sleep(70000).then(() => { throw new Error('test timed out'); })]);
        if (t.errs.length) throw new Error('page errors: ' + t.errs.join(' | '));
        console.log(`  ✓ ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)${attempt > 1 ? '  [passed on retry]' : ''}`);
        if (attempt > 1) flaky.push(name);
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        if (attempt === 1 && !process.env.NO_RETRY) console.log(`  … ${name}: first attempt failed: ${String(e.message || e).split('\n')[0]}`);
        if (t && attempt === 2) { try { await t.shot('FAILED-' + name.replace(/\W+/g, '-').slice(0, 40) + '.png'); } catch (x) { /* ignore */ } }
      } finally { if (t) await t.close(); }
    }
    if (lastErr) {
      failed++;
      console.log(`  ✗ ${name}\n      ${String(lastErr.message || lastErr).split('\n').join('\n      ')}`);
    }
  }
  if (flaky.length) console.log('\nFlaky (passed only on retry): ' + flaky.join('; '));
  await closeBrowser(); server.close();
  console.log(failed ? `\n${failed} of ${pick.length} FAILED` : `\nAll ${pick.length} checks passed`);
  process.exit(failed ? 1 : 0);
})();
