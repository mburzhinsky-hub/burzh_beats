/* BURZH planet — a dot-matrix globe drawn on canvas.
 *
 * The sphere is a lattice of dots (rows by latitude, like an LED globe), lit from the upper left, with
 * terrain noise so its rotation can actually be seen. Every station owns a
 * "transmitter" on the globe: tuning to another station spins the planet
 * until that transmitter faces you. Comets ride the orbit rings, and everything
 * responds to the music level (real bass energy when the sound engine is on,
 * a slow breathing otherwise; a kick makes a ring leave the planet).
 *
 * Every station has its own character ("look" in stations.json): how fast the planet
 * turns, how many rings it has and how they are tilted, how coarse the dots are, how wide
 * the glow is, how hard it pulses, tape flutter, falling rain, a second comet. Changing
 * station glides from one look to the next.
 */
(() => {
  'use strict';

  const TAU = Math.PI * 2;
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
  const STAR_COUNT = 46, STAR_RAIN = 64;  // the extra stars only show up as rain
  const BEACON_LAT = [0.34, -0.28, 0.12, -0.5];
  const RING_K = [1, 0.87, 0.75];         // ring radius relative to the outer ring
  const COMET_DIR = [1, -1], COMET_SPEED = [1, 1.3], COMET_SIZE = [1, 0.8];
  const KICK_MS = 700, KICK_MAX = 5, KICK_GAP_MS = 240;

  // A station's character. The defaults are the planet as it looked before stations had one.
  const LOOK = {
    spin: 1,        // rotation speed, 1 = normal
    rings: 1,       // orbit rings, 1..3
    spread: 0,      // how far the inner rings are turned against the outer one (radians)
    tilt: 0.38,     // ring tilt: 0 = edge-on, larger = looking down on it
    roll: -0.54,    // ring rotation on screen (radians)
    grain: 1,       // dot size/spacing: < 1 finer, > 1 coarser
    land: 0,        // shifts the coastline: > 0 more sea
    halo: 1,        // glow around the planet
    pulse: 1,       // how hard the music moves the planet
    flutter: 0,     // tape wobble of the spin (lo-fi)
    rain: 0,        // stars fall as rain
    comets: 1       // 1 or 2
  };
  const LIMITS = {
    spin: [0.2, 2.5], rings: [1, 3], spread: [0, 1.2], tilt: [0.1, 0.9], roll: [-1.4, 1.4], grain: [0.7, 1.5],
    land: [-0.06, 0.08], halo: [0.5, 2], pulse: [0, 2], flutter: [0, 0.6], rain: [0, 1], comets: [1, 2]
  };
  const INTEGER = { rings: true, comets: true };
  const GLIDE = Object.keys(LOOK).filter(k => k !== 'grain' && k !== 'land');   // the rest changes with the new terrain

  function normaliseLook(raw) {
    const out = {};
    for (const key of Object.keys(LOOK)) {
      const v = raw && raw[key] !== null && raw[key] !== undefined && raw[key] !== '' ? Number(raw[key]) : NaN;
      let n = Number.isFinite(v) ? clamp(v, LIMITS[key][0], LIMITS[key][1]) : LOOK[key];
      if (INTEGER[key]) n = Math.round(n);
      out[key] = n;
    }
    return out;
  }

  // Used only if theme.js is missing: the original Black palette.
  const FALLBACK = {
    accent: '#ff3b30', accentRgb: [255, 59, 48], core: '#fff4f0',
    planetDim: [64, 64, 60], planetLit: [255, 255, 251], planetA0: 0.22, planetA1: 1,
    star: [215, 216, 210], starK: 1, trackFront: 'rgba(236,237,231,.5)', trackBack: 'rgba(205,207,202,.18)',
    beacon: 'rgba(236,237,231,.8)', haloK: 1
  };
  const readPalette = () => (window.BurzhTheme ? window.BurzhTheme.read() : FALLBACK);
  const parseColor = (text, fallback) => (window.BurzhTheme ? window.BurzhTheme.rgb(text, fallback) : fallback);
  // Dot colour runs from "dim" (shadow side) to "lit" (towards the light), growing more opaque on the way.
  const bucketsFor = p => Array.from({ length: BUCKETS }, (_, b) => {
    const i = (b + 0.5) / BUCKETS;
    const c = p.planetDim.map((d, k) => Math.round(d + (p.planetLit[k] - d) * i));
    return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + (p.planetA0 + (p.planetA1 - p.planetA0) * i).toFixed(3) + ')';
  });

  function create(box, opts = {}) {
    const canvas = document.createElement('canvas');
    canvas.setAttribute('aria-hidden', 'true');
    canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block';
    if (getComputedStyle(box).position === 'static') box.style.position = 'relative';
    box.appendChild(canvas);
    const ctx = canvas.getContext('2d');
    // Calm mode: no motion at all (the person asked the phone for "reduce motion", or chose it in Settings).
    const isCalm = () => (opts.calm ? !!opts.calm() : reduceMotion.matches);

    let W = 0, H = 0, dpr = 1, cx = 0, cy = 0, S = 0, R = 0, Ro = 0;
    let pts = null;               // { n, x, y, z, land, h }
    let seed = 1;

    // Colours. The accent glides to the next station's colour instead of jumping.
    let pal = readPalette(), bucketColor = bucketsFor(pal);
    let accRgb = pal.accentRgb.slice(), accGoal = pal.accentRgb, coreBase = parseColor(pal.core, [255, 244, 240]);
    let accent = '', accentClear = '', core = '';
    function paintAccent() {
      const c = accRgb.map(Math.round);
      accent = 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')';
      accentClear = 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',0)';
      const m = coreBase.map((v, k) => Math.round(v + (c[k] - v) * 0.14));       // a hint of the station colour
      core = 'rgb(' + m[0] + ',' + m[1] + ',' + m[2] + ')';
    }
    function applyPalette(p, instant) {
      pal = p; bucketColor = bucketsFor(p); accGoal = p.accentRgb; coreBase = parseColor(p.core, coreBase);
      if (instant) accRgb = accGoal.slice();
      paintAccent();
    }
    paintAccent();
    if (window.BurzhTheme) window.BurzhTheme.onChange(p => applyPalette(p, false));

    let stationIndex = 0, stationCount = 4, period = 14;
    let playing = false;
    let spin = 0.6, omega = 0.035, seek = null;
    const cAng = [0.4, 0.4 + Math.PI], cRing = [0, 1];
    let orbitRate = 0.2;
    let level = 0, glow = 0.25, reveal = 0;
    let last = 0, lastDraw = 0, raf = 0;
    // Character: `goal` is the station's look, `cur` glides towards it.
    let goal = normaliseLook(null), cur = Object.assign({}, goal);
    let grain = 1, landShift = 0;
    // Music onsets: a rising edge in the bass level sends a ring away from the planet.
    let env = 0, lastKick = 0, kickCount = 0, kicks = [];
    let rainT = 0;
    const stars = Array.from({ length: STAR_RAIN }, (_, i) => ({
      x: hash(i, 1, 2, 91), y: hash(i, 3, 4, 91), r: 0.5 + hash(i, 5, 6, 91) * 0.9, p: hash(i, 7, 8, 91) * TAU, s: 0.4 + hash(i, 9, 1, 91) * 1.2
    }));

    function buildPoints() {
      // Rows of dots by latitude (like an LED globe): clean at any size, no moiré.
      const spacing = clamp(R * 0.062 * grain, 3.4, 13);
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
      const a = 0.46 + landShift, b = 0.56 + landShift;
      for (let i = 0; i < pts.n; i++) pts.land[i] = smooth(a, b, terrain(pts.x[i] + 3.1, pts.y[i] + 1.7, pts.z[i] + 5.3, seed));
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
      draw(performance.now());
    }

    // Ring `ring` (0 = outer). Inner rings are a little smaller and can be turned against the outer one.
    function orbitPoint(theta, ring) {
      const rr = Ro * RING_K[ring];
      const tilt = cur.tilt + ring * cur.spread * 0.18, roll = cur.roll + ring * cur.spread;
      const x0 = rr * Math.cos(theta), z0 = rr * Math.sin(theta);
      const y1 = -z0 * Math.sin(tilt), z1 = z0 * Math.cos(tilt);
      const c = Math.cos(roll), s = Math.sin(roll);
      return { x: cx + x0 * c - y1 * s, y: cy + x0 * s + y1 * c, z: z1 };
    }
    const inDisc = p => Math.hypot(p.x - cx, p.y - cy) < R * 1.005;
    const ringAlpha = ring => clamp(cur.rings - ring, 0, 1);
    const cometAlpha = i => (i === 0 ? 1 : clamp(cur.comets - 1, 0, 1));

    function dot(x, y, r, fill) { ctx.fillStyle = fill; ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill(); }

    function drawTrack(front, ring) {
      const a = ringAlpha(ring);
      if (a < 0.01) return;
      const M = Math.round(132 * RING_K[ring]);
      ctx.fillStyle = front ? pal.trackFront : pal.trackBack;
      ctx.globalAlpha = a;
      ctx.beginPath();
      const r = front ? 1.25 : 1;
      for (let k = 0; k < M; k++) {
        const p = orbitPoint(k / M * TAU, ring);
        if ((p.z > 0) !== front) continue;
        if (!front && inDisc(p)) continue;
        ctx.moveTo(p.x + r, p.y);
        ctx.arc(p.x, p.y, r, 0, TAU);
      }
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    function drawComet(front, i, lv) {
      const vis = cometAlpha(i);
      if (vis < 0.01) return;
      const ring = Math.min(cRing[i], Math.max(0, Math.ceil(cur.rings) - 1));
      const dir = COMET_DIR[i], size = COMET_SIZE[i];
      const TRAIL = 30, step = 0.05;
      for (let j = TRAIL; j >= 0; j--) {
        const p = orbitPoint(cAng[i] - dir * j * step, ring);
        const isFront = p.z > 0;
        if (isFront !== front) continue;
        if (!isFront && inDisc(p)) continue;
        const f = 1 - j / TRAIL;
        const a = Math.pow(f, 1.7) * (isFront ? 0.95 : 0.5);
        if (j === 0) {
          // (a comet near the edge of the canvas gets a smaller glow, so it fades out instead of being cut off)
          const gr = Math.max(1, Math.min(R * (0.2 + 0.1 * lv) * size, p.x, W - p.x, p.y, H - p.y));
          const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, gr);
          g.addColorStop(0, accent); g.addColorStop(1, accentClear);
          ctx.globalAlpha = clamp((0.38 + 0.3 * glow) * (isFront ? 1 : 0.6), 0, 1) * vis;
          ctx.fillStyle = g; ctx.beginPath(); ctx.arc(p.x, p.y, R * 0.32 * size, 0, TAU); ctx.fill();
          ctx.globalAlpha = (isFront ? 1 : 0.7) * vis;
          dot(p.x, p.y, R * 0.036 * (1 + 0.25 * lv) * size, accent);
          dot(p.x, p.y, R * 0.014 * size, core);
          ctx.globalAlpha = 1;
        } else {
          ctx.globalAlpha = a * vis;
          dot(p.x, p.y, R * 0.03 * (0.35 + 0.65 * f) * size, accent);
          ctx.globalAlpha = 1;
        }
      }
    }

    function draw(now) {
      if (!W) return;
      const t = now / 1000;
      const calm = isCalm();
      const lv = level * cur.pulse;
      ctx.clearRect(0, 0, W, H);

      // Atmosphere behind everything.
      // The glow must be gone before the canvas ends: a glow cut off by the edge shows as a straight line.
      const edge = Math.min(cx, W - cx, cy, H - cy);
      const hr = Math.min(R * (1.75 + 0.35 * (cur.halo - 1)), edge);
      const h0 = Math.min(R * 0.85, hr * 0.6);
      const hc = accRgb.map(Math.round).join(',');
      const halo = ctx.createRadialGradient(cx, cy, h0, cx, cy, hr);
      halo.addColorStop(0, 'rgba(' + hc + ',1)');
      halo.addColorStop(0.4, 'rgba(' + hc + ',0.5)');
      halo.addColorStop(0.75, 'rgba(' + hc + ',0.16)');
      halo.addColorStop(1, 'rgba(' + hc + ',0)');
      ctx.globalAlpha = clamp((0.035 + 0.1 * glow + 0.05 * lv) * pal.haloK * cur.halo, 0, 1);
      ctx.fillStyle = halo; ctx.beginPath(); ctx.arc(cx, cy, hr, 0, TAU); ctx.fill();
      ctx.globalAlpha = 1;

      // Stars (and rain, when the station has it).
      const rainK = cur.rain;
      const shown = rainK > 0.02 ? STAR_RAIN : STAR_COUNT;
      for (let i = 0; i < shown; i++) {
        const s = stars[i];
        let a = calm ? 0.24 * pal.starK : (0.14 + 0.2 * (0.5 + 0.5 * Math.sin(t * s.s + s.p))) * pal.starK;
        let y = s.y * H, hgt = s.r;
        if (rainK > 0.02) {
          if (i >= STAR_COUNT) a *= rainK;
          y = (s.y * H + rainT * (10 + 26 * s.s)) % H;
          hgt = s.r * (1 + rainK * (5 + 6 * s.s));
          a *= 1 + 0.7 * rainK;
        }
        ctx.fillStyle = 'rgba(' + pal.star[0] + ',' + pal.star[1] + ',' + pal.star[2] + ',' + clamp(a, 0, 1).toFixed(3) + ')';
        ctx.fillRect(s.x * W, y, s.r, hgt);
      }

      // Rings of sound: every kick leaves the planet as an expanding ring.
      if (kicks.length) {
        ctx.strokeStyle = accent; ctx.lineWidth = 1.3;
        for (const k0 of kicks) {
          const p = (now - k0) / KICK_MS;
          if (p < 0 || p > 1) continue;
          ctx.globalAlpha = clamp(Math.pow(1 - p, 1.6) * 0.5 * Math.min(1.4, cur.pulse), 0, 1);
          ctx.beginPath(); ctx.arc(cx, cy, R * (1.02 + 0.5 * easeOut(p)), 0, TAU); ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }

      for (let r = 0; r < RING_K.length; r++) drawTrack(false, r);
      drawComet(false, 0, lv); drawComet(false, 1, lv);

      // Planet.
      const cs = Math.cos(spin), sn = Math.sin(spin), ca = Math.cos(AXIS_TILT), sa = Math.sin(AXIS_TILT);
      const scale = 1 + 0.05 * lv;
      const dotR = Math.max(1.2, R * 0.03) * grain;
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
          const ph = calm ? 0.3 : (t * 0.55) % 1;
          ctx.globalAlpha = (1 - ph) * 0.55 * vis;
          ctx.strokeStyle = accent; ctx.lineWidth = 1.2;
          ctx.beginPath(); ctx.arc(px, py, R * (0.03 + 0.1 * ph), 0, TAU); ctx.stroke();
          ctx.globalAlpha = vis;
          dot(px, py, R * 0.038 * (1 + 0.45 * lv), accent);
          dot(px, py, R * 0.014, core);
        } else {
          ctx.globalAlpha = 0.55 * vis;
          ctx.strokeStyle = pal.beacon; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.arc(px, py, R * 0.02, 0, TAU); ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }

      for (let r = 0; r < RING_K.length; r++) drawTrack(true, r);
      drawComet(true, 0, lv); drawComet(true, 1, lv);
    }

    function tick(now) {
      raf = requestAnimationFrame(tick);
      if (!W) { resizeLater(); return; }
      const calm = isCalm();
      const interval = calm ? 250 : (playing ? 0 : 33);
      if (now - lastDraw < interval) return;
      const dt = Math.min(0.1, (now - (last || now)) / 1000);
      last = now; lastDraw = now;

      // Character and colour glide (calm mode: at once).
      const kg = calm ? 1 : 1 - Math.exp(-dt * 2.4);
      for (const key of GLIDE) cur[key] += (goal[key] - cur[key]) * kg;
      const ka = calm ? 1 : 1 - Math.exp(-dt * 5);
      let moved = false;
      for (let k = 0; k < 3; k++) {
        const d = accGoal[k] - accRgb[k];
        if (Math.abs(d) > 0.4) { accRgb[k] += d * ka; moved = true; } else if (d !== 0) { accRgb[k] = accGoal[k]; moved = true; }
      }
      if (moved) paintAccent();

      const motion = calm ? 0 : 1;
      if (calm) { omega = 0; orbitRate = 0; }                       // stands still at once, not after a slow fade
      const target = (playing ? 0.17 : 0.035) * motion * cur.spin;
      omega += (target - omega) * (1 - Math.exp(-dt * 1.6));
      // Tape flutter: the speed drifts up and down a little, never in a regular beat.
      const wobble = cur.flutter > 0.001 && !calm ? cur.flutter * (0.6 * Math.sin(now / 1000 * 0.8) + 0.4 * Math.sin(now / 1000 * 2.7 + 1.3)) : 0;
      if (seek) {
        const p = clamp((now - seek.t0) / seek.dur, 0, 1);
        spin = seek.from + (seek.to - seek.from) * easeOut(p);
        if (p >= 1) { spin = seek.to; seek = null; }
      } else {
        spin += omega * (1 + wobble) * dt;
      }
      if (!calm) orbitRate += ((TAU / period) * (playing ? 1 : 0.3) - orbitRate) * (1 - Math.exp(-dt * 1.2));
      cAng[0] += orbitRate * dt * COMET_SPEED[0] * COMET_DIR[0];
      cAng[1] += orbitRate * dt * COMET_SPEED[1] * COMET_DIR[1];
      rainT += dt * cur.rain * motion;

      let want = 0, real = null;
      if (playing && !calm) {
        real = opts.getLevel ? opts.getLevel() : null;
        want = real === null || real === undefined ? 0.35 + 0.25 * Math.sin(now / 1000 * 1.1) : real;
      }
      level += (want - level) * (1 - Math.exp(-dt * (want > level ? 16 : 5)));
      if (real !== null && real !== undefined) {
        env += (real - env) * (1 - Math.exp(-dt * 3.5));
        if (real - env > 0.12 && real > 0.35 && now - lastKick > KICK_GAP_MS) {
          lastKick = now; kickCount++; kicks.push(now);
          if (kicks.length > KICK_MAX) kicks.shift();
        }
      } else {
        env = 0;
      }
      if (kicks.length) kicks = kicks.filter(k0 => now - k0 < KICK_MS);
      glow += ((playing ? 0.9 : 0.25) - glow) * (1 - Math.exp(-dt * 1.4));
      if (reveal < 1) reveal = Math.min(1.2, reveal + dt / 1.0);

      draw(now);
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

        // Character: the smooth values glide, grain and coastline change with the new globe.
        goal = normaliseLook(st.look);
        const calm = isCalm();
        const rebuild = goal.grain !== grain;
        grain = goal.grain; landShift = goal.land;
        if (instant || calm) cur = Object.assign({}, goal);
        cRing[0] = 0; cRing[1] = Math.min(1, goal.rings - 1);
        applyPalette(readPalette(), instant || calm);
        if (rebuild && pts) buildPoints(); else buildTerrain();
        if (!changed) return;
        const lon = index * TAU / stationCount + 0.5;
        let to = -lon;
        const base = spin;
        to += Math.ceil((base - to) / TAU) * TAU;   // next time the transmitter faces you
        if (!instant && !calm) { seek = { from: base, to: to + TAU, t0: performance.now(), dur: 1800 }; reveal = 0.25; }
        else { spin = to; seek = null; reveal = instant ? 0 : 1; }
      },
      /** What the planet is doing right now (tests and the About screen). */
      state() {
        return {
          calm: isCalm(), playing, spin, omega, orbitRate, level, rings: cur.rings, comets: cur.comets, rain: cur.rain,
          grain, pulse: cur.pulse, look: Object.assign({}, cur), goal: Object.assign({}, goal),
          kicks: kicks.length, kickCount, accent: accRgb.map(Math.round), points: pts ? pts.n : 0, drawn: !!W
        };
      },
      resize,
      destroy() { cancelAnimationFrame(raf); canvas.remove(); }
    };
  }

  window.BurzhPlanet = { create, look: normaliseLook, LOOK, LIMITS };
})();
