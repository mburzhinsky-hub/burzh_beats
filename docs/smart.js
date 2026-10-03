/* BURZH smart sound — the part of the sound enhancer that listens.
 *
 * It does not need a microphone and does not know your room. It listens to the music itself and keeps four
 * things in order, slowly enough that you never hear it working:
 *
 *   tone      nine small filters pull the long-term tonal balance towards a target for the kind of music
 *             playing (neutral, bright, dark). Gentle: half of the error at most, never more than a few dB,
 *             and a band with nothing in it is left alone.
 *   level     one slow gain keeps different mixes equally loud and leaves room for the peaks.
 *   punch     bass and clarity harmonics come in only when the music lacks them.
 *   space     stereo width and glue come in only for narrow or very dynamic material.
 *
 * Everything here is plain arithmetic (no Web Audio), so it can be tested against numbers. sound.js feeds
 * it what the analysers hear and applies what it answers.
 */
(function (root) {
  'use strict';

  const EDGES = [20, 99, 198, 396, 792, 1585, 3170, 6340, 11200, 20000];   // nine bands, about an octave each
  const N = EDGES.length - 1;
  // One filter per band. A shelf at each end, peaking filters between (octave spacing, overlapping a little).
  const FILTERS = [
    { type: 'lowshelf', f: 100, q: 0.7 },
    { type: 'peaking', f: 140, q: 1.1 },
    { type: 'peaking', f: 280, q: 1.1 },
    { type: 'peaking', f: 560, q: 1.1 },
    { type: 'peaking', f: 1120, q: 1.1 },
    { type: 'peaking', f: 2240, q: 1.1 },
    { type: 'peaking', f: 4480, q: 1.1 },
    { type: 'peaking', f: 8400, q: 1.0 },
    { type: 'highshelf', f: 11000, q: 0.7 }
  ];

  // Energy of each band in dB, relative to the whole signal. Measured on the radio's own mixes
  // (neutral = their average; dark = the soft-topped mixes of the former Lo-Fi station, now used by the Warm preset; bright = the Trance mixes).
  const PROFILES = {
    neutral: [-1.6, -9.0, -12.0, -13.8, -18.4, -24.0, -27.2, -29.6, -35.5],
    bright:  [-2.0, -7.4, -13.0, -15.0, -15.6, -18.6, -21.0, -23.0, -29.5],
    dark:    [-2.6, -8.4, -8.4, -10.0, -17.5, -26.5, -32.0, -38.0, -48.0]
  };
  // Which target suits a station: it follows the station's sound preset (stations.json "sound").
  const PROFILE_OF_PRESET = { club: 'bright', warm: 'dark', deep: 'neutral', wide: 'neutral', clear: 'neutral', night: 'neutral', flat: 'neutral' };
  const profileFor = preset => PROFILE_OF_PRESET[preset] || 'neutral';

  const CAP_UP = [4, 4, 4, 4, 4, 4, 4, 3.5, 3];       // most a band may be lifted, dB
  const CAP_DOWN = [6, 5, 5, 5, 5, 5, 5, 5, 4];        // most a band may be lowered, dB
  const REF = [1, 2, 3, 4, 5, 6];                      // the mids are the yardstick: bass, highs and air are judged against them
  const DEADBAND = 1.0;                                // errors smaller than this are not worth chasing
  const TONE_K = 0.7;                                  // share of the error that is corrected, at full strength
  const LEVEL_TARGET = -14;                            // dBFS, RMS of the mid channel, where the radio's own mixes sit
  const LEVEL_GATE = -48;                              // quieter than this is silence: nothing is learned from it
  const LEVEL_RELATIVE_GATE = 10;                      // and a passage this many dB below the music so far (intro, breakdown) teaches nothing either
  const TAU_MAX = 25;                                  // seconds: how long the tonal average remembers
  const LEARN = 10;                                    // seconds of fast learning after a start or a new mix

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const median = (a, idx) => { const v = idx.map(i => a[i]).sort((x, y) => x - y), h = v.length >> 1; return v.length % 2 ? v[h] : (v[h - 1] + v[h]) / 2; };

  /** A target as dB relative to the whole signal (so the bands add up to 1). */
  function normalise(db) {
    let sum = 0;
    for (let i = 0; i < N; i++) sum += Math.pow(10, db[i] / 10);
    const off = 10 * Math.log10(sum);
    return db.map(v => v - off);
  }

  /** Adds up the power in each band from a dB spectrum (AnalyserNode.getFloatFrequencyData). */
  function bandPowers(db, sampleRate, out) {
    out = out || new Float64Array(N);
    const binHz = sampleRate / 2 / db.length;
    for (let b = 0; b < N; b++) {
      const lo = Math.max(1, Math.ceil(EDGES[b] / binHz - 0.5));
      const hi = Math.min(db.length - 1, Math.ceil(EDGES[b + 1] / binHz - 0.5) - 1);
      let sum = 0;
      for (let k = lo; k <= hi; k++) { const v = db[k]; if (v > -200) sum += Math.pow(10, v / 10); }
      out[b] = sum;
    }
    return out;
  }

  function createBrain() {
    let acc = new Float64Array(N), secs = 0;
    let cur = new Float64Array(N);
    const ex = { bass: 0, clarity: 0, width: 0, glue: 0 };
    let crest = NaN, sideMid = NaN, cSecs = 0;
    let lvlPow = 0, shortPow = 0, lvlSecs = 0, G = 0, peak = -90;
    let lastPlan = null;

    function reset(soft) {
      acc = new Float64Array(N); secs = 0; crest = NaN; sideMid = NaN; cSecs = 0; lvlPow = 0; shortPow = 0; lvlSecs = 0; peak = -90;
      if (!soft) { cur = new Float64Array(N); ex.bass = ex.clarity = ex.width = ex.glue = 0; G = 0; }
    }

    /** One look at the music. f = { powers[9], crestDb?, sideMidDb? }. */
    function feed(f, dt) {
      const tau = clamp(secs * 0.6, 1.2, TAU_MAX), lam = Math.exp(-dt / tau);
      for (let i = 0; i < N; i++) acc[i] = acc[i] * lam + f.powers[i] * (1 - lam);
      secs += dt;
      const tc = clamp(cSecs * 0.6, 1.5, 10), lc = Math.exp(-dt / tc);
      if (Number.isFinite(f.crestDb)) crest = Number.isFinite(crest) ? crest * lc + f.crestDb * (1 - lc) : f.crestDb;
      if (Number.isFinite(f.sideMidDb)) sideMid = Number.isFinite(sideMid) ? sideMid * lc + f.sideMidDb * (1 - lc) : f.sideMidDb;
      cSecs += dt;
    }

    function measured() {
      let total = 0;
      for (let i = 0; i < N; i++) total += acc[i];
      const m = new Float64Array(N);
      for (let i = 0; i < N; i++) m[i] = total > 0 ? 10 * Math.log10(Math.max(acc[i], 1e-30) / total) : -90;
      return m;
    }

    /** What the tone, punch and space stages should be doing now. strength 0..1; profile = a name or nine dB values. */
    function plan(strength, profile, dt) {
      const s = clamp(strength, 0, 1);
      const T = normalise(Array.isArray(profile) ? profile : (PROFILES[profile] || PROFILES.neutral));
      const m = measured();
      const conf = clamp((secs - 0.6) / 3, 0, 1);
      const err = new Float64Array(N), tgt = new Float64Array(N);
      const have = secs > 0;
      // Music has something in most of the mids. A tone or a solo instrument does not, and is not judged.
      const present = REF.filter(i => m[i] > -50);
      const musical = present.length >= 4;
      if (have && musical) {
        const e = T.map((t, i) => t - m[i]);
        const ref = median(e, present);                // the middle of the mids: one loud band does not drag the others
        for (let i = 0; i < N; i++) {
          let x = e[i] - ref;
          err[i] = x;
          const sign = x < 0 ? -1 : 1;
          x = sign * Math.max(0, Math.abs(x) - DEADBAND);
          tgt[i] = TONE_K * s * x * clamp((m[i] + 62) / 10, 0, 1);   // a band with nothing in it gets nothing
        }
        const sm = new Float64Array(N);
        for (let i = 0; i < N; i++) {
          const a = tgt[Math.max(0, i - 1)], c = tgt[Math.min(N - 1, i + 1)];
          sm[i] = 0.6 * tgt[i] + 0.2 * a + 0.2 * c;
        }
        for (let i = 0; i < N; i++) tgt[i] = clamp(sm[i] * conf, -CAP_DOWN[i], CAP_UP[i]);
      }
      const rate = secs < LEARN ? 4 : 0.5;
      for (let i = 0; i < N; i++) cur[i] += clamp(tgt[i] - cur[i], -rate * dt, rate * dt);

      // Punch and space: come in only when something is missing.
      const want = { bass: 0, clarity: 0, width: 0, glue: 0 };
      if (have && musical) {
        want.bass = clamp(err[0] * 2.5, 0, 25) * s * conf;
        want.clarity = clamp((err[7] + err[8]) / 2 * 2, 0, 25) * s * conf;
        if (Number.isFinite(sideMid)) want.width = clamp((-12 - sideMid) * 5, 0, 25) * s * conf;
        if (Number.isFinite(crest)) want.glue = clamp((crest - 9.5) * 5, 0, 30) * s * conf;
      }
      const er = (secs < LEARN ? 12 : 3) * dt;
      for (const k of Object.keys(ex)) ex[k] += clamp(want[k] - ex[k], -er, er);

      lastPlan = { gains: Array.from(cur), bass: ex.bass, clarity: ex.clarity, width: ex.width, glue: ex.glue, conf, seconds: secs, errors: Array.from(err), measured: Array.from(m), crest, sideMid };
      return lastPlan;
    }

    /** Is this moment worth learning from? Silence, and passages far quieter than the music so far, are not. */
    function listens(rmsDb) {
      if (!(rmsDb > LEVEL_GATE)) return false;
      if (lvlSecs < 1 || lvlPow <= 0) return true;
      return rmsDb - G > 10 * Math.log10(lvlPow) - LEVEL_RELATIVE_GATE;
    }

    /** The slow level gain, dB. o = { rmsDb, peakDb } measured where the gain has already been applied. */
    function level(o, strength, dt) {
      const s = clamp(strength, 0, 1);
      if (listens(o.rmsDb)) {
        // Input-referred, so the average does not chase the gain it is controlling.
        const inDb = o.rmsDb - G;
        const tau = clamp(lvlSecs * 0.6, 1.5, 12), lam = Math.exp(-dt / tau);
        const pw = Math.pow(10, inDb / 10), ls = Math.exp(-dt / clamp(lvlSecs * 0.6, 0.5, 3));
        lvlPow = lvlPow * lam + pw * (1 - lam);
        shortPow = shortPow * ls + pw * (1 - ls);                // the last few seconds: a sudden loud passage is caught quickly
        lvlSecs += dt;
        const inPeak = o.peakDb - G;
        peak = Math.max(inPeak, peak - 1.5 * dt);
      }
      if (lvlSecs < 0.4 || lvlPow <= 0) return G;
      const inAvg = 10 * Math.log10(lvlPow);
      const room = 1.8 - peak;                                  // lets the limiter take up to ~3 dB of the peaks
      // Raising is slow and earns its range: after a few seconds of music it may lift 1 dB, after 20 s 4 dB.
      // (A quiet intro or breakdown must not be boosted into the drop that follows.) Lowering is quick, and a
      // loud passage is lowered by what the last few seconds say, not by the long average.
      const maxUp = Math.min(4 * s, 0.2 * lvlSecs, Math.max(0, room));
      const hot = LEVEL_TARGET + 1.5 - 10 * Math.log10(shortPow);
      const want = clamp(Math.min(LEVEL_TARGET - inAvg, hot < LEVEL_TARGET - inAvg ? hot : Infinity), -10 * s, maxUp);
      const down = 2, up = 0.2;
      G += clamp(want - G, -down * dt, up * dt);
      return G;
    }

    return {
      feed, plan, level, listens, reset, measured,
      get gain() { return G; },
      get seconds() { return secs; },
      get last() { return lastPlan; }
    };
  }

  const api = { EDGES, N, FILTERS, PROFILES, profileFor, normalise, bandPowers, createBrain, LEVEL_TARGET, LEVEL_GATE, CAP_UP, CAP_DOWN };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BurzhSmart = api;
})(typeof window !== 'undefined' ? window : globalThis);
