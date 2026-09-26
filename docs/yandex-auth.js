(()=>{
  'use strict';

  /*
   * BURZH beats / Yandex Music device authorization.
   * Uses the public OAuth credentials of the official Yandex Music Android client,
   * matching the auth flow used by current open-source Yandex Music clients.
   */
  const MUSIC_CLIENT_ID='23cabbbdc6cd418abb4b39c32c41195d';
  const MUSIC_CLIENT_SECRET='53bc75238f0c4d08a118e51fe9203300';
  const TOKEN_KEY='burzh.web.yandex.token.v1';
  const DEVICE_ID_KEY='burzh.web.yandex.device.v1';
  const OAUTH='https://oauth.yandex.ru';

  let mounted=false;
  let pending=null;
  let pollTimer=0;
  let polling=false;

  const $=id=>document.getElementById(id);

  function status(message,isError){
    const e=$('authError');
    if(e)e.textContent=String(message||'');
    if(isError&&window.showStatus)window.showStatus(String(message||'YANDEX MUSIC LOGIN ERROR'),'error',4500);
  }

  function randomId(){
    const a=new Uint8Array(12);
    crypto.getRandomValues(a);
    return Array.from(a,x=>x.toString(16).padStart(2,'0')).join('');
  }

  function deviceId(){
    try{
      let v=localStorage.getItem(DEVICE_ID_KEY)||'';
      if(v.length<6){v='burzh-'+randomId();localStorage.setItem(DEVICE_ID_KEY,v)}
      return v.slice(0,50);
    }catch(e){
      return ('burzh-'+randomId()).slice(0,50);
    }
  }

  async function formPost(url,data){
    const body=new URLSearchParams();
    Object.entries(data).forEach(([k,v])=>body.set(k,String(v)));
    let r;
    try{
      r=await fetch(url,{
        method:'POST',
        mode:'cors',
        cache:'no-store',
        credentials:'omit',
        headers:{'Content-Type':'application/x-www-form-urlencoded'},
        body:body.toString()
      });
    }catch(cause){
      const er=new Error('SAFARI BLOCKED YANDEX OAUTH REQUEST');
      er.kind='network';
      er.cause=cause;
      throw er;
    }
    let j={};
    try{j=await r.json()}catch(e){}
    if(!r.ok){
      const er=new Error(String(j.error_description||j.error||('HTTP '+r.status)));
      er.status=r.status;
      er.oauth=j.error||'';
      throw er;
    }
    return j;
  }

  function renderStart(root){
    root.innerHTML='';
    const b=document.createElement('button');
    b.className='auth-btn primary';
    b.style.width='100%';
    b.textContent='CONNECT YANDEX MUSIC';
    b.onclick=start;
    root.appendChild(b);
    status('MUSIC ACCOUNT AUTHORIZATION');
  }

  function renderCode(root,code){
    root.innerHTML='';

    const label=document.createElement('div');
    label.className='settings-label';
    label.style.marginBottom='8px';
    label.textContent='YANDEX MUSIC CODE';

    const value=document.createElement('div');
    value.style.cssText="font:560 34px/.95 'Doto',monospace;letter-spacing:.12em;color:#f1f1ec;margin:8px 0 16px";
    value.textContent=String(code.user_code||'').toUpperCase();

    const open=document.createElement('button');
    open.className='auth-btn primary';
    open.style.width='100%';
    open.textContent='OPEN YANDEX · CONFIRM';
    open.onclick=()=>{
      const url=String(code.verification_url||'https://oauth.yandex.ru/device');
      window.open(url,'_blank');
      status('ENTER THE CODE IN YANDEX · THEN RETURN HERE');
      setTimeout(()=>pollNow(),1200);
    };

    const retry=document.createElement('button');
    retry.className='auth-btn';
    retry.style.width='100%';
    retry.style.marginTop='10px';
    retry.textContent='NEW CODE';
    retry.onclick=start;

    root.append(label,value,open,retry);
    status('WAITING FOR YANDEX MUSIC CONFIRMATION');
  }

  async function start(){
    clearTimeout(pollTimer);
    pollTimer=0;
    pending=null;
    polling=false;

    const root=$('yandexLoginMount');
    if(!root)return;
    root.innerHTML='';
    const wait=document.createElement('div');
    wait.className='settings-value';
    wait.textContent='REQUESTING YANDEX MUSIC CODE…';
    root.appendChild(wait);
    status('');

    try{
      const code=await formPost(OAUTH+'/device/code',{
        client_id:MUSIC_CLIENT_ID,
        device_id:deviceId(),
        device_name:'BURZH beats iPhone'
      });
      if(!code.device_code||!code.user_code)throw new Error('YANDEX DID NOT RETURN DEVICE CODE');
      pending={
        device_code:String(code.device_code),
        user_code:String(code.user_code),
        verification_url:String(code.verification_url||'https://oauth.yandex.ru/device'),
        interval:Math.max(5,Number(code.interval)||5),
        expiresAt:Date.now()+Math.max(60,Number(code.expires_in)||300)*1000
      };
      renderCode(root,pending);
      schedulePoll();
    }catch(e){
      console.warn('BURZH Music device auth start:',e);
      renderStart(root);
      status(String(e&&e.message||e),true);
    }
  }

  function schedulePoll(delay){
    clearTimeout(pollTimer);
    if(!pending)return;
    const ms=Number.isFinite(delay)?delay:pending.interval*1000;
    pollTimer=setTimeout(pollNow,ms);
  }

  async function pollNow(){
    if(!pending||polling)return;
    if(Date.now()>pending.expiresAt){
      const root=$('yandexLoginMount');
      pending=null;
      if(root)renderStart(root);
      status('CODE EXPIRED · TAP CONNECT AGAIN',true);
      return;
    }

    polling=true;
    try{
      const j=await formPost(OAUTH+'/token',{
        grant_type:'device_code',
        code:pending.device_code,
        client_id:MUSIC_CLIENT_ID,
        client_secret:MUSIC_CLIENT_SECRET
      });
      const token=String(j.access_token||'').trim();
      if(token.length<20)throw new Error('YANDEX MUSIC TOKEN MISSING');

      try{localStorage.setItem(TOKEN_KEY,token)}catch(e){}
      pending=null;
      clearTimeout(pollTimer);
      pollTimer=0;
      status('YANDEX MUSIC CONNECTED');

      if(window.AndroidBridge&&typeof window.AndroidBridge.saveYandexToken==='function'){
        window.AndroidBridge.saveYandexToken(token);
      }else{
        location.reload();
      }
    }catch(e){
      const code=String(e&&e.oauth||'');
      const msg=String(e&&e.message||e);
      if(code==='authorization_pending'||/authorization_pending/i.test(msg)){
        schedulePoll();
      }else if(code==='slow_down'){
        schedulePoll((pending.interval+5)*1000);
      }else if(code==='expired_token'){
        const root=$('yandexLoginMount');
        pending=null;
        if(root)renderStart(root);
        status('CODE EXPIRED · TAP CONNECT AGAIN',true);
      }else if(code==='access_denied'){
        const root=$('yandexLoginMount');
        pending=null;
        if(root)renderStart(root);
        status('YANDEX MUSIC ACCESS WAS NOT APPROVED',true);
      }else{
        console.warn('BURZH Music device auth poll:',e);
        status(msg,true);
        schedulePoll(8000);
      }
    }finally{
      polling=false;
    }
  }

  function mount(parentId){
    const root=document.getElementById(parentId);
    if(!root)return;
    mounted=true;
    if(pending)renderCode(root,pending);
    else renderStart(root);
  }

  function reset(){
    clearTimeout(pollTimer);
    pollTimer=0;
    pending=null;
    polling=false;
    const root=$('yandexLoginMount');
    if(root)renderStart(root);
  }

  document.addEventListener('visibilitychange',()=>{
    if(document.visibilityState==='visible'&&pending)setTimeout(pollNow,300);
  });

  window.BURZHYandexAuth={mount,start,pollNow,reset};
})();