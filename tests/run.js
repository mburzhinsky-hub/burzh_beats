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
  await t.p.click('[data-sseg="mode"] button[data-value="manual"]');     // the mock "music" is a bare tone: smart mode would (rightly) retune it
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

/* ---------------------------------------------------- smart sound (docs/smart.js, sound.js) */

// The brain is plain arithmetic: it is tested against numbers, the way a mastering engineer would check it.
test('smart sound (the brain): balanced music is left alone, thin / dull / muddy music is corrected within limits', async () => {
  const Smart = require('../docs/smart.js');
  const N = Smart.N, T = Smart.normalise(Smart.PROFILES.neutral);
  const powers = db => Float64Array.from(db, v => Math.pow(10, v / 10));
  const run = (bandsDb, { secs = 40, strength = 0.7, profile = 'neutral', rms = -14, peak = -6, crest = 7, sideMid = -9 } = {}) => {
    const b = Smart.createBrain(), p = powers(bandsDb);
    let plan, G = 0;
    for (let t = 0; t < secs; t += 0.125) {
      b.feed({ powers: p, crestDb: crest, sideMidDb: sideMid }, 0.125);
      plan = b.plan(strength, profile, 0.125);
      G = b.level({ rmsDb: rms + G, peakDb: peak + G }, strength, 0.125);
    }
    return { plan, G, b };
  };
  const all = (a, f) => a.every(f);

  const ref = run(T);
  assert.ok(all(ref.plan.gains, g => Math.abs(g) < 0.3), 'balanced music: no tone correction ' + ref.plan.gains.map(g => g.toFixed(1)));
  assert.ok(Math.abs(ref.G) < 0.5, 'balanced music at the target level: no level change ' + ref.G.toFixed(2));
  assert.ok(ref.plan.bass < 3 && ref.plan.clarity < 3 && ref.plan.width === 0 && ref.plan.glue === 0, 'nothing extra added');

  const dull = run(T.map((v, i) => (i >= 5 ? v - 4 * (i - 4) : v)));
  assert.ok(dull.plan.gains[7] >= 2.5 && dull.plan.gains[6] >= 2 && dull.plan.clarity >= 8, 'dull: the top is lifted ' + dull.plan.gains.map(g => g.toFixed(1)));
  assert.ok(Math.abs(dull.plan.gains[1]) < 0.8 && Math.abs(dull.plan.gains[2]) < 0.8, 'dull: the middle is left alone');

  const thin = run(T.map((v, i) => (i === 0 ? v - 14 : i === 1 ? v - 7 : v)));
  assert.ok(thin.plan.gains[0] >= 3.5 && thin.plan.bass >= 10, 'thin: the bass is lifted and its harmonics added ' + thin.plan.gains.map(g => g.toFixed(1)));

  const muddy = run(T.map((v, i) => (i === 2 || i === 3 ? v + 7 : v)));
  assert.ok(muddy.plan.gains[2] <= -1.5 && muddy.plan.gains[3] <= -1.5, 'muddy: the low mids are lowered ' + muddy.plan.gains.map(g => g.toFixed(1)));
  assert.ok(Math.abs(muddy.plan.gains[5]) < 0.8, 'muddy: the rest is left alone');

  // Limits, whatever the music: never more than the caps, strength 0 does nothing, a bare tone is not judged.
  const extreme = run(T.map((v, i) => (i < 4 ? v + 25 : v - 25)), { strength: 1 });
  extreme.plan.gains.forEach((g, i) => assert.ok(g <= Smart.CAP_UP[i] + 1e-6 && g >= -Smart.CAP_DOWN[i] - 1e-6, `band ${i} within its cap: ${g}`));
  assert.ok(all(run(T.map((v, i) => (i >= 5 ? v - 12 : v)), { strength: 0 }).plan.gains, g => g === 0), 'strength 0 changes nothing');
  const tone = run(T.map((v, i) => (i === 1 ? 0 : -90)));
  assert.ok(all(tone.plan.gains, g => Math.abs(g) < 1e-9) && tone.plan.bass === 0, 'a bare tone is not judged');

  // Quiet, it listens to nothing: silence teaches it nothing and moves nothing.
  const b = Smart.createBrain();
  for (let t = 0; t < 10; t += 0.125) { b.plan(0.7, 'neutral', 0.125); b.level({ rmsDb: -80, peakDb: -70 }, 0.7, 0.125); }
  assert.ok(all(b.last.gains, g => g === 0) && b.gain === 0, 'silence: nothing moves');

  // Slow: once it has learned, a sudden change of music moves a band by well under a decibel per second.
  const steady = run(T, { secs: 40 });
  const before = steady.plan.gains.slice();
  const dullPow = powers(T.map((v, i) => (i >= 5 ? v - 4 * (i - 4) : v)));
  for (let t = 0; t < 1; t += 0.125) { steady.b.feed({ powers: dullPow, crestDb: 7, sideMidDb: -9 }, 0.125); steady.plan = steady.b.plan(0.7, 'neutral', 0.125); }
  steady.plan.gains.forEach((g, i) => assert.ok(Math.abs(g - before[i]) <= 0.7 + 1e-6, `band ${i} moved ${(g - before[i]).toFixed(2)} dB in a second`));

  // Level: a quiet source is lifted, a hot one is lowered, both by no more than the limits; peaks leave room.
  const quiet = run(T, { rms: -30, peak: -22, secs: 90 });
  assert.ok(quiet.G > 2 && quiet.G <= 4 * 0.7 + 1e-6, 'quiet source lifted, within the limit: ' + quiet.G.toFixed(1));
  const intro = run(T, { rms: -30, peak: -22, secs: 12 });
  assert.ok(intro.G <= 2.5, 'a quiet intro earns only a small lift before the music shows itself: ' + intro.G.toFixed(1));
  const hot = run(T, { rms: -6, peak: 1, secs: 90 });
  assert.ok(hot.G < -4 && hot.G >= -10 * 0.7 - 1e-6, 'hot source lowered, within the limit: ' + hot.G.toFixed(1));
  const peaky = run(T, { rms: -26, peak: -2, secs: 90 });
  assert.ok(peaky.G <= 4.01, 'a peaky quiet source is not lifted into the limiter: ' + peaky.G.toFixed(1));
  // A quiet intro followed by a drop: the intro earns a small lift, and the drop is pulled back within seconds.
  const drop = Smart.createBrain(); let Gd = 0, at6 = null, maxUp = 0;
  for (let t = 0; t < 50; t += 0.125) {
    const inRms = t < 25 ? -26 : -12;
    drop.feed({ powers: powers(T) }, 0.125); drop.plan(0.7, 'neutral', 0.125);
    Gd = drop.level({ rmsDb: inRms + Gd, peakDb: inRms + 9 + Gd }, 0.7, 0.125);
    if (t < 25) maxUp = Math.max(maxUp, Gd);
    if (t >= 31 && at6 === null) at6 = inRms + Gd;
  }
  assert.ok(maxUp <= 4 * 0.7 + 1e-6, 'the intro is lifted by no more than the cap: ' + maxUp.toFixed(1));
  assert.ok(at6 <= -12 + 0.5, 'six seconds after the drop it is not louder than the music itself: ' + at6.toFixed(1) + ' dB');
  const settle = Smart.createBrain(); let G = 0, last = 0;
  for (let t = 0; t < 120; t += 0.125) { settle.feed({ powers: powers(T) }, 0.125); G = settle.level({ rmsDb: -18 + G, peakDb: -9 + G }, 1, 0.125); if (t > 100) last = Math.max(last, Math.abs(G - settle.gain)); }
  assert.ok(Math.abs(-18 + G - Smart.LEVEL_TARGET) < 0.6, 'the level settles on the target: ' + (-18 + G).toFixed(2));

  // Targets follow the kind of music (the station's sound preset).
  assert.deepStrictEqual(['club', 'warm', 'deep', 'wide', 'whatever'].map(Smart.profileFor), ['bright', 'dark', 'neutral', 'neutral', 'neutral']);
  const sum = db => db.reduce((s, v) => s + Math.pow(10, v / 10), 0);
  Object.values(Smart.PROFILES).forEach(pr => assert.ok(Math.abs(sum(Smart.normalise(pr)) - 1) < 1e-9, 'a target adds up to the whole signal'));
});

