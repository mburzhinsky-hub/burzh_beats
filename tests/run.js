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
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startServer, open, closeBrowser, sleep, waitFor, DOCS } = require('./lib');

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
  assert.strictEqual(await t.p.evaluate(() => window.BURZH.audioEl().getAttribute('crossorigin')), null, 'same-origin audio must load without CORS (iPhone loads CORS media through a slower path)');
  assert.ok(await waitFor(() => t.p.evaluate(() => window.BURZH.spectrum().some(v => v > 0)), 4000), 'the engine must hear the music (not CORS-tainted)');
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

/* Sound shaping is a switch the listener controls: whatever goes wrong with the engine, the switch stays usable. */
const switchUsable = async t => {
  await t.openSettings();
  const st = await t.p.evaluate(() => { const b = document.querySelector('[data-switch="sound.on"]'); return { disabled: b.disabled || b.getAttribute('aria-disabled') === 'true', hint: document.getElementById('soundHint').textContent }; });
  assert.strictEqual(st.disabled, false, 'the Sound switch must stay usable (hint: ' + st.hint + ')');
  assert.doesNotMatch(st.hint, /not supported/i, 'a failed start is not "not supported": ' + st.hint);
  return st;
};

test('a silent engine falls back to the original sound (the switch stays usable)', async t => {
  await t.play();
  const d = await waitFor(async () => { const x = await t.dbg(); return x.fxBroken ? x : null; }, 24000, 400);
  assert.ok(d, 'did not fall back');
  assert.strictEqual(d.fx, false);
  await waitFor(async () => (await t.dbg()).phase === 'live', 6000);
  assert.strictEqual((await t.dbg()).paused, false);
  await switchUsable(t);
}, { media: 'silent.ogg' });

/* ------------------------------------------------ never silent: fallbacks */

test('engine request fails, the plain player takes over and plays (and keeps the saved setting)', async t => {
  await t.play();
  const d = await waitFor(async () => { const x = await t.dbg(); return x.phase === 'live' && !x.paused && x.fxBroken ? x : null; }, 14000);
  assert.ok(d, 'no playback after the engine failed: ' + JSON.stringify(await t.dbg()));
  assert.strictEqual(d.fx, false);
  assert.strictEqual(d.fxFails, 1, 'one failed start is one strike, not a permanent verdict');
  assert.match(d.problem, /did not start|E\d|no sound/i, 'problem was not recorded: ' + JSON.stringify(d.problem));
  const saved = await t.p.evaluate(() => JSON.parse(localStorage.getItem('burzh.radio.settings.v1')).sound.on);
  assert.strictEqual(saved, true, 'a fallback must not switch Sound shaping off for the next launch');
  await switchUsable(t);
}, { policy: r => (r.fx ? { status: 404 } : undefined), allowNetworkErrors: true, settings: { sound: { on: true } } });

test('engine request hangs: the loader is restarted once, then the plain player takes over', async t => {
  await t.play();
  const d = await waitFor(async () => { const x = await t.dbg(); return x.phase === 'live' && !x.paused ? x : null; }, 55000, 300);
  assert.ok(d, 'no playback after a hang: ' + JSON.stringify(await t.dbg()));
  assert.strictEqual(d.fx, false);
  assert.strictEqual(d.fxFails, 1);
  assert.ok((await t.srcs()).length >= 3, 'expected engine, one restart, then plain: ' + (await t.srcs()).join(' | '));
  await switchUsable(t);
}, { policy: r => (r.fx && r.type === 'media' ? 'hang' : undefined), allowNetworkErrors: true });

test('a failed engine is retried at the next Play and recovers; two strikes park it until the switch is toggled', async t => {
  await t.play();
  assert.ok(await waitFor(async () => { const x = await t.dbg(); return x.phase === 'live' && x.fxFails === 1 && !x.fx ? x : null; }, 14000), 'first strike: plain playback expected');
  await t.play(); await sleep(400);                                   // stop
  await sleep(Math.max(0, 7000 - (Date.now() - t.opened)));           // the engine starts working again
  await t.play();
  const d = await waitFor(async () => { const x = await t.dbg(); return x.phase === 'live' && !x.paused && x.fx ? x : null; }, 12000);
  assert.ok(d, 'the engine should be tried again at the next Play: ' + JSON.stringify(await t.dbg()));
  assert.strictEqual(d.fxFails, 0, 'a successful engine start clears the strikes');
}, { policyFactory: () => r => (r.fx && r.ms < 7000 ? { status: 404 } : undefined), allowNetworkErrors: true });

test('two failed starts park the engine; toggling the Sound switch gives it a fresh start', async t => {
  for (let i = 0; i < 2; i++) {
    await t.play();
    assert.ok(await waitFor(async () => { const x = await t.dbg(); return x.phase === 'live' && x.fxFails === i + 1 ? x : null; }, 14000), 'strike ' + (i + 1));
    await t.play(); await sleep(400);
  }
  const engineAsks = () => t.log.filter(l => l.type === 'media' && l.fx).length;
  const before = engineAsks();
  await t.play(); assert.ok(await t.live(10000), 'plain playback while parked');
  assert.strictEqual((await t.dbg()).fx, false, 'a parked engine is not tried again');
  assert.strictEqual(engineAsks(), before, 'a parked engine must not be requested');
  const st = await switchUsable(t);
  assert.match(st.hint, /Paused|switch off and on/i, st.hint);
  await t.p.keyboard.press('Escape'); await sleep(300);
  await t.play(); await sleep(400);                                    // stop, then toggle the switch
  await t.openSettings();
  await t.p.click('[data-switch="sound.on"]'); await sleep(300);
  assert.strictEqual((await t.dbg()).fxFails, 0, 'toggling the switch clears the strikes');
}, { policy: r => (r.fx ? { status: 404 } : undefined), allowNetworkErrors: true, settings: { sound: { on: true } } });

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

test('everything fails: says why, retries calmly, never blames the engine', async t => {
  await t.play();
  assert.ok(await waitFor(async () => (await t.dbg()).phase === 'lost', 10000), 'should end up in "lost": ' + JSON.stringify(await t.dbg()));
  await sleep(3000);
  const d = await t.dbg();
  assert.match(d.problem, /E\d|NotSupported|play\(\)/, 'media error missing in the diagnosis');
  await waitFor(async () => /HTTP 404/.test((await t.dbg()).problem), 4000);
  assert.match((await t.dbg()).problem, /HTTP 404/, 'server answer missing in the diagnosis');
  assert.ok((await t.srcs()).length <= 10, 'too many retries: ' + (await t.srcs()).length);
  assert.strictEqual(d.fxFails, 0, 'a dead server says nothing about the sound engine');
  assert.strictEqual(d.fxBroken, false);
  await switchUsable(t);
}, { policy: () => ({ status: 404 }), allowNetworkErrors: true });

/* ------------------------------------------- loading: slow is not broken */

