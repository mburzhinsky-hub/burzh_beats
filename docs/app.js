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

  const VERSION = '0.21.2';
  const DATA_URL = './stations.json';
  const KEYS = {
    station: 'burzh.radio.station.v1',
    settings: 'burzh.radio.settings.v1',
    weather: 'burzh.radio.weather.v1'
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
  const settings = Object.assign(
    { v: 2, keepAwake: true, night: 'off', theme: 'black', weather: false, geo: null, sound: {} },
    storedSettings
  );
  settings.sound = Object.assign({ on: false, preset: 'auto', custom: null }, settings.sound || {});
  const saveSettings = () => store.set(KEYS.settings, settings);

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
  function rawOrder(st, cycle) {
    const idx = st.items.map((_, i) => i);
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
    return order;
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
    if (fx) el.crossOrigin = 'anonymous';
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
      if (fxActive() && wantPlaying && state !== 'running' && document.visibilityState === 'visible') sound.resume();
      const el = document.getElementById('engineState');
      if (el) el.textContent = engineLabel();
    };
  }
  function engineLabel() {
    if (!sound) return 'Not supported';
    if (fxBroken) return 'Unavailable on this device';
    return audio === audioFx ? 'Active · ' + sound.info() : 'Standby';
  }

  let station = null;
  let current = null;          // { st, item, url } loaded into <audio>
  let wantPlaying = false;
  let phase = 'stopped';       // stopped | tuning | live | buffering | lost
  let switching = 0;
  let retryTimer = 0;
  let retryDelay = 4000;
  let lastCueKey = '';
  let lastMetaKey = '';

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

  function tune({ autoplay = true, after = null } = {}) {
    const st = station;
    clearTimeout(retryTimer);
    if (!available(st)) { wantPlaying = false; setPhase('stopped'); render(); return; }
    configureAudioSession();
    if (fxActive()) sound.resume();

    let url;
    let offset = 0;
    let item = null;
    if (st.stream) {
      url = st.stream;
    } else {
      let live = liveAt(st);
      // Clock and audio can disagree by a second; never restart a mix that just ended.
      if (after && live.item === after && live.remaining < 5) live = { item: live.next, offset: 0 };
      item = live.item;
      offset = live.offset;
      url = mediaUrl(item);
    }

    const sameSource = current && current.url === url && audio.readyState >= 1;
    current = { st, item, url };
    // While the source is being swapped the element fires "pause"; that must not count as a stop.
    const swapping = !sameSource;
    const done = () => { if (swapping) switching = Math.max(0, switching - 1); };
    if (sameSource) {
      if (!st.stream) { try { audio.currentTime = offset; } catch (e) { /* not seekable yet */ } }
    } else {
      switching++;
      audio.src = st.stream ? url : url + '#t=' + offset.toFixed(1);
      audio.dataset.sync = st.stream ? '' : '1';
    }

    render();
    updateMediaSession(true);

    if (!autoplay) { done(); return; }
    wantPlaying = true;
    setPhase('tuning');
    const p = audio.play();
    if (!p || !p.then) { done(); return; }
    p.then(done).catch(err => {
      done();
      if (err && err.name === 'AbortError') return;
      if (err && err.name === 'NotAllowedError') { wantPlaying = false; setPhase('stopped'); toast('TAP PLAY TO TUNE IN'); return; }
      signalLost();
    });
  }

  function play() {
    if (!available(station)) { toast(station.name.toUpperCase() + ' · OFF AIR', 'info', 2600); nudge(); return; }
    tune({ autoplay: true });
  }
  function stop() {
    wantPlaying = false;
    clearTimeout(retryTimer);
    audio.pause();
    setPhase('stopped');
    render();
  }
  function togglePlay() { if (wantPlaying) stop(); else play(); }

  function selectStation(id, { announce = true } = {}) {
    const st = stations.find(s => s.id === id);
    if (!st) return;
    const changed = st !== station;
    station = st;
    store.set(KEYS.station, st.id);
    applyStationTheme();
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
    setPhase('lost');
    toast('SIGNAL LOST · RETUNING', 'error', 3000);
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => { if (wantPlaying) tune({ autoplay: true }); }, retryDelay);
    retryDelay = Math.min(30000, retryDelay * 2);
  }

  const handlers = {
    loadedmetadata() {
      if (!current || audio.dataset.sync !== '1' || !current.item) return;
      audio.dataset.sync = '';
      const live = liveAt(current.st);
      if (!live) return;
      if (live.item !== current.item) { if (wantPlaying) tune({ autoplay: true }); return; }
      if (Math.abs(audio.currentTime - live.offset) > 2) {
        try { audio.currentTime = live.offset; } catch (e) { /* ignore */ }
      }
    },
    playing() {
      retryDelay = 4000;
      if (audio === audioFx) { fxEverPlayed = true; watchFx(); }
      if (wantPlaying) setPhase('live');
      toast('');
    },
    waiting() { if (wantPlaying && phase !== 'tuning') setPhase('buffering'); },
    pause() {
      // Paused by the system (call, Siri, another app): treat it as a stop.
      if (switching || audio.ended || !wantPlaying) return;
      wantPlaying = false;
      setPhase('stopped');
      render();
    },
    ended() {
      const finished = current && current.item;
      if (wantPlaying) tune({ autoplay: true, after: finished });
    },
    error() {
      if (!wantPlaying) return;
      if (audio === audioFx && !fxEverPlayed) {
        // The chain needs CORS-enabled audio; fall back to the plain player instead of staying silent.
        fxFailed('SOUND SHAPING OFF · AUDIO SOURCE BLOCKS IT');
        return;
      }
      signalLost();
    },
    timeupdate() { checkCue(); }
  };
  function wireAudio(el) {
    Object.keys(handlers).forEach(type => el.addEventListener(type, e => { if (el === audio) handlers[type](e); }));
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
  let fxBroken = false;
  let fxWatchTimer = 0;

  function switchTo(next) {
    if (next === audio) return;
    const was = wantPlaying, prev = audio;
    audio = next; current = null; fxEverPlayed = false;
    try { prev.pause(); } catch (e) { /* ignore */ }
    if (was) tune({ autoplay: true }); else render();
  }

  function selectOutput() {
    if (settings.sound.on && sound && !fxBroken && audio !== audioFx) {
      try { switchTo(ensureFx()); } catch (e) {
        console.warn('BURZH sound chain unavailable:', e);
        fxFailed('SOUND SHAPING IS NOT AVAILABLE HERE');
        return;
      }
    }
    applySound();
  }

  // Never leave the listener in silence: give the chain up and play the plain way.
  function fxFailed(message) {
    fxBroken = true;
    clearInterval(fxWatchTimer);
    settings.sound.on = false;
    saveSettings();
    toast(message, 'error', 4800);
    if (audio !== audioPlain) switchTo(audioPlain);
    applySound();
    syncControls();
    renderSettings();
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
        if (ticks > 14) fxFailed('SOUND SHAPING DID NOT START · PLAYING THE ORIGINAL SOUND');
        return;
      }
      if (sound.hasSignal()) { clearInterval(fxWatchTimer); return; }
      if (ticks > 12 && !audio.paused && audio.currentTime - t0 > 3) fxFailed('SOUND SHAPING WAS SILENT · PLAYING THE ORIGINAL SOUND');
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
    const p = settings.sound.on && !fxBroken ? effectiveParams() : window.BurzhSound.clone(window.BurzhSound.PRESETS.flat.p);
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
      return { st, title: 'NO SIGNAL', sub: 'OFF AIR · ' + st.name.toUpperCase(), item: null, offset: 0, duration: 0 };
    }
    if (st.stream) return { st, title: st.streamTitle || st.name, sub: 'LIVE STREAM', item: null, offset: 0, duration: 0 };

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
    const position = st.items.indexOf(item) + 1;
    const counter = String(position).padStart(2, '0') + ' / ' + String(st.items.length).padStart(2, '0');
    return {
      st, item, offset, cue,
      duration: item.duration,
      title: cue ? cue.title : item.title,
      artist: cue && cue.artist ? cue.artist : (item.artist || ''),
      sub: cue && cue.artist ? cue.artist : (item.artist ? item.artist + ' · ' + counter : counter + ' · ' + fmt(item.duration))
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
    // Radio has no rewind: remove scrubbing from the lock screen and StandBy.
    set('seekto', null);
    set('seekforward', null);
    set('seekbackward', null);
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
    root.setProperty('--accent', station.accent || '#ff3b30');
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
      live: 'LIVE',
      buffering: 'BUFFERING…',
      lost: 'SIGNAL LOST'
    }[phase] || '';
    bind('status', label);
    const playing = wantPlaying;
    document.querySelectorAll('.play-toggle').forEach(b => {
      b.classList.toggle('is-playing', playing);
      b.setAttribute('aria-label', playing ? 'Stop' : 'Play');
    });
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
    bind('channel', 'CH ' + String(idx).padStart(2, '0') + ' / ' + String(stations.length).padStart(2, '0'));
    const tag = (station.tagline || []).join('\n');
    document.querySelectorAll('[data-bind="tagline"]').forEach(el => { if (el.dataset.raw !== tag) { el.dataset.raw = tag; el.textContent = ''; (station.tagline || []).forEach((line, i) => { if (i) el.appendChild(document.createElement('br')); el.appendChild(document.createTextNode(line)); }); } });
    renderStatus();
    renderProgress(np);
  }

  let lastRatio = 0;
  function renderProgress(np = nowPlaying()) {
    if (!np) return;
    const ratio = np.duration ? Math.max(0, Math.min(1, np.offset / np.duration)) : 0;
    // Jumps back (new mix, other station) snap instantly instead of sliding backwards.
    const snap = ratio < lastRatio - 0.005;
    lastRatio = ratio;
    document.querySelectorAll('.live-fill').forEach(el => {
      if (snap) { el.style.transition = 'none'; el.style.transform = 'scaleX(' + ratio.toFixed(4) + ')'; void el.offsetWidth; el.style.transition = ''; }
      else el.style.transform = 'scaleX(' + ratio.toFixed(4) + ')';
    });
    bind('elapsed', np.duration ? fmt(np.offset) : '');
    bind('remaining', np.duration ? 'NEXT −' + fmt(np.duration - np.offset) : (available(station) ? '∞' : ''));
  }

  function renderClock() {
    const d = new Date();
    bind('hh', String(d.getHours()).padStart(2, '0'));
    bind('mm', String(d.getMinutes()).padStart(2, '0'));
    const days = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
    const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
    bind('date', days[d.getDay()] + ' ' + String(d.getDate()).padStart(2, '0') + ' ' + months[d.getMonth()]);
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
  function applyNight() {
    document.documentElement.classList.toggle('night', isNight());
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = isNight() ? '#000000' : (settings.theme === 'graphite' ? '#17191a' : '#050606');
  }
  function applyTheme() {
    document.documentElement.classList.toggle('theme-graphite', settings.theme === 'graphite');
    applyNight();
  }

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

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      configureAudioSession();
      applyNight();
      render();
      refreshWeather(false);
      if (fxActive() && wantPlaying) sound.resume().then(() => { if (wantPlaying && audio.paused) tune({ autoplay: true }); });
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
    bind('w-city', place);
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
    const sh = $('soundHint');
    if (sh) sh.textContent = fxBroken ? 'Not supported on this device. Playing the original sound.' : settings.sound.on ? (fxActive() ? 'On · engine ' + sound.info().split(' ·')[0] + '. The equalizer and enhancer shape every station.' : 'On. Press play to start the engine.') : 'Off. Plays the original sound; you can still set things up.';
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
        b.addEventListener('click', () => { feedback(); settings.sound.preset = k; saveSettings(); applySound(); });
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
      b.textContent = available(st) ? (st.stream ? 'Live stream' : st.items.length + (st.items.length === 1 ? ' mix' : ' mixes')) : 'Off air';
      if (available(st)) b.className = 'live';
      row.append(a, b);
      box.appendChild(row);
    });
  }

  function renderSettings() {
    const set = (id, text) => { const el = $(id); if (el) el.textContent = text; };
    const mixes = stations.reduce((n, s) => n + (s.items ? s.items.length : 0), 0);
    set('libraryState', mixes + (mixes === 1 ? ' mix' : ' mixes') + ' · ' + availableStations().length + ' of ' + stations.length + ' on air');
    set('versionState', 'v' + VERSION);
    syncControls();
    renderStationList();
    renderWeather();
    renderSound();
    const hint = $('soundHint');
    if (hint && !sound) hint.textContent = 'This browser cannot process audio.';
    const sw = document.querySelector('[data-switch="sound.on"]');
    if (sw) sw.disabled = !sound || fxBroken;
    set('engineState', engineLabel());
  }

  function buildStationButtons() {
    const tiles = $('stationTiles');
    const menu = $('genreMenu');
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
    document.querySelectorAll('[data-close]').forEach(btn => btn.addEventListener('click', () => { feedback(); closeOverlay(btn.dataset.close); }));
    document.querySelectorAll('.overlay').forEach(o => o.addEventListener('click', e => { if (e.target === o) closeOverlay(o.id); }));
    document.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => { feedback(); showTab(b.dataset.tab); }));

    document.querySelectorAll('[data-switch]').forEach(b => b.addEventListener('click', () => {
      feedback();
      const key = b.dataset.switch;
      if (key === 'weather') { setWeather(!settings.weather); return; }
      if (key === 'sound.on') { settings.sound.on = !settings.sound.on; saveSettings(); syncControls(); selectOutput(); return; }
      settings[key] = !settings[key];
      saveSettings(); syncControls();
      if (key === 'keepAwake') updateWakeLock();
    }));
    document.querySelectorAll('[data-seg] button').forEach(b => b.addEventListener('click', () => {
      feedback();
      settings[b.parentElement.dataset.seg] = b.dataset.value;
      saveSettings(); syncControls(); applyTheme();
    }));
    $('locationBtn').addEventListener('click', () => { feedback(); updateLocation(); });

    document.querySelectorAll('input[data-param]').forEach(inp => {
      inp.addEventListener('input', () => editParams(p => { p[inp.dataset.param] = Number(inp.value); }));
      inp.addEventListener('change', saveSettings);
    });
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

  async function boot() {
    applyTheme();
    renderClock();
    if (window.BurzhPlanet) {
      document.querySelectorAll('[data-planet]').forEach(box => planets.push(window.BurzhPlanet.create(box, { getLevel: () => (fxActive() ? sound.level() : null) })));
    }
    bindUi();
    bindMediaSession();
    configureAudioSession();

    try {
      const res = await fetch(DATA_URL, { cache: 'no-cache' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      stations = normalise(await res.json());
    } catch (e) {
      toast('STATION LIST UNAVAILABLE', 'error', 0);
      return;
    }
    if (!stations.length) { toast('NO STATIONS', 'error', 0); return; }
    buildStationButtons();

    const saved = stations.find(s => s.id === store.get(KEYS.station, null));
    station = (saved && available(saved) ? saved : null) || availableStations()[0] || saved || stations[0];
    applyStationTheme();
    setPhase('stopped');
    selectOutput();
    render();
    updateMediaSession(true);
    renderSettings();
    refreshWeather(false);
    onOrientation();

    setInterval(() => { renderClock(); renderProgress(); checkCue(); }, 1000);
    setInterval(() => { applyNight(); shiftPixels(); if (wantPlaying) updateMediaSession(false); }, 60 * 1000);
    setInterval(() => refreshWeather(false), WEATHER_REFRESH_MS);
  }

  window.BURZH = {
    version: VERSION,
    liveAt: (id, t) => liveAt(stations.find(s => s.id === id), t),
    stations: () => stations,
    debug: () => ({ station: station && station.id, phase, wantPlaying, fx: fxActive(), fxOn: settings.sound.on, fxBroken, engine: sound ? sound.info() : null, preset: presetKey(), src: audio.currentSrc, time: audio.currentTime, paused: audio.paused }),
    spectrum: () => { const a = new Uint8Array(64); return sound && sound.spectrum(a) ? Array.from(a) : Array(64).fill(0); }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => { navigator.serviceWorker.register('./sw.js').catch(() => { /* offline shell is optional */ }); });
  }
})();