// The engine, with real audio: noise with a chosen spectrum goes through the real Web Audio chain.
test('smart sound (the engine): dull, thin and loud music is corrected through the real chain; silence and strength 0 do nothing', async t => {
  const Smart = require('../docs/smart.js');
  const res = await t.p.evaluate(async profiles => {
    const EDGES = [20, 99, 198, 396, 792, 1585, 3170, 6340, 11200, 20000];
    const fft = (re, im) => {
      const n = re.length;
      for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
      for (let len = 2; len <= n; len <<= 1) {
        const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
        for (let i = 0; i < n; i += len) { let cr = 1, ci = 0; for (let k = 0; k < len / 2; k++) {
          const a = i + k, b = i + k + len / 2, vr = re[b] * cr - im[b] * ci, vi = re[b] * ci + im[b] * cr;
          re[b] = re[a] - vr; im[b] = im[a] - vi; re[a] += vr; im[a] += vi;
          const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr; } }
      }
      for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
    };
    // Stereo noise whose band energies (dB, relative) are `bandDb`, scaled to a mid-channel RMS of `rmsDb`.
    const noise = (sr, bandDb, rmsDb) => {
      const n = 1 << Math.ceil(Math.log2(sr * 6)), chans = [];
      for (let c = 0; c < 2; c++) {
        const re = new Float64Array(n), im = new Float64Array(n);
        let seed = 7919 * 3 + c * 104729;
        const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
        for (let k = 1; k < n / 2; k++) {
          const f = k * sr / n; let b = -1;
          for (let i = 0; i < 9; i++) if (f >= EDGES[i] && f < EDGES[i + 1]) b = i;
          if (b < 0) continue;
          const amp = Math.sqrt(Math.pow(10, bandDb[b] / 10) / (EDGES[b + 1] - EDGES[b])), ph = rnd() * 2 * Math.PI;
          re[k] = amp * Math.cos(ph); im[k] = amp * Math.sin(ph); re[n - k] = re[k]; im[n - k] = -im[k];
        }
        fft(re, im); chans.push(re);
      }
      let sq = 0; for (let i = 0; i < n; i++) { const m = (chans[0][i] + chans[1][i]) / 2; sq += m * m; }
      const k = rmsDb <= -120 ? 0 : Math.pow(10, rmsDb / 20) / Math.sqrt(sq / n);
      const buf = new AudioBuffer({ length: n, numberOfChannels: 2, sampleRate: sr });
      for (let c = 0; c < 2; c++) { const d = buf.getChannelData(c); for (let i = 0; i < n; i++) d[i] = chans[c][i] * k; }
      return buf;
    };
    const N = profiles.neutral;
    const scenarios = {
      reference: { b: N, rms: -14 },
      dull: { b: N.map((v, i) => (i >= 5 ? v - 4 * (i - 4) : v)), rms: -14 },
      thin: { b: N.map((v, i) => (i === 0 ? v - 14 : i === 1 ? v - 7 : v)), rms: -14 },
      hot: { b: N, rms: -5 },
      silence: { b: N, rms: -150 },
      dullOff: { b: N.map((v, i) => (i >= 5 ? v - 4 * (i - 4) : v)), rms: -14, strength: 0 }
    };
    const out = {};
    for (const [name, sc] of Object.entries(scenarios)) {
      const eng = window.BurzhSound.create();
      const { ctx, node } = eng.input();
      await ctx.resume();
      eng.timeScale = 8;
      eng.apply(window.BurzhSound.clone(window.BurzhSound.PRESETS.flat.p), true);
      eng.setSmart({ on: true, strength: sc.strength == null ? 0.7 : sc.strength, profile: 'neutral' });
      const src = ctx.createBufferSource(); src.buffer = noise(ctx.sampleRate, sc.b, sc.rms); src.loop = true; src.connect(node); src.start();
      await new Promise(r => setTimeout(r, 4200));
      out[name] = { st: eng.smart(), outBands: eng.outputBands() };
      eng.setSmart({ on: false }); try { src.stop(); } catch (e) { /* stopped */ } await ctx.close();
    }
    return out;
  }, Smart.PROFILES);

  const finite = v => v == null || (Array.isArray(v) ? v.every(finite) : typeof v !== 'number' || Number.isFinite(v) || Number.isNaN(v));
  for (const [k, r] of Object.entries(res)) assert.ok(r.st.gains.every(Number.isFinite) && Number.isFinite(r.st.lev) && finite(r.outBands), `${k}: no NaN or infinity anywhere`);
  const g = x => res[x].st.gains;
  assert.ok(g('reference').every(v => Math.abs(v) < 0.7) && Math.abs(res.reference.st.lev) < 1.5, 'balanced noise is left alone: ' + g('reference').map(v => v.toFixed(1)) + ' lev ' + res.reference.st.lev.toFixed(1));
  assert.ok(g('dull')[7] >= 2 && g('dull')[6] >= 1.5 && res.dull.st.clarity >= 8, 'dull: the top is lifted ' + g('dull').map(v => v.toFixed(1)) + ' clarity ' + res.dull.st.clarity.toFixed(0));
  assert.ok(res.dull.outBands[7] - res.dull.st.measured[7] >= 1.5, `dull: the top really comes out stronger (${res.dull.st.measured[7].toFixed(1)} → ${res.dull.outBands[7].toFixed(1)} dB)`);
  assert.ok(g('thin')[0] >= 3 && res.thin.st.bass >= 10, 'thin: bass lifted ' + g('thin').map(v => v.toFixed(1)) + ' bass ' + res.thin.st.bass.toFixed(0));
  assert.ok(res.hot.st.lev <= -5, 'a hot source is lowered: ' + res.hot.st.lev.toFixed(1));
  assert.ok(g('silence').every(v => v === 0) && res.silence.st.lev === 0 && res.silence.st.seconds === 0, 'silence teaches it nothing and moves nothing');
  assert.ok(g('dullOff').every(v => v === 0) && res.dullOff.st.lev === 0 && res.dullOff.st.bass === 0, 'strength 0 does nothing');
});

