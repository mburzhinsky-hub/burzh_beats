(()=>{
  'use strict';

  const CLIENT_ID='56c8ea9fb560464d9ac0826dac3f5b1f';
  const REDIRECT_URI='https://mburzhinsky-hub.github.io/burzh_beats/';
  const TOKEN_KEY='burzh.web.yandex.token.v1';
  const VERIFIER_KEY='burzh.oauth.pkce.verifier.v1';
  const STATE_KEY='burzh.oauth.pkce.state.v1';
  const OAUTH='https://oauth.yandex.ru';

  const $=id=>document.getElementById(id);

  function setStatus(message,isError){
    const e=$('authError');
    if(e)e.textContent=String(message||'');
    if(isError&&window.showStatus)window.showStatus(String(message||'YANDEX LOGIN ERROR'),'error',4500);
  }

  function b64url(bytes){
    let s='';
    bytes.forEach(b=>s+=String.fromCharCode(b));
    return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  }

  function randomString(bytes=32){
    const a=new Uint8Array(bytes);
    crypto.getRandomValues(a);
    return b64url(a);
  }

  async function sha256(text){
    const data=new TextEncoder().encode(text);
    const hash=await crypto.subtle.digest('SHA-256',data);
    return b64url(new Uint8Array(hash));
  }

  function clearPending(){
    try{
      sessionStorage.removeItem(VERIFIER_KEY);
      sessionStorage.removeItem(STATE_KEY);
    }catch(e){}
  }

  async function start(){
    try{
      const verifier=randomString(48);
      const challenge=await sha256(verifier);
      const state=randomString(24);

      sessionStorage.setItem(VERIFIER_KEY,verifier);
      sessionStorage.setItem(STATE_KEY,state);

      const u=new URL(OAUTH+'/authorize');
      u.searchParams.set('response_type','code');
      u.searchParams.set('client_id',CLIENT_ID);
      u.searchParams.set('redirect_uri',REDIRECT_URI);
      u.searchParams.set('state',state);
      u.searchParams.set('code_challenge',challenge);
      u.searchParams.set('code_challenge_method','S256');
      u.searchParams.set('force_confirm','yes');
      u.searchParams.set('scope','login:info music:content music:read music:write');

      location.assign(u.toString());
    }catch(e){
      setStatus('PKCE START ERROR',true);
    }
  }

  async function exchange(code){
    const verifier=sessionStorage.getItem(VERIFIER_KEY)||'';
    if(!verifier)throw new Error('PKCE VERIFIER MISSING');

    const body=new URLSearchParams();
    body.set('grant_type','authorization_code');
    body.set('code',code);
    body.set('client_id',CLIENT_ID);
    body.set('redirect_uri',REDIRECT_URI);
    body.set('code_verifier',verifier);

    const r=await fetch(OAUTH+'/token',{
      method:'POST',
      mode:'cors',
      cache:'no-store',
      credentials:'omit',
      headers:{'Content-Type':'application/x-www-form-urlencoded'},
      body:body.toString()
    });

    let j={};
    try{j=await r.json()}catch(e){}
    if(!r.ok){
      const msg=String(j.error_description||j.error||('HTTP '+r.status));
      const er=new Error(msg);
      er.oauth=String(j.error||'');
      throw er;
    }

    const token=String(j.access_token||'').trim();
    if(token.length<20)throw new Error('YANDEX TOKEN MISSING');
    return token;
  }

  async function handleCallback(){
    const q=new URLSearchParams(location.search);
    const code=q.get('code')||'';
    const error=q.get('error')||'';
    const returnedState=q.get('state')||'';

    if(!code&&!error)return false;

    const expected=sessionStorage.getItem(STATE_KEY)||'';

    if(error){
      clearPending();
      history.replaceState(null,'',location.pathname);
      setStatus('YANDEX: '+(q.get('error_description')||error),true);
      return true;
    }

    if(!expected||returnedState!==expected){
      clearPending();
      history.replaceState(null,'',location.pathname);
      setStatus('YANDEX LOGIN STATE MISMATCH',true);
      return true;
    }

    setStatus('CONNECTING YANDEX MUSIC…');

    try{
      const token=await exchange(code);
      try{localStorage.setItem(TOKEN_KEY,token)}catch(e){}
      clearPending();
      history.replaceState(null,'',location.pathname);

      if(window.AndroidBridge&&typeof window.AndroidBridge.saveYandexToken==='function'){
        window.AndroidBridge.saveYandexToken(token);
      }else{
        location.reload();
      }
    }catch(e){
      clearPending();
      history.replaceState(null,'',location.pathname);
      const msg=String(e&&e.message||e);
      if(String(e&&e.oauth)==='invalid_scope'){
        setStatus('YANDEX OAUTH: MUSIC PERMISSIONS NOT ENABLED',true);
      }else{
        setStatus('YANDEX OAUTH: '+msg,true);
      }
    }
    return true;
  }

  function mount(parentId){
    const root=document.getElementById(parentId);
    if(!root)return;
    root.innerHTML='';

    const b=document.createElement('button');
    b.className='auth-btn primary';
    b.style.width='100%';
    b.textContent='LOGIN WITH YANDEX';
    b.onclick=start;
    root.appendChild(b);

    setStatus('YANDEX ACCOUNT + MUSIC ACCESS');
  }

  function reset(){
    clearPending();
    const root=$('yandexLoginMount');
    if(root)mount('yandexLoginMount');
  }

  window.BURZHYandexAuth={mount,start,reset,handleCallback};

  document.addEventListener('DOMContentLoaded',()=>{
    setTimeout(handleCallback,0);
  });
})();