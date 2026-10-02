/* BURZH planet — a cracked, rocky, black-and-white world, drawn live with WebGL.
 *
 * The surface is one height map (planet/surface.jpg, made by tools/make_art.py) wrapped around a sphere
 * and lit in the fragment shader: a key light from the upper left that skims the relief near the limb,
 * a bright rim all round the silhouette, a soft halo outside it. The planet turns slowly; every station
 * shows its own face of it, at its own speed and tilt ("look" in stations.json), and the music moves it
 * (bass energy brightens the rim and the halo, a kick flares the orbit ring).
 *
 * A second, 2D canvas on top draws the instrument around it: the thin orbit ring with its travelling
 * light, the tick marks left and right, and (optionally) the waveform under the station name.
 * Without WebGL the planet is a still picture (planet/fallback.png) under the same overlay.
 */
(() => {
  'use strict';

  const TAU = Math.PI * 2;
  const reduceMotion = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const ease = t => 1 - Math.pow(1 - t, 3);
  const BASE = (document.currentScript && document.currentScript.src) ? new URL('.', document.currentScript.src).href : './';
  const SURFACE = BASE + 'planet/surface.jpg';
  const FALLBACK_IMG = BASE + 'planet/fallback.png';

  // A station's character. Keep LIMITS equal to LOOK_LIMITS in tools/radio.py (a browser check compares them).
  const LOOK = {
    spin: 1,       // rotation speed, 1 = normal (one turn in about four minutes)
    tilt: 0.14,    // axis tilt towards the viewer (radians; small, so the pole stays out of sight)
    face: 0,       // which side of the planet faces you when you tune in (0..1 of a turn)
    halo: 1,       // rim light and glow
    pulse: 1,      // how much the music moves the light
    orbit: 1       // speed of the light on the orbit ring
  };
  const LIMITS = { spin: [0.2, 2.5], tilt: [0.05, 0.35], face: [0, 1], halo: [0.5, 2], pulse: [0, 2], orbit: [0.2, 3] };
  const KICK_MS = 650, KICK_GAP_MS = 240;
  const BUMP = 0.016;          // relief height, in planet radii

  function normaliseLook(raw) {
    const out = {};
    for (const key of Object.keys(LOOK)) {
      const v = raw && raw[key] !== null && raw[key] !== undefined && raw[key] !== '' ? Number(raw[key]) : NaN;
      out[key] = Number.isFinite(v) ? clamp(v, LIMITS[key][0], LIMITS[key][1]) : LOOK[key];
    }
    return out;
  }

  /* ------------------------------------------------------------------ WebGL */

  const VERT = 'attribute vec2 a;varying vec2 p;void main(){p=a;gl_Position=vec4(a,0.,1.);}';
  const FRAG = `
#ifdef GL_OES_standard_derivatives
#extension GL_OES_standard_derivatives : enable
#endif
precision highp float;
varying vec2 p;
uniform sampler2D tex;
uniform vec2 res;        // canvas size in pixels
uniform vec3 geo;        // centre x, centre y (pixels, y up), radius (pixels)
uniform vec4 rot;        // cos/sin tilt, cos/sin spin
uniform vec4 lite;       // rim, halo, exposure, bump
uniform vec2 texel;      // 1 / texture size
const vec3 L = vec3(-0.6080, 0.6853, 0.4643);
const float PI = 3.14159265;

vec3 toPlanet(vec3 v){
  vec3 t = vec3(v.x, v.y*rot.x + v.z*rot.y, -v.y*rot.y + v.z*rot.x);
  return vec3(t.x*rot.w - t.z*rot.z, t.y, t.x*rot.z + t.z*rot.w);
}
vec3 toView(vec3 q){
  vec3 t = vec3(q.x*rot.w + q.z*rot.z, q.y, -q.x*rot.z + q.z*rot.w);
  return vec3(t.x, t.y*rot.x - t.z*rot.y, t.y*rot.y + t.z*rot.x);
}
float h(vec2 uv){ return texture2D(tex, uv).r; }

void main(){
  vec2 px = (p*0.5+0.5)*res;
  vec2 d = (px - geo.xy) / geo.z;
  float r2 = dot(d, d);
  float r = sqrt(r2);
  float aa = clamp((1.0 - r) * geo.z, 0.0, 1.0);          // one pixel of anti-aliasing at the limb
  vec3 col = vec3(0.0);
  float alpha = 0.0;
  if (r < 1.0 + 1.0/geo.z) {
    float z = sqrt(max(0.0, 1.0 - r2));
    vec3 n = vec3(d, z);
    vec3 q = toPlanet(n);
    float lon = atan(q.x, q.z);
    float lat = asin(clamp(q.y, -1.0, 1.0));
    vec2 uv = vec2(lon/(2.0*PI) + 0.5, 0.5 - lat/PI);
#ifdef GL_OES_standard_derivatives
    vec2 uv2 = vec2(fract(uv.x + 0.5) - 0.5, uv.y);       // the same place, without the jump at the seam
    if (fwidth(uv2.x) < fwidth(uv.x)) uv = uv2;
#endif
    float hc = h(uv);
    float hx = h(uv + vec2(texel.x, 0.0)) - h(uv - vec2(texel.x, 0.0));
    float hy = h(uv - vec2(0.0, texel.y)) - h(uv + vec2(0.0, texel.y));
    float cl = max(cos(lat), 0.08);
    vec3 east = normalize(vec3(cos(lon), 0.0, -sin(lon)));
    vec3 north = cross(q, east);
    float ge = hx / (4.0 * PI * texel.x * cl);            // slope per unit of arc, east and north
    float gn = hy / (2.0 * PI * texel.y);
    vec3 qb = normalize(q - (east * ge + north * gn) * lite.w);
    vec3 nb = toView(qb);
    float diff = max(dot(nb, L), 0.0);
    vec3 H = normalize(L + vec3(0.0, 0.0, 1.0));
    float spec = pow(max(dot(nb, H), 0.0), 46.0);
    float albedo = 0.06 + 0.5 * pow(hc, 1.4);
    float fres = 1.0 - z;
    float side = clamp(0.3 + 0.75*(d.y*0.75 - d.x*0.35), 0.12, 1.15);
    float rim = (pow(fres, 8.0)*1.9 + pow(fres, 3.0)*0.42) * side * lite.x;
    float edgeW = 0.36 + 0.64 * pow(fres, 1.1);              // the face is dark (the name sits there), light skims the limb
    float c = albedo * (0.03 + 1.45 * pow(diff, 1.5) * edgeW) + rim * (0.35 + 1.1*pow(hc, 1.3))
            + spec * (0.1 + 1.6*hc*hc) * (0.3 + 0.7*fres) * 0.9;
    c *= lite.z;
    col = vec3(pow(clamp(c, 0.0, 1.0), 1.0/1.1)) * vec3(0.985, 0.99, 1.0);
    alpha = aa;
  }
  // halo: a soft white glow just outside the limb
  float g = r > 1.0 ? exp(-(r - 1.0) * 10.0) * 0.22 * lite.y : 0.0;
  vec3 outc = col * alpha + vec3(g) * (1.0 - alpha);
  float outa = max(alpha, g);
  gl_FragColor = vec4(outc, outa);
}`;

  function makeGL(canvas) {
    const gl = canvas.getContext('webgl', { premultipliedAlpha: true, alpha: true, antialias: false, preserveDrawingBuffer: false });
    if (!gl) return null;
    const deriv = gl.getExtension('OES_standard_derivatives');
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    const prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'a');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const u = name => gl.getUniformLocation(prog, name);
    const tex = gl.createTexture();
    return { gl, deriv: !!deriv, tex, u: { res: u('res'), geo: u('geo'), rot: u('rot'), lite: u('lite'), texel: u('texel'), tex: u('tex') }, ready: false };
  }

  function loadSurface(g, onReady) {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const gl = g.gl;
      gl.bindTexture(gl.TEXTURE_2D, g.tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, gl.LUMINANCE, gl.UNSIGNED_BYTE, img);
      const pot = (img.width & (img.width - 1)) === 0 && (img.height & (img.height - 1)) === 0;
      if (pot) gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, pot && g.deriv ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, pot ? gl.REPEAT : gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      g.texel = [1 / img.width, 1 / img.height];
      g.ready = true;
      onReady();
    };
    img.onerror = () => { g.failed = true; onReady(); };
    img.src = SURFACE;
  }

  /* ------------------------------------------------------------------ planet */

  function create(box, opts = {}) {
    if (getComputedStyle(box).position === 'static') box.style.position = 'relative';
    const mk = cls => { const c = document.createElement('canvas'); c.className = cls; c.setAttribute('aria-hidden', 'true'); c.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none'; return c; };
    const glCanvas = mk('planet-gl'), fx = mk('planet-fx');
    box.prepend(fx);
    box.prepend(glCanvas);
    const ctx = fx.getContext('2d');
    const wave = box.querySelector('canvas.wave');
    const wctx = wave ? wave.getContext('2d') : null;
    const isCalm = () => (opts.calm ? !!opts.calm() : reduceMotion.matches);

    let g = null;
    try { g = makeGL(glCanvas); } catch (e) { g = null; }
    const still = new Image();
    let stillReady = false;
    still.onload = () => { stillReady = true; frameOnce(); };
    if (!g) { still.src = FALLBACK_IMG; glCanvas.style.display = 'none'; }
    else loadSurface(g, () => { if (g.failed) { g = null; glCanvas.style.display = 'none'; still.src = FALLBACK_IMG; } frameOnce(); });

    let W = 0, H = 0, dpr = 1, cx = 0, cy = 0, R = 0;
    let look = normaliseLook(null), from = look, to = look, glideAt = 0;
    let stationId = '', tempo = 11;
    let spin = 0, orbitA = -0.9, lastT = 0;
    let playing = false, playAt = 0;
    let level = 0, lvAvg = 0, lastKick = 0, kickCount = 0, kickAt = -1e9;
    let frames = 0, drawn = false, raf = 0, alive = true;
    const spec = new Uint8Array(64);

    function resize() {
      const r = box.getBoundingClientRect();
      dpr = Math.min(window.devicePixelRatio || 1, 2.5);
      W = Math.max(1, Math.round(r.width * dpr));
      H = Math.max(1, Math.round(r.height * dpr));
      for (const c of [glCanvas, fx]) { if (c.width !== W) c.width = W; if (c.height !== H) c.height = H; }
      cx = W / 2; cy = H / 2;
      R = Math.min(W * 0.34, H * 0.37) * (opts.scale || 1);
      if (wave) { const wr = wave.getBoundingClientRect(); wave.width = Math.max(1, Math.round(wr.width * dpr)); wave.height = Math.max(1, Math.round(wr.height * dpr)); }
      frameOnce();
    }

    function currentLook(now) {
      const t = glideAt ? clamp((now - glideAt) / 1400, 0, 1) : 1;
      if (t >= 1) return to;
      const e = ease(t), out = {};
      for (const k of Object.keys(LOOK)) out[k] = from[k] + (to[k] - from[k]) * e;
      return out;
    }

    function readLevel(now) {
      const raw = opts.getLevel ? opts.getLevel() : null;
      if (raw === null || raw === undefined || !Number.isFinite(raw)) {
        // no analyser (plain player): a slow breathing while playing
        const b = playing ? 0.18 + 0.1 * Math.sin(now / 900) : 0;
        level += (b - level) * 0.05;
        return false;
      }
      level += (raw - level) * (raw > level ? 0.5 : 0.12);
      lvAvg += (raw - lvAvg) * 0.04;
      if (playing && !isCalm() && raw > 0.32 && raw > lvAvg * 1.35 + 0.06 && now - lastKick > KICK_GAP_MS) { lastKick = now; kickAt = now; kickCount++; }
      return true;
    }

    function drawGL(lk, now) {
      const gl = g.gl;
      gl.viewport(0, 0, W, H);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      const tilt = lk.tilt, sp = spin + lk.face * TAU;
      const lv = level * lk.pulse;
      gl.uniform2f(g.u.res, W, H);
      gl.uniform3f(g.u.geo, cx, H - cy, R * (1 + 0.012 * lv));
      gl.uniform4f(g.u.rot, Math.cos(tilt), Math.sin(tilt), Math.cos(sp), Math.sin(sp));
      gl.uniform4f(g.u.lite, Math.min(2.2, lk.halo * (0.85 + 0.6 * lv)), Math.min(1.6, lk.halo * (0.8 + 1.1 * lv)), 1 + 0.12 * lv, BUMP);
      gl.uniform2f(g.u.texel, g.texel[0], g.texel[1]);
      gl.uniform1i(g.u.tex, 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, g.tex);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    function drawOverlay(lk, now) {
      ctx.clearRect(0, 0, W, H);
      if (!g && stillReady) {                       // the still picture: same planet, same place
        const s = R * 2 / 0.74;
        ctx.drawImage(still, cx - s / 2, cy - s / 2, s, s);
      }
      const px = dpr;
      const ringR = R * 1.17;
      const kick = clamp(1 - (now - kickAt) / KICK_MS, 0, 1);
      const lv = level * lk.pulse;
      // orbit ring
      ctx.lineWidth = Math.max(1, px * 0.9);
      ctx.strokeStyle = 'rgba(255,255,255,' + (0.16 + 0.1 * lv + 0.25 * kick).toFixed(3) + ')';
      ctx.beginPath(); ctx.arc(cx, cy, ringR, 0, TAU); ctx.stroke();
      // the light on the ring and its trail
      const a = orbitA;
      const tail = 1.25;
      const segs = 40;
      for (let i = 0; i < segs; i++) {
        const t0 = i / segs, t1 = (i + 1) / segs;
        ctx.strokeStyle = 'rgba(255,255,255,' + (Math.pow(1 - t0, 2.2) * (0.75 + 0.25 * kick)).toFixed(3) + ')';
        ctx.lineWidth = px * (1.6 - t0);
        ctx.beginPath(); ctx.arc(cx, cy, ringR, a - tail * t1, a - tail * t0); ctx.stroke();
      }
      const dx = cx + Math.cos(a) * ringR, dy = cy + Math.sin(a) * ringR;
      const glow = ctx.createRadialGradient(dx, dy, 0, dx, dy, px * (12 + 10 * kick));
      glow.addColorStop(0, 'rgba(255,255,255,.9)'); glow.addColorStop(0.25, 'rgba(255,255,255,.35)'); glow.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(dx, dy, px * (12 + 10 * kick), 0, TAU); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(dx, dy, px * 2.4, 0, TAU); ctx.fill();
      // ticks left and right, like the marks of a tuning dial
      ctx.lineCap = 'round';
      for (const side of [-1, 1]) {
        const x1 = cx + side * R * 1.27, x2 = cx + side * R * 1.37;
        ctx.strokeStyle = 'rgba(255,255,255,.42)'; ctx.lineWidth = px * 1.2;
        ctx.beginPath(); ctx.moveTo(x1, cy - R * 0.1); ctx.lineTo(x1, cy + R * 0.1); ctx.stroke();
        ctx.strokeStyle = 'rgba(255,255,255,.22)';
        ctx.beginPath(); ctx.moveTo(x2, cy - R * 0.05); ctx.lineTo(x2, cy + R * 0.05); ctx.stroke();
        // a faint bracket of a second ring around the ticks
        ctx.strokeStyle = 'rgba(255,255,255,.08)'; ctx.lineWidth = px;
        ctx.beginPath(); ctx.arc(cx, cy, R * 1.23, side < 0 ? Math.PI - 0.32 : -0.32, side < 0 ? Math.PI + 0.32 : 0.32); ctx.stroke();
      }
    }

    function drawWave(now) {
      if (!wctx) return;
      const w = wave.width, h = wave.height;
      wctx.clearRect(0, 0, w, h);
      const n = 31, gap = w / n, mid = (n - 1) / 2;
      let haveSpec = false;
      if (opts.getSpectrum) haveSpec = !!opts.getSpectrum(spec);
      for (let i = 0; i < n; i++) {
        const dist = Math.abs(i - mid) / mid;
        let v;
        if (haveSpec) {
          const bin = Math.min(spec.length - 1, Math.floor(Math.abs(i - mid) / mid * 40) + 1);
          v = 0.22 + 0.78 * (spec[bin] / 255);
        } else {
          const breathe = playing && !isCalm() ? 0.12 * Math.sin(now / 420 + i * 0.7) : 0;
          v = 0.35 + 0.3 * Math.cos(i * 1.7) * Math.cos(i * 0.6) + breathe;
        }
        const hh = Math.max(2, h * (i === mid ? 1 : clamp(v, 0.1, 1) * (1 - dist * 0.35) * 0.72));
        wctx.fillStyle = 'rgba(255,255,255,' + (i === mid ? 0.95 : 0.55 - dist * 0.25).toFixed(3) + ')';
        const bw = Math.max(1, dpr * (i === mid ? 1.6 : 1.1));
        wctx.fillRect(Math.round(i * gap + gap / 2 - bw / 2), Math.round((h - hh) / 2), bw, Math.round(hh));
      }
    }

    function frame(now) {
      if (!alive) return;
      raf = 0;
      const visible = box.offsetWidth > 0 && box.offsetHeight > 0 && document.visibilityState !== 'hidden';
      if (!visible) { schedule(now, 600); return; }
      const calm = isCalm();
      const dt = lastT ? Math.min(0.1, (now - lastT) / 1000) : 0;
      lastT = now;
      const lk = currentLook(now);
      readLevel(now);
      if (!calm) {
        spin += dt * 0.026 * lk.spin * (playing ? 1 : 0.55);
        orbitA += dt * (TAU / Math.max(4, tempo * 3)) * lk.orbit * (playing ? 1 : 0.4);
      }
      if (g && g.ready) drawGL(lk, now);
      drawOverlay(lk, now);
      drawWave(now);
      frames++;
      drawn = true;
      if (!calm || glideAt && now - glideAt < 1500) schedule(now, 0);
      else schedule(now, 500);                      // still: one quiet look twice a second (motion may come back)
    }
    function schedule(now, delay) {
      if (raf || !alive) return;
      if (delay) raf = setTimeout(() => { raf = 0; raf = requestAnimationFrame(frame); }, delay);
      else raf = requestAnimationFrame(frame);
    }
    function frameOnce() { if (!raf) raf = requestAnimationFrame(frame); }

    const ro = 'ResizeObserver' in window ? new ResizeObserver(() => resize()) : null;
    if (ro) ro.observe(box); else window.addEventListener('resize', resize);
    resize();

    return {
      setPlaying(on) { if (on !== playing) { playing = on; playAt = performance.now(); } frameOnce(); },
      setStation(st, index, count, { instant = false } = {}) {
        const next = normaliseLook(st && st.look);
        if (st && st.id === stationId && !instant) return;
        stationId = st ? st.id : '';
        tempo = (st && st.tempo) || 11;
        from = instant ? next : currentLook(performance.now());
        to = next;
        glideAt = instant ? 0 : performance.now();
        frameOnce();
      },
      resize,
      state() {
        return {
          drawn: drawn && box.offsetWidth > 0, webgl: !!(g && g.ready), still: !g && stillReady, station: stationId,
          look: currentLook(performance.now()), playing, calm: isCalm(), kickCount, kicks: performance.now() - kickAt < KICK_MS ? 1 : 0,
          level, frames, spin, orbit: orbitA, R: R / dpr, ringR: R * 1.17 / dpr, cx: cx / dpr, cy: cy / dpr
        };
      },
      destroy() { alive = false; if (ro) ro.disconnect(); cancelAnimationFrame(raf); clearTimeout(raf); glCanvas.remove(); fx.remove(); }
    };
  }

  window.BurzhPlanet = { create, look: normaliseLook, LOOK, LIMITS };
})();