test('smart sound (settings): Smart / Manual, strength, what it is doing, a new station, and the Compare button', async t => {
  await t.play(); await t.live(); await t.openSettings();
  await t.p.click('[data-switch="sound.on"]'); await sleep(500);
  const pressed = sel => t.p.evaluate(s => [...document.querySelectorAll(s + ' button')].filter(b => b.getAttribute('aria-pressed') === 'true').map(b => b.dataset.value), sel);
  assert.deepStrictEqual(await pressed('[data-sseg="mode"]'), ['smart'], 'Smart is the default mode');
  assert.deepStrictEqual(await pressed('[data-sseg="strength"]'), ['70'], 'Balanced is the default strength');
  assert.strictEqual(await t.p.locator('#smartBox').isVisible(), true);
  const stored = () => t.p.evaluate(() => JSON.parse(localStorage.getItem('burzh.radio.settings.v1')).sound);
  const st = () => t.p.evaluate(() => window.BURZH.debug().smart);
  assert.ok(await waitFor(async () => (await st()).on, 3000), 'smart sound is on once the enhancer is');

  // What it is doing: after a few seconds the four tiles say something (the mock "music" is a bare tone, so the words are not judged).
  assert.ok(await waitFor(async () => (await st()).seconds > 3, 8000, 250), 'it listens: ' + JSON.stringify(await st()).slice(0, 200));
  await sleep(500);
  const tiles = await t.p.evaluate(() => ['liveTone', 'liveLevel', 'livePunch', 'liveSpace'].map(id => document.getElementById(id).textContent));
  assert.ok(tiles.every(v => v && v !== '—' && v !== 'Listening…'), 'the tiles describe what it does: ' + tiles.join(' | '));

  // Strength and mode are saved and reach the engine.
  await t.p.click('[data-sseg="strength"] button[data-value="100"]'); await sleep(200);
  assert.strictEqual((await stored()).strength, 100); assert.strictEqual((await st()).strength, 1);
  await t.p.click('[data-sseg="strength"] button[data-value="40"]'); await sleep(200);
  assert.strictEqual((await st()).strength, 0.4);
  await t.p.click('[data-sseg="mode"] button[data-value="manual"]'); await sleep(300);
  assert.strictEqual((await stored()).mode, 'manual'); assert.strictEqual((await st()).on, false, 'Manual: nothing is added by itself');
  assert.strictEqual(await t.p.locator('#smartBox').isVisible(), false, 'the smart controls hide in Manual');
  assert.ok((await t.dbg()).phase === 'live', 'music kept playing');
  await t.p.click('[data-sseg="mode"] button[data-value="smart"]'); await sleep(300);
  assert.strictEqual((await st()).on, true);

  // Compare mutes what smart sound adds, but it keeps listening: nothing is forgotten.
  await sleep(1500);
  const s0 = await st();
  const added = () => t.p.evaluate(() => Math.max(...window.BURZH.autoCurve([60, 140, 280, 560, 1120, 2240, 4480, 8400, 14000]).map(Math.abs)));
  assert.ok(await added() > 0.3, 'smart sound is adding something to the tone (' + (await added()).toFixed(2) + ' dB)');
  await t.p.locator('#abBtn').scrollIntoViewIfNeeded(); await sleep(200);
  const b = await t.p.locator('#abBtn').boundingBox();
  await t.p.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await t.p.mouse.down(); await sleep(500);
  const held = await st();
  assert.strictEqual(held.bypass, true, 'while held, what smart sound adds is muted');
  assert.ok(await added() < 1e-6, 'and the tone curve it draws is flat');
  assert.ok(held.seconds >= s0.seconds, 'it keeps listening while held (' + held.seconds.toFixed(1) + ' ≥ ' + s0.seconds.toFixed(1) + ')');
  await t.p.mouse.up(); await sleep(500);
  const back = await st();
  assert.strictEqual(back.bypass, false); assert.ok(back.seconds >= held.seconds, 'released: it picks up where it was');
  assert.ok(await added() > 0.3, 'released: it is adding the same again');

  // A new station: it starts learning the new music again (the average is fresh), the sound it had does not snap to zero.
  await t.p.evaluate(() => document.querySelector('button[data-station="deep-house"]').click());
  await sleep(1200);
  const after = await st();
  assert.ok(after.seconds < 3 && after.seconds < back.seconds, 'a new station: it learns again (' + after.seconds.toFixed(1) + ' s)');
  assert.ok((await t.dbg()).phase !== 'stopped', 'the new station plays');
}, { viewport: LAND });

test('smart sound (settings): an older saved setup opens in Smart / Balanced', async t => {
  await t.play(); await t.live();
  const d = await t.dbg();
  assert.strictEqual(d.mode, 'smart'); assert.strictEqual(d.strength, 70);
  assert.strictEqual(d.fxOn, true, 'the saved choice to have the enhancer on is kept');
  assert.strictEqual(d.preset, 'club', 'and so is the saved preset');
}, { viewport: LAND, settings: { sound: { on: true, preset: 'club', custom: null } } });

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
  await clickStation(t, 'deep-house'); await sleep(300);           // single-file mixes (cut mixes have their own check)
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

test('seek slider (landscape): drag, tap, keys, back to live, next mix', t => scrubFlow(t, '.l-live .seek', '.l-controls .play-toggle', '.l-live .golive'));
test('seek slider (portrait)', t => scrubFlow(t, '.p-live .seek', '.p-controls .play-toggle', '.p-live .golive'), { viewport: PORT });

test('seek slider works with touch, and the first touch on an idle screen only wakes it', async t => {
  await clickStation(t, 'deep-house'); await sleep(300);
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
  assert.ok(await waitFor(() => t.p.evaluate(() => [...document.querySelectorAll('.weather')].some(w => !w.hidden && /5°/.test(w.textContent))), 5000), 'weather pill');
  await t.p.click('#tab-about');
  assert.match(await t.p.textContent('#versionState'), /^v\d+\.\d+\.\d+$/);
  assert.ok((await t.dbg()).phase === 'live', 'music kept playing while changing settings');
}, { geolocation: { latitude: 55.7558, longitude: 37.6173 }, scale: 2 });

/* ----------------------------------------------------------- the design */

// Every visible piece of text must be readable on the colour it actually sits on, in every state of the
// screen. Catches a hard-coded colour or a too-faint grey.
const contrastReport = (page, min) => page.evaluate(min => {
  const chan = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const lum = c => 0.2126 * chan(c[0]) + 0.7152 * chan(c[1]) + 0.0722 * chan(c[2]);
  const parse = css => { const m = css.match(/[\d.]+/g) || [0, 0, 0]; return { c: m.slice(0, 3).map(Number), a: m.length > 3 ? Number(m[3]) : 1 }; };
  const bgOf = el => {
    for (let e = el; e; e = e.parentElement) { const b = parse(getComputedStyle(e).backgroundColor); if (b.a > 0.9) return b.c; }
    return [10, 10, 10];
  };
  const faded = el => { let o = 1; for (let e = el; e; e = e.parentElement) o *= Number(getComputedStyle(e).opacity); return o < 0.9; };
  const bad = [];
  document.querySelectorAll('body *').forEach(el => {
    if (!el.getClientRects().length || faded(el) || /^(SCRIPT|STYLE|CANVAS|svg|path)$/i.test(el.tagName)) return;
    const own = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
    if (!own) return;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || Number(cs.fontSize.replace('px', '')) < 6) return;
    const fg = parse(cs.color), bg = bgOf(el);
    const seen = fg.c.map((v, i) => v * fg.a + bg[i] * (1 - fg.a));          // a translucent grey, as the eye sees it
    const [a, b] = [lum(seen), lum(bg)].sort((x, y) => y - x);
    const ratio = (a + 0.05) / (b + 0.05);
    if (ratio < min) bad.push(`${el.tagName.toLowerCase()}.${el.className} "${el.textContent.trim().slice(0, 24)}" ${ratio.toFixed(2)}`);
  });
  return bad;
}, min);

const themeState = t => t.p.evaluate(() => ({
  white: document.documentElement.classList.contains('theme-white'), night: document.documentElement.classList.contains('night'),
  bg: getComputedStyle(document.body).backgroundColor, meta: document.querySelector('meta[name="theme-color"]').content
}));

// A station without music (what a new station is until its first mix arrives): the "off air" state keeps being checked
// even when every real station has music.
const lofiOffAir = j => { j.stations.find(x => x.id === 'lofi').items = []; };
const stationsFile = () => JSON.parse(fs.readFileSync(path.join(DOCS, 'stations.json'), 'utf8'));
const visiblePlanet = t => t.p.evaluate(() => (window.BURZH.planets().find(p => p.drawn) || null));
const clickStation = (t, id) => t.p.evaluate(sid => document.querySelector(`button[data-station="${sid}"]`).click(), id);

