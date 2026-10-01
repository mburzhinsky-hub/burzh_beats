/* BURZH sound — a small mastering chain for the radio.
 *
 *   in → trim → rumble filter → 6-band EQ ─┬─ dry ────────────────┐
 *                                          ├─ bass enhancer ──────┤
 *                                          └─ clarity exciter ────┤
 *   → stereo width (mid/side) → glue compressor → level → limiter → out
 *
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
  const EQ_RANGE = 10; // dB either way

  const make = (bands, bass, clarity, width, glue, level) => ({ bands, bass, clarity, width, glue, level });
  const PRESETS = {
    flat:  { name: 'Flat',  hint: 'Untouched sound',            p: make([0, 0, 0, 0, 0, 0], 0, 0, 100, 0, 0) },
    club:  { name: 'Club',  hint: 'Punchy low end, bright top', p: make([3.5, 2, -1.5, -0.5, 1.5, 2.5], 35, 25, 115, 35, 0) },
    deep:  { name: 'Deep',  hint: 'Heavy sub, smooth highs',    p: make([4.5, 2.5, -0.5, -1.5, -0.5, 1], 45, 10, 105, 30, 0) },
    warm:  { name: 'Warm',  hint: 'Tape-like, soft top',        p: make([2, 2.5, 1.5, -0.5, -2.5, -4], 20, 0, 95, 45, 0) },
    wide:  { name: 'Wide',  hint: 'Open space, airy top',       p: make([3, 1, -1, 0, 1.5, 3], 40, 30, 135, 25, 0) },
    clear: { name: 'Clear', hint: 'Forward mids, vocals',       p: make([-1, -1, -1, 1.5, 2.5, 1], 0, 35, 100, 20, 0) },
    night: { name: 'Night', hint: 'Quiet listening, even level', p: make([3, 2, 0, -1, 0, 2], 25, 0, 100, 70, 1) }
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

  function create() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;

    let ctx = null, g = null, source = null, sourceEl = null;
    let params = clone(PRESETS.flat.p);
    let freqBins = null, lastLevel = 0, timeBins = null;

    function build() {
      ctx = new AC();
      const n = {};
      n.trim = ctx.createGain();
      n.trim.channelCount = 2; n.trim.channelCountMode = 'explicit'; n.trim.channelInterpretation = 'speakers';
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

      n.trim.connect(n.hpf);
      let prev = n.hpf;
      n.eq.forEach(f => { prev.connect(f); prev = f; });
      prev.connect(n.dry); n.dry.connect(n.sum);
      prev.connect(n.bassLp); n.bassLp.connect(n.bassShape); n.bassShape.connect(n.bassHp); n.bassHp.connect(n.bassAmt); n.bassAmt.connect(n.sum);
      prev.connect(n.airHp); n.airHp.connect(n.airShape); n.airShape.connect(n.airHp2); n.airHp2.connect(n.airAmt); n.airAmt.connect(n.sum);

      n.sum.connect(n.split);
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
      g = n;
      ctx.addEventListener('statechange', () => { if (api.onstate) api.onstate(ctx.state); });
    }

    function apply(p, immediate) {
      params = clone(p);
      if (!g) return;
      const t = ctx.currentTime, tc = immediate ? 0.001 : 0.03;
      g.eq.forEach((f, i) => f.gain.setTargetAtTime(clamp(params.bands[i] || 0, -EQ_RANGE, EQ_RANGE), t, tc));

      const boost = Math.max(0, ...params.bands) + params.bass * 0.05 + params.clarity * 0.025;
      g.trim.gain.setTargetAtTime(Math.pow(10, -boost * 0.85 / 20), t, tc);

      g.bassAmt.gain.setTargetAtTime(params.bass / 100 * 0.9, t, tc);
      g.airAmt.gain.setTargetAtTime(params.clarity / 100 * 0.32, t, tc);

      const w = clamp(params.width, 0, 160) / 100;
      g.sideDelta.gain.setTargetAtTime(w - 1, t, tc);

      const gl = clamp(params.glue, 0, 100);
      g.glue.threshold.setTargetAtTime(gl === 0 ? 0 : -8 - 0.2 * gl, t, tc);
      g.glue.ratio.setTargetAtTime(gl === 0 ? 1.1 : 1.5 + 0.025 * gl, t, tc);

      g.out.gain.setTargetAtTime(Math.pow(10, clamp(params.level, -9, 9) / 20), t, tc);
    }

    const api = {
      PRESETS, ORDER, BANDS, EQ_RANGE,
      onstate: null,
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
      disconnect() { if (source) { try { source.disconnect(); } catch (e) { /* ignore */ } } source = null; sourceEl = null; },
      resume() { return ctx && ctx.state !== 'running' ? ctx.resume().catch(() => {}) : Promise.resolve(); },
      apply,
      get params() { return clone(params); },

      /** EQ curve in dB at the given frequencies, from the same maths as the filters (works before the chain exists). */
      curve(freqs, fs = 48000) {
        const out = new Float32Array(freqs.length);
        BANDS.forEach((b, k) => {
          const gdb = clamp(params.bands[k] || 0, -EQ_RANGE, EQ_RANGE);
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
        });
        return out;
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