test('no connection: says so, keeps the engine, and starts by itself when the connection returns', async t => {
  await t.play();
  assert.ok(await waitFor(async () => (await t.dbg()).phase === 'lost', 12000), 'should report a lost signal');
  let d = await t.dbg();
  assert.strictEqual(d.fxFails, 0, 'no connection is not an engine failure');
  await switchUsable(t);
  await t.p.keyboard.press('Escape'); await sleep(300);
  d = await waitFor(async () => { const x = await t.dbg(); return x.phase === 'live' && !x.paused ? x : null; }, 30000, 400);
  assert.ok(d, 'playback should resume when the connection is back: ' + JSON.stringify(await t.dbg()));
  assert.strictEqual(d.fx, true, 'shaping must still be on after an outage');
  assert.strictEqual(d.fxFails, 0);
}, { policyFactory: () => r => (r.ms < 12000 ? 'abort' : undefined), allowNetworkErrors: true });

test('the server stops answering while the player waits: the watchdog says so instead of blaming the engine', async t => {
  await t.play();
  const d = await waitFor(async () => { const x = await t.dbg(); return x.phase === 'lost' ? x : null; }, 30000, 400);
  assert.ok(d, 'should give up waiting: ' + JSON.stringify(await t.dbg()));
  assert.match(d.problem, /server did not answer/i, d.problem);
  assert.strictEqual(d.fxFails, 0);
}, { policy: r => (r.type === 'media' ? 'hang' : 'abort'), allowNetworkErrors: true });

test('a slow server (cold CDN) is waited for: no restart, no engine blame, shaping stays on', async t => {
  const t0 = Date.now();
  await t.play();
  const d = await waitFor(async () => { const x = await t.dbg(); return x.phase === 'live' && !x.paused ? x : null; }, 45000, 300);
  assert.ok(d, 'playback should start once the slow server answers: ' + JSON.stringify(await t.dbg()));
  assert.ok(Date.now() - t0 > 11000, 'the scenario should really have been slow');
  assert.strictEqual((await t.srcs()).length, 1, 'a slow load must not be restarted: ' + (await t.srcs()).join(' | '));
  assert.strictEqual(d.fx, true);
  assert.strictEqual(d.fxFails, 0);
  assert.ok(!d.problem, 'a slow start is not a problem: ' + d.problem);
  assert.match(await t.p.evaluate(() => document.getElementById('startState').textContent), /^engine · \d+\.\d s/);
}, { policyFactory: () => { let k = 0; return r => (r.type === 'media' ? (k++ === 0 ? { delay: 12000 } : undefined) : r.ms > 2000 ? { delay: 4000 } : undefined); }, allowNetworkErrors: true });

test('a stuck first connection while the server is fast: one restart with a fresh connection fixes it', async t => {
  await t.play();
  const d = await waitFor(async () => { const x = await t.dbg(); return x.phase === 'live' && !x.paused ? x : null; }, 45000, 300);
  assert.ok(d, 'the restart should have played: ' + JSON.stringify(await t.dbg()));
  assert.strictEqual((await t.srcs()).length, 2, 'exactly one restart: ' + (await t.srcs()).join(' | '));
  assert.strictEqual(d.fx, true, 'one stuck connection is not the engine\'s fault');
  assert.strictEqual(d.fxFails, 0);
}, { policyFactory: () => { let k = 0; return r => (r.type === 'media' && k++ === 0 ? 'hang' : undefined); }, allowNetworkErrors: true });

test('a load that is slowly working is left alone, even when the server answers probes at once', async t => {
  const t0 = Date.now();
  await t.play();
  const d = await waitFor(async () => { const x = await t.dbg(); return x.phase === 'live' && !x.paused ? x : null; }, 40000, 300);
  assert.ok(d, 'playback should start once the slow first request is answered: ' + JSON.stringify(await t.dbg()));
  assert.ok(Date.now() - t0 > 13000, 'the scenario should really have been slow');
  assert.strictEqual((await t.srcs()).length, 1, 'restarting a working load throws its progress away: ' + (await t.srcs()).join(' | '));
  assert.strictEqual(d.fx, true);
  assert.strictEqual(d.fxFails, 0);
}, { policyFactory: () => { let k = 0; return r => (r.type === 'media' ? (k++ === 0 ? { delay: 14000 } : undefined) : undefined); }, allowNetworkErrors: true });

/* ------------------------- the audio system takes the engine away (call, Siri, lock) */

test('engine interrupted: the music is not left silent, no strike, and a tap restores sound shaping', async t => {
  await t.play();
  assert.ok(await waitFor(async () => { const x = await t.dbg(); return x.phase === 'live' && x.fx && x.ctx === 'running' ? x : null; }, 10000), 'engine live first');
  await t.p.evaluate(async () => { window.__noResume = true; await window.__ctxs[0].suspend(); });
  const held = await waitFor(async () => { const x = await t.dbg(); return x.fxHeld && !x.fx && x.phase === 'live' && !x.paused ? x : null; }, 16000, 300);
  assert.ok(held, 'the music should continue on the plain player: ' + JSON.stringify(await t.dbg()));
  assert.strictEqual(held.fxFails, 0, 'an interruption is not an engine failure');
  // (read without tapping: any tap would already restore the engine)
  const st = await t.p.evaluate(() => ({ hint: document.getElementById('soundHint').textContent, disabled: document.querySelector('[data-switch="sound.on"]').disabled }));
  assert.match(st.hint, /tap the screen/i, st.hint);
  assert.strictEqual(st.disabled, false, 'the Sound switch stays usable');
  await t.p.evaluate(() => { window.__noResume = false; });         // the call is over
  await t.p.mouse.click(8, 8);                                        // any tap
  const back = await waitFor(async () => { const x = await t.dbg(); return x.fx && !x.fxHeld && x.ctx === 'running' && x.phase === 'live' && !x.paused ? x : null; }, 12000, 300);
  assert.ok(back, 'a tap should bring the engine back: ' + JSON.stringify(await t.dbg()));
  assert.strictEqual(back.fxFails, 0);
  assert.match(await t.p.evaluate(() => window.BURZH.report()), /engine held/);
}, { audioHooks: true, settings: { sound: { on: true } } });

test('engine interrupted with shaping off: just keeps the music going', async t => {
  await t.play();
  assert.ok(await waitFor(async () => { const x = await t.dbg(); return x.phase === 'live' && x.fx && x.ctx === 'running' ? x : null; }, 10000), 'engine live first');
  await t.p.evaluate(async () => { window.__noResume = true; await window.__ctxs[0].suspend(); });
  const held = await waitFor(async () => { const x = await t.dbg(); return !x.fx && x.phase === 'live' && !x.paused ? x : null; }, 16000, 300);
  assert.ok(held, 'the music should continue on the plain player: ' + JSON.stringify(await t.dbg()));
  assert.strictEqual(held.fxHeld, false, 'with shaping off there is nothing to restore');
  assert.strictEqual(held.fxFails, 0);
}, { audioHooks: true });

/* --------------------------------------------------------- event log */