for (const [label, viewport] of [['portrait', PORT], ['landscape', LAND]]) {
  test(`one dark design (${label}): every text readable on the screen and in Settings`, async t => {
    await t.play(); await t.live(); await sleep(400);
    let bad = await contrastReport(t.p, 4.5);
    assert.deepStrictEqual(bad, [], 'low contrast on the main screen:\n' + bad.join('\n'));
    await t.openSettings();
    for (const tab of ['sound', 'screen', 'about']) {
      await t.p.click('#tab-' + tab); await sleep(200);
      if (tab === 'sound') { await t.p.click('[data-switch="sound.on"]'); await sleep(900); }
      bad = await contrastReport(t.p, 4.5);
      assert.deepStrictEqual(bad, [], `low contrast in Settings / ${tab}:\n` + bad.join('\n'));
    }
    assert.strictEqual(await t.p.locator('.seg[data-seg="theme"]').count(), 0, 'no background choice any more');
  }, { viewport, touch: true, scale: 2, settings: { weather: true, geo: { lat: 55.75, lon: 37.62, name: 'Moscow' } } });
}

test('one dark design: a saved White background opens dark, night mode is pure black', async t => {
  let st = await themeState(t);
  assert.deepStrictEqual([st.white, st.night, st.bg, st.meta], [false, false, 'rgb(10, 10, 10)', '#0a0a0a'], 'dark, even with White saved');
  await t.openSettings(); await t.p.click('#tab-screen');
  await t.p.click('.seg[data-seg="night"] button[data-value="on"]'); await sleep(200);
  st = await themeState(t);
  assert.deepStrictEqual([st.night, st.bg, st.meta], [true, 'rgb(0, 0, 0)', '#000000'], 'night mode');
  await t.p.click('.seg[data-seg="night"] button[data-value="off"]'); await sleep(200);
  st = await themeState(t);
  assert.deepStrictEqual([st.night, st.meta], [false, '#0a0a0a']);
}, { viewport: PORT, touch: true, settings: { theme: 'white' } });

test('the dark design and night mode are applied before the app script runs (no flash)', async t => {
  const p2 = await t.ctx.newPage();
  await p2.route('**/app.js', r => r.abort());
  await p2.goto(t.p.url(), { waitUntil: 'domcontentloaded' });
  let r = await p2.evaluate(() => ({ bg: getComputedStyle(document.body).backgroundColor, meta: document.querySelector('meta[name="theme-color"]').content }));
  assert.deepStrictEqual(r, { bg: 'rgb(10, 10, 10)', meta: '#0a0a0a' });
  await p2.evaluate(() => localStorage.setItem('burzh.radio.settings.v1', JSON.stringify({ night: 'on' })));
  await p2.reload({ waitUntil: 'domcontentloaded' });
  r = await p2.evaluate(() => ({ night: document.documentElement.classList.contains('night'), meta: document.querySelector('meta[name="theme-color"]').content }));
  assert.deepStrictEqual(r, { night: true, meta: '#000000' });
  await p2.close();
}, { viewport: PORT });

/* ------------------------------------------------------------ the planet */

test('stations: each has its own texture and planet, in step with the validator; the live planet glides to it', async t => {
  const data = stationsFile();
  assert.strictEqual(new Set(data.stations.map(s => JSON.stringify(s.look))).size, data.stations.length, 'every station has its own look');
  const py = JSON.parse(require('child_process').execFileSync('python3', ['-c', 'import json,sys; sys.path.insert(0,"tools"); import radio; print(json.dumps(radio.LOOK_LIMITS))'], { cwd: path.join(DOCS, '..') }).toString());
  const page = await t.p.evaluate(() => window.BurzhPlanet.LIMITS);
  assert.deepStrictEqual(page, py, 'LIMITS in planet.js and LOOK_LIMITS in tools/radio.py must match');
  data.stations.forEach(s => Object.entries(s.look).forEach(([k, v]) => assert.ok(k in page && v >= page[k][0] && v <= page[k][1], `${s.id}: look.${k}=${v} is out of range`)));

  // every tile shows its texture
  const tiles = await waitFor(() => t.p.evaluate(() => {
    const imgs = [...document.querySelectorAll('.p-tiles .tile img')];
    return imgs.length && imgs.every(i => i.complete && i.naturalWidth >= 256) ? imgs.map(i => i.getAttribute('src')) : null;
  }), 6000, 150);
  assert.deepStrictEqual(tiles, data.stations.map(s => './planet/tile-' + s.id + '.jpg'), 'tile textures');

  for (const s of data.stations) {
    await clickStation(t, s.id);
    const want = await t.p.evaluate(look => window.BurzhPlanet.look(look), s.look);
    const got = await waitFor(async () => {
      const pl = await visiblePlanet(t);
      return pl && pl.station === s.id && Object.keys(want).every(k => Math.abs(pl.look[k] - want[k]) < 0.02) ? pl : null;
    }, 5000, 150);
    assert.ok(got, `${s.id}: the planet should glide to its look: ` + JSON.stringify(await visiblePlanet(t)));
    assert.strictEqual(got.webgl, true, 'the planet is drawn live (WebGL), not the still picture');
    assert.strictEqual(await t.p.evaluate(() => document.querySelector('.p-stage [data-bind="station"]').textContent), s.name, 'the name sits on the planet');
    assert.strictEqual(await t.p.evaluate(() => document.querySelector('.tile.active').dataset.station), s.id, 'the tile is marked');
  }
  const a = await visiblePlanet(t); await sleep(700); const b = await visiblePlanet(t);
  assert.ok(b.frames > a.frames && b.spin !== a.spin && b.orbit !== a.orbit, 'the planet turns and the light runs round the ring');
}, { viewport: PORT, touch: true });

test('planet without WebGL: the still picture of the same planet, under the same ring', async t => {
  const r = await t.p.evaluate(async () => {
    const sleep = ms => new Promise(res => setTimeout(res, ms));
    const real = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (kind, o) { return /webgl/.test(kind) ? null : real.call(this, kind, o); };
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;left:0;top:0;width:300px;height:300px;z-index:-1';
    document.body.appendChild(box);
    const pl = window.BurzhPlanet.create(box, { getLevel: () => null });
    HTMLCanvasElement.prototype.getContext = real;
    await sleep(1500);
    const st = pl.state();
    const cv = box.querySelector('canvas.planet-fx');
    const d = cv.getContext('2d').getImageData(cv.width >> 1, cv.height >> 1, 1, 1).data;
    pl.destroy(); box.remove();
    return { still: st.still, webgl: st.webgl, centre: d[3] };
  });
  assert.deepStrictEqual([r.still, r.webgl], [true, false]);
  assert.ok(r.centre > 200, 'the picture is drawn in the middle: ' + r.centre);
}, { viewport: PORT });

test('planet: a kick in the music flares the ring; nothing without a real signal; nothing in calm mode', async t => {
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
    const before = pl.state().kickCount;
    window.__lv = null; await sleep(2400); out.noSignal = pl.state().kickCount - before;
    window.__lv = 0.05; window.__calm = true; await sleep(400);
    const b2 = pl.state().kickCount; await beat(4); out.calm = pl.state().kickCount - b2;
    out.calmState = pl.state().calm;
    pl.destroy(); box.remove();
    return out;
  });
  assert.ok(r.beats >= 5 && r.beats <= 8, 'six kicks, about six flares: ' + JSON.stringify(r));
  assert.strictEqual(r.noSignal, 0, 'no flares without a real level: ' + JSON.stringify(r));
  assert.strictEqual(r.calm, 0, 'no flares in calm mode: ' + JSON.stringify(r));
  assert.strictEqual(r.calmState, true);
}, { viewport: PORT, touch: true });

