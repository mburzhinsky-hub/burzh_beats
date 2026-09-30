(()=>{
  'use strict';

  const TRACKS=[
    {title:'Mix1',url:'./media/trance.m4a',fallbackDurationMs:3567119},
    {title:'Mix2',url:'https://drive.usercontent.google.com/download?id=1hhdiSG5G2s_VyB0JkjRBbJThe5i_SWCl&export=download&confirm=t',fallbackDurationMs:3901928}
  ];
  const STATION='Trance';
  const THEME_KEY='burzh.web.theme.v1';
  const FAV_KEY='burzh.web.local.favorites.v1';

  let selectedStation=STATION;
  let index=0;
  let repeat=false;
  let shuffle=false;
  let seeking=false;
  let loadedIndex=-1;
  let favorites=new Set();

  const a=new Audio();
  a.preload='metadata';
  a.playsInline=true;

  const q=id=>document.getElementById(id);
  const formatMs=ms=>{
    if(!Number.isFinite(ms)||ms<0)return'--:--';
    const sec=Math.floor(ms/1000);
    return Math.floor(sec/60)+':'+String(sec%60).padStart(2,'0');
  };

  function current(){return TRACKS[index]}
  function durationMs(){return Number.isFinite(a.duration)&&a.duration>0?Math.round(a.duration*1000):current().fallbackDurationMs}
  function positionMs(){return Number.isFinite(a.currentTime)?Math.round(a.currentTime*1000):0}
  function isFavorite(){return favorites.has('trance-'+index)}
  function saveFavorites(){try{localStorage.setItem(FAV_KEY,JSON.stringify([...favorites]))}catch(e){}}

  function setStationUI(){
    if(q('landStation'))q('landStation').textContent=selectedStation;
    document.querySelectorAll('.station').forEach(btn=>btn.classList.toggle('active',btn.dataset.station===selectedStation));
    document.querySelectorAll('.l-genre-btn').forEach(btn=>btn.classList.toggle('active',btn.dataset.station===selectedStation));
  }

  function setTrackUI(){
    const hasTrack=selectedStation===STATION;
    const title=hasTrack?current().title:'NO LOCAL MIX YET';
    const artist=hasTrack?'TRANCE · BURZH BEATS':selectedStation.toUpperCase();
    ['title','landTitle'].forEach(id=>{const e=q(id);if(e)e.textContent=title});
    ['artist','landArtist'].forEach(id=>{const e=q(id);if(e)e.textContent=artist});
    if('mediaSession' in navigator&&hasTrack){
      try{navigator.mediaSession.metadata=new MediaMetadata({title,artist:'BURZH beats',album:'BURZH beats · Trance'})}catch(e){}
    }
  }

  function setPlayUI(){
    const playing=selectedStation===STATION&&!a.paused&&!a.ended;
    ['playBtn','landPlayBtn'].forEach(id=>{
      const e=q(id);
      if(e){e.classList.toggle('is-playing',playing);e.setAttribute('aria-label',playing?'Pause':'Play')}
    });
    [q('landArt'),q('portraitArt')].forEach(e=>e&&e.classList.toggle('is-playing',playing));
    if('mediaSession' in navigator){try{navigator.mediaSession.playbackState=playing?'playing':'paused'}catch(e){}}
  }

  function setProgressUI(previewMs){
    const d=durationMs();
    const p=Math.max(0,Math.min(d,Number.isFinite(previewMs)?previewMs:positionMs()));
    const ratio=d?Math.max(0,Math.min(1,p/d)):0;
    ['fill','landFill'].forEach(id=>{const e=q(id);if(e)e.style.width=(ratio*100)+'%'});
    ['knob','landKnob'].forEach(id=>{const e=q(id);if(e)e.style.left=(ratio*100)+'%'});
    if(q('elapsed'))q('elapsed').textContent=formatMs(p);
    if(q('landElapsed'))q('landElapsed').textContent=formatMs(p);
    const remain=d?'-'+formatMs(Math.max(0,d-p)):'--:--';
    if(q('remaining'))q('remaining').textContent=remain;
    if(q('landRemaining'))q('landRemaining').textContent=remain;
  }

  function setModesUI(){
    const rep=q('repeatMode'),sh=q('shuffleMode');
    if(rep){rep.classList.toggle('active',repeat);rep.setAttribute('aria-pressed',String(repeat))}
    if(sh){sh.classList.toggle('active',shuffle);sh.setAttribute('aria-pressed',String(shuffle))}
    if(q('repeatState'))q('repeatState').textContent=repeat?'ON':'OFF';
    if(q('shuffleState'))q('shuffleState').textContent=shuffle?'ON':'OFF';
  }

  function setFavoriteUI(){
    [q('heartBtn'),q('landHeartBtn')].filter(Boolean).forEach(e=>e.classList.toggle('active',selectedStation===STATION&&isFavorite()));
    if(q('favoritesSummary'))q('favoritesSummary').textContent=favorites.size+' saved '+(favorites.size===1?'track':'tracks');
  }

  function setMatrixUI(){
    document.querySelectorAll('.track-matrix').forEach(matrix=>{
      const dots=matrix.querySelectorAll('i');
      dots.forEach((dot,i)=>{
        dot.classList.toggle('hot',selectedStation===STATION&&i===index);
        dot.classList.toggle('past',selectedStation===STATION&&i<index);
      });
    });
  }

  function syncAll(){setStationUI();setTrackUI();setPlayUI();setProgressUI();setModesUI();setFavoriteUI();setMatrixUI()}

  function loadTrack(nextIndex,{autoplay=false,reset=true}={}){
    index=(nextIndex+TRACKS.length)%TRACKS.length;
    const track=current();
    if(loadedIndex!==index){
      a.src=track.url;
      loadedIndex=index;
      a.load();
    }else if(reset){
      try{a.currentTime=0}catch(e){}
    }
    syncAll();
    if(autoplay){
      const p=a.play();
      if(p&&p.catch)p.catch(()=>{if(window.showStatus)showStatus('AUDIO PLAYBACK ERROR','error',3500)});
    }
  }

  async function playPause(){
    if(selectedStation!==STATION){
      if(window.showStatus)showStatus(selectedStation.toUpperCase()+' · NO LOCAL MIX YET','info',2600);
      return;
    }
    if(loadedIndex!==index)loadTrack(index,{autoplay:false,reset:false});
    try{
      if(a.paused||a.ended)await a.play();
      else a.pause();
    }catch(e){
      if(window.showStatus)showStatus('LOCAL AUDIO ERROR','error',3500);
    }
    setPlayUI();
  }

  function move(delta){
    if(selectedStation!==STATION){
      if(window.showStatus)showStatus(selectedStation.toUpperCase()+' · NO LOCAL MIX YET','info',2600);
      return;
    }
    const wasPlaying=!a.paused&&!a.ended;
    const next=shuffle&&TRACKS.length>1?(index===0?1:0):(index+delta+TRACKS.length)%TRACKS.length;
    loadTrack(next,{autoplay:wasPlaying,reset:true});
  }

  function selectStation(name){
    selectedStation=name||STATION;
    if(selectedStation!==STATION){
      a.pause();
      setStationUI();setTrackUI();setPlayUI();setProgressUI(0);setMatrixUI();
      if(window.showStatus)showStatus(selectedStation.toUpperCase()+' · NO LOCAL MIX YET','info',2200);
      return;
    }
    if(loadedIndex<0)loadTrack(index,{autoplay:false,reset:false});else syncAll();
  }

  function seekToRatio(ratio){
    if(selectedStation!==STATION)return;
    const d=durationMs();
    const clamped=Math.max(0,Math.min(1,ratio));
    const ms=d*clamped;
    setProgressUI(ms);
    if(Number.isFinite(a.duration)&&a.duration>0){try{a.currentTime=a.duration*clamped}catch(e){}}
  }

  function bindSeek(bar){
    if(!bar||bar.dataset.seekBound==='1')return;
    bar.dataset.seekBound='1';
    const ratioFromEvent=e=>{
      const rect=bar.getBoundingClientRect();
      return rect.width?Math.max(0,Math.min(1,(e.clientX-rect.left)/rect.width)):0;
    };
    bar.addEventListener('pointerdown',e=>{
      if(selectedStation!==STATION)return;
      seeking=true;
      try{bar.setPointerCapture(e.pointerId)}catch(_){}
      seekToRatio(ratioFromEvent(e));e.preventDefault();
    });
    bar.addEventListener('pointermove',e=>{if(!seeking)return;seekToRatio(ratioFromEvent(e));e.preventDefault()});
    const done=e=>{
      if(!seeking)return;
      seeking=false;seekToRatio(ratioFromEvent(e));
      try{bar.releasePointerCapture(e.pointerId)}catch(_){}
      e.preventDefault();
    };
    bar.addEventListener('pointerup',done);
    bar.addEventListener('pointercancel',()=>{seeking=false});
  }

  function applyTheme(theme){
    const graphite=theme==='graphite';
    document.documentElement.classList.toggle('theme-graphite',graphite);
    const b=q('themeToggleBtn');if(b)b.textContent=graphite?'GRAPHITE':'BLACK';
    const meta=document.querySelector('meta[name="theme-color"]');if(meta)meta.content=graphite?'#17191a':'#050606';
  }

  window.toggleTheme=()=>{
    const next=document.documentElement.classList.contains('theme-graphite')?'black':'graphite';
    try{localStorage.setItem(THEME_KEY,next)}catch(e){}
    applyTheme(next);
  };

  window.tap=(action,el)=>{
    try{window.feedback&&feedback(action)}catch(e){}
    if(el)el.animate([{transform:'scale(.92)'},{transform:'scale(1)'}],{duration:150,easing:'cubic-bezier(.2,.8,.2,1)'});
    if(action==='play')playPause();else if(action==='next')move(1);else if(action==='previous')move(-1);
  };

  window.stationTap=(el)=>{try{window.feedback&&feedback('station')}catch(e){};selectStation(el&&el.dataset?el.dataset.station:STATION)};
  window.landStationTap=window.stationTap;

  window.toggleMode=(kind)=>{
    if(kind==='repeat'){repeat=!repeat;a.loop=repeat}
    else if(kind==='shuffle'){shuffle=!shuffle}
    setModesUI();
  };

  window.toggleFavorite=()=>{
    if(selectedStation!==STATION)return;
    const key='trance-'+index;
    if(favorites.has(key))favorites.delete(key);else favorites.add(key);
    saveFavorites();setFavoriteUI();
  };

  window.openSettings=()=>{
    const e=q('accountState');if(e)e.textContent='LOCAL · TRANCE · '+TRACKS.length+' MIXES';
    const o=q('settingsOverlay');if(o)o.classList.add('show');
  };

  if(window.BURZH)window.BURZH.onState=()=>{};

  a.addEventListener('play',setPlayUI);
  a.addEventListener('pause',setPlayUI);
  a.addEventListener('loadedmetadata',()=>{setProgressUI();setTrackUI()});
  a.addEventListener('durationchange',()=>setProgressUI());
  a.addEventListener('timeupdate',()=>{if(!seeking)setProgressUI()});
  a.addEventListener('ended',()=>{if(repeat){a.currentTime=0;a.play().catch(()=>{})}else move(1)});
  a.addEventListener('error',()=>{if(window.showStatus)showStatus(current().title.toUpperCase()+' · AUDIO FILE ERROR','error',5000);setPlayUI()});

  if('mediaSession' in navigator){
    try{navigator.mediaSession.setActionHandler('play',()=>playPause())}catch(e){}
    try{navigator.mediaSession.setActionHandler('pause',()=>a.pause())}catch(e){}
    try{navigator.mediaSession.setActionHandler('nexttrack',()=>move(1))}catch(e){}
    try{navigator.mediaSession.setActionHandler('previoustrack',()=>move(-1))}catch(e){}
    try{navigator.mediaSession.setActionHandler('seekto',d=>{if(Number.isFinite(d.seekTime)){a.currentTime=Math.max(0,Math.min(a.duration||0,d.seekTime));setProgressUI()}})}catch(e){}
    try{navigator.mediaSession.setActionHandler('seekforward',d=>{a.currentTime=Math.min(a.duration||0,a.currentTime+(d.seekOffset||10));setProgressUI()})}catch(e){}
    try{navigator.mediaSession.setActionHandler('seekbackward',d=>{a.currentTime=Math.max(0,a.currentTime-(d.seekOffset||10));setProgressUI()})}catch(e){}
  }

  window.addEventListener('load',()=>{
    try{localStorage.removeItem('burzh.web.yandex.token.v1')}catch(e){}
    try{favorites=new Set(JSON.parse(localStorage.getItem(FAV_KEY)||'[]'))}catch(e){favorites=new Set()}
    let theme='black';try{theme=localStorage.getItem(THEME_KEY)||'black'}catch(e){}
    applyTheme(theme);
    const auth=q('authOverlay');if(auth)auth.remove();
    document.querySelectorAll('.p-progress .bar,.l-progress .bar').forEach(bindSeek);
    selectedStation=STATION;
    loadTrack(0,{autoplay:false,reset:false});
    syncAll();
  });
})();