test('event log: records what happened, survives a relaunch, and the report is complete', async t => {
  await t.play(); assert.ok(await t.live());
  await t.p.keyboard.press('Shift'); await sleep(150);
  await t.play(); await sleep(300);                                   // stop
  await t.p.reload();
  assert.ok(await waitFor(() => t.p.evaluate(() => !!(window.BURZH && window.BURZH.stations().length)), 8000));
  await t.openSettings(); await t.p.click('#tab-about'); await sleep(200);
  await t.p.locator('#logBox summary').scrollIntoViewIfNeeded();
  await t.p.click('#logBox summary'); await sleep(300);
  const text = await t.p.textContent('#logView');
  for (const word of ['launch v', 'play', 'tune ', 'loadstart', 'START ', 'stop', 'warm ']) assert.ok(text.includes(word), `the log should contain "${word}" (from before the relaunch):\n${text}`);
  assert.ok((text.match(/launch v/g) || []).length >= 2, 'both launches should be in the log');
  const report = await t.p.evaluate(() => window.BURZH.report());
  for (const word of ['BURZH beats v', 'device:', 'mode:', 'saved copy:', 'launch:', 'sound:', 'last problem:', '--- events']) assert.ok(report.includes(word), `the report should contain "${word}"`);
  await t.p.locator('#logCopy').scrollIntoViewIfNeeded();
  await t.p.click('#logCopy');
  assert.ok(await waitFor(() => t.p.evaluate(() => /Copied|Could not copy/.test(document.getElementById('logState').textContent)), 4000), 'the copy button should answer');
  await t.p.click('#logClear'); await sleep(200);
  assert.strictEqual((await t.p.textContent('#logView')).trim(), '', 'Clear empties the log');
}, { viewport: PORT });

/* ------------------------------------------------- launch and warm-up */

test('warm-up: the live mix gets a tiny range request at launch, once, and the next one before it is needed', async t => {
  const live = await t.p.evaluate(() => { const s = window.BURZH.stations().find(x => x.id === window.BURZH.debug().station); const l = window.BURZH.liveAt(s.id); return { item: l.item.file, next: l.next && l.next.file, remaining: l.remaining }; });
  const warm = () => t.log.filter(l => l.type === 'fetch' && l.range === 'bytes=0-1');
  assert.ok(await waitFor(async () => warm().some(l => l.url.endsWith(live.item)), 3000), 'the live mix was not warmed up: ' + JSON.stringify(t.log.map(l => l.url.split('/media/')[1] + ' ' + l.range)));
  const n = warm().filter(l => l.url.endsWith(live.item)).length;
  await t.p.locator('button[data-station]:visible').last().click(); await sleep(300);
  await t.p.locator(`button[data-station="${await t.p.evaluate(() => window.BURZH.debug().station)}"]:visible`).first().click(); await sleep(300);
  assert.strictEqual(warm().filter(l => l.url.endsWith(live.item)).length, n, 'warming must not repeat within minutes');
  if (live.next && live.next !== live.item) assert.ok(warm().some(l => l.url.endsWith(live.next)), 'the next mix should be warmed up too');
});

test('launch from the saved station list is instant even when the network is slow', async t => {
  assert.ok(await t.p.evaluate(() => !!localStorage.getItem('burzh.radio.data.v1')), 'the station list should be saved after the first launch');
  t.net.stationsDelay = 7000;
  const t0 = Date.now();
  await t.p.reload();
  const ok = await waitFor(() => t.p.evaluate(() => !!(window.BURZH && window.BURZH.stations().length)), 6000, 100);
  assert.ok(ok, 'the app should open from the saved list');
  assert.ok(Date.now() - t0 < 3500, 'opened in ' + (Date.now() - t0) + ' ms');
  assert.match(await t.p.evaluate(() => document.getElementById('launchState').textContent), /saved list/);
  await t.play();
  assert.ok(await t.live(10000), 'playback from the saved list');
});

test('Settings → About: start time, launch, connection test and Refresh app', async t => {
  await t.play(); assert.ok(await t.live());
  await t.openSettings(); await t.p.click('#tab-about'); await sleep(200);
  assert.match(await t.p.textContent('#startState'), /^(engine|plain) · \d+\.\d s/);
  assert.match(await t.p.textContent('#launchState'), /^\d+\.\d s · (saved list|first load)$/);
  await t.p.locator('#netBtn').scrollIntoViewIfNeeded();
  await t.p.click('#netBtn');
  assert.ok(await waitFor(() => t.p.evaluate(() => /first byte [\d.]+ s · 1 MB in/.test(document.getElementById('netState').textContent)), 8000), 'connection test result: ' + await t.p.textContent('#netState'));
  const box = await t.p.evaluate(() => { const r = ['netBtn', 'refreshBtn'].map(id => document.getElementById(id).getBoundingClientRect()); return { w: innerWidth, r: r.map(x => [x.left, x.right]), sw: document.querySelector('.sheet-body').scrollWidth, cw: document.querySelector('.sheet-body').clientWidth }; });
  box.r.forEach(([l, r]) => assert.ok(l >= 0 && r <= box.w, 'About buttons outside the screen: ' + JSON.stringify(box)));
  assert.ok(box.sw <= box.cw + 1, 'About must not scroll sideways: ' + JSON.stringify(box));
  await t.p.click('#refreshBtn');
  assert.ok(await waitFor(() => t.p.evaluate(() => !!(window.BURZH && window.BURZH.stations().length) && /first load/.test(document.getElementById('launchState').textContent)).catch(() => false), 10000), 'the app should come back after a refresh, without the saved list: ' + await t.p.textContent('#launchState').catch(() => '?'));
}, { viewport: PORT });

/* ---------------------------------------------------- service worker */

// The app opens from a copy saved on the device. These tests run a copy of docs/ (without the audio) on a
// throw-away server, with the service worker switched on.
const copyDocs = build => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'burzh-sw-'));
  fs.cpSync(DOCS, dir, { recursive: true, filter: src => path.basename(src) !== 'media' });
  setBuild(dir, build);
  return dir;
};
const setBuild = (dir, build) => {
  const f = path.join(dir, 'sw.js');
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/^const BUILD = '[^']*';/m, `const BUILD = '${build}';`));
};
const swState = page => page.evaluate(async () => {
  const reg = await navigator.serviceWorker.getRegistration();
  const keys = await caches.keys();
  const files = keys.length ? (await (await caches.open(keys[0])).keys()).length : 0;
  return { active: !!(reg && reg.active), controlled: !!navigator.serviceWorker.controller, keys, files };
}).catch(() => null);