for (const [label, viewport] of [['portrait 390x844', PORT], ['portrait 320x568', { width: 320, height: 568 }], ['landscape 932x430', LAND], ['landscape 667x375', { width: 667, height: 375 }]]) {
  test(`planet (${label}): ring, ticks and glow fit inside the stage, the name and waveform fit on the planet`, async t => {
    await sleep(600);
    const r = await t.p.evaluate(() => {
      const box = [...document.querySelectorAll('[data-planet]')].find(b => b.offsetWidth > 0);
      const pl = window.BURZH.planets().find(p => p.drawn);
      const rb = box.getBoundingClientRect();
      const name = box.querySelector('.op-name').getBoundingClientRect();
      const wave = box.querySelector('.wave').getBoundingClientRect();
      const top = box.querySelector('.op-top').getBoundingClientRect();
      const bottom = box.querySelector('.op-bottom').getBoundingClientRect();
      return { pl, W: rb.width, H: rb.height, left: rb.left, top: rb.top, name: { l: name.left, r: name.right }, wave: { l: wave.left, r: wave.right }, labels: { t: top.top, b: bottom.bottom } };
    });
    const { pl } = r;
    assert.ok(pl && pl.R > 60, 'a planet of a decent size: ' + JSON.stringify(pl));
    assert.ok(pl.R * 1.37 + 2 <= r.W / 2, `the outer ticks (${(pl.R * 1.37).toFixed(0)}) fit in the width (${r.W / 2})`);
    assert.ok(pl.ringR + 4 <= r.H / 2, `the ring (${pl.ringR.toFixed(0)}) fits in the height (${r.H / 2})`);
    // the glow fades as exp(-10 (r - 1)) and is at most 0.22 × 1.6: at the stage edge it must be invisible (< 3/255)
    const edge = Math.min(r.W, r.H) / 2 / pl.R - 1;
    assert.ok(0.22 * 1.6 * Math.exp(-10 * edge) < 0.012, 'no straight line where the glow meets the edge: ' + edge.toFixed(2));
    const cx = r.left + pl.cx, cy = r.top + pl.cy;
    for (const k of ['name', 'wave']) assert.ok(r[k].l >= cx - pl.R * 0.98 && r[k].r <= cx + pl.R * 0.98, `${k} stays on the planet: ${JSON.stringify(r[k])}`);
    assert.ok(r.labels.t >= cy - pl.R && r.labels.b <= cy + pl.R, 'the labels stay on the planet');
  }, { viewport, touch: true });
}

/* ------------------------------------------------------- reduce motion */

const motionState = t => t.p.evaluate(() => ({
  calm: document.documentElement.classList.contains('calm'), api: window.BURZH.calm(),
  anim: (v => parseFloat(v) * (/ms$/.test(v) ? 0.001 : 1))(getComputedStyle(document.querySelector('.p-live .live-fill')).transitionDuration),
  planet: window.BURZH.planets().find(p => p.drawn) || null
}));

test('reduce motion: follows the phone, can be switched on or off in Settings, stills the planet and the animations', async t => {
  let m = await motionState(t);
  assert.strictEqual(m.calm, false, 'normal motion by default');
  assert.ok(m.anim >= 0.9, 'the progress glides: ' + m.anim);

  await t.p.emulateMedia({ reducedMotion: 'reduce' });                    // iPhone: Accessibility → Motion → Reduce Motion
  m = await waitFor(async () => { const x = await motionState(t); return x.calm ? x : null; }, 4000, 100) || await motionState(t);
  assert.deepStrictEqual([m.calm, m.api], [true, true], 'Auto follows the phone');
  assert.ok(m.anim < 0.01, 'CSS motion is stilled: ' + m.anim);
  await t.play(); assert.ok(await t.live());
  await sleep(1600);
  const a = (await motionState(t)).planet; await sleep(900); const b = (await motionState(t)).planet;
  assert.strictEqual(a.calm, true);
  assert.strictEqual(a.spin, b.spin, 'the planet does not turn');
  assert.strictEqual(a.orbit, b.orbit, 'the light on the ring stands still');
  assert.strictEqual(b.kicks, 0, 'no flares');

  await t.openSettings(); await t.p.click('#tab-screen');
  await t.p.click('.seg[data-seg="motion"] button[data-value="off"]'); await sleep(250);
  m = await motionState(t);
  assert.deepStrictEqual([m.calm, m.api], [false, false], 'Off wins over the phone setting');
  assert.ok(m.anim >= 0.9, 'motion is back');
  await t.p.click('[data-close]'); await sleep(700);
  const c = (await motionState(t)).planet; await sleep(700); const d = (await motionState(t)).planet;
  assert.ok(Math.abs(d.spin - c.spin) > 0.001, 'the planet turns again');

  await t.p.emulateMedia({ reducedMotion: 'no-preference' }); await sleep(1300);
  await t.openSettings(); await t.p.click('#tab-screen');
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
  assert.ok(manifest.icons.length >= 3 && manifest.background_color === '#0a0a0a' && manifest.theme_color === '#0a0a0a', 'manifest keeps its icons and the dark launch colour');

  const open = async q => {
    await t.p.goto(new URL(q, t.p.url()).href);
    await waitFor(() => t.p.evaluate(() => !!(window.BURZH && window.BURZH.stations().length)), 8000);
    await sleep(300);
    return t.p.evaluate(() => ({ station: window.BURZH.debug().station, search: location.search, saved: localStorage.getItem('burzh.radio.station.v1'), name: document.querySelector('.p-stage [data-bind="station"]').textContent, status: document.querySelector('.p-stage [data-bind="status"]').textContent, top: document.querySelector('.p-stage [data-bind="onair"]').textContent }));
  };
  let r = await open('?station=trance');
  assert.strictEqual(r.station, 'trance'); assert.strictEqual(r.search, '', 'the address is clean'); assert.strictEqual(JSON.parse(r.saved), 'trance', 'remembered');
  assert.deepStrictEqual([r.name, r.top, r.status], ['Trance', 'ON AIR NOW', 'TAP TO PLAY']);
  r = await open('?station=lofi');
  assert.strictEqual(r.station, 'lofi'); assert.deepStrictEqual([r.top, r.status], ['NO SIGNAL', 'OFF AIR'], 'a station without music opens and says so');
  r = await open('?station=deep-house');
  assert.strictEqual(r.station, 'deep-house');
  r = await open('?station=no-such-station');
  assert.strictEqual(r.search, ''); assert.strictEqual(r.station, 'deep-house', 'an unknown id changes nothing');
  await t.play(); assert.ok(await t.live(), 'and the station opened from a shortcut plays');
}, { viewport: PORT, touch: true, mutate: lofiOffAir });

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
  const devices = new Set(links.map(l => /device-width: (\d+)px\) and \(device-height: (\d+)px\) and \(-webkit-device-pixel-ratio: (\d)/.exec(l.media).slice(1).join('/')));
  devices.forEach(d => ['portrait', 'landscape'].forEach(o => ['dark', 'light'].forEach(c => assert.ok(seen.has(`${d}/${o}/${c}`), `${d} is missing ${o} ${c}`))));
  assert.ok(bytes < 2.5e6, 'launch images stay small: ' + Math.round(bytes / 1024) + ' KB');
  assert.deepStrictEqual(fs.readdirSync(path.join(DOCS, 'splash')).sort(), links.map(l => l.file.replace('splash/', '')).sort());
  assert.ok(/<meta name="apple-mobile-web-app-capable" content="yes">/.test(html));
});

/* ------------------------------------------------------ station tiles */

const tileReport = (t, sel) => t.p.evaluate(sel => {
  const chan = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const lum = c => 0.2126 * chan(c[0]) + 0.7152 * chan(c[1]) + 0.0722 * chan(c[2]);
  const rgba = css => { const m = (css.match(/[\d.]+/g) || [0, 0, 0]).map(Number); return { c: m.slice(0, 3), a: m.length > 3 ? m[3] : 1 }; };
  const bg = rgba(getComputedStyle(document.body).backgroundColor).c;
  return [...document.querySelectorAll(sel + ' .tile')].map(b => {
    const label = b.querySelector('.tlabel');
    let op = 1; for (let e = label; e; e = e.parentElement) op *= Number(getComputedStyle(e).opacity);
    const f = rgba(getComputedStyle(label).color);
    const fg = f.c.map((v, i) => (v * f.a + bg[i] * (1 - f.a)) * op + bg[i] * (1 - op));
    const [hi, lo] = [lum(fg), lum(bg)].sort((x, y) => y - x);
    const r = b.getBoundingClientRect();
    return { id: b.dataset.station, off: b.classList.contains('off'), active: b.classList.contains('active'), ratio: (hi + 0.05) / (lo + 0.05), after: getComputedStyle(label, '::after').content, box: { l: r.left, r: r.right, t: r.top, b: r.bottom } };
  });
}, sel);

