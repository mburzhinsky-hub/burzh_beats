(()=>{
  'use strict';

  const CLIENT_ID='56c8ea9fb560464d9ac0826dac3f5b1f';
  const REDIRECT_URI='https://mburzhinsky-hub.github.io/burzh_beats/';
  const ORIGIN='https://mburzhinsky-hub.github.io';
  let mounted=false;
  let mounting=false;

  function findToken(value,depth){
    if(depth>6||value==null)return '';
    if(typeof value==='string'){
      if(value.length>20&&!/\s/.test(value))return value;
      return '';
    }
    if(Array.isArray(value)){
      for(const x of value){const t=findToken(x,depth+1);if(t)return t}
      return '';
    }
    if(typeof value==='object'){
      for(const k of ['access_token','accessToken','token','oauth_token']){
        if(typeof value[k]==='string'&&value[k].length>20)return value[k];
      }
      for(const k of Object.keys(value)){
        const t=findToken(value[k],depth+1);if(t)return t;
      }
    }
    return '';
  }

  function show(message,isError){
    const e=document.getElementById('authError');
    if(e)e.textContent=String(message||'');
    if(isError&&window.showStatus)window.showStatus(String(message||'YANDEX LOGIN ERROR'),'error',4500);
  }

  function acceptToken(token){
    token=String(token||'').trim();
    if(token.length<20){show('YANDEX LOGIN DID NOT RETURN A TOKEN',true);return false}
    try{
      if(window.AndroidBridge&&typeof window.AndroidBridge.saveYandexToken==='function'){
        window.AndroidBridge.saveYandexToken(token);
        return true;
      }
    }catch(e){}
    try{localStorage.setItem('burzh.web.yandex.token.v1',token)}catch(e){}
    location.reload();
    return true;
  }

  function directLogin(){
    const u=new URL('https://oauth.yandex.ru/authorize');
    u.searchParams.set('response_type','token');
    u.searchParams.set('client_id',CLIENT_ID);
    u.searchParams.set('redirect_uri',REDIRECT_URI);
    location.assign(u.toString());
  }

  async function mount(parentId){
    if(mounted||mounting)return;
    mounting=true;
    const root=document.getElementById(parentId);
    if(!root){mounting=false;return}
    root.textContent='';
    try{
      if(!window.YaAuthSuggest)throw new Error('YANDEX SDK NOT LOADED');
      const result=await window.YaAuthSuggest.init(
        {client_id:CLIENT_ID,response_type:'token',redirect_uri:REDIRECT_URI},
        ORIGIN,
        {
          view:'button',
          parentId:parentId,
          buttonView:'main',
          buttonTheme:'dark',
          buttonSize:'xl',
          buttonBorderRadius:999
        }
      );
      if(!result||typeof result.handler!=='function')throw new Error('YANDEX BUTTON INIT FAILED');
      mounted=true;
      show('');
      result.handler()
        .then(data=>{
          const token=findToken(data,0);
          if(!acceptToken(token))show('YANDEX LOGIN COMPLETED WITHOUT TOKEN',true);
        })
        .catch(err=>{
          console.warn('BURZH Yandex login:',err);
          show('YANDEX LOGIN ERROR · TAP RETRY',true);
          mounted=false;
        });
    }catch(e){
      console.warn('BURZH Yandex SDK unavailable:',e);
      const b=document.createElement('button');
      b.className='auth-btn primary';
      b.style.width='100%';
      b.textContent='LOGIN WITH YANDEX';
      b.onclick=directLogin;
      root.appendChild(b);
      mounted=true;
      show('STANDARD YANDEX LOGIN MODE');
    }finally{
      mounting=false;
    }
  }

  function callbackMode(){
    const hash=new URLSearchParams((location.hash||'').replace(/^#/,''));
    const token=hash.get('access_token')||'';
    const error=hash.get('error')||'';
    if(!token&&!error)return false;

    if(error){
      try{history.replaceState(null,'',location.pathname+location.search)}catch(e){}
      show('YANDEX LOGIN: '+error,true);
      return true;
    }

    // If this page is the SDK callback iframe/popup, return the token to the
    // original BURZH page through Yandex's official callback helper.
    if(window.YaSendSuggestToken){
      try{window.YaSendSuggestToken(ORIGIN,{source:'burzh-beats'});}catch(e){}
    }

    // Also accept the token locally. This covers standalone iOS/PWA redirects.
    acceptToken(token);
    try{history.replaceState(null,'',location.pathname+location.search)}catch(e){}
    return true;
  }

  window.BURZHYandexAuth={
    mount,
    login:directLogin,
    acceptToken,
    callbackMode
  };

  window.addEventListener('load',()=>setTimeout(callbackMode,0));
})();