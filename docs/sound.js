/* BURZH sound — a small mastering chain for the radio.
 *
 *   in → trim ─┬→ (tap: what the music is like)
 *              └→ auto tone (9 filters) → auto level → rumble filter → 6-band EQ ─┬─ dry ─────────────┐
 *                                                                                ├─ bass enhancer ───┤
 *                                                                                └─ clarity exciter ─┤
 *   → stereo width (mid/side) → glue compressor → level → limiter → out
 *
 * - Smart mode (smart.js): the tap, the level meter and the stereo meters tell it what the music is like; it
 *   drives the nine auto-tone filters, the auto level gain and adds to bass, clarity, width and glue. The
 *   6-band EQ and the sliders stay yours, on top of that.
 * - Bass enhancer: saturates the sub region so its harmonics are audible on
 *   phone and desk speakers that cannot reproduce 50 Hz.
 * - Clarity exciter: adds a little harmonic "air" above 5 kHz.
 * - Width works on the side signal above 150 Hz only, so the low end stays
 *   centred and mono-safe at any setting.
 * - Auto headroom lowers the input by the amount the EQ boosts, and a
 *   look-ahead limiter catches whatever is left.
 */
(() => {
  'use strict';

  const BANDS = [
    { f: 60, type: 'lowshelf', q: 0.7, label: '60' },
    { f: 150, type: 'peaking', q: 1.0, label: '150' },
    { f: 400, type: 'peaking', q: 0.9, label: '400' },
    { f: 1500, type: 'peaking', q: 0.8, label: '1.5k' },
    { f: 4000, type: 'peaking', q: 0.9, label: '4k' },
    { f: 10000, type: 'highshelf', q: 0.7, label: '10k' }
  ];
  const EQ_RANGE = 12; // dB either way

  const make = (bands, bass, clarity, width, glue, level) => ({ bands, bass, clarity, width, glue, level });
  const PRESETS = {
    flat:  { name: 'Flat',  hint: 'Untouched sound',             p: make([0, 0, 0, 0, 0, 0], 0, 0, 100, 0, 0) },
    club:  { name: 'Club',  hint: 'Punchy low end, bright top',  p: make([5, 3.5, -2.5, -1, 2.5, 4], 55, 40, 125, 40, 1) },
    deep:  { name: 'Deep',  hint: 'Heavy sub, smooth highs',     p: make([7, 4.5, -1, -2.5, -1.5, 1.5], 70, 15, 110, 35, 1) },
    warm:  { name: 'Warm',  hint: 'Tape-like, soft top',         p: make([3, 4, 2.5, -1, -4.5, -7], 30, 0, 90, 55, 1) },
    wide:  { name: 'Wide',  hint: 'Open space, airy top',        p: make([4.5, 1.5, -2, 0, 2.5, 4.5], 50, 45, 150, 30, 1) },
    clear: { name: 'Clear', hint: 'Forward mids, vocals',        p: make([-2, -2, -1.5, 3, 4.5, 2.5], 0, 55, 105, 25, 1) },
    night: { name: 'Night', hint: 'Quiet listening, even level', p: make([5, 3, 0, -1.5, 0, 3], 35, 10, 100, 85, 2) }
  };
  const ORDER = ['auto', 'flat', 'club', 'deep', 'warm', 'wide', 'clear', 'night'];

  const clone = p => ({ bands: p.bands.slice(), bass: p.bass, clarity: p.clarity, width: p.width, glue: p.glue, level: p.level });
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  function satCurve(k, bias) {
    const n = 2048, c = new Float32Array(n);
    const off = Math.tanh(bias);
    for (let i = 0; i < n; i++) { const x = i / (n - 1) * 2 - 1; c[i] = Math.tanh(k * x + bias) - off; }
    return c;
  }

  /** Adds the response of one biquad (peaking or shelf, same maths as the filters) in dB to `out`. */
  function addResponse(out, b, gdb, freqs, fs) {
    if (!gdb) return;
    const A = Math.pow(10, gdb / 40), w0 = 2 * Math.PI * b.f / fs, cw = Math.cos(w0), sw = Math.sin(w0);
    let b0, b1, b2, a0, a1, a2;
    if (b.type === 'peaking') {
      const al = sw / (2 * b.q);
      b0 = 1 + al * A; b1 = -2 * cw; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * cw; a2 = 1 - al / A;
    } else {
      const al = sw / 2 * Math.SQRT2, t = 2 * Math.sqrt(A) * al;
      if (b.type === 'lowshelf') {
        b0 = A * ((A + 1) - (A - 1) * cw + t); b1 = 2 * A * ((A - 1) - (A + 1) * cw); b2 = A * ((A + 1) - (A - 1) * cw - t);
        a0 = (A + 1) + (A - 1) * cw + t; a1 = -2 * ((A - 1) + (A + 1) * cw); a2 = (A + 1) + (A - 1) * cw - t;
      } else {
        b0 = A * ((A + 1) + (A - 1) * cw + t); b1 = -2 * A * ((A - 1) + (A + 1) * cw); b2 = A * ((A + 1) + (A - 1) * cw - t);
        a0 = (A + 1) - (A - 1) * cw + t; a1 = 2 * ((A - 1) - (A + 1) * cw); a2 = (A + 1) - (A - 1) * cw - t;
      }
    }
    for (let i = 0; i < freqs.length; i++) {
      const w = 2 * Math.PI * freqs[i] / fs, c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
      const nr = b0 + b1 * c1 + b2 * c2, ni = -(b1 * s1 + b2 * s2);
      const dr = a0 + a1 * c1 + a2 * c2, di = -(a1 * s1 + a2 * s2);
      out[i] += 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di));
    }
  }

  function create() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;

    // Smart mode needs the float readings of the analysers (iOS 14.5 and later); without them it simply is not offered.
    const AN = window.AnalyserNode && window.AnalyserNode.prototype;
    const S = window.BurzhSmart && AN && AN.getFloatTimeDomainData && AN.getFloatFrequencyData ? window.BurzhSmart : null;
    let ctx = null, g = null, source = null, sourceEl = null;
    let params = clone(PRESETS.flat.p);
    let freqBins = null, lastLevel = 0, timeBins = null;

    // Smart mode: what the music is like (brain) and what it asks of the chain (auto).
    const smart = { on: false, bypass: false, strength: 0.7, profile: 'neutral' };   // bypass: keeps learning, adds nothing (A/B compare)
    const brain = S ? S.createBrain() : null;
    const auto = { gains: new Array(S ? S.N : 9).fill(0), lev: 0, bass: 0, clarity: 0, width: 0, glue: 0 };
    let tickTimer = 0, lastTick = 0, specDb = null, tdMono = null, tdL = null, tdR = null;
    let lastHear = { rmsDb: -120, peakDb: -120 };
    let bypassed = false;
    const ZERO = { gains: new Array(S ? S.N : 9).fill(0), lev: 0, bass: 0, clarity: 0, width: 0, glue: 0 };

    function build() {
      ctx = new AC();
      const n = {};
      n.trim = ctx.createGain();
      n.trim.channelCount = 2; n.trim.channelCountMode = 'explicit'; n.trim.channelInterpretation = 'speakers';
      if (S) {
        n.auto = S.FILTERS.map(b => { const f = ctx.createBiquadFilter(); f.type = b.type; f.frequency.value = b.f; f.Q.value = b.q; f.gain.value = 0; return f; });
        n.lev = ctx.createGain();
        n.tap = ctx.createAnalyser(); n.tap.fftSize = 4096; n.tap.smoothingTimeConstant = 0; n.tap.minDecibels = -140; n.tap.maxDecibels = 0;
        n.meas = ctx.createAnalyser(); n.meas.fftSize = 2048; n.meas.smoothingTimeConstant = 0;
        n.anL = ctx.createAnalyser(); n.anL.fftSize = 2048; n.anL.smoothingTimeConstant = 0;
        n.anR = ctx.createAnalyser(); n.anR.fftSize = 2048; n.anR.smoothingTimeConstant = 0;
      }
      n.hpf = ctx.createBiquadFilter(); n.hpf.type = 'highpass'; n.hpf.frequency.value = 24; n.hpf.Q.value = 0.7;
      n.eq = BANDS.map(b => { const f = ctx.createBiquadFilter(); f.type = b.type; f.frequency.value = b.f; f.Q.value = b.q; f.gain.value = 0; return f; });

      n.dry = ctx.createGain();
      n.bassLp = ctx.createBiquadFilter(); n.bassLp.type = 'lowpass'; n.bassLp.frequency.value = 130; n.bassLp.Q.value = 0.7;
      n.bassShape = ctx.createWaveShaper(); n.bassShape.curve = satCurve(3.2, 0.18); n.bassShape.oversample = '2x';
      n.bassHp = ctx.createBiquadFilter(); n.bassHp.type = 'highpass'; n.bassHp.frequency.value = 70; n.bassHp.Q.value = 0.7;
      n.bassAmt = ctx.createGain(); n.bassAmt.gain.value = 0;
      n.airHp = ctx.createBiquadFilter(); n.airHp.type = 'highpass'; n.airHp.frequency.value = 3200; n.airHp.Q.value = 0.7;
      n.airShape = ctx.createWaveShaper(); n.airShape.curve = satCurve(2.6, 0.3); n.airShape.oversample = '2x';
      n.airHp2 = ctx.createBiquadFilter(); n.airHp2.type = 'highpass'; n.airHp2.frequency.value = 5500; n.airHp2.Q.value = 0.7;
      n.airAmt = ctx.createGain(); n.airAmt.gain.value = 0;
      n.sum = ctx.createGain();

      // Mid/side width.
      n.split = ctx.createChannelSplitter(2);
      n.mid = ctx.createGain();
      n.side = ctx.createGain();
      n.sideHp1 = ctx.createBiquadFilter(); n.sideHp1.type = 'highpass'; n.sideHp1.frequency.value = 150; n.sideHp1.Q.value = 0.7071;
      n.sideHp2 = ctx.createBiquadFilter(); n.sideHp2.type = 'highpass'; n.sideHp2.frequency.value = 150; n.sideHp2.Q.value = 0.7071;
      n.sideDelta = ctx.createGain(); n.sideDelta.gain.value = 0;
      n.sideSum = ctx.createGain();
      n.sideInv = ctx.createGain(); n.sideInv.gain.value = -1;
      n.merge = ctx.createChannelMerger(2);
      const half = (v) => { const x = ctx.createGain(); x.gain.value = v; return x; };
      const mL = half(0.5), mR = half(0.5), sL = half(0.5), sR = half(-0.5);

      n.glue = ctx.createDynamicsCompressor();
      n.glue.knee.value = 8; n.glue.attack.value = 0.012; n.glue.release.value = 0.22; n.glue.threshold.value = 0; n.glue.ratio.value = 1.1;
      n.out = ctx.createGain();
      n.limit = ctx.createDynamicsCompressor();
      n.limit.threshold.value = -1.2; n.limit.knee.value = 0; n.limit.ratio.value = 20; n.limit.attack.value = 0.002; n.limit.release.value = 0.07;
      n.analyser = ctx.createAnalyser();
      n.analyser.fftSize = 2048; n.analyser.smoothingTimeConstant = 0.8; n.analyser.minDecibels = -85; n.analyser.maxDecibels = -12;

      let head = n.trim;
      if (S) {
        n.trim.connect(n.tap);
        n.auto.forEach(f => { head.connect(f); head = f; });
        head.connect(n.lev); head = n.lev;
      }
      head.connect(n.hpf);
      let prev = n.hpf;
      n.eq.forEach(f => { prev.connect(f); prev = f; });
      prev.connect(n.dry); n.dry.connect(n.sum);
      prev.connect(n.bassLp); n.bassLp.connect(n.bassShape); n.bassShape.connect(n.bassHp); n.bassHp.connect(n.bassAmt); n.bassAmt.connect(n.sum);
      prev.connect(n.airHp); n.airHp.connect(n.airShape); n.airShape.connect(n.airHp2); n.airHp2.connect(n.airAmt); n.airAmt.connect(n.sum);

      if (S) n.sum.connect(n.meas);
      n.sum.connect(n.split);
      if (S) { n.split.connect(n.anL, 0); n.split.connect(n.anR, 1); }
      n.split.connect(mL, 0); n.split.connect(mR, 1); mL.connect(n.mid); mR.connect(n.mid);
      n.split.connect(sL, 0); n.split.connect(sR, 1); sL.connect(n.side); sR.connect(n.side);
      n.side.connect(n.sideSum);
      n.side.connect(n.sideHp1); n.sideHp1.connect(n.sideHp2); n.sideHp2.connect(n.sideDelta); n.sideDelta.connect(n.sideSum);
      n.mid.connect(n.merge, 0, 0); n.mid.connect(n.merge, 0, 1);
      n.sideSum.connect(n.merge, 0, 0);
      n.sideSum.connect(n.sideInv); n.sideInv.connect(n.merge, 0, 1);

      n.merge.connect(n.glue); n.glue.connect(n.out); n.out.connect(n.limit);
      n.limit.connect(ctx.destination);
      n.limit.connect(n.analyser);
      freqBins = new Uint8Array(n.analyser.frequencyBinCount);
      timeBins = new Uint8Array(n.analyser.fftSize);
      if (S) { specDb = new Float32Array(n.tap.frequencyBinCount); tdMono = new Float32Array(n.meas.fftSize); tdL = new Float32Array(n.anL.fftSize); tdR = new Float32Array(n.anR.fftSize); }
      g = n;
      ctx.addEventListener('statechange', () => { if (api.onstate) api.onstate(ctx.state); });
    }

    function apply(p, immediate) {
      params = clone(p);
      push(immediate);
    }

    /** Your settings plus what smart mode adds on top: everything the chain does, in one place. */
    function push(immediate) {
      if (!g) return;
      const t = ctx.currentTime, tc = immediate ? 0.001 : 0.03;
      const A = smart.bypass ? ZERO : auto;
      const bass = clamp(params.bass + A.bass, 0, 100), clarity = clamp(params.clarity + A.clarity, 0, 100);
      const width = clamp(params.width + A.width, 0, 160), glue = clamp(params.glue + A.glue, 0, 100);
      g.eq.forEach((f, i) => f.gain.setTargetAtTime(clamp(params.bands[i] || 0, -EQ_RANGE, EQ_RANGE), t, tc));
      if (S) {
        // Bypassing (A/B) is quick; the slow ramps are for the smart mode's own small moves.
        const toggled = smart.bypass !== bypassed;
        g.auto.forEach((f, i) => f.gain.setTargetAtTime(A.gains[i] || 0, t, immediate || toggled ? 0.03 : 0.35));
        g.lev.gain.setTargetAtTime(Math.pow(10, A.lev / 20), t, immediate || toggled ? 0.03 : 0.3);
        bypassed = smart.bypass;
      }

      const boost = Math.max(0, ...params.bands) + bass * 0.05 + clarity * 0.025 + Math.max(0, ...A.gains) * 0.5;
      g.trim.gain.setTargetAtTime(Math.pow(10, -boost * 0.35 / 20), t, tc);

      g.bassAmt.gain.setTargetAtTime(bass / 100 * 1.5, t, tc);
      g.airAmt.gain.setTargetAtTime(clarity / 100 * 0.6, t, tc);

      g.sideDelta.gain.setTargetAtTime(width / 100 - 1, t, tc);

      g.glue.threshold.setTargetAtTime(glue === 0 ? 0 : -8 - 0.2 * glue, t, tc);
      g.glue.ratio.setTargetAtTime(glue === 0 ? 1.1 : 1.5 + 0.025 * glue, t, tc);

      g.out.gain.setTargetAtTime(Math.pow(10, clamp(params.level, -9, 9) / 20), t, tc);
    }

    /* ------------------------------------------------------------------ smart mode */

    function hear() {
      g.meas.getFloatTimeDomainData(tdMono);
      let sq = 0, pk = 0;
      for (let i = 0; i < tdMono.length; i++) { const v = tdMono[i]; sq += v * v; const a = v < 0 ? -v : v; if (a > pk) pk = a; }
      const rms = Math.sqrt(sq / tdMono.length);
      lastHear = { rmsDb: 20 * Math.log10(rms + 1e-9), peakDb: 20 * Math.log10(pk + 1e-9) };
      return lastHear;
    }
    function sideMid() {
      g.anL.getFloatTimeDomainData(tdL); g.anR.getFloatTimeDomainData(tdR);
      let m = 0, sd = 0;
      for (let i = 0; i < tdL.length; i++) { const a = (tdL[i] + tdR[i]) / 2, b = (tdL[i] - tdR[i]) / 2; m += a * a; sd += b * b; }
      return m > 1e-9 ? 10 * Math.log10((sd + 1e-12) / m) : NaN;
    }

    function tick() {
      try { step(); } catch (e) {
        // Whatever went wrong, the music must not suffer: smart mode stops, the chain keeps playing as it is.
        smart.on = false; clearInterval(tickTimer); tickTimer = 0; relax();
        if (api.onerror) api.onerror(e);
      }
    }
    function step() {
      if (!g || ctx.state !== 'running') { lastTick = performance.now(); return; }
      const now = performance.now();
      const dt = Math.min(0.5, (now - lastTick) / 1000) * api.timeScale;
      lastTick = now;
      if (dt <= 0) return;
      if (!smart.on || !S) return;
      const h = hear();
      if (brain.listens(h.rmsDb)) {
        g.tap.getFloatFrequencyData(specDb);
        brain.feed({ powers: S.bandPowers(specDb, ctx.sampleRate), crestDb: h.peakDb - h.rmsDb, sideMidDb: sideMid() }, dt);
      }
      const plan = brain.plan(smart.strength, smart.profile, dt);
      auto.gains = plan.gains; auto.bass = plan.bass; auto.clarity = plan.clarity; auto.width = plan.width; auto.glue = plan.glue;
      auto.lev = brain.level(h, smart.strength, dt);
      push(false);
    }

    function relax() {
      auto.gains.fill(0); auto.lev = 0; auto.bass = auto.clarity = auto.width = auto.glue = 0;
      if (brain) brain.reset(false);
      push(false);
    }

    const api = {
      PRESETS, ORDER, BANDS, EQ_RANGE,
      onstate: null,
      onerror: null,
      timeScale: 1,                       // tests run the smart mode faster than real time
      get smartAvailable() { return !!S; },
      get state() { return ctx ? ctx.state : 'none'; },
      get supported() { return true; },

      /** Route an <audio> element through the chain. The element must be same-origin or CORS-enabled. */
      connect(el) {
        if (!ctx) build();
        if (sourceEl === el) return;
        if (source) { try { source.disconnect(); } catch (e) { /* ignore */ } }
        source = ctx.createMediaElementSource(el);
        sourceEl = el;
        source.connect(g.trim);
        apply(params, true);
      },
      /** Smart mode on/off, how hard it works (0..1) and which target it aims at. Safe at any time. */
      setSmart(o) {
        if (!S) return;
        const was = smart.on;
        if (o.strength != null) smart.strength = clamp(o.strength, 0, 1);
        if (o.profile) smart.profile = o.profile;
        if (o.on != null) smart.on = !!o.on;
        const wasBypass = smart.bypass;
        if (o.bypass != null) smart.bypass = !!o.bypass;
        if (smart.bypass !== wasBypass) push(false);
        if (smart.on && !tickTimer) { lastTick = performance.now(); tickTimer = setInterval(tick, 125); }
        if (!smart.on) { if (tickTimer) { clearInterval(tickTimer); tickTimer = 0; } if (was) relax(); }
      },
      /** A new mix or station: forget the old average quickly, keep the current settings so nothing jumps. */
      smartReset() { if (brain) brain.reset(true); },
      /** For tests and for apps that have their own source: the chain's input and its context. */
      input() { if (!ctx) build(); return { ctx, node: g.trim }; },
      smart() {
        const last = brain && brain.last;
        return {
          available: !!S, on: smart.on, strength: smart.strength, profile: smart.profile,
          bypass: smart.bypass, gains: auto.gains.slice(), lev: auto.lev, bass: auto.bass, clarity: auto.clarity, width: auto.width, glue: auto.glue,
          seconds: brain ? brain.seconds : 0, rmsDb: lastHear.rmsDb, peakDb: lastHear.peakDb,
          measured: last ? last.measured : null, errors: last ? last.errors : null, crest: last ? last.crest : NaN, sideMid: last ? last.sideMid : NaN
        };
      },
      disconnect() { if (source) { try { source.disconnect(); } catch (e) { /* ignore */ } } source = null; sourceEl = null; },
      resume() { return ctx && ctx.state !== 'running' ? ctx.resume().catch(() => {}) : Promise.resolve(); },
      apply,
      get params() { return clone(params); },

      /** EQ curve in dB at the given frequencies, from the same maths as the filters (works before the chain exists). */
      curve(freqs, fs = 48000) {
        const out = new Float32Array(freqs.length);
        BANDS.forEach((b, k) => addResponse(out, b, clamp(params.bands[k] || 0, -EQ_RANGE, EQ_RANGE), freqs, fs));
        return out;
      },

      /** What smart mode is adding to the tone right now, in dB at the given frequencies. */
      autoCurve(freqs, fs = 48000) {
        const out = new Float32Array(freqs.length);
        if (S && !smart.bypass) S.FILTERS.forEach((b, k) => addResponse(out, b, auto.gains[k] || 0, freqs, fs));
        return out;
      },

      /** Nine band levels at the output, dB relative to the whole signal (tests and the readout). */
      outputBands() {
        if (!g || !S || ctx.state !== 'running') return null;
        const db = new Float32Array(g.analyser.frequencyBinCount);
        g.analyser.getFloatFrequencyData(db);
        const pw = S.bandPowers(db, ctx.sampleRate);
        let tot = 0; for (const v of pw) tot += v;
        if (!(tot > 0)) return null;
        return Array.from(pw, v => 10 * Math.log10(Math.max(v, 1e-30) / tot));
      },

      /** Fills `out` with 0..255 magnitudes, low → high frequency. Returns false when idle. */
      spectrum(out) {
        if (!g || ctx.state !== 'running') return false;
        g.analyser.getByteFrequencyData(freqBins);
        for (let i = 0; i < out.length; i++) {
          // Log-spaced read: 30 Hz … 16 kHz.
          const f = 30 * Math.pow(16000 / 30, i / (out.length - 1));
          const bin = clamp(Math.round(f / (ctx.sampleRate / 2) * freqBins.length), 0, freqBins.length - 1);
          out[i] = freqBins[bin];
        }
        return true;
      },

      /** True once any non-silent sample has come out of the chain. Used to detect a muted route. */
      hasSignal() {
        if (!g || ctx.state !== 'running') return false;
        g.analyser.getByteTimeDomainData(timeBins);
        for (let i = 0; i < timeBins.length; i++) if (timeBins[i] !== 128) return true;
        return false;
      },
      info() { return ctx ? ctx.state + ' · ' + Math.round(ctx.sampleRate / 100) / 10 + ' kHz' : 'not started'; },

      /** Low-end energy 0..1 for visuals; null while the chain is not running. */
      level() {
        if (!g || ctx.state !== 'running') return null;
        g.analyser.getByteFrequencyData(freqBins);
        const bin = f => Math.round(f / (ctx.sampleRate / 2) * freqBins.length);
        let sum = 0, cnt = 0;
        for (let i = bin(40); i <= bin(140); i++) { sum += freqBins[i]; cnt++; }
        const v = cnt ? sum / cnt / 255 : 0;
        lastLevel = clamp((v - 0.5) / 0.4, 0, 1);
        return lastLevel;
      }
    };
    return api;
  }

  window.BurzhSound = { create, PRESETS, ORDER, BANDS, EQ_RANGE, clone };
})();