for (const [label, viewport, sel] of [['portrait', PORT, '.p-tiles'], ['landscape', LAND, '.l-tiles']]) {
  test(`station tiles (${label}): every name readable, also when the screen goes idle; stations without music say "soon"`, async t => {
    for (const idle of [false, true]) {
      if (idle) { await t.p.evaluate(() => document.documentElement.classList.add('idle')); await sleep(1200); }
      const rep = await tileReport(t, sel);
      assert.strictEqual(rep.length, 4);
      rep.forEach(r => {
        assert.ok(r.ratio >= 4.5, `${r.id} reads at ${r.ratio.toFixed(2)}:1 (idle ${idle})`);
        assert.strictEqual(/soon/.test(r.after), r.off, `${r.id}: "soon" belongs to stations without music only (${r.after})`);
        assert.ok(r.box.l >= -1 && r.box.r <= viewport.width + 1 && r.box.b <= viewport.height + 1, `${r.id} is on the screen: ${JSON.stringify(r.box)}`);
      });
    }
  }, { viewport, mutate: lofiOffAir });
}

/* ----------------------------------------------------------- layouts */

const blocksOf = (t, list) => t.p.evaluate(list => {
  const box = sel => { const e = [...document.querySelectorAll(sel)].find(x => x.getClientRects().length); if (!e) return null; const r = e.getBoundingClientRect(); return { t: r.top, b: r.bottom, l: r.left, r: r.right, w: r.width, h: r.height }; };
  return { blocks: list.map(s => [s, box(s)]), iw: innerWidth, ih: innerHeight, sw: document.scrollingElement.scrollWidth, sh: document.scrollingElement.scrollHeight };
}, list);

for (const [w, h] of [[375, 667], [390, 844], [393, 852], [430, 932], [402, 874], [360, 740], [320, 568]]) {
  test(`portrait ${w}x${h}: header, planet, title, progress, controls and tiles stack without overlap`, async t => {
    await t.play(); await t.live(); await sleep(300);
    const m = await blocksOf(t, ['.p-head', '.p-stage', '.p-np', '.p-live', '.p-controls', '.p-tiles']);
    let prev = null;
    m.blocks.forEach(([name, b]) => {
      assert.ok(b, name + ' is missing');
      assert.ok(b.l >= -1 && b.r <= m.iw + 1 && b.b <= m.ih + 1 && b.t >= -1, `${name} is outside the screen: ${JSON.stringify(b)}`);
      if (prev) assert.ok(b.t >= prev[1].b - 1, `${name} (top ${b.t.toFixed(1)}) overlaps ${prev[0]} (bottom ${prev[1].b.toFixed(1)})`);
      prev = [name, b];
    });
    assert.ok(m.sh <= m.ih + 1 && m.sw <= m.iw + 1, 'no scrolling');
    const stage = m.blocks.find(([n]) => n === '.p-stage')[1];
    assert.ok(stage.h >= m.ih * 0.28, 'the planet takes the room that is left: ' + stage.h.toFixed(0));
    const head = await t.p.evaluate(() => { const b = document.querySelector('.p-head .brand').getBoundingClientRect(), tl = document.querySelector('.p-head .tools').getBoundingClientRect(); return { brand: b.right, tools: tl.left }; });
    assert.ok(head.brand + 6 <= head.tools, `the logo with its clock and the weather keep 6px apart (${head.brand.toFixed(0)} vs ${head.tools.toFixed(0)})`);
    await t.shot(`portrait-${w}x${h}.png`);
  }, { viewport: { width: w, height: h }, touch: true, settings: { weather: true, geo: { lat: 55.75, lon: 37.62, name: 'Moscow' } } });
}

for (const [w, h] of [[932, 430], [1000, 462], [844, 390], [667, 375], [1180, 820]]) {
  test(`landscape ${w}x${h}: planet on the left, title, progress, controls and tiles on the right, nothing overlaps`, async t => {
    await t.play(); await t.live(); await sleep(300);
    const m = await blocksOf(t, ['.l-brand', '.l-tools', '.l-stage', '.l-np', '.l-live', '.l-controls', '.l-tiles']);
    const b = Object.fromEntries(m.blocks);
    Object.entries(b).forEach(([name, r]) => {
      assert.ok(r, name + ' is missing');
      assert.ok(r.l >= -1 && r.r <= m.iw + 1 && r.b <= m.ih + 1 && r.t >= -1, `${name} is outside the screen: ${JSON.stringify(r)}`);
    });
    let prev = null;
    for (const name of ['.l-tools', '.l-np', '.l-live', '.l-controls', '.l-tiles']) {
      if (prev) assert.ok(b[name].t >= b[prev].b - 1, `${name} (top ${b[name].t.toFixed(1)}) overlaps ${prev} (bottom ${b[prev].b.toFixed(1)})`);
      prev = name;
    }
    assert.ok(b['.l-stage'].r <= b['.l-np'].l + 1, 'the planet stays left of the panel');
    assert.ok(m.sh <= m.ih + 1 && m.sw <= m.iw + 1, 'no scrolling');
    await t.shot(`landscape-${w}x${h}.png`);
  }, { viewport: { width: w, height: h }, settings: { weather: true, geo: { lat: 55.75, lon: 37.62, name: 'Moscow' } } });
}

test('weather pill: icon, temperature and the place, tidy name; a tap opens the screen settings', async t => {
  const r = await waitFor(() => t.p.evaluate(() => {
    const w = [...document.querySelectorAll('.weather')].find(x => x.getClientRects().length);
    return w && /5°/.test(w.textContent) ? { text: w.textContent, icon: w.querySelector('.w-icon').dataset.sky, svg: !!w.querySelector('.w-icon svg') } : null;
  }), 6000, 150);
  assert.ok(r, 'the pill shows the temperature');
  assert.match(r.text, /5°/); assert.match(r.text, /Krasnogorsk/); assert.doesNotMatch(r.text, /Okrug/i);
  assert.deepStrictEqual([r.icon, r.svg], ['partly', true], 'partly cloudy has its icon');
  await t.p.locator('.weather:visible').first().click(); await sleep(400);
  assert.strictEqual(await t.p.getAttribute('#tab-screen', 'aria-selected'), 'true', 'the pill opens Settings → Screen');
}, { viewport: PORT, touch: true, settings: { weather: true, geo: { lat: 55.75, lon: 37.62, name: 'Gorodskoy Okrug Krasnogorsk' } } });

