/* BURZH theme — one palette for CSS and canvas.
 *
 * Colours live in CSS custom properties (see :root and html.theme-white in
 * index.html). Canvases cannot use var(), so they ask this module for the
 * current values. The result is cached and dropped whenever the class list of
 * <html> changes (theme, night mode), so drawing never touches getComputedStyle.
 */
(() => {
  'use strict';

  const root = document.documentElement;
  let cache = null;
  const listeners = [];

  function rgb(text, fallback) {
    const t = String(text || '').trim();
    let m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(t);
    if (m) {
      const h = m[1].length === 3 ? m[1].replace(/./g, c => c + c) : m[1];
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
    }
    m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i.exec(t);
    if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
    m = /^(\d+)\s*,\s*(\d+)\s*,\s*(\d+)$/.exec(t);
    if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
    return fallback || [255, 255, 255];
  }
  const css = (c, a) => 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + (a === undefined ? 1 : Number(a.toFixed(3))) + ')';

  function read() {
    if (cache) return cache;
    const cs = getComputedStyle(root);
    const v = name => cs.getPropertyValue('--' + name).trim();
    const num = (name, fallback) => { const n = parseFloat(v(name)); return Number.isFinite(n) ? n : fallback; };
    cache = {
      accent: v('accent') || '#ff3b30',
      accentRgb: rgb(v('accent'), [255, 59, 48]),
      core: v('core') || '#fff4f0',
      ink: rgb(v('ink'), [241, 241, 236]),
      bg: v('bg') || '#050606',
      planetDim: rgb(v('planet-dim'), [64, 64, 60]),
      planetLit: rgb(v('planet-lit'), [255, 255, 251]),
      planetA0: num('planet-a0', 0.22),
      planetA1: num('planet-a1', 1),
      star: rgb(v('star'), [215, 216, 210]),
      starK: num('star-k', 1),
      trackFront: v('track-front') || 'rgba(236,237,231,.5)',
      trackBack: v('track-back') || 'rgba(205,207,202,.18)',
      beacon: v('beacon') || 'rgba(236,237,231,.8)',
      haloK: num('halo-k', 1),
      eqMuted: rgb(v('eq-muted'), [139, 140, 134]),
      eqHandle: v('eq-handle') || '#070808'
    };
    return cache;
  }

  function refresh() {
    cache = null;
    listeners.slice().forEach(fn => { try { fn(read()); } catch (e) { /* a broken view must not block the others */ } });
  }
  if ('MutationObserver' in window) new MutationObserver(refresh).observe(root, { attributes: true, attributeFilter: ['class'] });

  window.BurzhTheme = {
    read,
    refresh,
    rgb,
    css,
    // Same colour, transparent: gradients that fade to this do not go muddy on a light background.
    clear: c => css(c, 0),
    onChange(fn) { listeners.push(fn); }
  };
})();