test('service worker list: every saved file exists, every file the page loads is saved, the release id can be stamped', async () => {
  const sw = fs.readFileSync(path.join(DOCS, 'sw.js'), 'utf8');
  assert.match(sw, /^const BUILD = 'dev';/m, "deploy-web.yml stamps the release into the line `const BUILD = 'dev';`");
  const shell = [...sw.slice(sw.indexOf('const SHELL'), sw.indexOf('];')).matchAll(/'\.\/([^']*)'/g)].map(m => m[1]).filter(Boolean);
  shell.forEach(f => assert.ok(fs.existsSync(path.join(DOCS, f)), `sw.js lists ${f}, which does not exist (the whole install would fail)`));
  const html = fs.readFileSync(path.join(DOCS, 'index.html'), 'utf8');
  // The launch images (apple-touch-startup-image) are read by iOS itself when the icon is added; the page never loads them.
  const loaded = html.replace(/<!-- splash:start[\s\S]*?<!-- splash:end -->/, '');
  [...loaded.matchAll(/(?:src|href)="\.\/([^"#?]+)"/g)].map(m => m[1]).forEach(f => assert.ok(shell.includes(f), `index.html loads ${f}, but sw.js does not save it`));
  fs.readdirSync(path.join(DOCS, 'art')).filter(f => /\.png$/.test(f)).forEach(f => assert.ok(shell.includes('art/' + f), `art/${f} is not saved by sw.js`));
  assert.ok(shell.includes('stations.json') && shell.includes('app.js'));
});

test('service worker: saves the whole app, removes older copies, then opens with no network at all', async t => {
  const dir = copyDocs('b1'), srv = await startServer(dir);
  try {
    // An older release left a copy behind: it must be gone once the new one is active.
    await t.p.addInitScript(() => { try { if (!sessionStorage.getItem('seeded')) { sessionStorage.setItem('seeded', '1'); caches.open('burzh-radio-old').then(c => c.put('/old', new Response('old'))); } } catch (e) { /* ignore */ } });
    await t.p.goto(srv.url);
    const st = await waitFor(async () => { const s = await swState(t.p); return s && s.active && s.controlled && s.files >= 21 && s.keys.length === 1 ? s : null; }, 12000, 300);
    assert.ok(st, 'the service worker should install and take over: ' + JSON.stringify(await swState(t.p)));
    assert.deepStrictEqual(st.keys, ['burzh-radio-b1'], 'older copies must be deleted');
    srv.close();                                              // the network is gone
    await t.p.reload();
    assert.ok(await waitFor(() => t.p.evaluate(() => !!(window.BURZH && window.BURZH.stations().length)), 8000), 'the app should open from the saved copy');
    assert.match(await t.p.evaluate(() => document.getElementById('versionState').textContent), /^v\d/);
  } finally { srv.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}, { sw: true });

test('service worker: a release that cannot be saved completely is not installed (nothing half-saved, the app still runs)', async t => {
  const dir = copyDocs('b1'), srv = await startServer(dir);
  try {
    fs.rmSync(path.join(dir, 'art', 'lofi.png'));             // one file of the release is missing
    await t.p.goto(srv.url);
    await sleep(3500);
    const st = await swState(t.p);
    assert.deepStrictEqual(st.keys, [], 'no half-saved copy may be left behind: ' + JSON.stringify(st));
    assert.strictEqual(st.controlled, false);
    assert.ok(await t.p.evaluate(() => !!(window.BURZH && window.BURZH.stations().length)), 'without a saved copy the app still loads from the network');
  } finally { srv.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}, { sw: true });

/* ------------------------------------------------------ app updates */

// A new release is saved in the background. The page switches to it only when that costs nothing:
// not while music plays, not while Settings are open. (Chromium delays real update checks by a minute after
// a registration, so the "new copy took control" signal is sent by hand; the service worker side is above.)
const newReleaseReady = page => page.evaluate(() => {
  window.__stay = 1;
  navigator.serviceWorker.dispatchEvent(new Event('controllerchange'));   // the first one only marks the first install
  navigator.serviceWorker.dispatchEvent(new Event('controllerchange'));
});
const reloaded = async (t, ms) => waitFor(async () => (await t.p.evaluate(() => window.__stay).catch(() => 'reloading')) === undefined, ms, 250);

test('app update: waits while music plays, switches when it is stopped', async t => {
  await t.play(); assert.ok(await t.live());
  await newReleaseReady(t.p);
  await sleep(1800);
  assert.strictEqual(await t.p.evaluate(() => window.__stay), 1, 'the page must not reload while music plays');
  assert.strictEqual((await t.dbg()).phase, 'live');
  await t.play();                                           // stop
  assert.ok(await reloaded(t, 6000), 'the page should switch to the new release once the music stops');
  assert.ok(await waitFor(() => t.p.evaluate(() => !!(window.BURZH && window.BURZH.stations().length)).catch(() => false), 8000), 'the new page should start');
});

test('app update: waits while Settings are open, switches when they close, and never reloads in a loop', async t => {
  await t.openSettings();
  await newReleaseReady(t.p);
  await sleep(1800);
  assert.strictEqual(await t.p.evaluate(() => window.__stay), 1, 'the page must not reload while Settings are open');
  await t.p.keyboard.press('Escape');
  assert.ok(await reloaded(t, 6000), 'the page should switch once Settings close');
  assert.ok(await waitFor(() => t.p.evaluate(() => !!(window.BURZH && window.BURZH.stations().length)).catch(() => false), 8000));
  await newReleaseReady(t.p);                               // another "new release" right away: no second reload within 30 s
  await sleep(1500);
  assert.strictEqual(await t.p.evaluate(() => window.__stay), 1, 'two reloads in a row are a loop');
});

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

/* ----------------------------------------------------------------- theme */

// Every visible piece of text must be readable on the colour it actually sits on, in every state of the
// screen. Catches a hard-coded colour that was left over from the other palette.
const contrastReport = (page, min) => page.evaluate(min => {
  const chan = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const lum = c => 0.2126 * chan(c[0]) + 0.7152 * chan(c[1]) + 0.0722 * chan(c[2]);
  const parse = css => { const m = css.match(/[\d.]+/g) || [0, 0, 0]; return { c: m.slice(0, 3).map(Number), a: m.length > 3 ? Number(m[3]) : 1 }; };
  const bgOf = el => {
    for (let e = el; e; e = e.parentElement) { const b = parse(getComputedStyle(e).backgroundColor); if (b.a > 0.9) return b.c; }
    return [255, 255, 255];
  };
  const faded = el => { let o = 1; for (let e = el; e; e = e.parentElement) o *= Number(getComputedStyle(e).opacity); return o < 0.9; };
  const bad = [];
  document.querySelectorAll('body *').forEach(el => {
    if (!el.getClientRects().length || faded(el) || /^(SCRIPT|STYLE|CANVAS|svg|path)$/i.test(el.tagName)) return;
    const own = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
    if (!own) return;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || Number(cs.fontSize.replace('px', '')) < 6) return;
    const fg = parse(cs.color).c, bg = bgOf(el);
    const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
    const ratio = (a + 0.05) / (b + 0.05);
    if (ratio < min) bad.push(`${el.tagName.toLowerCase()}.${el.className} "${el.textContent.trim().slice(0, 24)}" ${ratio.toFixed(2)}`);
  });
  return bad;
}, min);

const paintStats = (page, selector) => page.evaluate(sel => {
  const cv = [...document.querySelectorAll(sel)].find(c => c.offsetParent !== null && c.width > 20);
  if (!cv) return null;
  const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
  let dark = 0, bright = 0, red = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 150) continue;
    const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    if (d[i] > 150 && d[i + 1] < 110 && d[i + 2] < 110) red++;
    else if (l < 70) dark++;
    else if (l > 190) bright++;
  }
  return { dark, bright, red };
}, selector);

const themeState = t => t.p.evaluate(() => {
  const root = document.documentElement;
  return {
    white: root.classList.contains('theme-white'), night: root.classList.contains('night'),
    bg: getComputedStyle(document.body).backgroundColor,
    meta: document.querySelector('meta[name="theme-color"]').content,
    accent: root.style.getPropertyValue('--accent').trim().toLowerCase()
  };
});

test('white theme: paper palette, every text readable (settings tabs included)', async t => {
  const st = await themeState(t);
  assert.deepStrictEqual([st.white, st.night, st.bg, st.meta], [true, false, 'rgb(241, 241, 238)', '#F1F1EE'], 'paper background');
  assert.strictEqual(st.accent, '#cc2f26', 'the accent is a touch deeper on paper');
  let bad = await contrastReport(t.p, 4.0);
  assert.deepStrictEqual(bad, [], 'low contrast on the main screen:\n' + bad.join('\n'));
  await t.openSettings();
  for (const tab of ['sound', 'screen', 'about']) {
    await t.p.click('#tab-' + tab); await sleep(200);
    if (tab === 'sound') { await t.p.click('[data-switch="sound.on"]'); await sleep(900); }
    bad = await contrastReport(t.p, 4.0);
    assert.deepStrictEqual(bad, [], `low contrast in Settings / ${tab}:\n` + bad.join('\n'));
    await t.shot(`white-settings-${tab}.png`);
  }
  const seg = await t.p.locator('.seg[data-seg="theme"] button').allTextContents();
  assert.deepStrictEqual(seg, ['Black', 'White'], 'the Graphite option is gone');
}, { viewport: PORT, touch: true, scale: 2, settings: { theme: 'white' } });

test('black theme keeps readable text (guard against regressions from the token refactor)', async t => {
  const bad = await contrastReport(t.p, 3.0);
  assert.deepStrictEqual(bad, [], 'low contrast:\n' + bad.join('\n'));
  await t.openSettings();
  for (const tab of ['sound', 'screen', 'about']) {
    await t.p.click('#tab-' + tab); await sleep(150);
    const b = await contrastReport(t.p, 3.0);
    assert.deepStrictEqual(b, [], `low contrast in Settings / ${tab}:\n` + b.join('\n'));
  }
  const st = await themeState(t);
  assert.deepStrictEqual([st.white, st.bg, st.meta, st.accent], [false, 'rgb(5, 6, 6)', '#050606', '#ff3b30'], 'black palette untouched');
}, { viewport: PORT, touch: true, scale: 2 });

test('background switch: applies live, persists, night mode wins, old Graphite maps to White', async t => {
  await t.openSettings(); await t.p.click('#tab-screen');
  const pick = v => t.p.click(`.seg[data-seg="theme"] button[data-value="${v}"]`);
  const night = v => t.p.click(`.seg[data-seg="night"] button[data-value="${v}"]`);
  let st = await themeState(t);
  assert.deepStrictEqual([st.white, st.bg, st.meta], [true, 'rgb(241, 241, 238)', '#F1F1EE'], 'Graphite is shown as White');
  assert.strictEqual(await t.p.getAttribute('.seg[data-seg="theme"] button[data-value="white"]', 'aria-pressed'), 'true');

  await pick('black'); await sleep(150); st = await themeState(t);
  assert.deepStrictEqual([st.white, st.bg, st.meta, st.accent], [false, 'rgb(5, 6, 6)', '#050606', '#ff3b30'], 'black applied live');
  await pick('white'); await sleep(150); st = await themeState(t);
  assert.deepStrictEqual([st.white, st.bg, st.meta, st.accent], [true, 'rgb(241, 241, 238)', '#F1F1EE', '#cc2f26'], 'white applied live');
  assert.strictEqual(await t.p.evaluate(() => JSON.parse(localStorage.getItem('burzh.radio.settings.v1')).theme), 'white', 'saved');

  await night('on'); await sleep(150); st = await themeState(t);
  assert.deepStrictEqual([st.night, st.bg, st.meta, st.accent], [true, 'rgb(0, 0, 0)', '#000000', '#ff3b30'], 'night mode is black even on the White background');
  await night('off'); await sleep(150); st = await themeState(t);
  assert.deepStrictEqual([st.night, st.white, st.meta], [false, true, '#F1F1EE'], 'back to paper');

  await t.p.reload(); await waitFor(() => t.p.evaluate(() => !!window.BURZH), 6000);
  st = await themeState(t);
  assert.deepStrictEqual([st.white, st.bg], [true, 'rgb(241, 241, 238)'], 'White survives a reload');
}, { viewport: PORT, touch: true, scale: 2, settings: { theme: 'graphite' } });

test('white theme is applied before the app script runs (no black flash)', async t => {
  const p2 = await t.ctx.newPage();
  await p2.route('**/app.js', r => r.abort());
  await p2.goto(t.p.url(), { waitUntil: 'domcontentloaded' });
  const r = await p2.evaluate(() => ({ white: document.documentElement.classList.contains('theme-white'), bg: getComputedStyle(document.body).backgroundColor, meta: document.querySelector('meta[name="theme-color"]').content }));
  assert.deepStrictEqual(r, { white: true, bg: 'rgb(241, 241, 238)', meta: '#F1F1EE' });
  await p2.close();
}, { viewport: PORT, settings: { theme: 'white' } });

test('canvases follow the theme: planet and equalizer are drawn in ink on white, in light on black', async t => {
  await t.play(); await t.live(); await sleep(1500);
  let w = await paintStats(t.p, '[data-planet] canvas');
  assert.ok(w && w.dark > 300, 'on White the planet is drawn with dark dots: ' + JSON.stringify(w));
  assert.ok(w.bright < w.dark / 10, 'and no longer with light ones: ' + JSON.stringify(w));
  assert.ok(w.red > 5, 'the comet stays red: ' + JSON.stringify(w));
  await t.openSettings(); await t.p.click('[data-switch="sound.on"]'); await sleep(900);
  await t.p.locator('#eqCanvas').scrollIntoViewIfNeeded(); await sleep(300);
  let e = await paintStats(t.p, '#eqCanvas');
  assert.ok(e && e.dark > 100, 'EQ curve and handles are ink on White: ' + JSON.stringify(e));
  await t.p.click('#tab-screen'); await t.p.click('.seg[data-seg="theme"] button[data-value="black"]'); await sleep(600);
  await t.p.click('[data-close]'); await sleep(500);
  w = await paintStats(t.p, '[data-planet] canvas');
  assert.ok(w && w.bright > 300, 'switching to Black repaints the planet in light dots: ' + JSON.stringify(w));
  assert.ok(w.dark < w.bright / 10, 'without ink left over: ' + JSON.stringify(w));
}, { viewport: PORT, touch: true, scale: 2, settings: { theme: 'white' } });

/* ------------------------------------------------- station character */

const wcag = (a, b) => {
  const lum = hex => { const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4))); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const stationsFile = () => JSON.parse(fs.readFileSync(path.join(DOCS, 'stations.json'), 'utf8'));
