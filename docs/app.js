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

  const VERSION = '0.20.1';
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
  const settings = Object.assign(
    { v: 2, keepAwake: true, night: 'off', theme: 'black', weather: false, city: null },
    storedSettings
  );
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

  const audio = new Audio();
  audio.preload = 'none';
  audio.playsInline = true;
  audio.setAttribute('playsinline', '');
  audio.setAttribute('webkit-playsinline', '');

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

  audio.addEventListener('loadedmetadata', () => {
    if (!current || audio.dataset.sync !== '1' || !current.item) return;
    audio.dataset.sync = '';
    const live = liveAt(current.st);
    if (!live) return;
    if (live.item !== current.item) { if (wantPlaying) tune({ autoplay: true }); return; }
    if (Math.abs(audio.currentTime - live.offset) > 2) {
      try { audio.currentTime = live.offset; } catch (e) { /* ignore */ }
    }
  });
  audio.addEventListener('playing', () => { retryDelay = 4000; if (wantPlaying) setPhase('live'); toast(''); });
  audio.addEventListener('waiting', () => { if (wantPlaying && phase !== 'tuning') setPhase('buffering'); });
  audio.addEventListener('pause', () => {
    // Paused by the system (call, Siri, another app): treat it as a stop.
    if (switching || audio.ended || !wantPlaying) return;
    wantPlaying = false;
    setPhase('stopped');
    render();
  });
  audio.addEventListener('ended', () => {
    const finished = current && current.item;
    if (wantPlaying) tune({ autoplay: true, after: finished });
  });
  audio.addEventListener('error', () => { if (wantPlaying) signalLost(); });
  audio.addEventListener('timeupdate', () => { checkCue(); });

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

  function applyStationTheme() {
    if (!station) return;
    const root = document.documentElement.style;
    root.setProperty('--accent', station.accent || '#ff3b30');
    root.setProperty('--orbit', (station.tempo || 11) + 's');
    document.documentElement.dataset.current = station.id;
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

  function renderWeather() {
    const box = $('weatherWidget');
    const on = settings.weather && settings.city;
    document.documentElement.classList.toggle('has-weather', !!on);
    if (box) box.hidden = !on;
    const btn = $('weatherToggleBtn');
    if (btn) btn.textContent = settings.weather ? 'ON' : 'OFF';
    bind('city-setting', settings.city ? settings.city.name.toUpperCase() : 'NOT SET');
    if (!on) return;
    const w = store.get(KEYS.weather, null);
    if (w && w.cityId === settings.city.id) {
      bind('w-temp', Math.round(w.temp) + '°');
      bind('w-cond', WMO[w.code] || 'WEATHER');
      bind('w-city', settings.city.name.toUpperCase());
    } else {
      bind('w-temp', '--°');
      bind('w-cond', 'WEATHER');
      bind('w-city', settings.city.name.toUpperCase());
    }
  }

  async function refreshWeather(force) {
    if (!settings.weather || !settings.city || weatherLoading) return;
    const cached = store.get(KEYS.weather, null);
    if (!force && cached && cached.cityId === settings.city.id && Date.now() - cached.ts < WEATHER_REFRESH_MS) { renderWeather(); return; }
    weatherLoading = true;
    try {
      const c = settings.city;
      const j = await fetchJson('https://api.open-meteo.com/v1/forecast?latitude=' + c.lat + '&longitude=' + c.lon + '&current=temperature_2m,weather_code&timezone=auto');
      const cur = j && j.current;
      if (cur && Number.isFinite(cur.temperature_2m)) {
        store.set(KEYS.weather, { ts: Date.now(), cityId: c.id, temp: cur.temperature_2m, code: cur.weather_code });
      }
    } catch (e) { /* keep the cached value */ }
    weatherLoading = false;
    renderWeather();
  }

  async function setCity(name) {
    name = String(name || '').trim();
    if (!name) return;
    toast('LOOKING UP ' + name.toUpperCase(), 'info', 0);
    try {
      const j = await fetchJson('https://geocoding-api.open-meteo.com/v1/search?count=1&language=en&name=' + encodeURIComponent(name));
      const r = j && j.results && j.results[0];
      if (!r) { toast('CITY NOT FOUND', 'error'); return; }
      settings.city = { id: r.id, name: r.name, lat: r.latitude, lon: r.longitude };
      settings.weather = true;
      saveSettings();
      store.set(KEYS.weather, null);
      toast(r.name.toUpperCase() + (r.country ? ' · ' + r.country.toUpperCase() : ''));
      renderWeather();
      refreshWeather(true);
    } catch (e) {
      toast('WEATHER UNAVAILABLE', 'error');
    }
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

  function openOverlay(id) { const o = $(id); if (o) { o.classList.add('show'); document.documentElement.classList.remove('idle'); } }
  function closeOverlay(id) { const o = $(id); if (o) o.classList.remove('show'); scheduleIdle(); }

  function renderSettings() {
    const set = (id, text) => { const el = $(id); if (el) el.textContent = text; };
    set('awakeBtn', settings.keepAwake ? 'ON' : 'OFF');
    set('nightBtn', settings.night.toUpperCase());
    set('themeBtn', settings.theme === 'graphite' ? 'GRAPHITE' : 'BLACK');
    const mixes = stations.reduce((n, s) => n + (s.items ? s.items.length : 0), 0);
    const onAir = availableStations().length;
    set('libraryState', stations.length + ' STATIONS · ' + mixes + ' MIXES · ' + onAir + ' ON AIR');
    set('versionState', 'v' + VERSION + ' · RADIO');
    renderWeather();
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
        b.className = 'l-genre-btn';
        b.dataset.station = st.id;
        label(b, st.name);
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

    $('awakeBtn').addEventListener('click', () => { settings.keepAwake = !settings.keepAwake; saveSettings(); renderSettings(); updateWakeLock(); });
    $('nightBtn').addEventListener('click', () => {
      const order = ['auto', 'on', 'off'];
      settings.night = order[(order.indexOf(settings.night) + 1) % order.length];
      saveSettings(); renderSettings(); applyNight();
    });
    $('themeBtn').addEventListener('click', () => { settings.theme = settings.theme === 'graphite' ? 'black' : 'graphite'; saveSettings(); renderSettings(); applyTheme(); });
    $('weatherToggleBtn').addEventListener('click', () => {
      if (!settings.city) { $('cityInput').focus(); toast('ENTER A CITY FIRST'); return; }
      settings.weather = !settings.weather; saveSettings(); renderSettings(); refreshWeather(false);
    });
    $('cityForm').addEventListener('submit', e => { e.preventDefault(); const input = $('cityInput'); setCity(input.value); input.value = ''; input.blur(); });

    // Swipe across the artwork to change station.
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
      if (e.target && /INPUT|TEXTAREA/.test(e.target.tagName)) return;
      if (e.key === 'Escape') document.querySelectorAll('.overlay.show').forEach(o => closeOverlay(o.id));
      else if (e.key === ' ' || e.key === 'k') { e.preventDefault(); togglePlay(); }
      else if (e.key === 'ArrowRight') stepStation(1);
      else if (e.key === 'ArrowLeft') stepStation(-1);
    });
  }

  function artworkSvg(s) {
    return '<svg viewBox="0 0 220 220" aria-hidden="true" focusable="false"><defs>' +
      '<radialGradient id="sphere-' + s + '" cx="34%" cy="27%" r="76%"><stop offset="0" stop-color="#686966"/><stop offset=".19" stop-color="#42433f"/><stop offset=".46" stop-color="#222320"/><stop offset=".72" stop-color="#0f100f"/><stop offset="1" stop-color="#020303"/></radialGradient>' +
      '<linearGradient id="rim-' + s + '" x1="18%" y1="12%" x2="84%" y2="90%"><stop offset="0" stop-color="#f2f3ed" stop-opacity=".42"/><stop offset=".4" stop-color="#9b9c96" stop-opacity=".12"/><stop offset=".77" stop-color="#20211f" stop-opacity="0"/></linearGradient>' +
      '<filter id="grain-' + s + '" x="-20%" y="-20%" width="140%" height="140%"><feTurbulence type="fractalNoise" baseFrequency=".78" numOctaves="3" seed="17" result="n"/><feColorMatrix in="n" type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 .34 0" result="g"/><feComposite in="g" in2="SourceGraphic" operator="in"/></filter>' +
      '</defs><g class="art-stars"><circle cx="24" cy="45" r="1"/><circle cx="38" cy="171" r=".8"/><circle cx="64" cy="27" r=".65"/><circle cx="173" cy="36" r=".8"/><circle cx="193" cy="157" r=".65"/><circle cx="157" cy="189" r=".9"/><circle cx="31" cy="111" r=".55"/><circle cx="187" cy="91" r=".6"/><circle cx="82" cy="194" r=".5"/><circle cx="134" cy="22" r=".5"/></g>' +
      '<ellipse class="orbit-back" cx="110" cy="110" rx="94" ry="35" transform="rotate(-31 110 110)"/>' +
      '<circle cx="110" cy="110" r="63" fill="url(#sphere-' + s + ')"/>' +
      '<circle class="sphere-grain" cx="110" cy="110" r="62.4" fill="#fff" filter="url(#grain-' + s + ')"/>' +
      '<circle class="sphere-rim" cx="110" cy="110" r="63" stroke="url(#rim-' + s + ')"/>' +
      '<ellipse class="orbit-front" cx="110" cy="110" rx="94" ry="35" transform="rotate(-31 110 110)"/>' +
      '<g transform="rotate(-31 110 110)"><g transform="translate(110 110) scale(1 .372) translate(-110 -110)"><g class="orbit-spin"><ellipse class="orbit-halo" cx="204" cy="110" rx="8.5" ry="22"/><ellipse class="orbit-dot" cx="204" cy="110" rx="4.1" ry="10.8"/></g></g></g></svg>';
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
    document.querySelectorAll('.orbital-art').forEach((el, i) => { el.innerHTML = artworkSvg('a' + i); });
    applyTheme();
    renderClock();
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
    debug: () => ({ station: station && station.id, phase, wantPlaying, src: audio.currentSrc, time: audio.currentTime, paused: audio.paused })
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => { navigator.serviceWorker.register('./sw.js').catch(() => { /* offline shell is optional */ }); });
  }
})();
