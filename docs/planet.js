/* BURZH planet — a dot-matrix globe drawn on canvas.
 *
 * The sphere is a Fibonacci lattice of dots, lit from the upper left, with
 * terrain noise so its rotation can actually be seen. Every station owns a
 * "transmitter" on the globe: tuning to another station spins the planet
 * until that transmitter faces you. A comet rides the orbit ring, and both
 * respond to the music level (real bass energy when the sound engine is on,
 * a slow breathing otherwise).
 */
(() => {
  'use strict';

  const TAU = Math.PI * 2;
  const GOLDEN = Math.PI * (3 - Math.sqrt(5));
  const BUCKETS = 10;
  const reduceMotion = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  const easeOut = t => 1 - Math.pow(1 - t, 3);

  function hash(x, y, z, s) {
    let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 2147483629) ^ Math.imul(s, 1274126177);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }
  function vnoise(x, y, z, s) {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    const xf = x - xi, yf = y - yi, zf = z - zi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf);
    const l = (a, b, t) => a + (b - a) * t;
    return l(
      l(l(hash(xi, yi, zi, s), hash(xi + 1, yi, zi, s), u), l(hash(xi, yi + 1, zi, s), hash(xi + 1, yi + 1, zi, s), u), v),
      l(l(hash(xi, yi, zi + 1, s), hash(xi + 1, yi, zi + 1, s), u), l(hash(xi, yi + 1, zi + 1, s), hash(xi + 1, yi + 1, zi + 1, s), u), v),
      w);
  }
  function terrain(x, y, z, s) {
    return vnoise(x * 1.7, y * 1.7, z * 1.7, s) * 0.58 + vnoise(x * 3.6, y * 3.6, z * 3.6, s + 7) * 0.30 + vnoise(x * 7.5, y * 7.5, z * 7.5, s + 13) * 0.12;
  }
  function hashString(str) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }

  const LIGHT = (() => { const l = [-0.55, 0.5, 0.67]; const n = Math.hypot(l[0], l[1], l[2]); return l.map(v => v / n); })();
  const AXIS_TILT = 0.41;                 // planet axis, 23.5°
  const ORBIT_TILT = 0.38, ORBIT_ROLL = -0.54;
  const STAR_COUNT = 46;
  const BEACON_LAT = [0.34, -0.28, 0.12, -0.5];

  const bucketColor = Array.from({ length: BUCKETS }, (_, b) => {
    const i = (b + 0.5) / BUCKETS;
    const v = Math.round(64 + 191 * i);
    return 'rgba(' + v + ',' + v + ',' + (v - 4) + ',' + (0.22 + 0.78 * i).toFixed(3) + ')';
  });

  function create(box, opts = {}) {
    const canvas = document.createElement('canvas');
    canvas.setAttribute('aria-hidden', 'true');
    canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block';
    if (getComputedStyle(box).position === 'static') box.style.position = 'relative';
    box.appendChild(canvas);
    const ctx = canvas.getContext('2d');

    let W = 0, H = 0, dpr = 1, cx = 0, cy = 0, S = 0, R = 0, Ro = 0;
    let pts = null;               // { n, x, y, z, land, h }
    let seed = 1, accent = '#ff3b30';
    let stationIndex = 0, stationCount = 4, period = 14;
    let playing = false;
    let spin = 0.6, omega = 0.035, seek = null;
    let orbit = 0.4, orbitRate = 0.2;
    let level = 0, glow = 0.25, reveal = 0;
    let last = 0, lastDraw = 0, raf = 0, started = 0;
    const stars = Array.from({ length: STAR_COUNT }, (_, i) => ({
      x: hash(i, 1, 2, 91), y: hash(i, 3, 4, 91), r: 0.5 + hash(i, 5, 6, 91) * 0.9, p: hash(i, 7, 8, 91) * TAU, s: 0.4 + hash(i, 9, 1, 91) * 1.2
    }));

    function buildPoints() {
      // Rows of dots by latitude (like an LED globe): clean at any size, no moiré.
      const spacing = clamp(R * 0.062, 4.2, 11);
      const rows = Math.max(8, Math.round(Math.PI * R / spacing));
      const xs = [], ys = [], zs = [], hs = [];
      for (let j = 0; j < rows; j++) {
        const lat = -Math.PI / 2 + (j + 0.5) * Math.PI / rows;
        const cl = Math.cos(lat), sl = Math.sin(lat);
        const count = Math.max(1, Math.round(TAU * cl * R / spacing));
        const phase = (j % 2) * 0.5;
        for (let k = 0; k < count; k++) {
          const lon = (k + phase) / count * TAU;
          xs.push(cl * Math.sin(lon)); ys.push(sl); zs.push(cl * Math.cos(lon));
          hs.push(hash(j, k, 5, 3));
        }
      }
      const n = xs.length;
      pts = {
        n, x: Float32Array.from(xs), y: Float32Array.from(ys), z: Float32Array.from(zs),
        land: new Float32Array(n), h: Float32Array.from(hs),
        sx: new Float32Array(n), sy: new Float32Array(n), sr: new Float32Array(n), sb: new Uint8Array(n)
      };
      buildTerrain();
    }
    function buildTerrain() {
      if (!pts) return;
      for (let i = 0; i < pts.n; i++) pts.land[i] = smooth(0.46, 0.56, terrain(pts.x[i] + 3.1, pts.y[i] + 1.7, pts.z[i] + 5.3, seed));
    }

    function resize() {
      const r = box.getBoundingClientRect();
      W = Math.round(r.width); H = Math.round(r.height);
      if (W < 8 || H < 8) { W = H = 0; return; }
      dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      S = Math.min(W, H); cx = W / 2; cy = H / 2;
      R = S * 0.3; Ro = Math.min(S * 0.47, W * 0.49);
      buildPoints();
      draw(performance.now(), 0);
    }

    function orbitPoint(theta) {
      const x0 = Ro * Math.cos(theta), z0 = Ro * Math.sin(theta);
      const y1 = -z0 * Math.sin(ORBIT_TILT), z1 = z0 * Math.cos(ORBIT_TILT);
      const c = Math.cos(ORBIT_ROLL), s = Math.sin(ORBIT_ROLL);
      return { x: cx + x0 * c - y1 * s, y: cy + x0 * s + y1 * c, z: z1 };
    }
    const inDisc = p => Math.hypot(p.x - cx, p.y - cy) < R * 1.005;

    function dot(x, y, r, fill) { ctx.fillStyle = fill; ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill(); }

    function drawTrack(front, t) {
      const M = 132;
      for (let k = 0; k < M; k++) {
        const p = orbitPoint(k / M * TAU);
        const isFront = p.z > 0;
        if (isFront !== front) continue;
        if (!isFront && inDisc(p)) continue;
        ctx.fillStyle = isFront ? 'rgba(236,237,231,.5)' : 'rgba(205,207,202,.18)';
        ctx.beginPath(); ctx.arc(p.x, p.y, isFront ? 1.25 : 1, 0, TAU); ctx.fill();
      }
    }

    function drawComet(front) {
      const TRAIL = 30, step = 0.05;
      for (let j = TRAIL; j >= 0; j--) {
        const p = orbitPoint(orbit - j * step);
        const isFront = p.z > 0;
        if (isFront !== front) continue;
        if (!isFront && inDisc(p)) continue;
        const f = 1 - j / TRAIL;
        const a = Math.pow(f, 1.7) * (isFront ? 0.95 : 0.5);
        if (j === 0) {
          const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, R * (0.2 + 0.1 * level));
          g.addColorStop(0, accent); g.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.globalAlpha = (0.38 + 0.3 * glow) * (isFront ? 1 : 0.6);
          ctx.fillStyle = g; ctx.beginPath(); ctx.arc(p.x, p.y, R * 0.32, 0, TAU); ctx.fill();
          ctx.globalAlpha = isFront ? 1 : 0.7;
          dot(p.x, p.y, R * 0.036 * (1 + 0.25 * level), accent);
          dot(p.x, p.y, R * 0.014, '#fff4f0');
          ctx.globalAlpha = 1;
        } else {
          ctx.globalAlpha = a;
          dot(p.x, p.y, R * 0.03 * (0.35 + 0.65 * f), accent);
          ctx.globalAlpha = 1;
        }
      }
    }

    function draw(now, dt) {
      if (!W) return;
      const t = now / 1000;
      ctx.clearRect(0, 0, W, H);

      // Atmosphere behind everything.
      const halo = ctx.createRadialGradient(cx, cy, R * 0.85, cx, cy, R * 1.75);
      halo.addColorStop(0, accent); halo.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.globalAlpha = 0.035 + 0.1 * glow + 0.05 * level;
      ctx.fillStyle = halo; ctx.beginPath(); ctx.arc(cx, cy, R * 1.8, 0, TAU); ctx.fill();
      ctx.globalAlpha = 1;

      // Stars.
      for (const s of stars) {
        const a = 0.14 + 0.2 * (0.5 + 0.5 * Math.sin(t * s.s + s.p));
        ctx.fillStyle = 'rgba(215,216,210,' + a.toFixed(3) + ')';
        ctx.fillRect(s.x * W, s.y * H, s.r, s.r);
      }

      drawTrack(false, t);
      drawComet(false);

      // Planet.
      const cs = Math.cos(spin), sn = Math.sin(spin), ca = Math.cos(AXIS_TILT), sa = Math.sin(AXIS_TILT);
      const scale = 1 + 0.05 * level;
      const dotR = Math.max(1.2, R * 0.03);
      const { n, x, y, z, land, h, sx, sy, sr, sb } = pts;
      for (let i = 0; i < n; i++) {
        sb[i] = 255;
        if (h[i] > reveal) continue;
        const x1 = x[i] * cs + z[i] * sn, z1 = -x[i] * sn + z[i] * cs;
        const y2 = y[i] * ca - z1 * sa, z2 = y[i] * sa + z1 * ca;
        if (z2 < 0) continue;
        const lit = Math.max(0, x1 * LIGHT[0] + y2 * LIGHT[1] + z2 * LIGHT[2]);
        const rim = Math.pow(1 - z2, 3) * (lit > 0 ? 0.5 : 0.18);
        let I = (0.16 + 0.84 * Math.pow(lit, 0.85)) * (0.38 + 0.62 * land[i]) + rim * 0.4;
        I = clamp(I, 0, 1);
        sx[i] = cx + x1 * R; sy[i] = cy - y2 * R;
        sr[i] = dotR * (0.34 + 0.66 * I) * (0.6 + 0.4 * z2) * scale * (reveal < 1 ? Math.min(1, (reveal - h[i]) * 9 + 0.35) : 1);
        sb[i] = Math.min(BUCKETS - 1, Math.floor(I * BUCKETS));
      }
      for (let b = 0; b < BUCKETS; b++) {
        ctx.fillStyle = bucketColor[b];
        ctx.beginPath();
        for (let i = 0; i < n; i++) {
          if (sb[i] !== b) continue;
          ctx.moveTo(sx[i] + sr[i], sy[i]);
          ctx.arc(sx[i], sy[i], sr[i], 0, TAU);
        }
        ctx.fill();
      }

      // Station transmitters.
      for (let k = 0; k < stationCount; k++) {
        const lon = k * TAU / stationCount + 0.5, lat = BEACON_LAT[k % BEACON_LAT.length];
        const bx = Math.cos(lat) * Math.sin(lon), by = Math.sin(lat), bz = Math.cos(lat) * Math.cos(lon);
        const x1 = bx * cs + bz * sn, z1 = -bx * sn + bz * cs;
        const y2 = by * ca - z1 * sa, z2 = by * sa + z1 * ca;
        if (z2 < 0.04) continue;
        const px = cx + x1 * R, py = cy - y2 * R;
        const on = k === stationIndex;
        const vis = smooth(0.04, 0.35, z2);
        if (on) {
          const ph = (t * 0.55) % 1;
          ctx.globalAlpha = (1 - ph) * 0.55 * vis;
          ctx.strokeStyle = accent; ctx.lineWidth = 1.2;
          ctx.beginPath(); ctx.arc(px, py, R * (0.03 + 0.1 * ph), 0, TAU); ctx.stroke();
          ctx.globalAlpha = vis;
          dot(px, py, R * 0.038 * (1 + 0.45 * level), accent);
          dot(px, py, R * 0.014, '#fff4f0');
        } else {
          ctx.globalAlpha = 0.55 * vis;
          ctx.strokeStyle = 'rgba(236,237,231,.8)'; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.arc(px, py, R * 0.02, 0, TAU); ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }

      drawTrack(true, t);
      drawComet(true);
    }

    function tick(now) {
      raf = requestAnimationFrame(tick);
      if (!W) { resizeLater(); return; }
      const interval = playing ? 0 : 33;
      if (now - lastDraw < interval) return;
      const dt = Math.min(0.1, (now - (last || now)) / 1000);
      last = now; lastDraw = now;

      const motion = reduceMotion.matches ? 0 : 1;
      const target = (playing ? 0.17 : 0.035) * motion;
      omega += (target - omega) * (1 - Math.exp(-dt * 1.6));
      if (seek) {
        const p = clamp((now - seek.t0) / seek.dur, 0, 1);
        spin = seek.from + (seek.to - seek.from) * easeOut(p);
        if (p >= 1) { spin = seek.to; seek = null; }
      } else {
        spin += omega * dt;
      }
      orbitRate += ((TAU / period) * (playing ? 1 : 0.3) * motion - orbitRate) * (1 - Math.exp(-dt * 1.2));
      orbit += orbitRate * dt;

      let want = 0;
      if (playing) {
        const real = opts.getLevel ? opts.getLevel() : null;
        want = real === null || real === undefined ? 0.35 + 0.25 * Math.sin(now / 1000 * 1.1) : real;
      }
      level += (want - level) * (1 - Math.exp(-dt * (want > level ? 16 : 5)));
      glow += ((playing ? 0.9 : 0.25) - glow) * (1 - Math.exp(-dt * 1.4));
      if (reveal < 1) reveal = Math.min(1.2, reveal + dt / 1.0);

      draw(now, dt);
    }

    let resizeTimer = 0;
    function resizeLater() { if (resizeTimer) return; resizeTimer = setTimeout(() => { resizeTimer = 0; resize(); }, 120); }

    if ('ResizeObserver' in window) new ResizeObserver(resizeLater).observe(box);
    else window.addEventListener('resize', resizeLater);
    resize();
    raf = requestAnimationFrame(tick);

    return {
      setPlaying(on) { playing = !!on; },
      setStation(st, index, count, { instant = false } = {}) {
        const nextSeed = hashString(st.id) % 997 + 1;
        const changed = nextSeed !== seed || index !== stationIndex;
        seed = nextSeed;
        stationIndex = index; stationCount = Math.max(1, count);
        period = Math.max(6, Number(st.tempo) || 14);
        accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#ff3b30';
        buildTerrain();
        if (!changed) return;
        const lon = index * TAU / stationCount + 0.5;
        let to = -lon;
        const base = spin;
        to += Math.ceil((base - to) / TAU) * TAU;   // next time the transmitter faces you
        if (!instant && !reduceMotion.matches) { seek = { from: base, to: to + TAU, t0: performance.now(), dur: 1800 }; reveal = 0.25; }
        else { spin = to; seek = null; reveal = instant ? 0 : 1; }
      },
      resize,
      destroy() { cancelAnimationFrame(raf); canvas.remove(); }
    };
  }

  window.BurzhPlanet = { create };
})();