const visiblePlanet = t => t.p.evaluate(() => (window.BURZH.planets().find(p => p.drawn) || null));
const hexToRgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const clickStation = (t, id) => t.p.evaluate(sid => document.querySelector(`button[data-station="${sid}"]`).click(), id);

test('every station has its own colour and character, readable on Black and on White, in step with the validator', async t => {
  const data = stationsFile();
  const accents = data.stations.map(s => s.accent.toLowerCase());
  assert.strictEqual(new Set(accents).size, accents.length, 'every station has its own accent: ' + accents);
  assert.strictEqual(new Set(data.stations.map(s => JSON.stringify(s.look))).size, data.stations.length, 'every station has its own look');
  data.stations.forEach(s => {
    assert.ok(wcag(s.accent, '#050606') >= 4.5, `${s.id}: accent ${s.accent} on Black is ${wcag(s.accent, '#050606').toFixed(2)}`);
    assert.ok(s.accentPaper, `${s.id}: needs accentPaper`);
    [['#f1f1ee', 'page'], ['#fafaf8', 'card']].forEach(([bg, what]) => assert.ok(wcag(s.accentPaper, bg) >= 4.5, `${s.id}: accentPaper ${s.accentPaper} on the White ${what} is ${wcag(s.accentPaper, bg).toFixed(2)}`));
  });
  // The ranges in tools/radio.py (validator) and docs/planet.js (what the planet accepts) are one table.
  const py = JSON.parse(require('child_process').execFileSync('python3', ['-c', 'import json,sys; sys.path.insert(0,"tools"); import radio; print(json.dumps(radio.LOOK_LIMITS))'], { cwd: path.join(DOCS, '..') }).toString());
  const page = await t.p.evaluate(() => window.BurzhPlanet.LIMITS);
  assert.deepStrictEqual(page, py, 'LIMITS in planet.js and LOOK_LIMITS in tools/radio.py must match');
  data.stations.forEach(s => Object.entries(s.look).forEach(([k, v]) => assert.ok(k in page && v >= page[k][0] && v <= page[k][1], `${s.id}: look.${k}=${v} is out of range`)));

  // Tuning: the page takes the station's colour, and the planet glides to its look and colour.
  for (const s of data.stations) {
    await clickStation(t, s.id);
    assert.strictEqual(await t.p.evaluate(() => document.documentElement.style.getPropertyValue('--accent').trim().toLowerCase()), s.accent.toLowerCase(), s.id + ' accent');
    const want = await t.p.evaluate(look => window.BurzhPlanet.look(look), s.look);
    const got = await waitFor(async () => {
      const pl = await visiblePlanet(t);
      const close = pl && Object.keys(want).every(k => k === 'grain' || k === 'land' || Math.abs(pl.look[k] - want[k]) < 0.03);
      return close && pl.accent.every((v, i) => Math.abs(v - hexToRgb(s.accent)[i]) <= 3) ? pl : null;
    }, 5000, 150);
    assert.ok(got, `${s.id}: the planet should glide to its look and colour: ` + JSON.stringify(await visiblePlanet(t)));
    assert.strictEqual(got.grain, want.grain, s.id + ' grain');
    assert.ok(got.points > 100, 'the globe has dots');
  }
}, { viewport: PORT, touch: true });

