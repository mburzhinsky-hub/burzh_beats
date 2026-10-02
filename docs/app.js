/* BURZH beats — genre radio.
 *
 * Every station is a looped playlist that runs on a shared clock. Opening a
 * station tunes into whatever is "on air" right now, like a real radio: all
 * devices hear the same thing at the same moment. The order of mixes changes
 * every full cycle (deterministic shuffle), so the broadcast does not feel
 * like the same tape on repeat.
 */
(() => {
  'use strict';

  const VERSION = '0.27.1';
  const DATA_URL = './stations.json';
  const KEYS = {
    station: 'burzh.radio.station.v1',
    settings: 'burzh.radio.settings.v1',
    weather: 'burzh.radio.weather.v1',
    data: 'burzh.radio.data.v1',
    log: 'burzh.radio.log.v1'
  };
  const IDLE_MS = 8000;
  const NIGHT_FROM = 23;
  const NIGHT_TO = 7;

  const $ = id => document.getElementById(id);
  const store = {
    get(key, fallback) {
      try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch (e) { return fallback; }
    },
    set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* private mode */ } }
  };

  const storedSettings = store.get(KEYS.settings, {});
  // v2: night mode no longer recolours the screen and is off unless chosen.
  if (storedSettings.v !== 2) { delete storedSettings.night; storedSettings.v = 2; }
  // v0.20 asked for a typed city; weather now works from the device location.
  if (!storedSettings.geo) storedSettings.weather = false;
  delete storedSettings.city;
  // v0.23: the Graphite background became White.
  if (storedSettings.theme === 'graphite') storedSettings.theme = 'white';
  const settings = Object.assign(
    { v: 2, keepAwake: true, night: 'off', theme: 'black', motion: 'auto', weather: false, geo: null, sound: {} },
    storedSettings
  );
  if (settings.theme !== 'white') settings.theme = 'black';
  if (!['auto', 'on', 'off'].includes(settings.motion)) settings.motion = 'auto';
  settings.sound = Object.assign({ on: false, preset: 'auto', custom: null }, settings.sound || {});
  const saveSettings = () => store.set(KEYS.settings, settings);

  /* ------------------------------------------------------------------ */
  /* Flight recorder: the last events survive a relaunch (Settings → About) */
  /* ------------------------------------------------------------------ */

  const LOG_MAX = 160;
  let logBuf = [];
  try { const saved = store.get(KEYS.log, []); if (Array.isArray(saved)) logBuf = saved.filter(e => Array.isArray(e) && typeof e[1] === 'string').slice(-LOG_MAX); } catch (e) { /* ignore */ }
  let logTimer = 0, logLast = '', logLastAt = 0, logOpen = false;
  const clock = t => new Date(t).toTimeString().slice(0, 8);
  const logText = () => logBuf.map(e => clock(e[0]) + '  ' + e[1]).join('\n');
  function saveLog() { clearTimeout(logTimer); logTimer = 0; store.set(KEYS.log, logBuf); }
  function renderLog() {
    const el = document.getElementById('logView');
    if (!el || !logOpen) return;
    const stick = el.scrollTop + el.clientHeight >= el.scrollHeight - 24;
    el.textContent = logText();
    if (stick) el.scrollTop = el.scrollHeight;
  }
  function rec(text) {
    const now = Date.now();
    text = String(text).replace(/\s+/g, ' ').slice(0, 220);
    if (text === logLast && now - logLastAt < 1500) return;
    logLast = text; logLastAt = now;
    logBuf.push([now, text]);
    if (logBuf.length > LOG_MAX) logBuf.splice(0, logBuf.length - LOG_MAX);
    if (!logTimer) logTimer = setTimeout(saveLog, 1000);
    renderLog();
  }
  window.addEventListener('pagehide', saveLog);
  window.addEventListener('online', () => rec('network online'));
  window.addEventListener('offline', () => rec('network offline'));
  window.addEventListener('error', e => rec('JS error: ' + (e && e.message) + (e && e.lineno ? ' @' + e.lineno : '')));
  window.addEventListener('unhandledrejection', e => rec('JS rejection: ' + ((e && e.reason && (e.reason.message || e.reason.name)) || e.reason)));

  /* ------------------------------------------------------------------ */
  /* Broadcast schedule                                                  */
  /* ------------------------------------------------------------------ */

  let epochMs = Date.UTC(2026, 0, 1);
  let mediaBase = new URL('./media/', location.href);
  let stations = [];

  function hashString(s) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function seededRandom(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  // A long mix that was cut into parts (items that share a `group`) always plays back to back, in file order:
  // the shuffle below moves whole groups, so part 2 can never come before part 1. A station without groups
  // gets exactly the schedule it always had (a group is then a single item).
  const groupCache = new WeakMap();
  function groupsOf(st) {
    let groups = groupCache.get(st);
    if (groups) return groups;
    groups = [];
    const open = new Map();
    st.items.forEach((it, i) => {
      const key = it.group ? String(it.group) : '';
      if (key && open.has(key)) { open.get(key).push(i); return; }
      const run = [i];
      groups.push(run);
      if (key) open.set(key, run);
    });
    groupCache.set(st, groups);
    return groups;
  }
  // Where an item sits inside its mix. A mix cut into parts is shown, timed and scrubbed as one.
  function spanOf(st, item) {
    const i = st.items.indexOf(item);
    const parts = (groupsOf(st).find(g => g.includes(i)) || [i]).map(k => st.items[k]);
    let start = 0;
    for (const p of parts) { if (p === item) break; start += p.duration; }
    return { parts, start, total: parts.reduce((n, p) => n + p.duration, 0) };
  }
  // A moment of the whole mix: the part that holds it and the time inside that part.
  function partAt(span, time) {
    let t = Math.max(0, time);
    for (let k = 0; k < span.parts.length; k++) {
      const p = span.parts[k];
      if (t < p.duration || k === span.parts.length - 1) return { item: p, offset: Math.min(t, Math.max(0, p.duration - 1)) };
      t -= p.duration;
    }
    return { item: span.parts[0], offset: 0 };
  }
  // The tracklist of the whole mix (a track that runs across a cut is listed once).
  function mixCues(span) {
    const out = [];
    let start = 0;
    span.parts.forEach(p => {
      (p.cues || []).forEach(c => {
        const prev = out[out.length - 1];
        if (c.at < 0.5 && prev && start > 0 && prev.title === c.title && prev.artist === c.artist) return;
        out.push(Object.assign({}, c, { at: c.at + start }));
      });
      start += p.duration;
    });
    return out;
  }
  function rawOrder(st, cycle) {
    const idx = groupsOf(st).map((_, i) => i);
    if (idx.length < 3) return idx; // with 1–2 mixes a fixed order never repeats a mix back to back
    const rnd = seededRandom(hashString(st.id + ':' + cycle));
    for (let i = idx.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [idx[i], idx[j]] = [idx[j], idx[i]];
    }
    return idx;
  }
  // The last slot of a cycle is never touched by the fix-up below, so the
  // previous cycle's last mix is always known and never repeats at the seam.
  function cycleOrder(st, cycle) {
    const order = rawOrder(st, cycle);
    if (order.length >= 3) {
      const prev = rawOrder(st, cycle - 1);
      if (order[0] === prev[prev.length - 1]) [order[0], order[1]] = [order[1], order[0]];
    }
    const groups = groupsOf(st);
    return order.reduce((all, g) => all.concat(groups[g]), []);
  }

  function liveAt(st, now = Date.now()) {
    if (!st || !st.total) return null;
    const t = Math.max(0, (now - epochMs) / 1000);
    const cycle = Math.floor(t / st.total);
    let offset = t - cycle * st.total;
    const order = cycleOrder(st, cycle);
    for (let k = 0; k < order.length; k++) {
      const item = st.items[order[k]];
      if (offset < item.duration || k === order.length - 1) {
        offset = Math.min(offset, Math.max(0, item.duration - 0.25));
        const nextIndex = k + 1 < order.length ? order[k + 1] : cycleOrder(st, cycle + 1)[0];
        return { item, offset, remaining: item.duration - offset, next: st.items[nextIndex] };
      }
      offset -= item.duration;
    }
    return null;
  }

  function cueAt(item, offset) {
    const cues = item && item.cues;
    if (!cues || !cues.length) return null;
    let found = null;
    for (const c of cues) { if (c.at <= offset + 0.5) found = c; else break; }
    return found;
  }

  /* Same-origin audio needs no CORS for the sound engine. Asking for it anyway makes iPhone load the file
   * through a different (slower, separately cached) path, so it is only requested for other hosts. */
  function setCors(el, url) {
    let cross = false;
    try { cross = new URL(url, location.href).origin !== location.origin; } catch (e) { /* relative */ }
    if (el.dataset.fx === '1' && cross) el.crossOrigin = 'anonymous';
    else el.removeAttribute('crossorigin');
  }

  function mediaUrl(item) {
    return item.url ? item.url : new URL(item.file, mediaBase).href;
  }

  /* ------------------------------------------------------------------ */
  /* Player                                                              */
  /* ------------------------------------------------------------------ */

  // Two outputs: a plain <audio> (best background/lock-screen behaviour) and one
  // routed through the sound chain. Only one is ever active; switching re-tunes live.
  function makeAudio(fx) {
    const el = new Audio();
    el.preload = 'none';
    el.playsInline = true;
    el.setAttribute('playsinline', '');
    el.setAttribute('webkit-playsinline', '');
    el.dataset.fx = fx ? '1' : '';
    return el;
  }
  const audioPlain = makeAudio(false);
  let audioFx = null;
  let audio = audioPlain;
  const sound = window.BurzhSound ? window.BurzhSound.create() : null;
  let fxEverPlayed = false;
  const fxActive = () => !!sound && audio === audioFx;
  if (sound) {
    // iOS interrupts audio contexts (calls, Siri, route changes); bring the chain back when the app is visible.
    sound.onstate = state => {
      rec('audio engine ' + state);
      if (fxActive() && wantPlaying && state !== 'running' && document.visibilityState === 'visible') sound.resume();
      const el = document.getElementById('engineState');
      if (el) el.textContent = engineLabel();
    };
  }
  function engineLabel() {
    if (!sound) return 'Not supported';
    if (fxUnsupported) return 'Unavailable on this device';
    if (audio === audioFx) return 'Active · ' + sound.info();
    if (fxHeld) return 'Paused · tap to restore';
    return fxFails ? 'Paused · did not start ' + fxFails + '×' : 'Standby';
  }

  let station = null;
  let current = null;          // { st, item, url } loaded into <audio>
  let wantPlaying = false;
  let phase = 'stopped';       // stopped | tuning | live | buffering | lost
  let switching = 0;
  let retryTimer = 0;
  let retryDelay = 4000;
  let lastCueKey = '';
  let lastTuneAt = 0;       // iOS can pause a freshly started element while the audio session reconfigures
  let pauseRetries = 0;
  let lastMetaKey = '';
  // Loading watchdog (see "Never stay silent" below).
  let watchTimer = 0;
  let swReg = null, updateReady = false, lastUpdateCheck = 0;   // app update flow (bottom of file)
  let lastLife = 0;              // last sign of life from the loader (bytes, metadata, data)
  let tuneStartedAt = 0;
  let stallRetries = 0;          // reloads of a stuck loader since the last successful start
  let fastStrikes = 0;           // looks in a row where the server was fine but the element stayed silent
  let slowShown = false;
  let waitStartedAt = 0;         // when the current stall in playback began ("buffering")
  let probing = false;
  let fxRescue = false;          // the engine stalled and the plain player took over: its first start is the verdict
  let rescueFrom = null;         // the engine element the rescue left; the way back if the plain player fails too
  let notice = null;             // a message to show once playback is running (the "playing" event clears toasts)
  let marks = {};                // timeline of the current start, for Settings → About
  let lastStart = '';
  let tuneToken = 0;             // a late answer to an older tune() must not trigger recovery of the new one
  let playedSinceTune = false;   // did this tune ever reach "playing"? (decides between recovering and retrying)
  let useFragment = true;        // #t=offset in the URL; dropped as a last resort for picky players
  let lastProblem = '';          // shown in Settings → About so a screenshot is enough to diagnose
  let shifted = false;      // the listener moved inside the mix, so playback is off the live clock

  function configureAudioSession() {
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) { /* not supported */ }
  }

  const available = st => !!st && (st.stream ? true : st.total > 0);
  const availableStations = () => stations.filter(available);

  function setPhase(next) {
    phase = next;
    document.documentElement.dataset.phase = next;
    renderStatus();
    updateWakeLock();
  }

  function tune({ autoplay = true, after = null, follow = false, retry = false, at = null } = {}) {
    const st = station;
    clearTimeout(retryTimer);
    retryTimer = 0;
    playedSinceTune = false;
    tuneStartedAt = Date.now(); lastLife = tuneStartedAt; slowShown = false; fastStrikes = 0;
    marks = { t0: performance.now() };
    const token = ++tuneToken;
    if (!retry) useFragment = true;
    if (!available(st)) { wantPlaying = false; shifted = false; setPhase('stopped'); render(); return; }
    configureAudioSession();
    if (fxActive()) sound.resume();
    lastTuneAt = Date.now();
    pauseRetries = 0;

    let url;
    let offset = 0;
    let item = null;
    if (st.stream) {
      shifted = false;
      url = st.stream;
    } else {
      let live;
      if (at) {
        // A seek into another part of the same mix (the caller has decided whether that is live).
        live = { item: at.item, offset: at.offset };
      } else if (follow && after) {
        // Time-shifted listener: carry on with the next mix from its start instead of jumping to the clock.
        live = { item: followingItem(st, after), offset: 0 };
      } else {
        shifted = false;
        live = liveAt(st);
        // Clock and audio can disagree by a second; never restart a mix that just ended.
        if (after && live.item === after && live.remaining < 5) live = { item: live.next, offset: 0 };
      }
      item = live.item;
      offset = live.offset;
      url = mediaUrl(item);
    }

    const sameSource = current && current.url === url && audio.readyState >= 1;
    rec('tune ' + st.id + ' ' + (item ? (item.file || item.url) : 'stream') + (st.stream ? '' : ' @' + Math.round(offset) + 's') + ' · ' + (fxActive() ? 'engine' : 'plain') + (useFragment ? '' : ' · no #t') + (retry ? ' · retry' : '') + (sameSource ? ' · same source' : ''));
    current = { st, item, url };
    // While the source is being swapped the element fires "pause"; that must not count as a stop.
    const swapping = !sameSource;
    const done = () => { if (swapping) switching = Math.max(0, switching - 1); };
    if (sameSource) {
      if (!st.stream) { try { audio.currentTime = offset; } catch (e) { /* not seekable yet */ } }
    } else {
      switching++;
      setCors(audio, url);
      audio.src = st.stream || !useFragment ? url : url + '#t=' + offset.toFixed(1);
      audio.dataset.sync = st.stream ? '' : '1';
    }

    render();
    updateMediaSession(true);

    if (!autoplay) { done(); return; }
    wantPlaying = true;
    if (sameSource && !audio.paused) {
      // Already playing this mix (e.g. back to live): the position moved, nothing to reload.
      stopWatch();
      setPhase(audio.readyState >= 3 && !audio.seeking ? 'live' : 'buffering');
      return;
    }
    setPhase('tuning');
    startWatch();
    const p = audio.play();
    if (!p || !p.then) { done(); return; }
    p.then(done).catch(err => {
      done();
      if (token !== tuneToken) return;
      if (err && err.name === 'AbortError') return;
      if (err && err.name === 'NotAllowedError') { wantPlaying = false; setPhase('stopped'); toast('TAP PLAY TO TUNE IN'); return; }
      noteProblem('play() ' + (err && err.name ? err.name : 'rejected'));
      if (!recover()) signalLost();
    });
  }

  /* ------------------------------------------------------------------ */
  /* CDN warm-up                                                         */
  /* ------------------------------------------------------------------ */

  /* GitHub Pages' CDN keeps a file for about ten minutes, and a file nobody asked for lately takes 1.5–4 s
   * to answer EVERY request (a phone needs three in a row before the first sound: probe, index, seek).
   * One tiny range request makes the whole file hot for everybody for the next ten minutes (measured:
   * 25 ms for any range afterwards). So the mix that is on air is asked for as soon as the app opens and
   * when another station is picked, and the next mix is asked for before the current one ends. The phone
   * receives two bytes; the CDN does the work. */
  const WARM_EVERY = 6 * 60 * 1000;
  const warmedAt = new Map();
  function warmUp(url) {
    if (!url || !window.fetch) return;
    if (Date.now() - (warmedAt.get(url) || 0) < WARM_EVERY) return;
    warmedAt.set(url, Date.now());
    let same = true;
    try { same = new URL(url, location.href).origin === location.origin; } catch (e) { /* relative */ }
    const t0 = performance.now();
    fetch(url, { headers: { Range: 'bytes=0-1' }, cache: 'no-store', credentials: 'omit', mode: same ? 'same-origin' : 'no-cors' })
      .then(r => {
        try { if (r.body) r.body.cancel(); } catch (e) { /* ignore */ }
        rec('warm ' + url.split('/').slice(-2).join('/') + ' ' + Math.round(performance.now() - t0) + ' ms · ' + (r.type === 'opaque' ? 'opaque' : 'HTTP ' + r.status + (r.headers.get('x-cache') ? ' ' + r.headers.get('x-cache').toLowerCase() : '')));
      })
      .catch(() => warmedAt.delete(url));
  }
  function warmStation(st) {
    if (!st || !available(st) || st.stream) return;
    const live = liveAt(st);
    if (!live) return;
    warmUp(mediaUrl(live.item));
    if (live.remaining < 240 && live.next) warmUp(mediaUrl(live.next));
  }

  /* ------------------------------------------------------------------ */
  /* Never stay silent: a ladder of fallbacks, and a readable reason     */
  /* ------------------------------------------------------------------ */

  const MEDIA_ERRORS = { 1: 'ABORTED', 2: 'NETWORK', 3: 'DECODE', 4: 'SRC_NOT_SUPPORTED' };

  // Remember what went wrong (and, asynchronously, what the server said) for Settings → About.
  function noteProblem(what) {
    rec('problem: ' + what);
    const url = current && current.url;
    const engine = audio === audioFx ? 'engine' : 'plain';
    lastProblem = new Date().toTimeString().slice(0, 5) + ' ' + what + ' · ' + engine + (useFragment ? '' : ' · no #t');
    refreshProblem();
    if (!url || !window.fetch) return;
    const stamp = lastProblem;
    fetch(url, { headers: { Range: 'bytes=0-1' }, cache: 'no-store' }).then(r => {
      const info = 'HTTP ' + r.status + (r.headers.get('content-range') ? ' ' + r.headers.get('content-range') : '') + ' ' + (r.headers.get('content-type') || '');
      if (lastProblem === stamp) { lastProblem = stamp + ' · ' + info; refreshProblem(); }
    }).catch(err => {
      if (lastProblem === stamp) { lastProblem = stamp + ' · fetch failed: ' + (err && err.message ? err.message : err); refreshProblem(); }
    });
  }
  function refreshProblem() {
    const el = document.getElementById('problemState');
    if (el) el.textContent = lastProblem || 'None';
  }

  /* When tuning fails before anything played: 1) doubt the sound engine (start again on the plain player;
   * if that works, the engine was the problem), 2) drop the #t=offset fragment (seek after the metadata
   * loads instead). Returns true if it acted. A slow or dead network never ends up here: see inspect(). */
  function recover() {
    if (!wantPlaying || playedSinceTune || phase === 'lost') return false;     // 'lost': a retry is already scheduled
    if (fxActive() && !fxRescue) { rescueWithPlain(); return true; }
    if (useFragment && current && !current.st.stream) {
      useFragment = false;
      stallRetries = 0;
      tune({ autoplay: true, retry: true });
      return true;
    }
    return false;
  }
  function rescueWithPlain() {
    rec('rescue: trying the plain player');
    fxRescue = true;
    rescueFrom = audio;
    stallRetries = 0;
    toast('STARTING WITHOUT SOUND SHAPING…', 'info', 3500);
    switchTo(audioPlain);
  }

  /* Loading watchdog. Silence from the element is not proof that anything is broken: the first sound of
   * an hour-long mix needs several requests in a row, and a file the CDN has not served for a while takes
   * seconds for each of them. So after a quiet spell the watchdog asks the server itself (a tiny range
   * request) and tells three cases apart:
   *   - the server does not answer         -> no connection: say so, retry with a growing delay;
   *   - it answers, but slowly             -> slow network / cold CDN: keep waiting, never restart;
   *   - it answers fast, the element is silent (twice) -> the loader is stuck: restart it once, then doubt
   *     the engine, then the #t fragment.
   * The sound engine is only ever blamed when the plain player works where the engine did not. */
  const QUIET_MS = 6000;      // this long without a sign of life and the watchdog looks closer
  const GIVE_UP_MS = 60000;   // a very slow link may need this long for the first sound; beyond it, start over
  const LOADING_PATIENCE_MS = 20000;   // while the element reports an open request, a restart waits this long
  const SLOW_MS = 2500;       // the 64 KB probe taking longer than this means a slow network, not a stuck loader

  function startWatch() { clearInterval(watchTimer); watchTimer = setInterval(watchTick, 1000); }
  function stopWatch() { clearInterval(watchTimer); watchTimer = 0; probing = false; }

  function watchTick() {
    if (!wantPlaying || phase === 'live' || phase === 'stopped' || phase === 'lost') { stopWatch(); return; }
    if (document.visibilityState !== 'visible' || probing) return;
    const now = Date.now();
    if (phase === 'tuning' && !slowShown && now - tuneStartedAt > 3500) { slowShown = true; toast('WARMING UP THE SIGNAL…', 'info', 6000); }
    if (now - lastLife >= QUIET_MS) inspect();
  }

  function probeServer(url) {
    const t0 = performance.now();
    const ctl = 'AbortController' in window ? new AbortController() : null;
    const timer = setTimeout(() => { if (ctl) ctl.abort(); }, 8000);
    return fetch(url, { headers: { Range: 'bytes=0-65535' }, cache: 'no-store', signal: ctl ? ctl.signal : undefined })
      .then(r => r.arrayBuffer().then(buf => {
        clearTimeout(timer);
        return { ok: r.status === 200 || r.status === 206, status: r.status, ms: performance.now() - t0, bytes: buf.byteLength, why: 'HTTP ' + r.status };
      }))
      .catch(e => { clearTimeout(timer); return { ok: false, ms: performance.now() - t0, bytes: 0, why: e && e.name === 'AbortError' ? 'no answer in 8 s' : (e && e.message) || 'fetch failed' }; });
  }

  function inspect() {
    const url = current && current.url;
    if (!url || !window.fetch) { lastLife = Date.now(); return; }
    const token = tuneToken;
    probing = true;
    probeServer(url).then(res => {
      probing = false;
      if (token !== tuneToken || !wantPlaying || phase === 'live' || phase === 'stopped') return;
      const waited = Math.round((Date.now() - tuneStartedAt) / 1000);
      rec('probe ' + (res.ok ? 'HTTP ' + res.status : 'FAILED ' + res.why) + ' ' + Math.round(res.ms) + ' ms · quiet ' + waited + 's · ready ' + audio.readyState + ' net ' + audio.networkState);
      if (!res.ok) {
        noteProblem('server did not answer (' + res.why + ') after ' + waited + ' s');
        stopWatch();
        signalLost();
        return;
      }
      if (res.ms > SLOW_MS) {
        fastStrikes = 0;
        lastLife = Date.now() - QUIET_MS + 4000;           // look again in four seconds
        toast('SLOW NETWORK · STILL TUNING', 'info', 4000);
        if (Date.now() - tuneStartedAt > GIVE_UP_MS) {
          noteProblem('too slow: no sound after ' + waited + ' s (server needs ' + Math.round(res.ms) + ' ms for 64 KB)');
          stopWatch();
          signalLost();
        }
        return;
      }
      // The element still has a request open: it is working, only slowly (Safari needs several round trips
      // before the first sound). Restarting it would throw that progress away, so give it time.
      const since = Date.now() - (phase === 'buffering' ? waitStartedAt : tuneStartedAt);
      if (audio.networkState === 2 && since < (stallRetries ? LOADING_PATIENCE_MS * 0.6 : LOADING_PATIENCE_MS)) { fastStrikes = 0; lastLife = Date.now() - QUIET_MS + 4000; return; }
      if (++fastStrikes < 2) { lastLife = Date.now() - QUIET_MS + 3000; return; }   // one more look before blaming the loader
      fastStrikes = 0;
      stuckLoader(res, waited);
    });
  }

  function stuckLoader(res, waited) {
    noteProblem('loader stuck: no data for ' + waited + ' s while the server answers in ' + Math.round(res.ms) + ' ms (ready ' + audio.readyState + ', net ' + audio.networkState + ')');
    stallRetries++;
    if (phase === 'buffering') {                       // it was playing, then the data dried up
      if (stallRetries <= 1) { toast('CONNECTION STUCK · RETRYING', 'info', 3000); lastLife = Date.now(); try { audio.currentTime = audio.currentTime; } catch (e) { /* ignore */ } return; }
      stopWatch();
      signalLost();
      return;
    }
    if (stallRetries === 1) { toast('CONNECTION STUCK · RETRYING', 'info', 3000); restartLoad(); return; }
    if (recover()) return;
    stopWatch();
    signalLost();
  }

  // Tear the stuck loader down and ask again (a fresh connection), keeping the same output path.
  function restartLoad() {
    try { audio.removeAttribute('src'); audio.load(); } catch (e) { /* ignore */ }
    tune({ autoplay: true, retry: true });
  }

  function play() {
    if (!available(station)) { toast(station.name.toUpperCase() + ' · OFF AIR', 'info', 2600); nudge(); return; }
    fxRescue = false; rescueFrom = null; stallRetries = 0; fxHeld = false;
    rec('play');
    ensureEngine();          // only a deliberate Play (inside the tap) attaches the engine; a retune never undoes a fallback
    tune({ autoplay: true });
  }
  function stop() {
    rec('stop');
    wantPlaying = false;
    shifted = false;
    clearTimeout(retryTimer);
    retryTimer = 0;
    stopWatch();
    fxRescue = false; rescueFrom = null;
    audio.pause();
    setPhase('stopped');
    render();
    if (pendingData) applyStations(pendingData);
    applyUpdate();
  }
  function togglePlay() { if (wantPlaying) stop(); else play(); }

  function selectStation(id, { announce = true } = {}) {
    const st = stations.find(s => s.id === id);
    if (!st) return;
    const changed = st !== station;
    rec('station ' + st.id);
    station = st;
    store.set(KEYS.station, st.id);
    applyStationTheme();
    warmStation(st);
    if (!changed && wantPlaying) return;
    if (wantPlaying && available(st)) {
      tune({ autoplay: true });
    } else {
      if (wantPlaying) { audio.pause(); wantPlaying = false; setPhase('stopped'); }
      render();
      updateMediaSession(true);
      if (announce && !available(st)) toast(st.name.toUpperCase() + ' · OFF AIR', 'info', 2200);
    }
  }

  function stepStation(dir) {
    const list = wantPlaying ? availableStations() : stations;
    if (!list.length) return;
    const i = list.indexOf(station);
    const next = list[(i + dir + list.length) % list.length];
    feedback('station');
    selectStation(next.id);
  }

  function signalLost() {
    if (!wantPlaying) return;
    // A failed rescue says nothing about the engine (the plain player failed as well: the network is the
    // problem). The next attempt goes back to the engine, so shaping is not silently lost.
    const back = fxRescue && rescueFrom && audio === audioPlain && rescueFrom === audioFx && !fxUnsupported ? rescueFrom : null;
    fxRescue = false; rescueFrom = null;
    setPhase('lost');
    if (!lastProblem) noteProblem('signal lost');
    const code = (lastProblem.match(/E\d/) || [''])[0];
    toast('SIGNAL LOST' + (code ? ' · ' + code : '') + ' · RETUNING', 'error', 3000);
    if (retryTimer) return;      // a retry is already scheduled (the element reports one failure twice)
    rec('signal lost, retry in ' + Math.round(retryDelay / 1000) + ' s');
    retryTimer = setTimeout(() => {
      retryTimer = 0;
      retryDelay = Math.min(30000, retryDelay * 2);
      if (back && wantPlaying && audio === audioPlain) {
        try { audioPlain.pause(); } catch (e) { /* ignore */ }
        audio = back; current = null; fxEverPlayed = false;
      }
      if (wantPlaying) tune({ autoplay: true });
    }, retryDelay);
  }

  const handlers = {
    loadedmetadata() {
      if (!current || audio.dataset.sync !== '1' || !current.item) return;
      audio.dataset.sync = '';
      if (shifted) return;
      const live = liveAt(current.st);
      if (!live) return;
      if (live.item !== current.item) { if (wantPlaying) tune({ autoplay: true }); return; }
      if (Math.abs(audio.currentTime - live.offset) > 2) {
        try { audio.currentTime = live.offset; } catch (e) { /* ignore */ }
      }
    },
    playing() {
      retryDelay = 4000;
      playedSinceTune = true;
      stallRetries = 0; fastStrikes = 0;
      stopWatch();
      noteStart();
      if (audio === audioFx) { fxEverPlayed = true; fxFails = 0; watchFx(); }
      if (wantPlaying) setPhase('live');
      toast('');
      if (fxRescue && audio === audioPlain) { fxRescue = false; rescueFrom = null; fxFault('SOUND SHAPING PAUSED · THE ENGINE DID NOT START'); }
      if (notice) { toast(notice.message, notice.kind, 5200); notice = null; }
    },
    waiting() {
      if (!wantPlaying || phase === 'tuning') return;
      setPhase('buffering');
      waitStartedAt = Date.now();
      lastLife = Date.now(); fastStrikes = 0;
      startWatch();
    },
    seeked() { if (wantPlaying && phase === 'buffering' && !audio.paused && audio.readyState >= 3) setPhase('live'); },
    canplay() { if (wantPlaying && phase === 'buffering' && !audio.paused && audio.readyState >= 3) setPhase('live'); },
    pause() {
      if (audio.ended || !wantPlaying) return;
      // Right after (re)tuning, a pause is the audio session reconfiguring, not the listener
      // (this includes pauses that arrive while the source is still being swapped): start again.
      if (Date.now() - lastTuneAt < 5000 && document.visibilityState === 'visible') {
        if (pauseRetries >= 4) {
          // Give control back instead of hanging: the next tap on play starts it inside a user gesture.
          wantPlaying = false;
          stopWatch();
          setPhase('stopped');
          render();
          toast('TAP PLAY TO RESUME', 'info', 3000);
          return;
        }
        pauseRetries++;
        const el = audio;
        setTimeout(() => {
          if (el !== audio || !wantPlaying || !audio.paused) return;
          if (fxActive()) sound.resume();
          const r = audio.play();
          if (r && r.catch) r.catch(() => { /* the stall watchdog handles it */ });
        }, 120);
        return;
      }
      // Paused by the system (call, Siri, another app): treat it as a stop.
      if (switching) return;
      wantPlaying = false;
      setPhase('stopped');
      render();
    },
    ended() {
      const finished = current && current.item;
      if (wantPlaying) tune({ autoplay: true, after: finished, follow: shifted });
    },
    error() {
      if (!wantPlaying) return;
      const code = audio.error ? audio.error.code : 0;
      noteProblem('E' + code + ' ' + (MEDIA_ERRORS[code] || 'MEDIA_ERROR') + (audio.error && audio.error.message ? ' (' + audio.error.message + ')' : ''));
      if (recover()) return;
      signalLost();
    },
    timeupdate() { checkCue(); }
  };
  function wireAudio(el) {
    Object.keys(handlers).forEach(type => el.addEventListener(type, e => { if (el === audio) handlers[type](e); }));
    // Signs of life from the loader keep the watchdog calm.
    ['progress', 'loadedmetadata', 'loadeddata', 'canplay', 'canplaythrough', 'durationchange', 'seeked', 'timeupdate', 'playing']
      .forEach(type => el.addEventListener(type, () => { if (el === audio) lastLife = Date.now(); }));
    ['loadstart', 'loadedmetadata', 'canplay', 'playing']
      .forEach(type => el.addEventListener(type, () => { if (el === audio && marks.t0 !== undefined && marks[type] === undefined) marks[type] = Math.round(performance.now() - marks.t0); }));
    // The flight recorder: what the element did, and when, relative to the start of this tune.
    ['loadstart', 'loadedmetadata', 'canplay', 'waiting', 'stalled', 'pause', 'ended', 'error']
      .forEach(type => el.addEventListener(type, () => {
        if (el !== audio) return;
        const code = type === 'error' && audio.error ? ' E' + audio.error.code : '';
        const page = type === 'pause' ? ' · page ' + document.visibilityState : '';
        rec(type + code + ' +' + ((Date.now() - tuneStartedAt) / 1000).toFixed(1) + 's · ready ' + audio.readyState + ' net ' + audio.networkState + page);
      }));
  }

  // Settings → About: how long the last start took, and where the time went.
  function noteStart() {
    if (marks.t0 === undefined || marks.done) return;
    marks.done = true;
    const sec = ms => (ms / 1000).toFixed(1) + ' s';
    const total = performance.now() - marks.t0;
    lastStart = (audio === audioFx ? 'engine' : 'plain') + ' · ' + sec(total)
      + (marks.loadedmetadata !== undefined ? ' (info ' + sec(marks.loadedmetadata) + ')' : '')
      + (stallRetries ? ' · ' + stallRetries + ' retry' : '');
    const el = document.getElementById('startState');
    if (el) el.textContent = lastStart;
    rec('START ' + lastStart);
  }
  wireAudio(audioPlain);

  function ensureFx() {
    if (audioFx) return audioFx;
    const el = makeAudio(true);
    wireAudio(el);
    sound.connect(el);       // throws if Web Audio is unavailable
    audioFx = el;
    return el;
  }

  /* The first time shaping is switched on, playback moves to an element that is routed
   * through the sound chain (one re-tune). From then on "off" is a neutral bypass inside the
   * chain, so toggling never interrupts the music. A fresh app launch with shaping off uses the
   * plain <audio> path again. */
  let fxUnsupported = false;   // Web Audio is missing or refuses to build the chain (permanent for this launch)
  let fxFails = 0;             // times the engine did not start where the plain player did; reset by a success or by the switch
  const FX_MAX_FAILS = 2;      // then it is parked until the Sound switch is toggled
  const fxParked = () => fxFails >= FX_MAX_FAILS;
  let fxWatchTimer = 0;
  let abHold = false;      // A/B compare: while held, the chain is neutral

  function switchTo(next) {
    if (next === audio) return;
    const was = wantPlaying, prev = audio;
    audio = next; current = null; fxEverPlayed = false;
    if (next === audioFx && was) toast('STARTING SOUND ENGINE…', 'info', 3000);
    try { prev.pause(); } catch (e) { /* ignore */ }
    if (was) tune({ autoplay: true }); else render();
  }

  /* The chain is attached when playback first starts (inside the tap on play), so shaping on/off and
   * preset changes afterwards never touch the player. Plain <audio> is only the fallback. */
  function ensureEngine() {
    if (!sound || fxUnsupported || fxParked() || audio === audioFx || !audioPlain.paused) return;
    try {
      audio = ensureFx();
      current = null;
      fxEverPlayed = false;
    } catch (e) {
      console.warn('BURZH sound chain unavailable:', e);
      fxUnavailable('SOUND SHAPING IS NOT AVAILABLE HERE');
    }
  }

  function selectOutput() { applySound(); }

  // Web Audio itself is not there: nothing to retry.
  function fxUnavailable(message) {
    fxUnsupported = true;
    clearInterval(fxWatchTimer);
    noteProblem(message.toLowerCase());
    toast(message, 'error', 4800);
    if (audio !== audioPlain) switchTo(audioPlain);
    applySound();
    syncControls();
    renderSettings();
  }

  // The engine did not work where the plain player does. It is retried at the next mix; after two misses it
  // is parked until the Sound switch is toggled. The switch itself always stays usable.
  function fxFault(message, { switchAway = false } = {}) {
    fxFails++;
    rec('engine fault ' + fxFails + '/' + FX_MAX_FAILS + ': ' + message);
    clearInterval(fxWatchTimer);
    noteProblem(message.toLowerCase());
    notice = { message: message + (fxParked() ? ' · SWITCH SHAPING OFF AND ON TO RETRY' : ''), kind: 'error' };
    if (phase === 'live') { toast(notice.message, 'error', 5200); notice = null; }
    if (switchAway && audio !== audioPlain) switchTo(audioPlain);
    applySound();
    syncControls();
    renderSettings();
  }

  /* The audio system can take the chain away while the app is open (a call, Siri, another app, a route change,
   * the screen locking): the context stops and the music, which flows through it, goes silent. Resume it as
   * soon as possible; if it stays down, play on the plain player so the music never stays silent, and bring the
   * chain back at the next tap (iOS only restarts a context inside a gesture). This is not an engine failure. */
  let fxIdle = 0;              // seconds in a row (page visible, music live) that the chain was not running
  let fxHeld = false;          // the chain is paused for the moment; a tap restores it
  let lastRestore = 0, restoreCount = 0;
  function engineHealth() {
    if (!fxActive() || !wantPlaying || phase !== 'live') { fxIdle = 0; return; }
    if (document.visibilityState !== 'visible') return;
    if (sound.state === 'running') { fxIdle = 0; return; }
    fxIdle++;
    if (fxIdle === 1 || fxIdle === 3) { rec('engine ' + sound.state + ' while playing, resuming'); sound.resume(); }
    if (fxIdle >= 6) holdEngine();
  }
  function holdEngine() {
    fxIdle = 0;
    if (!fxActive()) return;
    const wanted = settings.sound.on;
    fxHeld = wanted;
    rec('engine held (' + sound.state + '): playing on the plain player' + (wanted ? ', a tap restores shaping' : ''));
    toast(wanted ? 'SOUND SHAPING PAUSED · TAP TO RESTORE' : 'AUDIO RESTARTED', 'info', 5000);
    switchTo(audioPlain);
    applySound(); syncControls(); renderSettings();
  }
  function restoreEngine() {
    if (!fxHeld || !sound || fxUnsupported) return;
    if (!settings.sound.on || !wantPlaying) { fxHeld = false; return; }
    if (Date.now() - lastRestore < 15000 || restoreCount >= 3) return;
    lastRestore = Date.now(); restoreCount++;
    fxHeld = false;
    rec('tap: restoring the sound engine (' + restoreCount + ')');
    sound.resume();                                    // inside the tap: the only place iOS lets a stopped context start
    try { switchTo(ensureFx()); } catch (e) { fxUnavailable('SOUND SHAPING IS NOT AVAILABLE HERE'); }
  }

  // After playback starts through the chain, make sure sound actually comes out of it.
  function watchFx() {
    clearInterval(fxWatchTimer);
    if (!fxActive()) return;
    let ticks = 0;
    const t0 = audio.currentTime;
    fxWatchTimer = setInterval(() => {
      if (!fxActive() || !wantPlaying) { clearInterval(fxWatchTimer); return; }
      if (document.visibilityState !== 'visible') return;
      ticks++;
      if (sound.state !== 'running') {
        if (ticks === 3 || ticks === 8) sound.resume();
        if (ticks > 14) fxFault('SOUND SHAPING PAUSED · THE ENGINE STOPPED RUNNING', { switchAway: true });
        return;
      }
      if (sound.hasSignal()) { clearInterval(fxWatchTimer); return; }
      if (ticks > 16 && !audio.paused && audio.currentTime - t0 > 3) fxFault('SOUND SHAPING PAUSED · NO SOUND CAME OUT OF THE ENGINE', { switchAway: true });
    }, 500);
  }

  /* Sound presets: "auto" follows the station (stations.json: "sound"). */
  function presetKey() {
    const k = settings.sound.preset;
    return k === 'auto' ? ((station && station.sound) || 'flat') : k;
  }
  function effectiveParams() {
    const P = window.BurzhSound;
    if (settings.sound.preset === 'custom' && settings.sound.custom) return P.clone(settings.sound.custom);
    return P.clone((P.PRESETS[presetKey()] || P.PRESETS.flat).p);
  }
  function applySound() {
    if (!sound) return;
    // Off keeps the chain in the signal path but neutral (flat EQ, no enhancement).
    const p = settings.sound.on && !abHold ? effectiveParams() : window.BurzhSound.clone(window.BurzhSound.PRESETS.flat.p);
    sound.apply(p, false);
    renderSound();
  }

  /* ------------------------------------------------------------------ */
  /* Now playing                                                         */
  /* ------------------------------------------------------------------ */

  function nowPlaying() {
    const st = station;
    if (!st) return null;
    if (!available(st)) {
      return { st, title: 'NO SIGNAL', sub: 'OFF AIR · ' + st.name.toUpperCase(), line: 'No music here yet', item: null, offset: 0, duration: 0 };
    }
    if (st.stream) return { st, title: st.streamTitle || st.name, sub: 'LIVE STREAM', line: 'Live stream', item: null, offset: 0, duration: 0 };

    let item, offset;
    const loaded = current && current.st === st && current.item;
    if (wantPlaying && loaded && Number.isFinite(audio.currentTime) && audio.readyState >= 1) {
      item = current.item;
      offset = audio.currentTime;
    } else {
      const live = liveAt(st);
      item = live.item;
      offset = live.offset;
    }
    const cue = cueAt(item, offset);
    const span = spanOf(st, item);
    const groups = groupsOf(st);
    const position = groups.findIndex(g => g.includes(st.items.indexOf(item))) + 1;
    // "02 / 05" only when there is more than one mix to count.
    const meta = (groups.length > 1 ? String(position).padStart(2, '0') + ' / ' + String(groups.length).padStart(2, '0') + ' · ' : '') + fmt(span.total);
    const title = cue ? cue.title : item.title;
    const artist = cue && cue.artist ? cue.artist : (item.artist || '');
    return {
      st, item, span, cue, title, artist,
      offset: span.start + offset,           // position in the whole mix
      duration: span.total,
      sub: cue && cue.artist ? cue.artist : (item.artist ? item.artist + ' · ' + meta : meta),
      line: cue ? (cue.artist ? cue.artist + ' — ' + cue.title : cue.title) : (item.artist ? item.artist + ' — ' : '') + item.title + ' · ' + fmt(span.total)
    };
  }

  function checkCue() {
    const np = nowPlaying();
    const key = np && np.item ? np.item.file + '|' + (np.cue ? np.cue.at : '-') : '';
    if (key !== lastCueKey) { lastCueKey = key; render(); updateMediaSession(false); }
  }

  function updateMediaSession(force) {
    if (!('mediaSession' in navigator) || !station) return;
    const np = nowPlaying();
    const key = [np.st.id, np.title, np.sub].join('|');
    if (force || key !== lastMetaKey) {
      lastMetaKey = key;
      try {
        const art = np.st.art ? new URL(np.st.art, location.href).href : null;
        navigator.mediaSession.metadata = new MediaMetadata({
          title: np.title,
          artist: np.artist || np.st.name + ' · BURZH beats',
          album: 'BURZH beats · ' + np.st.name,
          artwork: art ? [{ src: art, sizes: '1024x1024', type: 'image/png' }] : []
        });
      } catch (e) { /* older Safari */ }
    }
    try { navigator.mediaSession.playbackState = wantPlaying ? 'playing' : 'paused'; } catch (e) { /* ignore */ }
    if (navigator.mediaSession.setPositionState && np.duration > 0) {
      try { navigator.mediaSession.setPositionState({ duration: np.duration, position: Math.min(np.duration, Math.max(0, np.offset)), playbackRate: 1 }); } catch (e) { /* ignore */ }
    }
  }

  function bindMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const set = (action, fn) => { try { navigator.mediaSession.setActionHandler(action, fn); } catch (e) { /* unsupported action */ } };
    set('play', () => play());
    set('pause', () => stop());
    set('stop', () => stop());
    set('nexttrack', () => stepStation(1));
    set('previoustrack', () => stepStation(-1));
    // Scrubbing from the lock screen and StandBy moves inside the current mix.
    set('seekto', d => { if (d && Number.isFinite(d.seekTime)) seekTo(d.seekTime); });
    set('seekforward', null);
    set('seekbackward', null);
  }

  /* ------------------------------------------------------------------ */
  /* Seek: drag the rail to move inside the current mix (time-shift)     */
  /* ------------------------------------------------------------------ */

  const scrub = { active: false, time: 0 };

  // The mix that follows `item` in the current cycle (used while time-shifted).
  function followingItem(st, item) {
    const t = Math.max(0, (Date.now() - epochMs) / 1000);
    const cycle = Math.floor(t / st.total);
    const order = cycleOrder(st, cycle).map(i => st.items[i]);
    const k = order.indexOf(item);
    if (k >= 0 && k + 1 < order.length) return order[k + 1];
    return st.items[cycleOrder(st, cycle + 1)[0]];
  }

  const canSeek = () => !!(wantPlaying && current && current.item && !current.st.stream && audio.readyState >= 1);

  // `time` is a moment of the whole mix; a mix cut into parts switches to the part that holds it.
  function seekTo(time) {
    if (!canSeek()) return;
    const span = spanOf(current.st, current.item);
    const to = partAt(span, Math.min(Math.max(0, span.total - 1), time));
    if (to.item !== current.item) {
      const live = liveAt(current.st);
      shifted = !(live && live.item === to.item && Math.abs(live.offset - to.offset) < 4);
      snapProgress = true;
      rec('seek to ' + (to.item.file || to.item.url) + ' @' + Math.round(to.offset) + 's');
      tune({ autoplay: true, at: to });
      return;
    }
    const item = current.item;
    const length = Number.isFinite(audio.duration) && audio.duration > 0 ? Math.min(audio.duration, item.duration) : item.duration;
    const t = Math.max(0, Math.min(Math.max(0, length - 1), to.offset));
    audio.dataset.sync = '';
    try { audio.currentTime = t; } catch (e) { return; }
    const live = liveAt(current.st);
    shifted = !(live && live.item === item && Math.abs(live.offset - t) < 4);
    snapProgress = true;
    renderStatus();
    render();
    updateMediaSession(true);
  }

  function goLive() {
    if (!wantPlaying) return;
    feedback('play');
    shifted = false;
    snapProgress = true;
    tune({ autoplay: true });
  }

  // Back from a lock/sleep: keep the listener's own position when time-shifted.
  function revive() {
    if (shifted && current && audio.readyState >= 1) {
      const r = audio.play();
      if (r && r.catch) r.catch(() => { /* the stall watchdog handles it */ });
    } else {
      tune({ autoplay: true });
    }
  }

  function bindSeek(el) {
    const rail = el.querySelector('.live-rail');
    let pid = null;
    let lastMagnet = null;

    const timeAt = clientX => {
      const r = rail.getBoundingClientRect();
      const span = spanOf(current.st, current.item);
      const dur = span.total;
      const ratio = clamp01((clientX - r.left) / (r.width || 1));
      let t = ratio * dur;
      let magnet = null;
      // Track starts attract the thumb a little, with a tick of feedback.
      mixCues(span).forEach(c => { if (Math.abs(c.at / dur - ratio) * r.width < 7) { t = c.at; magnet = c.at; } });
      if (magnet !== lastMagnet) { lastMagnet = magnet; if (magnet !== null) feedback('soft'); }
      return t;
    };
    const move = e => { scrub.time = timeAt(e.clientX); renderProgress(); };

    el.addEventListener('pointerdown', e => {
      if (e.button > 0 || pid !== null || !canSeek()) return;
      if (document.documentElement.classList.contains('idle')) return;   // the first touch only wakes the screen
      e.preventDefault();
      e.stopPropagation();
      pid = e.pointerId;
      try { el.setPointerCapture(pid); } catch (err) { /* ignore */ }
      scrub.active = true;
      el.classList.add('dragging');
      lastMagnet = null;
      feedback('play');
      move(e);
    });
    el.addEventListener('pointermove', e => { if (e.pointerId === pid) move(e); });
    const finish = (e, commit) => {
      if (e.pointerId !== pid) return;
      pid = null;
      scrub.active = false;
      el.classList.remove('dragging');
      if (commit) { feedback('play'); seekTo(scrub.time); }
      renderProgress();
    };
    el.addEventListener('pointerup', e => finish(e, true));
    el.addEventListener('pointercancel', e => finish(e, false));

    el.addEventListener('keydown', e => {
      if (!canSeek()) return;
      const big = e.shiftKey || e.key === 'PageUp' || e.key === 'PageDown';
      const step = big ? 60 : 10;
      let target = null;
      const span = spanOf(current.st, current.item);
      const now = span.start + audio.currentTime;
      if (e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'PageUp') target = now + step;
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown' || e.key === 'PageDown') target = now - step;
      else if (e.key === 'Home') target = 0;
      else if (e.key === 'End') target = span.total;
      if (target === null) return;
      e.preventDefault();
      e.stopPropagation();
      seekTo(target);
    });
  }

  /* ------------------------------------------------------------------ */
  /* Rendering                                                           */
  /* ------------------------------------------------------------------ */

  const fmt = sec => {
    if (!Number.isFinite(sec) || sec < 0) return '--:--';
    const s = Math.floor(sec);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, '0');
    return h ? h + ':' + String(m).padStart(2, '0') + ':' + ss : m + ':' + ss;
  };
  const bind = (name, text) => document.querySelectorAll('[data-bind="' + name + '"]').forEach(el => {
    if (el.textContent !== text) {
      el.textContent = text;
      if (el.dataset.swap !== undefined) { el.classList.remove('swap'); void el.offsetWidth; el.classList.add('swap'); }
    }
  });

  const planets = [];
  let planetsPrimed = false;

  function applyStationTheme() {
    if (!station) return;
    const root = document.documentElement.style;
    applyAccent();
    root.setProperty('--orbit', (station.tempo || 11) + 's');
    document.documentElement.dataset.current = station.id;
    const idx = stations.indexOf(station);
    planets.forEach(pl => pl.setStation(station, idx, stations.length, { instant: !planetsPrimed }));
    planetsPrimed = true;
    if (settings.sound.preset === 'auto') applySound();
    document.querySelectorAll('button[data-station]').forEach(btn => {
      const st = stations.find(s => s.id === btn.dataset.station);
      btn.classList.toggle('active', btn.dataset.station === station.id);
      btn.classList.toggle('off', !available(st));
      btn.setAttribute('aria-pressed', String(btn.dataset.station === station.id));
    });
  }

  function renderStatus() {
    const label = {
      stopped: available(station) ? 'ON AIR NOW' : 'OFF AIR',
      tuning: 'TUNING…',
      live: shifted ? 'TIMESHIFT' : 'LIVE',
      buffering: 'BUFFERING…',
      lost: 'SIGNAL LOST'
    }[phase] || '';
    bind('status', label);
    const playing = wantPlaying;
    document.querySelectorAll('.play-toggle').forEach(b => {
      b.classList.toggle('is-playing', playing);
      b.setAttribute('aria-label', playing ? 'Stop' : 'Play');
    });
    document.documentElement.classList.toggle('shifted', shifted && playing);
    document.documentElement.classList.toggle('is-playing', playing && phase === 'live');
    document.documentElement.classList.toggle('is-on', playing);
    planets.forEach(pl => pl.setPlaying(playing && phase === 'live'));
  }

  function render() {
    if (!station) return;
    const np = nowPlaying();
    const idx = stations.indexOf(station) + 1;
    bind('station', station.name);
    bind('title', np.title);
    bind('sub', np.sub);
    bind('nowline', np.line);
    bind('channel', 'CH ' + String(idx).padStart(2, '0') + ' / ' + String(stations.length).padStart(2, '0'));
    const lines = station.tagline || [];
    const tag = lines.join('\n');
    document.querySelectorAll('[data-bind="tagline"]').forEach(el => {
      if (el.dataset.raw === tag) return;
      el.dataset.raw = tag;
      el.textContent = '';
      if (el.dataset.join) { el.textContent = lines.join(el.dataset.join); return; }     // one line (caption under the planet)
      lines.forEach((line, i) => { if (i) el.appendChild(document.createElement('br')); el.appendChild(document.createTextNode(line)); });
    });
    renderStatus();
    renderProgress(np);
  }

  let lastRatio = 0;
  let snapProgress = false;
  const clamp01 = v => Math.max(0, Math.min(1, v));

  function renderProgress(np = nowPlaying()) {
    if (!np) return;
    const seekable = canSeek() && !!np.duration;
    const offset = scrub.active ? scrub.time : np.offset;
    const ratio = np.duration ? clamp01(offset / np.duration) : 0;
    // Jumps (new mix, other station, a seek) snap instantly instead of sliding.
    const snap = snapProgress || ratio < lastRatio - 0.005;
    snapProgress = false;
    lastRatio = ratio;
    document.querySelectorAll('.seek').forEach(el => {
      const fill = el.querySelector('.live-fill'), thumb = el.querySelector('.seek-thumb');
      const pct = ratio.toFixed(4);
      if (snap) {
        fill.style.transition = 'none'; thumb.style.transition = 'none';
        fill.style.transform = 'scaleX(' + pct + ')'; thumb.style.left = (ratio * 100).toFixed(3) + '%';
        void el.offsetWidth;
        fill.style.transition = ''; thumb.style.transition = '';
      } else {
        fill.style.transform = 'scaleX(' + pct + ')';
        thumb.style.left = (ratio * 100).toFixed(3) + '%';
      }
      el.classList.toggle('can-seek', seekable);
      el.setAttribute('aria-disabled', String(!seekable));
      if (seekable) {
        el.setAttribute('aria-valuemax', String(Math.round(np.duration)));
        el.setAttribute('aria-valuenow', String(Math.round(offset)));
        el.setAttribute('aria-valuetext', fmt(offset) + ' of ' + fmt(np.duration));
      }
      renderTicks(el, np);
      if (el.classList.contains('dragging')) placeTip(el, np, ratio, offset);
    });
    bind('elapsed', np.duration ? fmt(offset) : '');
    bind('remaining', np.duration ? 'NEXT −' + fmt(np.duration - offset) : (available(station) ? '∞' : ''));
  }

  // Track starts inside the mix, if the station lists them (cues in stations.json).
  function renderTicks(el, np) {
    const box = el.querySelector('.seek-ticks');
    const cues = np.span ? mixCues(np.span) : [];
    const key = np.span ? np.span.parts.map(p => p.file || p.url).join('+') + '|' + cues.length : '';
    if (box.dataset.key === key) return;
    box.dataset.key = key;
    box.textContent = '';
    cues.forEach(c => {
      if (!c.at || !np.duration) return;
      const i = document.createElement('i');
      i.style.left = (c.at / np.duration * 100).toFixed(3) + '%';
      box.appendChild(i);
    });
  }

  function placeTip(el, np, ratio, offset) {
    const tip = el.querySelector('.seek-tip');
    const rail = el.querySelector('.live-rail');
    const w = rail.getBoundingClientRect().width;
    if (!w) return;
    tip.querySelector('b').textContent = fmt(offset);
    let cue = null;
    if (np.span) for (const c of mixCues(np.span)) { if (c.at <= offset + 0.5) cue = c; else break; }
    let info = cue && cue.title ? cue.title : '';
    if (!info && np.span) {
      const live = liveAt(np.st);
      if (live && np.span.parts.includes(live.item)) {
        const d = offset - (spanOf(np.st, live.item).start + live.offset);
        info = Math.abs(d) < 4 ? 'Live position' : (d > 0 ? '+' : '−') + fmt(Math.abs(d)) + (d > 0 ? ' ahead of live' : ' behind live');
      }
    }
    tip.querySelector('span').textContent = info;
    tip.querySelector('span').hidden = !info;
    const half = tip.offsetWidth / 2;
    tip.style.left = Math.max(half, Math.min(w - half, ratio * w)) + 'px';
  }

  // "Gorodskoy Okrug Krasnogorsk" → "Krasnogorsk": the district word adds length, not information.
  function cleanPlace(name) {
    return String(name || '').replace(/^(gorodskoy|munitsipal'?nyy?|urban|municipal)\s+(okrug|district)\s+/i, '').replace(/^(городской|муниципальный)\s+округ\s+/i, '').trim();
  }

  /* Landscape: the planet is centred in the room right of the clock (the clock's width depends on the screen). */
  function placeStage() {
    const scr = document.querySelector('.landscape');
    const clock = scr && scr.querySelector('.clock');
    if (!scr || !clock || !isLandscape()) return;
    const W = scr.clientWidth, left = clock.getBoundingClientRect().left;
    const right = Math.max(...[...clock.children].map(c => c.getBoundingClientRect().right));   // the digits, not the box
    const clockW = right - left;
    if (!(clockW > 0)) return;
    const stage = Math.round(Math.min(Math.max(left + clockW + W * 0.02, W * 0.4), W * 0.6));
    scr.style.setProperty('--stage-left', stage + 'px');
    scr.style.setProperty('--clock-w', Math.round(clockW) + 'px');
  }

  function renderClock() {
    const d = new Date();
    bind('hh', String(d.getHours()).padStart(2, '0'));
    bind('mm', String(d.getMinutes()).padStart(2, '0'));
    const days = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
    const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
    bind('date', days[d.getDay()] + ' ' + String(d.getDate()).padStart(2, '0') + ' ' + months[d.getMonth()]);
    placeStage();
  }

  /* ------------------------------------------------------------------ */
  /* Ambient screen: idle chrome, wake lock, night mode, burn-in shift   */
  /* ------------------------------------------------------------------ */

  const landscapeQuery = window.matchMedia('(orientation: landscape)');
  const isLandscape = () => landscapeQuery.matches;
  let idleTimer = 0;
  let swallowClick = false;
  let wakeLock = null;
  let wakePending = false;

  function overlayOpen() { return !!document.querySelector('.overlay.show'); }

  function scheduleIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (isLandscape() && !overlayOpen()) document.documentElement.classList.add('idle');
    }, IDLE_MS);
  }
  function wake() {
    document.documentElement.classList.remove('idle');
    scheduleIdle();
    // Some browsers only grant a wake lock after a user gesture.
    if (!wakeLock && wantWakeLock()) updateWakeLock();
  }
  document.addEventListener('pointerdown', e => {
    if (document.documentElement.classList.contains('idle')) {
      // First touch only wakes the screen; it must not press a hidden button.
      swallowClick = true;
      e.preventDefault();
      e.stopPropagation();
    }
    wake();
    if (fxHeld && !(e.target && e.target.closest && e.target.closest('.play-toggle'))) restoreEngine();
  }, true);
  document.addEventListener('click', e => {
    if (swallowClick) { swallowClick = false; e.preventDefault(); e.stopPropagation(); }
  }, true);
  document.addEventListener('keydown', wake, true);

  function wantWakeLock() {
    return settings.keepAwake && isLandscape() && document.visibilityState === 'visible';
  }
  async function updateWakeLock() {
    const want = wantWakeLock();
    try { if (window.AndroidBridge && AndroidBridge.setKeepAwake) AndroidBridge.setKeepAwake(!!want); } catch (e) { /* not in the Android shell */ }
    if (!('wakeLock' in navigator)) return;
    if (want && !wakeLock && !wakePending) {
      wakePending = true;
      try {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      } catch (e) {
        wakeLock = null;
      } finally {
        wakePending = false;
      }
      if (!wantWakeLock() && wakeLock) { try { await wakeLock.release(); } catch (e) { /* ignore */ } wakeLock = null; }
    } else if (!want && wakeLock) {
      try { await wakeLock.release(); } catch (e) { /* ignore */ }
      wakeLock = null;
    }
  }

  function isNight() {
    if (settings.night === 'on') return true;
    if (settings.night === 'off') return false;
    const h = new Date().getHours();
    return h >= NIGHT_FROM || h < NIGHT_TO;
  }
  // Night mode always uses the black palette, whatever background is chosen.
  const THEME_COLOR = { black: '#050606', white: '#F1F1EE', night: '#000000' };
  const onPaper = () => settings.theme === 'white' && !isNight();
  // The station's own colour, as shown on the current background. Every station brings a version for
  // paper (accentPaper); without one the accent is darkened 20 % so small text and thin lines keep their contrast.
  const isHex = h => /^#[0-9a-f]{6}$/i.test(h || '');
  function accentFor(st) {
    const base = isHex(st && st.accent) ? st.accent : '#ff3b30';
    if (!onPaper()) return base;
    if (isHex(st && st.accentPaper)) return st.accentPaper;
    const k = 0.8, ch = i => Math.round(parseInt(base.slice(1 + i * 2, 3 + i * 2), 16) * k).toString(16).padStart(2, '0');
    return '#' + ch(0) + ch(1) + ch(2);
  }
  function applyAccent() {
    document.documentElement.style.setProperty('--accent', accentFor(station));
    if (window.BurzhTheme) window.BurzhTheme.refresh();   // canvases pick the new colours up on their next frame
  }
  function applyNight() {
    const night = isNight();
    document.documentElement.classList.toggle('night', night);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = night ? THEME_COLOR.night : (THEME_COLOR[settings.theme] || THEME_COLOR.black);
    applyAccent();
  }
  function applyTheme() {
    document.documentElement.classList.toggle('theme-white', settings.theme === 'white');
    applyNight();
  }

  // Reduce motion: follows the phone's setting (Accessibility → Motion) unless it is switched on or off here.
  // Calm mode stills the planet, the stars and every CSS animation (see html.calm in index.html).
  const motionQuery = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
  const calmOn = () => settings.motion === 'on' || (settings.motion !== 'off' && !!motionQuery.matches);
  function applyMotion() { document.documentElement.classList.toggle('calm', calmOn()); }
  // The change event alone is not enough: Chromium drops it when something reads `.matches` in between (the planet
  // does, every frame). So the class is also re-checked every second and when the app comes back to the front.
  if (motionQuery.addEventListener) motionQuery.addEventListener('change', applyMotion);
  else if (motionQuery.addListener) motionQuery.addListener(applyMotion);

  function shiftPixels() {
    // Tiny drift keeps static pixels from burning into an OLED panel.
    const r = () => (Math.round(Math.random() * 10) - 5) + 'px';
    document.documentElement.style.setProperty('--shift-x', isLandscape() ? r() : '0px');
    document.documentElement.style.setProperty('--shift-y', isLandscape() ? r() : '0px');
  }

  function onOrientation() {
    if (isLandscape()) scheduleIdle(); else { clearTimeout(idleTimer); document.documentElement.classList.remove('idle'); }
    shiftPixels();
    updateWakeLock();
  }
  if (landscapeQuery.addEventListener) landscapeQuery.addEventListener('change', onOrientation);
  else if (landscapeQuery.addListener) landscapeQuery.addListener(onOrientation);
  // the planet follows the clock: after a resize, a turn of the phone, and once the dot face has loaded
  window.addEventListener('resize', () => requestAnimationFrame(placeStage));
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(placeStage);

  document.addEventListener('visibilitychange', () => {
    rec('page ' + document.visibilityState);
    if (document.visibilityState === 'hidden') saveLog();
    if (document.visibilityState === 'visible') {
      configureAudioSession();
      applyNight();
      applyMotion();
      render();
      refreshWeather(false);
      warmStation(station);
      checkForUpdate(false);
      if (fxActive() && wantPlaying) sound.resume().then(() => { if (wantPlaying && audio.paused) revive(); });
    }
    updateWakeLock();
  });

  /* ------------------------------------------------------------------ */
  /* Weather (Open-Meteo, no API key)                                    */
  /* ------------------------------------------------------------------ */

  const WEATHER_REFRESH_MS = 30 * 60 * 1000;
  const WMO = {
    0: 'CLEAR', 1: 'MOSTLY CLEAR', 2: 'PARTLY CLOUDY', 3: 'OVERCAST', 45: 'FOG', 48: 'FOG',
    51: 'DRIZZLE', 53: 'DRIZZLE', 55: 'DRIZZLE', 56: 'ICY DRIZZLE', 57: 'ICY DRIZZLE',
    61: 'RAIN', 63: 'RAIN', 65: 'HEAVY RAIN', 66: 'ICY RAIN', 67: 'ICY RAIN',
    71: 'SNOW', 73: 'SNOW', 75: 'HEAVY SNOW', 77: 'SNOW GRAINS',
    80: 'SHOWERS', 81: 'SHOWERS', 82: 'HEAVY SHOWERS', 85: 'SNOW SHOWERS', 86: 'SNOW SHOWERS',
    95: 'THUNDERSTORM', 96: 'THUNDER · HAIL', 99: 'THUNDER · HAIL'
  };
  let weatherLoading = false;

  async function fetchJson(url, timeoutMs = 12000) {
    const ctrl = 'AbortController' in window ? new AbortController() : null;
    const timer = setTimeout(() => ctrl && ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl ? ctrl.signal : undefined, cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  function weatherStatus(text, isError) {
    const el = $('weatherStatus');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('error', !!isError);
  }
  const zoneName = zone => String(zone || '').split('/').pop().replace(/_/g, ' ');

  function renderWeather() {
    const geo = settings.geo;
    const on = !!(settings.weather && geo);
    document.documentElement.classList.toggle('has-weather', on);
    const box = $('weatherWidget');
    if (box) box.hidden = !on;
    const btn = $('locationBtn');
    if (btn) btn.hidden = !on;
    syncControls();
    if (!on) { weatherStatus(''); return; }
    const w = store.get(KEYS.weather, null);
    const place = ((geo.name || (w && zoneName(w.zone))) || '').toUpperCase();
    bind('w-temp', w ? Math.round(w.temp) + '°' : '--°');
    bind('w-cond', w ? (WMO[w.code] || 'WEATHER') : '');
    bind('w-city', cleanPlace(place));
    weatherStatus(place ? 'Showing the weather for ' + place.charAt(0) + place.slice(1).toLowerCase() + '.' : 'Showing the weather for your location.');
  }

  async function refreshWeather(force) {
    const geo = settings.geo;
    if (!settings.weather || !geo || weatherLoading) return;
    const cached = store.get(KEYS.weather, null);
    if (!force && cached && Date.now() - cached.ts < WEATHER_REFRESH_MS) { renderWeather(); return; }
    weatherLoading = true;
    try {
      const j = await fetchJson('https://api.open-meteo.com/v1/forecast?latitude=' + geo.lat + '&longitude=' + geo.lon + '&current=temperature_2m,weather_code&timezone=auto');
      const cur = j && j.current;
      if (cur && Number.isFinite(cur.temperature_2m)) {
        store.set(KEYS.weather, { ts: Date.now(), temp: cur.temperature_2m, code: cur.weather_code, zone: j.timezone || '' });
      }
    } catch (e) { /* keep the cached value */ }
    weatherLoading = false;
    renderWeather();
  }

  // Reverse-geocoding is a nicety: the timezone name is used when it is unavailable.
  async function lookupPlace() {
    const geo = settings.geo;
    if (!geo) return;
    try {
      const j = await fetchJson('https://api.bigdatacloud.net/data/reverse-geocode-client?localityLanguage=en&latitude=' + geo.lat + '&longitude=' + geo.lon, 8000);
      const name = j && (j.city || j.locality || j.principalSubdivision);
      if (name && settings.geo === geo) { geo.name = name; saveSettings(); renderWeather(); }
    } catch (e) { /* ignore */ }
  }

  async function updateLocation() {
    if (!navigator.geolocation) { weatherStatus('This device cannot share a location.', true); return; }
    weatherStatus('Waiting for permission to use your location…');
    try {
      const pos = await new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: false, timeout: 15000, maximumAge: 600000 }));
      // Rounded to ~1 km: enough for weather, and nothing more precise is ever stored.
      settings.geo = { lat: Number(pos.coords.latitude.toFixed(2)), lon: Number(pos.coords.longitude.toFixed(2)), name: null };
      settings.weather = true;
      saveSettings();
      store.set(KEYS.weather, null);
      renderWeather();
      await refreshWeather(true);
      lookupPlace();
    } catch (err) {
      settings.weather = false;
      saveSettings();
      renderWeather();
      weatherStatus(err && err.code === 1
        ? 'Location access is blocked. Allow it for this app in your phone settings, then try again.'
        : 'Could not get your location. Check your connection and try again.', true);
    }
  }

  function setWeather(on) {
    if (!on) { settings.weather = false; saveSettings(); renderWeather(); return; }
    if (settings.geo) { settings.weather = true; saveSettings(); renderWeather(); refreshWeather(true); return; }
    updateLocation();
  }

  /* ------------------------------------------------------------------ */
  /* UI glue                                                             */
  /* ------------------------------------------------------------------ */

  let toastTimer = 0;
  function toast(message, kind = 'info', ms = 2200) {
    const el = $('playerStatus');
    if (!el) return;
    clearTimeout(toastTimer);
    if (!message) { el.classList.remove('show', 'error'); return; }
    rec('toast: ' + message);
    el.textContent = message;
    el.classList.toggle('error', kind === 'error');
    el.classList.add('show');
    if (ms > 0) toastTimer = setTimeout(() => el.classList.remove('show'), ms);
  }

  let feedbackAt = 0;
  function feedback(kind = 'soft') {
    const now = Date.now();
    if (now - feedbackAt < 55) return;
    feedbackAt = now;
    try { if (window.AndroidBridge && AndroidBridge.feedback) { AndroidBridge.feedback(kind); return; } } catch (e) { /* ignore */ }
    try { if (navigator.vibrate) navigator.vibrate(kind === 'play' ? 30 : 16); } catch (e) { /* ignore */ }
  }

  function press(el) {
    if (el && el.animate) el.animate([{ transform: 'scale(.92)' }, { transform: 'scale(1)' }], { duration: 150, easing: 'cubic-bezier(.2,.8,.2,1)' });
  }
  function nudge() {
    document.querySelectorAll('button[data-station].active').forEach(el => { el.classList.remove('nudge'); void el.offsetWidth; el.classList.add('nudge'); });
  }

  let activeTab = 'sound';
  function openOverlay(id) {
    const o = $(id);
    if (!o) return;
    o.classList.add('show');
    document.documentElement.classList.remove('idle');
    if (id === 'settingsOverlay') { showTab(activeTab); const c = o.querySelector('[data-close]'); if (c) c.focus({ preventScroll: true }); }
  }
  function closeOverlay(id) {
    const o = $(id);
    if (o) o.classList.remove('show');
    if (id === 'settingsOverlay' && eqView) eqView.stop();
    scheduleIdle();
    applyUpdate();
  }
  function showTab(name) {
    activeTab = name;
    document.querySelectorAll('[data-tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
    document.querySelectorAll('[data-pane]').forEach(p => { p.hidden = p.dataset.pane !== name; });
    if (eqView) { if (name === 'sound' && overlayOpen()) eqView.start(); else eqView.stop(); }
    const body = document.querySelector('.sheet-body');
    if (body) body.scrollTop = 0;
  }

  /* ---- Settings: controls are described in the markup (data-switch, data-seg, data-param) ---- */
  const getPath = (obj, path) => path.split('.').reduce((o, k) => (o ? o[k] : undefined), obj);
  function syncControls() {
    document.querySelectorAll('[data-switch]').forEach(b => b.setAttribute('aria-checked', String(!!getPath(settings, b.dataset.switch))));
    document.querySelectorAll('[data-seg]').forEach(seg => {
      const v = settings[seg.dataset.seg];
      seg.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.value === v)));
    });
  }

  const PRESET_LABEL = k => (k === 'auto' ? 'Auto' : k === 'custom' ? 'Custom' : window.BurzhSound.PRESETS[k].name);
  const PARAM_FORMAT = {
    bass: v => v + '%', clarity: v => v + '%', glue: v => v + '%', width: v => v + '%',
    level: v => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(1) + ' dB'
  };
  function renderSound() {
    if (!sound) return;
    const P = window.BurzhSound;
    const fx = $('fxControls');
    if (!fx) return;
    fx.classList.toggle('is-off', !settings.sound.on);
    const ab = $('abRow');
    if (ab) ab.hidden = !(settings.sound.on && fxActive());
    const sh = $('soundHint');
    if (sh) {
      sh.textContent = fxUnsupported ? 'Not supported on this device. Playing the original sound.'
        : !settings.sound.on ? 'Off. Plays the original sound; you can still set things up.'
        : fxActive() ? 'On · engine ' + sound.info().split(' ·')[0] + '. The equalizer and enhancer shape every station.'
        : fxHeld ? 'Paused while the audio system was busy (call, Siri, lock). Tap the screen to restore.'
        : fxFails ? (fxParked() ? 'Paused: the engine did not start. Switch off and on to try again.' : 'The engine did not start. It tries again when you press play; switch off and on to try now.')
        : 'On. Press play to start the engine.';
    }
    const params = effectiveParams();
    const current = settings.sound.preset;

    const chips = $('presetChips');
    const keys = P.ORDER.slice();
    if (settings.sound.custom) keys.push('custom');
    if (chips.dataset.keys !== keys.join()) {
      chips.dataset.keys = keys.join();
      chips.textContent = '';
      keys.forEach(k => {
        const b = document.createElement('button');
        b.className = 'chip'; b.dataset.preset = k; b.textContent = PRESET_LABEL(k);
        b.addEventListener('click', () => { feedback(); settings.sound.preset = k; rec('preset ' + k); saveSettings(); applySound(); });
        chips.appendChild(b);
      });
    }
    chips.querySelectorAll('.chip').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.preset === current)));
    const key = presetKey();
    $('presetHint').textContent = current === 'custom'
      ? 'Your own settings. Pick a preset to start over.'
      : current === 'auto'
        ? 'Follows the station: ' + (P.PRESETS[key] || P.PRESETS.flat).name + ' for ' + (station ? station.name : 'this station') + '.'
        : P.PRESETS[current].hint + '.';

    document.querySelectorAll('input[data-param]').forEach(inp => {
      const name = inp.dataset.param;
      if (document.activeElement !== inp) inp.value = params[name];
      const min = Number(inp.min), max = Number(inp.max), v = Number(inp.value);
      const pct = (v - min) / (max - min) * 100;
      const zero = (0 - min) / (max - min) * 100;
      const bip = inp.hasAttribute('data-bipolar');
      inp.style.setProperty('--a', (bip ? Math.min(pct, zero) : 0) + '%');
      inp.style.setProperty('--b', (bip ? Math.max(pct, zero) : pct) + '%');
      const out = inp.parentElement.querySelector('output');
      if (out) out.textContent = PARAM_FORMAT[name](Number(params[name]));
    });
    if (eqView) eqView.draw();
  }

  function editParams(mutate) {
    const p = effectiveParams();
    mutate(p);
    settings.sound.custom = p;
    settings.sound.preset = 'custom';
    if (sound) sound.apply(p, false);
    renderSound();
  }

  let eqView = null;
  function renderStationList() {
    const box = $('stationList');
    if (!box) return;
    box.textContent = '';
    stations.forEach(st => {
      const row = document.createElement('div');
      row.className = 'list-row';
      const a = document.createElement('span'); a.textContent = st.name;
      const b = document.createElement('span');
      b.textContent = available(st) ? (st.stream ? 'Live stream' : groupsOf(st).length + (groupsOf(st).length === 1 ? ' mix' : ' mixes')) : 'Off air';
      if (available(st)) b.className = 'live';
      row.append(a, b);
      box.appendChild(row);
    });
  }

  // Settings → About → Connection: what the server needs for the first byte and for the first megabyte
  // (the first megabyte is what a phone reads before the first sound).
  async function testConnection() {
    const out = $('netState'), btn = $('netBtn');
    if (!out || !btn || btn.disabled) return;
    const st = station && available(station) && !station.stream ? station : availableStations().find(x => !x.stream);
    if (!st) { out.textContent = 'No mix on air'; return; }
    const url = mediaUrl(liveAt(st).item);
    btn.disabled = true;
    out.textContent = 'Testing…';
    const get = async range => {
      const t0 = performance.now();
      const r = await fetch(url, { headers: { Range: 'bytes=' + range }, cache: 'no-store' });
      const first = performance.now() - t0;
      const buf = await r.arrayBuffer();
      return { status: r.status, first, ms: performance.now() - t0, bytes: buf.byteLength, cache: (r.headers.get('x-cache') || '').toLowerCase() };
    };
    try {
      const a = await get('0-1');
      const b = await get('0-1048575');
      const mbps = b.bytes / 1048576 / Math.max(0.001, b.ms / 1000);
      out.textContent = 'first byte ' + (a.first / 1000).toFixed(2) + ' s · 1 MB in ' + (b.ms / 1000).toFixed(2) + ' s (' + mbps.toFixed(1) + ' MB/s)' + (a.cache ? ' · ' + a.cache : '') + (a.status === 206 || a.status === 200 ? '' : ' · HTTP ' + a.status);
      warmedAt.set(url, Date.now());
      rec('connection test: ' + out.textContent);
    } catch (e) {
      out.textContent = 'failed: ' + ((e && e.message) || e);
      rec('connection test: ' + out.textContent);
    }
    btn.disabled = false;
  }

  // Settings → About → Event log: everything needed to understand a problem, as text that can be pasted anywhere.
  let cacheNames = '';
  try { if (window.caches) caches.keys().then(k => { cacheNames = k.join(', '); }).catch(() => {}); } catch (e) { /* ignore */ }
  function buildReport() {
    const nav = navigator, c = nav.connection || {};
    const head = [
      'BURZH beats v' + VERSION + ' · report ' + new Date().toString().slice(0, 33),
      'device: ' + nav.userAgent,
      'mode: ' + (nav.standalone || (window.matchMedia && matchMedia('(display-mode: standalone)').matches) ? 'home-screen app' : 'browser tab') + ' · online ' + nav.onLine + (c.effectiveType ? ' · ' + c.effectiveType + (c.downlink ? ' ' + c.downlink + ' Mbit/s' : '') + (c.rtt ? ' rtt ' + c.rtt + ' ms' : '') : ''),
      'saved copy: ' + (nav.serviceWorker && nav.serviceWorker.controller ? 'active' : 'none') + (cacheNames ? ' (' + cacheNames + ')' : ''),
      'launch: ' + (launchInfo || '-') + ' · last start: ' + (lastStart || '-'),
      'sound: shaping ' + (settings.sound.on ? 'on' : 'off') + ' · preset ' + settings.sound.preset + ' · engine ' + (sound ? sound.info() : 'none') + ' · strikes ' + fxFails + (fxHeld ? ' · held' : '') + (fxUnsupported ? ' · unsupported' : ''),
      'last problem: ' + (lastProblem || 'none'),
      '--- events (newest last) ---'
    ];
    return head.join('\n') + '\n' + logText();
  }
  function copyText(text) {
    const fallback = () => {
      try {
        const ta = document.createElement('textarea');
        ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;font-size:16px';
        document.body.appendChild(ta); ta.focus(); ta.select(); ta.setSelectionRange(0, text.length);
        const ok = document.execCommand && document.execCommand('copy');
        ta.remove();
        return !!ok;
      } catch (e) { return false; }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text).then(() => true).catch(() => fallback());
    return Promise.resolve(fallback());
  }
  function bindLog() {
    const view = $('logView'), box = $('logBox');
    if (!view || !box) return;
    box.addEventListener('toggle', () => { logOpen = box.open; if (logOpen) { renderLog(); view.scrollTop = view.scrollHeight; } });
    if ($('logCopy')) $('logCopy').addEventListener('click', () => {
      feedback();
      copyText(buildReport()).then(ok => {
        const out = $('logState');
        if (out) out.textContent = ok ? 'Copied. Paste it into the chat.' : 'Could not copy: select the text above and copy it by hand.';
      });
    });
    if ($('logShare')) {
      if (!navigator.share) $('logShare').hidden = true;
      else $('logShare').addEventListener('click', () => { feedback(); navigator.share({ title: 'BURZH beats report', text: buildReport() }).catch(() => { /* cancelled */ }); });
    }
    if ($('logClear')) $('logClear').addEventListener('click', () => { feedback(); logBuf = []; saveLog(); renderLog(); const out = $('logState'); if (out) out.textContent = 'Cleared.'; });
  }

  // Last resort for a stuck app: forget every saved copy and load everything again.
  async function refreshApp() {
    try {
      if ('serviceWorker' in navigator) (await navigator.serviceWorker.getRegistrations()).forEach(r => r.unregister());
      if (window.caches) (await caches.keys()).forEach(k => caches.delete(k));
    } catch (e) { /* reload anyway */ }
    try { localStorage.removeItem(KEYS.data); } catch (e) { /* ignore */ }
    location.reload();
  }

  function renderSettings() {
    const set = (id, text) => { const el = $(id); if (el) el.textContent = text; };
    set('startState', lastStart || '-');
    set('launchState', launchInfo || '-');
    const mixes = stations.reduce((n, s) => n + (s.items ? groupsOf(s).length : 0), 0);
    set('libraryState', mixes + (mixes === 1 ? ' mix' : ' mixes') + ' · ' + availableStations().length + ' of ' + stations.length + ' on air');
    set('versionState', 'v' + VERSION);
    syncControls();
    renderStationList();
    renderWeather();
    renderSound();
    const hint = $('soundHint');
    if (hint && !sound) hint.textContent = 'This browser cannot process audio.';
    const sw = document.querySelector('[data-switch="sound.on"]');
    if (sw) sw.disabled = !sound || fxUnsupported;
    set('engineState', engineLabel());
    set('problemState', lastProblem || 'None');
  }

  /* Station glyphs: one 36×30 box and one stroke weight for all four, so the tiles read as a set. */
  const GLYPHS = (() => {
    const svg = body => '<svg viewBox="0 0 36 30" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">' + body + '</svg>';
    let dots = '';
    for (let j = -3; j <= 3; j++) for (let i = -3; i <= 3; i++) {
      if (i * i + j * j > 10.5) continue;                       // a round field of dots
      dots += '<circle cx="' + (18 + i * 4.1).toFixed(1) + '" cy="' + (15 + j * 4.1).toFixed(1) + '" r="1.05" fill="currentColor" stroke="none"/>';
    }
    return {
      grid: svg(dots),
      wave: svg('<path d="M4 9.5c3-2.4 6-2.4 9 0s6 2.4 9 0 6-2.4 9 0"/><path d="M7 15c3-2.4 6-2.4 9 0s6 2.4 9 0 4.5-1.8 6 0" opacity=".75"/><path d="M4 20.5c3-2.4 6-2.4 9 0s6 2.4 9 0" opacity=".5"/>'),
      rings: svg('<circle cx="13.5" cy="15" r="9.5"/><circle cx="22.5" cy="15" r="9.5"/>'),
      tri: svg('<path d="M18 4.5 30.5 26h-25z"/><path d="M18 12.5 24 23h-12z" opacity=".55"/>')
    };
  })();

  function buildStationButtons() {
    const tiles = $('stationTiles');
    const menu = $('genreMenu');
    if (tiles) tiles.textContent = '';
    if (menu) menu.textContent = '';
    const label = (el, name) => name.split(' ').forEach((word, i) => { if (i) el.appendChild(document.createElement('br')); el.appendChild(document.createTextNode(word)); });
    const onTap = btn => () => {
      feedback('station');
      press(btn);
      selectStation(btn.dataset.station);
      if (!available(station)) nudge();
    };
    stations.forEach(st => {
      if (tiles) {
        const b = document.createElement('button');
        b.className = 'station';
        b.dataset.station = st.id;
        b.setAttribute('aria-label', st.name);
        const icon = document.createElement('span');
        icon.className = 'sicon glyph-' + (st.glyph || 'grid');
        icon.innerHTML = GLYPHS[st.glyph] || GLYPHS.grid;
        icon.setAttribute('aria-hidden', 'true');
        const name = document.createElement('span');
        name.className = 'slabel';
        label(name, st.name);
        const dot = document.createElement('i');
        dot.className = 'sdot';
        b.append(icon, name, dot);
        b.addEventListener('click', onTap(b));
        tiles.appendChild(b);
      }
      if (menu) {
        const b = document.createElement('button');
        b.dataset.station = st.id;
        b.textContent = st.name;
        b.addEventListener('click', onTap(b));
        menu.appendChild(b);
      }
    });
  }

  function bindUi() {
    document.querySelectorAll('.play-toggle').forEach(btn => btn.addEventListener('click', () => { feedback('play'); press(btn); togglePlay(); }));
    document.querySelectorAll('[data-step]').forEach(btn => btn.addEventListener('click', () => { press(btn); stepStation(Number(btn.dataset.step)); }));
    document.querySelectorAll('[data-open]').forEach(btn => btn.addEventListener('click', () => { feedback(); renderSettings(); openOverlay(btn.dataset.open); }));
    document.querySelectorAll('.seek').forEach(bindSeek);
    document.querySelectorAll('.golive').forEach(b => b.addEventListener('click', goLive));
    document.querySelectorAll('[data-close]').forEach(btn => btn.addEventListener('click', () => { feedback(); closeOverlay(btn.dataset.close); }));
    document.querySelectorAll('.overlay').forEach(o => o.addEventListener('click', e => { if (e.target === o) closeOverlay(o.id); }));
    document.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => { feedback(); showTab(b.dataset.tab); }));

    document.querySelectorAll('[data-switch]').forEach(b => b.addEventListener('click', () => {
      feedback();
      const key = b.dataset.switch;
      if (key === 'weather') { setWeather(!settings.weather); return; }
      if (key === 'sound.on') {
        settings.sound.on = !settings.sound.on;
        rec('shaping ' + (settings.sound.on ? 'on' : 'off'));
        fxHeld = false; restoreCount = 0;
        saveSettings(); syncControls(); selectOutput();
        // A deliberate tap gives a parked engine a fresh start (this one re-tunes, so it is only done when the engine is wanted and missing).
        if (fxFails || (settings.sound.on && wantPlaying && !fxActive() && !fxUnsupported)) {
          fxFails = 0;
          if (settings.sound.on && wantPlaying && !fxActive() && sound && !fxUnsupported) {
            try { fxRescue = false; stallRetries = 0; switchTo(ensureFx()); } catch (e) { fxUnavailable('SOUND SHAPING IS NOT AVAILABLE HERE'); }
          }
          renderSettings();
        }
        return;
      }
      settings[key] = !settings[key];
      saveSettings(); syncControls();
      if (key === 'keepAwake') updateWakeLock();
    }));
    document.querySelectorAll('[data-seg] button').forEach(b => b.addEventListener('click', () => {
      feedback();
      settings[b.parentElement.dataset.seg] = b.dataset.value;
      saveSettings(); syncControls(); applyTheme(); applyMotion();
    }));
    $('locationBtn').addEventListener('click', () => { feedback(); updateLocation(); });
    if ($('netBtn')) $('netBtn').addEventListener('click', () => { feedback(); testConnection(); });
    if ($('refreshBtn')) $('refreshBtn').addEventListener('click', () => { feedback(); refreshApp(); });
    bindLog();

    document.querySelectorAll('input[data-param]').forEach(inp => {
      inp.addEventListener('input', () => editParams(p => { p[inp.dataset.param] = Number(inp.value); }));
      inp.addEventListener('change', saveSettings);
    });
    const abBtn = $('abBtn');
    const abSet = on => { if (abHold === on) return; abHold = on; abBtn.classList.toggle('holding', on); abBtn.textContent = on ? 'Original' : 'Hold: original'; if (sound) applySound(); };
    abBtn.addEventListener('pointerdown', e => { e.preventDefault(); try { abBtn.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ } feedback(); abSet(true); });
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(t => abBtn.addEventListener(t, () => abSet(false)));
    $('soundReset').addEventListener('click', () => { feedback(); settings.sound.preset = 'auto'; settings.sound.custom = null; saveSettings(); applySound(); });
    if (sound && window.BurzhEqView) {
      eqView = window.BurzhEqView.create($('eqCanvas'), {
        engine: sound,
        getParams: effectiveParams,
        onBand: (i, db) => editParams(p => { p.bands[i] = db; }),
        onCommit: saveSettings
      });
    }

    // Swipe across the planet to change station.
    document.querySelectorAll('.swipe').forEach(el => {
      let x0 = null, y0 = 0;
      el.addEventListener('pointerdown', e => { x0 = e.clientX; y0 = e.clientY; });
      el.addEventListener('pointerup', e => {
        if (x0 === null) return;
        const dx = e.clientX - x0, dy = e.clientY - y0;
        x0 = null;
        if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.4) stepStation(dx < 0 ? 1 : -1);
      });
      el.addEventListener('pointercancel', () => { x0 = null; });
    });

    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') { document.querySelectorAll('.overlay.show').forEach(o => closeOverlay(o.id)); return; }
      if (e.target && /INPUT|TEXTAREA|BUTTON/.test(e.target.tagName)) return;
      if (e.target && e.target.closest && e.target.closest('.seek')) return;
      if (e.key === ' ' || e.key === 'k') { e.preventDefault(); togglePlay(); }
      else if (e.key === 'ArrowRight') stepStation(1);
      else if (e.key === 'ArrowLeft') stepStation(-1);
    });
  }

  /* ------------------------------------------------------------------ */
  /* Boot                                                                */
  /* ------------------------------------------------------------------ */

  function normalise(data) {
    if (data.epoch) { const t = Date.parse(data.epoch); if (Number.isFinite(t)) epochMs = t; }
    if (data.mediaBase) mediaBase = new URL(data.mediaBase, location.href);
    return (data.stations || []).map(s => {
      const items = (s.items || [])
        .filter(it => (it.file || it.url) && Number(it.duration) > 0)
        .map(it => Object.assign({}, it, {
          title: it.title || 'Untitled mix',
          duration: Number(it.duration),
          cues: (it.cues || []).map(c => ({ at: Number(c.at) || 0, title: String(c.title || ''), artist: String(c.artist || '') })).filter(c => c.title).sort((a, b) => a.at - b.at)
        }));
      return Object.assign({}, s, { items, total: items.reduce((n, it) => n + it.duration, 0) });
    });
  }

  /* The station list is saved on the device: the screen is usable at once, and the list from the network
   * replaces it when it has changed (never under a playing listener: that would move the schedule). */
  let pendingData = null;
  let launchInfo = '';
  function applyStations(data) {
    pendingData = null;
    stations = normalise(data);
    const keep = station && stations.find(x => x.id === station.id);
    station = keep || availableStations()[0] || stations[0];
    current = null;
    buildStationButtons();
    applyStationTheme();
    render();
    renderSettings();
    updateMediaSession(true);
    warmStation(station);
  }
  function offerStations(data) {
    if (!data || !Array.isArray(data.stations) || !data.stations.length) return;
    if (JSON.stringify(data) === JSON.stringify(store.get(KEYS.data, null))) return;
    store.set(KEYS.data, data);
    if (wantPlaying) { pendingData = data; return; }
    applyStations(data);
  }

  // ?station=<id> (app-icon shortcut), read once and removed from the address.
  const requestedStation = (() => { try { return new URLSearchParams(location.search).get('station'); } catch (e) { return null; } })();

  async function boot() {
    applyTheme();
    applyMotion();
    renderClock();
    if (window.BurzhPlanet) {
      document.querySelectorAll('[data-planet]').forEach(box => planets.push(window.BurzhPlanet.create(box, { getLevel: () => (fxActive() ? sound.level() : null), calm: calmOn })));
    }
    bindUi();
    bindMediaSession();
    configureAudioSession();

    let data = store.get(KEYS.data, null);
    const saved0 = !!(data && Array.isArray(data.stations) && data.stations.length);
    const fresh = fetch(DATA_URL, { cache: 'no-cache' }).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
    if (saved0) {
      fresh.then(offerStations).catch(() => { /* the saved list is good enough for now */ });
    } else {
      try {
        data = await fresh;
        if (data && Array.isArray(data.stations)) store.set(KEYS.data, data);
      } catch (e) {
        toast('STATION LIST UNAVAILABLE', 'error', 0);
        return;
      }
    }
    stations = normalise(data);
    if (!stations.length) { toast('NO STATIONS', 'error', 0); return; }
    buildStationButtons();

    const saved = stations.find(s => s.id === store.get(KEYS.station, null));
    station = (saved && available(saved) ? saved : null) || availableStations()[0] || saved || stations[0];
    // A shortcut on the app icon (long press) opens a station: ./?station=<id>. It only picks the station;
    // the browser does not let a page start sound by itself, so play stays one tap away.
    const asked = stations.find(s => s.id === requestedStation);
    if (asked) { station = asked; store.set(KEYS.station, asked.id); rec('opened from a shortcut: ' + asked.id); }
    if (requestedStation !== null) { try { history.replaceState(null, '', location.pathname); } catch (e) { /* ignore */ } }
    applyStationTheme();
    setPhase('stopped');
    selectOutput();
    render();
    updateMediaSession(true);
    renderSettings();
    refreshWeather(false);
    onOrientation();
    launchInfo = (performance.now() / 1000).toFixed(1) + ' s · ' + (saved0 ? 'saved list' : 'first load');
    rec('launch v' + VERSION + ' · ' + launchInfo + ' · ' + (navigator.standalone || (window.matchMedia && matchMedia('(display-mode: standalone)').matches) ? 'app' : 'browser') + ' · service worker ' + (navigator.serviceWorker && navigator.serviceWorker.controller ? 'on' : 'off') + ' · ' + station.id);
    renderSettings();
    warmStation(station);

    setInterval(() => { renderClock(); renderProgress(); checkCue(); applyMotion(); }, 1000);
    setInterval(() => { if (station && (wantPlaying || document.visibilityState === 'visible')) warmStation(station); }, 20000);
    setInterval(engineHealth, 1000);
    setInterval(() => { applyNight(); shiftPixels(); if (wantPlaying) updateMediaSession(false); }, 60 * 1000);
    setInterval(() => refreshWeather(false), WEATHER_REFRESH_MS);
  }

  window.BURZH = {
    version: VERSION,
    report: () => buildReport(),
    liveAt: (id, t) => liveAt(stations.find(s => s.id === id), t),
    stations: () => stations,
    audioEl: () => audio,
    seekTo: t => seekTo(t),
    debug: () => ({ station: station && station.id, phase, wantPlaying, fx: fxActive(), fxOn: settings.sound.on, fxBroken: fxUnsupported || fxFails > 0, fxFails, fxUnsupported, fxHeld, ctx: sound ? sound.state : 'none', lastStart, engine: sound ? sound.info() : null, preset: presetKey(), src: audio.currentSrc, time: audio.currentTime, paused: audio.paused, shifted, canSeek: canSeek(), problem: lastProblem, useFragment }),
    planets: () => planets.map(p => p.state()),
    calm: () => calmOn(),
    spectrum: () => { const a = new Uint8Array(64); return sound && sound.spectrum(a) ? Array.from(a) : Array(64).fill(0); }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  /* The app opens from the copy saved on the device (service worker). A new release installs in the
   * background; the page asks for it on every launch, and switches over as soon as that costs nothing
   * (not while music plays or settings are open). */
  function checkForUpdate(force) {
    if (!swReg || (!force && Date.now() - lastUpdateCheck < 5 * 60 * 1000)) return;
    lastUpdateCheck = Date.now();
    try { swReg.update().catch(() => { /* offline */ }); } catch (e) { /* ignore */ }
  }
  function applyUpdate() {
    if (!updateReady || wantPlaying || document.querySelector('.overlay.show')) return;
    let last = 0;
    try { last = Number(sessionStorage.getItem('burzh.reloaded') || 0); } catch (e) { /* ignore */ }
    if (Date.now() - last < 30000) return;       // never loop
    try { sessionStorage.setItem('burzh.reloaded', String(Date.now())); } catch (e) { /* ignore */ }
    rec('reloading for the new release');
    saveLog();
    location.reload();
  }
  window.BURZH_applyUpdate = applyUpdate;
  if ('serviceWorker' in navigator) {
    let hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController) { hadController = true; return; }     // the very first install replaces nothing
      updateReady = true;
      rec('new release is ready');
      applyUpdate();
    });
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).then(reg => { swReg = reg; checkForUpdate(true); }).catch(() => { /* offline shell is optional */ });
    });
  }
})();