// The clock: small, under the logo, in both layouts. It must show the real local time and never touch a neighbour.
for (const [name, viewport, wordmark, wideRing] of [
  ['portrait 390x844', { width: 390, height: 844 }, '.p-head .wordmark', false],
  ['portrait 320x568', { width: 320, height: 568 }, '.p-head .wordmark', false],
  ['landscape 932x430', { width: 932, height: 430 }, '.l-brand .wordmark', true],
  ['landscape 667x375', { width: 667, height: 375 }, '.l-brand .wordmark', true],
]) {
  test(`clock under the logo (${name}): local time and date, one line, nothing touches it`, async t => {
    await t.play(); await t.live(); await sleep(300);
    const r = await t.p.evaluate(({ wordmark, wideRing }) => {
      const vis = sel => [...document.querySelectorAll(sel)].find(e => e.getClientRects().length);
      const line = vis('.clockline'), clk = vis('.clockline .clk'), date = vis('.clockline .cdate'), mark = vis(wordmark);
      const rect = e => { const b = e.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height }; };
      const d = new Date();
      const out = {
        time: clk.textContent, date: date.textContent, line: rect(line), mark: rect(mark), color: getComputedStyle(clk).color,
        now: String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'), fontPx: parseFloat(getComputedStyle(clk).fontSize),
        tagline: !!document.querySelector('.tagline'),
      };
      if (wideRing) {          // landscape: the orbit ring of the planet must not run through the clock
        const boxes = [...document.querySelectorAll('[data-planet]')];
        const i = boxes.findIndex(b => b.getClientRects().length);
        const st = window.BURZH.planets()[i], fx = (boxes[i].querySelector('.planet-fx') || boxes[i]).getBoundingClientRect();
        const cx = fx.left + st.cx, cy = fx.top + st.cy, L = out.line;
        const nx = Math.max(L.l, Math.min(cx, L.r)), ny = Math.max(L.t, Math.min(cy, L.b));
        out.ringGap = Math.hypot(nx - cx, ny - cy) - st.ringR;
      }
      return out;
    }, { wordmark, wideRing });
    assert.match(r.time, /^\d\d:\d\d$/, 'time is HH:MM, got ' + r.time);
    assert.ok(r.time === r.now || Math.abs(Number(r.time.slice(0, 2)) * 60 + Number(r.time.slice(3)) - (Number(r.now.slice(0, 2)) * 60 + Number(r.now.slice(3)))) <= 1, `the clock shows the local time (${r.time} vs ${r.now})`);
    assert.match(r.date, /^(MON|TUE|WED|THU|FRI|SAT|SUN) \d\d (JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)$/, 'date looks like FRI 02 OCT, got ' + r.date);
    assert.strictEqual(r.color, 'rgb(255, 255, 255)', 'the time is white');
    assert.ok(r.fontPx >= 11 && r.fontPx <= 18, 'the clock stays small: ' + r.fontPx.toFixed(1) + 'px');
    assert.ok(r.line.h <= r.fontPx * 1.3, 'the clock is one line, height ' + r.line.h.toFixed(1));
    assert.ok(r.line.t >= r.mark.b, `the clock sits under the logo (${r.line.t.toFixed(1)} vs ${r.mark.b.toFixed(1)})`);
    assert.ok(Math.abs(r.line.l - r.mark.l) <= 1.5, 'the clock is left-aligned with the logo');
    assert.strictEqual(r.tagline, false, 'the old tagline is gone');
    if (wideRing) assert.ok(r.ringGap >= 2, 'the orbit ring does not touch the clock, gap ' + r.ringGap.toFixed(1));
    // it keeps going: one minute is too long to wait, so check that the binding is alive instead
    await t.p.evaluate(() => { document.querySelectorAll('[data-bind="mm"]').forEach(e => { e.textContent = 'xx'; }); });
    assert.ok(await waitFor(() => t.p.evaluate(() => [...document.querySelectorAll('[data-bind="mm"]')].every(e => /^\d\d$/.test(e.textContent))), 3000, 150), 'the clock refreshes itself every second');
    await t.shot('clock-' + name.replace(/[^a-z0-9]+/gi, '-') + '.png');
  }, { viewport, touch: true, settings: { weather: true, geo: { lat: 55.75, lon: 37.62, name: 'Moscow' } } });
}

test('play button: the ring around it shows how far the mix has played', async t => {
  await t.play(); await t.live();
  const r = await waitFor(async () => {
    const x = await t.p.evaluate(() => {
      const b = document.querySelector('.p-controls .play-toggle');
      return { p: Number(b.style.getPropertyValue('--p')), offset: getComputedStyle(b.querySelector('.arc-fg')).strokeDashoffset, dbg: window.BURZH.debug().time };
    });
    return x.p > 0.05 ? x : null;
  }, 6000, 200);
  assert.ok(r, 'the arc follows the mix');
  const want = 301.6 * (1 - r.p);
  near(parseFloat(r.offset), want, 8, 'arc length');
}, { viewport: PORT, touch: true });

/* ------------------------------------------------- long mixes cut in parts */

// A station with three single mixes and one mix cut into three parts (what tools/radio.py makes of a very long mix).
const partsFixture = j => {
  const st = j.stations.find(x => x.id === 'trance');
  const one = (file, title, group) => Object.assign({ file, title, duration: 60, cues: [] }, group ? { group } : {});
  st.items = [one('trance/mix-01.m4a', 'A'), one('trance/mix-02.m4a', 'B'), one('trance/mix-01.m4a', 'Long · 1/3', 'long'),
    one('trance/mix-02.m4a', 'Long · 2/3', 'long'), one('trance/mix-01.m4a', 'Long · 3/3', 'long'), one('trance/mix-02.m4a', 'C')];
};

test('the parts of one cut mix play back to back and in order, count as one mix, and the other mixes keep their schedule', async t => {
  const r = await t.p.evaluate(() => {
    const st = window.BURZH.stations().find(x => x.id === 'trance');
    const titles = [];
    const now = Date.now();
    for (let i = 0; i < 1500; i++) {                                    // 1500 half-minutes: about 125 cycles of six minutes
      const l = window.BURZH.liveAt('trance', now + i * 30000);
      if (titles[titles.length - 1] !== l.item.title) titles.push(l.item.title);
    }
    return { titles, total: st.total, items: st.items.length };
  });
  assert.strictEqual(r.items, 6);
  const starts = r.titles.map((x, i) => x === 'Long · 1/3' ? i : -1).filter(i => i >= 0);
  assert.ok(starts.length >= 100, 'the long mix came round many times: ' + starts.length);
  starts.forEach(i => { if (i + 2 < r.titles.length) assert.deepStrictEqual(r.titles.slice(i, i + 3), ['Long · 1/3', 'Long · 2/3', 'Long · 3/3'], 'parts in order at ' + i); });
  assert.strictEqual(r.titles.filter(x => x.startsWith('Long')).length >= starts.length * 3 - 2, true, 'no part is ever played alone');
  // every group still turns up once per cycle, and no mix is repeated back to back at a seam
  const groups = r.titles.map(x => x.startsWith('Long') ? 'Long' : x).filter((x, i, a) => x !== 'Long' || a[i - 1] !== 'Long');
  groups.forEach((g, i) => { if (i) assert.notStrictEqual(g, groups[i - 1], 'a mix repeated straight away at ' + i); });
  assert.ok(groups.length >= 4 * 100, 'many cycles were checked: ' + groups.length);
  const counts = ['A', 'B', 'Long', 'C'].map(g => groups.filter(x => x === g).length);
  assert.ok(Math.max(...counts) - Math.min(...counts) <= 2, 'every mix comes once per cycle: ' + counts);

  // The settings list says "4 mixes" (the three parts count once), and the count in About agrees.
  await t.openSettings();
  const rows = await t.p.evaluate(() => [...document.querySelectorAll('.list-row')].map(e => e.textContent.trim()));
  assert.ok(rows.some(x => /Trance.*4 mixes/.test(x)), 'station list: ' + JSON.stringify(rows));
  const lib = await t.p.evaluate(() => document.getElementById('libraryState').textContent);
  assert.match(lib, /^\d+ mixes · 3 of 4 on air|^\d+ mixes · \d of 4 on air/, lib);
}, { mutate: partsFixture });