test('White uses each station\'s paper colour', async t => {
  for (const s of stationsFile().stations) {
    await clickStation(t, s.id);
    assert.strictEqual(await t.p.evaluate(() => document.documentElement.style.getPropertyValue('--accent').trim().toLowerCase()), s.accentPaper.toLowerCase(), s.id + ' paper accent');
  }
}, { viewport: PORT, touch: true, settings: { theme: 'white' } });

test('planet: a kick in the music sends a ring out; nothing without a real signal; nothing in calm mode', async t => {
  const r = await t.p.evaluate(async () => {
    const sleep = ms => new Promise(res => setTimeout(res, ms));
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;left:0;top:0;width:300px;height:300px;z-index:-1';
    document.body.appendChild(box);
    window.__lv = 0.05; window.__calm = false;
    const pl = window.BurzhPlanet.create(box, { getLevel: () => window.__lv, calm: () => window.__calm });
    pl.setStation(window.BURZH.stations()[2], 2, 4, { instant: true });
    pl.setPlaying(true);
    await sleep(500);
    const beat = async n => { for (let i = 0; i < n; i++) { window.__lv = 0.05; await sleep(420); window.__lv = 0.9; await sleep(160); } window.__lv = 0.05; await sleep(200); };
    const out = { start: pl.state().kickCount };
    await beat(6); out.beats = pl.state().kickCount - out.start;
    out.visible = pl.state().kicks;
    const before = pl.state().kickCount;
    window.__lv = null; await sleep(2400); out.noSignal = pl.state().kickCount - before;   // the engine is off: only the slow breathing
    window.__lv = 0.05; window.__calm = true; await sleep(400);
    const b2 = pl.state().kickCount; await beat(4); out.calm = pl.state().kickCount - b2;
    out.calmState = pl.state().calm;
    pl.destroy(); box.remove();
    return out;
  });
  assert.ok(r.beats >= 5 && r.beats <= 8, 'six kicks should make about six rings: ' + JSON.stringify(r));
  assert.ok(r.visible >= 0 && r.visible <= 5, 'at most five rings at once: ' + JSON.stringify(r));
  assert.strictEqual(r.noSignal, 0, 'no rings without a real level: ' + JSON.stringify(r));
  assert.strictEqual(r.calm, 0, 'no rings in calm mode: ' + JSON.stringify(r));
  assert.strictEqual(r.calmState, true);
}, { viewport: PORT, touch: true });

test('planet glow fades out before the edge of its canvas (no straight line on any station, at full music level)', async t => {
  const r = await t.p.evaluate(async () => {
    const sleep = ms => new Promise(res => setTimeout(res, ms));
    const out = [];
    const stations = window.BURZH.stations();
    for (const [bw, bh] of [[400, 400], [520, 380], [300, 340]]) {
      const box = document.createElement('div');
      box.style.cssText = `position:fixed;left:0;top:0;width:${bw}px;height:${bh}px;z-index:-1`;
      document.body.appendChild(box);
      window.__lv = 0.95;
      const pl = window.BurzhPlanet.create(box, { getLevel: () => window.__lv });
      pl.setPlaying(true);
      for (let i = 0; i < stations.length; i++) {
        pl.setStation(stations[i], i, stations.length, { instant: true });
        await sleep(700);                                   // glow and level come up
        const cv = box.querySelector('canvas');
        const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
        const edges = { left: [], right: [], top: [], bottom: [] };
        for (let y = 0; y < cv.height; y++) { edges.left.push(d[(y * cv.width) * 4 + 3]); edges.right.push(d[(y * cv.width + cv.width - 1) * 4 + 3]); }
        for (let x = 0; x < cv.width; x++) { edges.top.push(d[x * 4 + 3]); edges.bottom.push(d[((cv.height - 1) * cv.width + x) * 4 + 3]); }
        // share of the edge that is visibly tinted (a few stray star pixels are fine, a cut-off glow is a long run)
        const tinted = a => a.filter(v => v > 3).length / a.length;
        const glowAtCentre = d[((cv.height >> 1) * cv.width + (cv.width >> 1)) * 4 + 3];
        out.push({ box: bw + 'x' + bh, id: stations[i].id, left: tinted(edges.left), right: tinted(edges.right), top: tinted(edges.top), bottom: tinted(edges.bottom), centre: glowAtCentre });
      }
      pl.destroy(); box.remove();
    }
    return out;
  });
  assert.strictEqual(r.length, 12);
  r.forEach(x => {
    assert.ok(x.centre > 0, `${x.id} ${x.box}: something is drawn`);
    ['left', 'right', 'top', 'bottom'].forEach(side => assert.ok(x[side] <= 0.1, `${x.id} ${x.box}: the glow reaches the ${side} edge of the canvas along ${Math.round(x[side] * 100)} % of it: it shows as a straight line`));
  });
}, { viewport: PORT, touch: true });

