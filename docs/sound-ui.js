/* BURZH equalizer view — a draggable response curve over a live spectrum. */
(() => {
  'use strict';

  const FMIN = 30, FMAX = 16000, BARS = 64;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  function create(canvas, opts) {
    const ctx = canvas.getContext('2d');
    const { BANDS, EQ_RANGE } = window.BurzhSound;
    const curveFreqs = Array.from({ length: 110 }, (_, i) => FMIN * Math.pow(FMAX / FMIN, i / 109));
    const spec = new Uint8Array(BARS);
    const smooth = new Float32Array(BARS);
    let W = 0, H = 0, dpr = 1, raf = 0, running = false;
    let drag = -1, lastTap = { i: -1, t: 0 };
    const PAD = 22, TOP = 16, BOTTOM = 24;

    const fx = f => PAD + Math.log(f / FMIN) / Math.log(FMAX / FMIN) * (W - 2 * PAD);
    const plotH = () => H - TOP - BOTTOM;
    const dy = db => TOP + plotH() / 2 - db / EQ_RANGE * (plotH() / 2);
    const dbAt = y => clamp(Math.round((TOP + plotH() / 2 - y) / (plotH() / 2) * EQ_RANGE * 2) / 2, -EQ_RANGE, EQ_RANGE);

    function resize() {
      const r = canvas.getBoundingClientRect();
      W = Math.round(r.width); H = Math.round(r.height);
      if (!W || !H) return;
      dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = W * dpr; canvas.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function draw() {
      if (!W || !H) { resize(); if (!W) return; }
      const params = opts.getParams();
      const pal = window.BurzhTheme ? window.BurzhTheme.read() : null;
      const accent = pal ? pal.accent : '#ff3b30';
      const ink = pal ? pal.ink : [241, 241, 236];
      const mute = pal ? pal.eqMuted : [139, 140, 134];
      const acc = pal ? pal.accentRgb : [255, 59, 48];
      const handle = pal ? pal.eqHandle : '#070808';
      const core = pal ? pal.core : '#fff4f0';
      const rgba = (c, a) => 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')';
      const inkSolid = rgba(ink, 1);
      ctx.clearRect(0, 0, W, H);
      ctx.font = '10px "IBM Plex Mono", monospace';
      ctx.textBaseline = 'alphabetic';

      // Grid.
      [-EQ_RANGE, -EQ_RANGE / 2, 0, EQ_RANGE / 2, EQ_RANGE].forEach(db => {
        const y = dy(db);
        ctx.strokeStyle = db === 0 ? rgba(ink, .22) : rgba(ink, .07);
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(PAD - 6, y + .5); ctx.lineTo(W - PAD + 6, y + .5); ctx.stroke();
      });
      ctx.fillStyle = rgba(mute, .8);
      ctx.textAlign = 'left';
      ctx.fillText('+' + EQ_RANGE, 6, dy(EQ_RANGE) - 3);
      ctx.fillText('−' + EQ_RANGE, 6, dy(-EQ_RANGE) + 11);

      // Live spectrum.
      const live = opts.engine && opts.engine.spectrum(spec);
      if (live) {
        const bw = (W - 2 * PAD) / BARS;
        const base = H - BOTTOM;
        for (let i = 0; i < BARS; i++) {
          smooth[i] += (spec[i] - smooth[i]) * (spec[i] > smooth[i] ? 0.6 : 0.18);
          const h = Math.pow(smooth[i] / 255, 1.5) * plotH() * 0.95;
          ctx.fillStyle = rgba(acc, (0.1 + 0.2 * smooth[i] / 255).toFixed(3));
          ctx.fillRect(PAD + i * bw + 0.5, base - h, Math.max(1, bw - 1.5), h);
        }
      } else { smooth.fill(0); }

      // Band columns + labels.
      ctx.textAlign = 'center';
      BANDS.forEach((b, i) => {
        const x = fx(b.f);
        ctx.strokeStyle = rgba(ink, .06);
        ctx.beginPath(); ctx.moveTo(x + .5, TOP); ctx.lineTo(x + .5, H - BOTTOM); ctx.stroke();
        ctx.fillStyle = i === drag ? inkSolid : rgba(mute, .9);
        ctx.fillText(b.label, x, H - 8);
      });

      // Response curve.
      const db = opts.engine.curve(curveFreqs);
      ctx.beginPath();
      curveFreqs.forEach((f, i) => { const x = fx(f), y = dy(clamp(db[i], -EQ_RANGE * 1.4, EQ_RANGE * 1.4)); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
      ctx.strokeStyle = inkSolid; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.stroke();
      ctx.lineTo(fx(FMAX), dy(0)); ctx.lineTo(fx(FMIN), dy(0)); ctx.closePath();
      ctx.fillStyle = rgba(ink, .06); ctx.fill();

      // Handles.
      BANDS.forEach((b, i) => {
        const x = fx(b.f), y = dy(params.bands[i] || 0), on = i === drag;
        if (on) {
          const g = ctx.createRadialGradient(x, y, 0, x, y, 26);
          g.addColorStop(0, rgba(acc, .45)); g.addColorStop(1, rgba(acc, 0));
          ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, 26, 0, Math.PI * 2); ctx.fill();
        }
        ctx.beginPath(); ctx.arc(x, y, on ? 9 : 7, 0, Math.PI * 2);
        ctx.fillStyle = on ? accent : handle; ctx.fill();
        ctx.lineWidth = 2; ctx.strokeStyle = on ? core : inkSolid; ctx.stroke();
        if (on) {
          const v = params.bands[i] || 0;
          const label = (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(1) + ' dB';
          ctx.fillStyle = inkSolid; ctx.textAlign = 'center';
          ctx.fillText(label, clamp(x, 28, W - 28), y < TOP + 26 ? y + 24 : y - 16);
        }
      });
    }

    function nearest(x) {
      let best = 0, d = Infinity;
      BANDS.forEach((b, i) => { const e = Math.abs(fx(b.f) - x); if (e < d) { d = e; best = i; } });
      return best;
    }
    function pos(e) { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }

    canvas.addEventListener('pointerdown', e => {
      const p = pos(e);
      drag = nearest(p.x);
      try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      const now = Date.now();
      if (lastTap.i === drag && now - lastTap.t < 340) { opts.onBand(drag, 0); lastTap = { i: -1, t: 0 }; }
      else { lastTap = { i: drag, t: now }; opts.onBand(drag, dbAt(p.y)); }
      draw();
    });
    canvas.addEventListener('pointermove', e => {
      if (drag < 0) return;
      opts.onBand(drag, dbAt(pos(e).y));
      draw();
    });
    const end = () => { if (drag < 0) return; drag = -1; opts.onCommit(); draw(); };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);

    function loop() {
      if (!running) return;
      draw();
      raf = setTimeout(() => requestAnimationFrame(loop), 33);
    }
    if ('ResizeObserver' in window) new ResizeObserver(() => { resize(); draw(); }).observe(canvas);
    if (window.BurzhTheme) window.BurzhTheme.onChange(() => draw());

    return {
      draw,
      start() { if (running) return; running = true; resize(); loop(); },
      stop() { running = false; clearTimeout(raf); }
    };
  }

  window.BurzhEqView = { create };
})();