test('a mix cut into parts looks and scrubs as one mix: one title, one length, one rail across the cut', async t => {
  const st = stationsFile().stations.find(s => s.items.some(i => i.group));
  assert.ok(st, 'a station with a cut mix');
  await clickStation(t, st.id);
  if (!(await t.dbg()).wantPlaying) await t.play();
  assert.ok(await t.live(), 'plays');
  const text = () => t.p.evaluate(() => ({
    title: document.querySelector('.p-stage [data-bind="station"]').textContent,
    line: document.querySelector('.p-np [data-bind="headline"]').textContent,
    left: document.querySelector('.p-live [data-bind="remaining"]').textContent,
    max: document.querySelector('.p-live .seek').getAttribute('aria-valuemax'),
    now: +document.querySelector('.p-live .seek').getAttribute('aria-valuenow')
  }));
  let x = await text();
  assert.strictEqual(x.title, st.name);
  assert.strictEqual(x.line, st.name + ' · Mix 01', 'no part number: ' + x.line);
  assert.match(x.left, /^−1:\d\d$/, 'the time left is that of the whole mix (two 60 s parts in the fixture): ' + x.left);
  assert.strictEqual(x.max, '120', 'the rail spans both parts');

  await t.p.evaluate(() => window.BURZH.seekTo(90));                 // into the second part
  let d = await waitFor(async () => { const v = await t.dbg(); return /part2/.test(v.src) && v.phase === 'live' && !v.paused && v.time > 25 ? v : null; }, 9000);
  assert.ok(d, 'the second part plays: ' + JSON.stringify(await t.dbg()));
  near(d.time, 30, 4, 'time inside the second part');
  x = await text();
  near(x.now, 91, 4, 'the rail shows the place in the whole mix');
  assert.strictEqual(x.line, st.name + ' · Mix 01');
  assert.match(x.left, /^−0:\d\d$/);

  await t.p.evaluate(() => window.BURZH.seekTo(10));                 // back into the first part
  d = await waitFor(async () => { const v = await t.dbg(); return /part1/.test(v.src) && v.phase === 'live' && !v.paused ? v : null; }, 9000);
  assert.ok(d, 'back in the first part');
  near(d.time, 10, 4, 'time inside the first part');
}, { viewport: PORT, touch: true });

test('the schedule of a station without parts is exactly what it always was', async t => {
  // A frozen copy of the original schedule (shuffle of whole mixes, seeded by station and cycle). If this ever differs
  // from the app, every listener would suddenly hear a different mix: change it only on purpose.
  const bad = await t.p.evaluate(async () => {
    const j = await (await fetch('./stations.json')).json();
    const epoch = Date.parse(j.epoch);
    const st = j.stations.find(x => x.id === 'trance');
    const n = st.items.length, total = n * 60;
    const hash = s => { let h = 2166136261 >>> 0; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
    const seeded = seed => { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
    const raw = c => { const idx = [...Array(n).keys()]; const r = seeded(hash(st.id + ':' + c)); for (let i = n - 1; i > 0; i--) { const k = Math.floor(r() * (i + 1)); [idx[i], idx[k]] = [idx[k], idx[i]]; } return idx; };
    const order = c => { const o = raw(c); const prev = raw(c - 1); if (o[0] === prev[n - 1]) [o[0], o[1]] = [o[1], o[0]]; return o; };
    const bad = [];
    const shuffled = new Set();
    // The fixture's clock moves a little between fetches: look in the middle of each slot, where that cannot matter.
    const base = Date.now() + (30 - window.BURZH.liveAt('trance', Date.now()).offset) * 1000;
    for (let i = 0; i < 1500; i++) {
      const now = base + i * 60000, tt = (now - epoch) / 1000;
      const cycle = Math.floor(tt / total), slot = Math.floor((tt - cycle * total) / 60);
      const want = st.items[order(cycle)[slot]].title, got = window.BURZH.liveAt('trance', now).item.title;
      shuffled.add(order(cycle).join());
      if (want !== got) bad.push({ i, want, got });
    }
    return { bad: bad.slice(0, 3), orders: shuffled.size };
  });
  assert.deepStrictEqual(bad.bad, [], 'the schedule moved');
  assert.ok(bad.orders > 20, 'the shuffle was really exercised: ' + bad.orders + ' different orders');
}, { mutate: j => { const st = j.stations.find(x => x.id === 'trance'); st.items = [0, 1, 2, 3, 4].map(i => ({ file: `trance/mix-0${1 + i % 2}.m4a`, title: 'T' + i, duration: 60, cues: [] })); } });

test('tools/radio.py cuts a very long mix at its quietest moment, keeps the loudness, and writes parts the player keeps together', async () => {
  const cp = require('child_process');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'burzh-split-'));
  const src = path.join(work, 'long.m4a');
  // 3 minutes of tone with one second of silence at 71 s (inside the window around the half-way point at 90 s)
  cp.execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=180:sample_rate=44100',
    '-af', "volume=enable='between(t,70.5,71.5)':volume=0", '-c:a', 'aac', '-b:a', '128k', src]);
  const script = `
import json, sys, pathlib, io, contextlib
sys.path.insert(0, "tools")
import radio
radio.MAX_PART_BYTES = 1_500_000          # 3 min of 128 kbps is 2.9 MB: two parts
out = pathlib.Path(sys.argv[2])
files = radio.encode_source(pathlib.Path(sys.argv[1]), out, "demo")
res = {"files": files, "durations": [radio.probe(out / f)["duration"] for f in files]}
cues = [{"at": 0, "title": "A", "artist": ""}, {"at": 50, "title": "B", "artist": ""}, {"at": 120, "title": "C", "artist": ""}]
res["cues"] = [radio.cues_between(cues, 0, 71.0), radio.cues_between(cues, 71.0, 180.0)]
res["count"] = radio.mix_count([{"file": "a", "group": "g"}, {"file": "b", "group": "g"}, {"file": "c"}])
# the validator insists that the parts of one mix are listed together
data = radio.load()
fake = lambda g1, g2, g3: [{"file": "deep-house/mix-01.m4a", "duration": 4302.866, "title": "x", "group": g1}, {"file": "deep-house/mix-02.m4a", "duration": 5442.432, "title": "y", "group": g2}, {"file": "deep-house/mix-01.m4a", "duration": 4302.866, "title": "z", "group": g3}]
def run(items):
    d = json.loads(json.dumps(data)); d["stations"][0]["items"] = items
    radio.load = lambda: d
    buf = io.StringIO()
    try:
        with contextlib.redirect_stdout(buf): radio.validate(None)
        return "ok"
    except SystemExit: return buf.getvalue()
res["apart"] = run(fake("g", "h", "g"))
res["together"] = run(fake("g", "g", "h"))
print(json.dumps(res))
`;
  const res = JSON.parse(cp.execFileSync('python3', ['-c', script, src, path.join(work, 'media')], { cwd: path.join(DOCS, '..') }).toString().trim().split('\n').pop());
  assert.deepStrictEqual(res.files, ['demo/long-part1.m4a', 'demo/long-part2.m4a']);
  near(res.durations[0], 71, 0.7, 'the cut is in the silence');
  near(res.durations[0] + res.durations[1], 180, 0.3, 'nothing is lost');
  assert.deepStrictEqual(res.cues[0], [{ at: 0, title: 'A', artist: '' }, { at: 50, title: 'B', artist: '' }]);
  assert.deepStrictEqual(res.cues[1], [{ at: 0, title: 'B', artist: '' }, { at: 49, title: 'C', artist: '' }], 'the track playing at the cut starts the second part');
  assert.strictEqual(res.count, 2);
  assert.match(res.apart, /must be listed one after another/);
  assert.ok(!/one after another/.test(res.together), 'parts listed together are fine: ' + res.together);
  // the parts have the same loudness (one constant gain for the whole mix)
  const level = f => { const o = cp.spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', path.join(work, 'media', f), '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' }).stderr; return +/mean_volume: (-?[\d.]+) dB/.exec(o)[1]; };
  near(level(res.files[0]), level(res.files[1]), 1.5, 'part loudness');
  fs.rmSync(work, { recursive: true, force: true });
});

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