/* ------------------------------------------------------- reduce motion */

const motionState = t => t.p.evaluate(() => ({
  calm: document.documentElement.classList.contains('calm'), api: window.BURZH.calm(),
  anim: parseFloat(getComputedStyle(document.querySelector('.soft-colon i')).animationDuration) * (/ms$/.test(getComputedStyle(document.querySelector('.soft-colon i')).animationDuration) ? 0.001 : 1),
  planet: window.BURZH.planets().find(p => p.drawn) || null
}));

test('reduce motion: follows the phone, can be switched on or off in Settings, stills the planet and the animations', async t => {
  let m = await motionState(t);
  assert.strictEqual(m.calm, false, 'normal motion by default');
  assert.ok(m.anim > 1, 'the colon breathes: ' + m.anim);

  await t.p.emulateMedia({ reducedMotion: 'reduce' });                    // iPhone: Accessibility → Motion → Reduce Motion
  m = await waitFor(async () => { const x = await motionState(t); return x.calm ? x : null; }, 4000, 100) || await motionState(t);
  assert.deepStrictEqual([m.calm, m.api], [true, true], 'Auto follows the phone');
  assert.ok(m.anim < 0.01, 'CSS animations are stilled: ' + m.anim);
  await t.play(); assert.ok(await t.live());
  await sleep(600);
  const a = (await motionState(t)).planet; await sleep(900); const b = (await motionState(t)).planet;
  assert.strictEqual(a.calm, true);
  assert.strictEqual(a.spin, b.spin, 'the planet does not turn');
  assert.strictEqual(b.omega, 0); assert.strictEqual(b.orbitRate, 0);
  assert.strictEqual(b.kicks, 0, 'no rings');

  await t.openSettings(); await t.p.click('#tab-screen');
  await t.p.click('.seg[data-seg="motion"] button[data-value="off"]'); await sleep(250);
  m = await motionState(t);
  assert.deepStrictEqual([m.calm, m.api], [false, false], 'Off wins over the phone setting');
  assert.ok(m.anim > 1, 'animations are back');
  await sleep(700);
  const c = (await motionState(t)).planet; await sleep(700); const d = (await motionState(t)).planet;
  assert.ok(Math.abs(d.spin - c.spin) > 0.01, 'the planet turns again');

  await t.p.emulateMedia({ reducedMotion: 'no-preference' }); await sleep(1300);
  await t.p.click('.seg[data-seg="motion"] button[data-value="on"]'); await sleep(250);
  m = await motionState(t);
  assert.deepStrictEqual([m.calm, m.api], [true, true], 'On works with a normal phone');
  assert.strictEqual(await t.p.getAttribute('.seg[data-seg="motion"] button[data-value="on"]', 'aria-pressed'), 'true');
  assert.strictEqual(await t.p.evaluate(() => JSON.parse(localStorage.getItem('burzh.radio.settings.v1')).motion), 'on', 'saved');
  await t.p.reload(); await waitFor(() => t.p.evaluate(() => !!(window.BURZH && window.BURZH.stations().length)), 8000);
  assert.strictEqual((await motionState(t)).calm, true, 'and kept after a relaunch');
}, { viewport: PORT, touch: true });

test('reduce motion is applied before the app script runs (no animation frame of motion)', async t => {
  const p2 = await t.ctx.newPage();
  await p2.route('**/app.js', r => r.abort());
  await p2.emulateMedia({ reducedMotion: 'reduce' });
  await p2.goto(t.p.url(), { waitUntil: 'domcontentloaded' });
  assert.strictEqual(await p2.evaluate(() => document.documentElement.classList.contains('calm')), true);
  await p2.close();
}, { viewport: PORT });

/* ------------------------------------------------ icon shortcuts, launch */

test('app-icon shortcuts: the manifest lists the stations; ?station= opens one and leaves the address clean', async t => {
  const manifest = JSON.parse(fs.readFileSync(path.join(DOCS, 'manifest.webmanifest'), 'utf8'));
  const data = stationsFile();
  assert.ok(manifest.shortcuts && manifest.shortcuts.length >= 1 && manifest.shortcuts.length <= 4, 'one to four shortcuts (Android shows four)');
  manifest.shortcuts.forEach(sc => {
    const m = /^\.\/\?station=([a-z0-9-]+)$/.exec(sc.url);
    assert.ok(m, 'shortcut url: ' + sc.url);
    const st = data.stations.find(x => x.id === m[1]);
    assert.ok(st, 'shortcut for an unknown station ' + m[1]);
    assert.strictEqual(sc.name, st.name);
    sc.icons.forEach(i => assert.ok(fs.existsSync(path.join(DOCS, i.src)), 'shortcut icon ' + i.src));
  });
  assert.strictEqual(manifest.shortcuts[0].url.endsWith(data.stations.find(s => s.items.length).id), true, 'stations with music come first');
  assert.ok(manifest.icons.length >= 3 && manifest.background_color === '#050606', 'manifest keeps its icons and the dark launch colour');

  const open = async q => {
    await t.p.goto(new URL(q, t.p.url()).href);
    await waitFor(() => t.p.evaluate(() => !!(window.BURZH && window.BURZH.stations().length)), 8000);
    await sleep(300);
    return t.p.evaluate(() => ({ station: window.BURZH.debug().station, search: location.search, saved: localStorage.getItem('burzh.radio.station.v1'), name: document.querySelector('[data-bind="station"]').textContent, status: document.querySelector('.p-live [data-bind="status"]').textContent }));
  };
  let r = await open('?station=trance');
  assert.strictEqual(r.station, 'trance'); assert.strictEqual(r.search, '', 'the address is clean'); assert.strictEqual(JSON.parse(r.saved), 'trance', 'remembered');
  r = await open('?station=lofi');
  assert.strictEqual(r.station, 'lofi'); assert.strictEqual(r.status, 'OFF AIR', 'a station without music opens and says so');
  r = await open('?station=deep-house');
  assert.strictEqual(r.station, 'deep-house');
  r = await open('?station=no-such-station');
  assert.strictEqual(r.search, ''); assert.strictEqual(r.station, 'deep-house', 'an unknown id changes nothing');
  await t.play(); assert.ok(await t.live(), 'and the station opened from a shortcut plays');
}, { viewport: PORT, touch: true });

/* ----------------------------------------------------------- launch images */

test('launch images: every iPhone size, both orientations and appearances, right dimensions, dark launch colour', async () => {
  const html = fs.readFileSync(path.join(DOCS, 'index.html'), 'utf8');
  const links = [...html.matchAll(/<link rel="apple-touch-startup-image" media="([^"]+)" href="\.\/([^"]+)">/g)].map(m => ({ media: m[1], file: m[2] }));
  assert.ok(links.length >= 24, 'launch images are declared: ' + links.length);
  const seen = new Set();
  const png = f => { const b = fs.readFileSync(path.join(DOCS, f)); assert.strictEqual(b.toString('latin1', 1, 4), 'PNG', f + ' is a PNG'); return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), size: b.length }; };
  let bytes = 0;
  links.forEach(({ media, file }) => {
    const m = /device-width: (\d+)px\) and \(device-height: (\d+)px\) and \(-webkit-device-pixel-ratio: (\d)\) and \(orientation: (portrait|landscape)\) and \(prefers-color-scheme: (dark|light)\)/.exec(media);
    assert.ok(m, 'media query: ' + media);
    const [, w, h, dpr, orient, scheme] = m;
    const want = orient === 'portrait' ? [w * dpr, h * dpr] : [h * dpr, w * dpr];
    const g = png(file); bytes += g.size;
    assert.deepStrictEqual([g.w, g.h], want, `${file} must be ${want.join('x')} for ${media}`);
    seen.add([w, h, dpr, orient, scheme].join('/'));
  });
  // every device has all four variants
  const devices = new Set(links.map(l => /device-width: (\d+)px\) and \(device-height: (\d+)px\) and \(-webkit-device-pixel-ratio: (\d)/.exec(l.media).slice(1).join('/')));
  devices.forEach(d => ['portrait', 'landscape'].forEach(o => ['dark', 'light'].forEach(c => assert.ok(seen.has(`${d}/${o}/${c}`), `${d} is missing ${o} ${c}`))));
  assert.ok(bytes < 2.5e6, 'launch images stay small: ' + Math.round(bytes / 1024) + ' KB');
  // the files in docs/splash are exactly the declared ones (nothing stale)
  assert.deepStrictEqual(fs.readdirSync(path.join(DOCS, 'splash')).sort(), links.map(l => l.file.replace('splash/', '')).sort());
  assert.ok(/<meta name="apple-mobile-web-app-capable" content="yes">/.test(html));
});

/* ------------------------------------------------------ station selector */

const dialReport = t => t.p.evaluate(() => {
  const chan = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const lum = c => 0.2126 * chan(c[0]) + 0.7152 * chan(c[1]) + 0.0722 * chan(c[2]);
  const rgb = css => (css.match(/[\d.]+/g) || [0, 0, 0]).slice(0, 3).map(Number);
  const bg = rgb(getComputedStyle(document.body).backgroundColor);
  return [...document.querySelectorAll('.dial button')].map(b => {
    let op = 1; for (let e = b; e; e = e.parentElement) op *= Number(getComputedStyle(e).opacity);
    const fg = rgb(getComputedStyle(b).color).map((v, i) => v * op + bg[i] * (1 - op));      // what the eye sees
    const [hi, lo] = [lum(fg), lum(bg)].sort((x, y) => y - x);
    return { id: b.dataset.station, off: b.classList.contains('off'), active: b.classList.contains('active'), ratio: (hi + 0.05) / (lo + 0.05), tag: getComputedStyle(b, '::after').content };
  });
});

for (const theme of ['black', 'white']) {
  test(`landscape station dial (${theme}): inactive stations stay readable, stations without music say "soon", also when the screen goes idle`, async t => {
    for (const idle of [false, true]) {
      if (idle) { await t.p.evaluate(() => document.documentElement.classList.add('idle')); await sleep(1200); }
      const rep = await dialReport(t);
      assert.strictEqual(rep.length, 4);
      rep.forEach(r => {
        assert.ok(r.ratio >= 4.5, `${r.id} reads at ${r.ratio.toFixed(2)}:1 (idle ${idle})`);
        assert.strictEqual(r.tag === '"soon"', r.off, `${r.id}: the "soon" tag belongs to stations without music only (${r.tag})`);
      });
    }
  }, { viewport: LAND, settings: { theme } });
}

/* ----------------------------------------------------- portrait fitting */

for (const [w, h] of [[375, 667], [390, 844], [393, 852], [430, 932], [402, 874], [360, 740], [320, 568]]) {
  test(`portrait ${w}x${h}: the blocks stack without overlap and the planet takes the room that is left`, async t => {
    const m = await t.p.evaluate(() => {
      const box = sel => { const e = document.querySelector(sel); if (!e || getComputedStyle(e).display === 'none') return null; const r = e.getBoundingClientRect(); return { t: r.top, b: r.bottom, l: r.left, r: r.right, w: r.width, h: r.height }; };
      const blocks = ['.p-logo', '.stations', '.p-artwrap', '.p-caption', '.p-meta', '.p-live', '.p-controls', '.p-footer'].map(s => [s, box(s)]);
      return { blocks, card: box('.p-artwrap .art-frame'), menu: box('.p-menu'), iw: innerWidth, ih: innerHeight, sw: document.scrollingElement.scrollWidth, sh: document.scrollingElement.scrollHeight, tag: document.querySelector('.p-caption').scrollWidth - document.querySelector('.p-caption').clientWidth };
    });
    let prev = null;
    m.blocks.filter(([, b]) => b).forEach(([name, b]) => {
      assert.ok(b.l >= -1 && b.r <= m.iw + 1 && b.b <= m.ih + 1 && b.t >= -1, `${name} is outside the screen: ${JSON.stringify(b)}`);
      if (prev && name !== '.p-menu') assert.ok(b.t >= prev[1].b - 1, `${name} (top ${b.t.toFixed(1)}) overlaps ${prev[0]} (bottom ${prev[1].b.toFixed(1)})`);
      prev = [name, b];
    });
    assert.ok(m.sh <= m.ih + 1 && m.sw <= m.iw + 1, 'no scrolling');
    const art = m.blocks.find(([n]) => n === '.p-artwrap')[1];
    assert.ok(m.card.t >= art.t - 1 && m.card.b <= art.b + 1, 'the planet card stays inside its area');
    const room = Math.min(0.86 * art.w, art.h);
    assert.ok(m.card.w >= room * 0.97, `the planet card should use the room: ${m.card.w.toFixed(0)} of ${room.toFixed(0)}`);
    assert.ok(m.card.w >= m.iw * 0.5, 'the planet card is at least half the screen wide: ' + m.card.w.toFixed(0));
    assert.ok(m.tag <= 1, 'the caption fits on one line');
    await t.shot(`portrait-fit-${w}x${h}.png`);
  }, { viewport: { width: w, height: h }, touch: true });
}

/* --------------------------------------------------------------- layouts */

for (const [theme, w, h] of [['black', 932, 430], ['black', 667, 375], ['black', 844, 390], ['black', 1180, 820], ['black', 390, 844], ['black', 375, 667],
                              ['white', 932, 430], ['white', 667, 375], ['white', 390, 844], ['white', 375, 667]]) {
  test(`layout ${w}x${h} (${theme}): fits the screen, controls visible`, async t => {
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
    await t.shot(`layout-${theme === 'white' ? 'white-' : ''}${w}x${h}.png`);
  }, { viewport: { width: w, height: h }, settings: { theme } });
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
