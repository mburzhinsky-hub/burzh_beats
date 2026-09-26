(()=>{
  'use strict';

  const CLIENT_ID='23cabbbdc6cd418abb4b39c32c41195d';
  const OAUTH='https://oauth.yandex.ru';
  const DEVICE_ID_KEY='burzh.web.yandex.device.v2';

  let pending=null;
  let pollTimer=0;
  let polling=false;

  const $=id=>document.getElementById(id);

  function setStatus(message,isError){
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
      if(v.length<6){
        v='burzh-'+randomId();
        localStorage.setItem(DEVICE_ID_KEY,v);
      }
      return v.slice(0,50);
    }catch(e){
      return ('burzh-'+randomId()).slice(0,50);
    }
  }

  async function postForm(url,data){
    const body=new URLSearchParams();
    Object.entries(data).forEach(([k,v])=>{
      if(v!==undefined&&v!==null&&v!=='')body.set(k,String(v));
    });

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
      er.oauth=String(j.error||'');
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
    setStatus('YANDEX MUSIC AUTHORIZATION');
  }

  function renderCode(root,code){
    root.innerHTML='';

    const label=document.createElement('div');
    label.className='settings-label';
    label.style.marginBottom='8px';
    label.textContent='YANDEX MUSIC CODE';

    const value=document.createElement('div');
    value.style.cssText=[
      'font:600 30px/1.1 ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace',
      'letter-spacing:.10em',
      'color:#f1f1ec',
      'margin:10px 0 16px',
      'text-transform:none',
      'font-variant-ligatures:none',
      'user-select:all',
      '-webkit-user-select:all'
    ].join(';');
    value.textContent=String(code.user_code||'');

    const copy=document.createElement('button');
    copy.className='auth-btn';
    copy.style.width='100%';
    copy.textContent='COPY CODE';
    copy.onclick=async()=>{
      try{
        await navigator.clipboard.writeText(String(code.user_code||''));
        setStatus('CODE COPIED · PASTE IT IN YANDEX');
      }catch(e){
        setStatus('LONG PRESS THE CODE TO COPY IT');
      }
    };

    const open=document.createElement('button');
    open.className='auth-btn primary';
    open.style.width='100%';
    open.style.marginTop='10px';
    open.textContent='OPEN YANDEX · CONFIRM';
    open.onclick=()=>{
      window.open(String(code.verification_url||'https://oauth.yandex.ru/device'),'_blank');
      setStatus('ENTER THIS CODE IN YANDEX · THEN RETURN HERE');
      setTimeout(pollNow,1200);
    };

    const fresh=document.createElement('button');
    fresh.className='auth-btn';
    fresh.style.width='100%';
    fresh.style.marginTop='10px';
    fresh.textContent='NEW CODE';
    fresh.onclick=start;

    root.append(label,value,copy,open,fresh);
    setStatus('WAITING FOR YANDEX MUSIC CONFIRMATION');
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
    setStatus('');

    try{
      const code=await postForm(OAUTH+'/device/code',{
        client_id:CLIENT_ID,
        device_id:deviceId(),
        device_name:'BURZH beats iPhone',
        scope:'music:content music:read music:write'
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
      console.warn('BURZH Yandex Music auth start:',e);
      renderStart(root);
      setStatus(String(e&&e.message||e),true);
    }
  }

  function schedulePoll(ms){
    clearTimeout(pollTimer);
    if(!pending)return;
    pollTimer=setTimeout(pollNow,Number.isFinite(ms)?ms:pending.interval*1000);
  }

  async function pollNow(){
    if(!pending||polling)return;

    if(Date.now()>pending.expiresAt){
      const root=$('yandexLoginMount');
      pending=null;
      if(root)renderStart(root);
      setStatus('CODE EXPIRED · TAP CONNECT AGAIN',true);
      return;
    }

    polling=true;
    try{
      const j=await postForm(OAUTH+'/token',{
        grant_type:'device_code',
        code:pending.device_code,
        client_id:CLIENT_ID
      });

      const token=String(j.access_token||'').trim();
      if(token.length<20)throw new Error('YANDEX MUSIC TOKEN MISSING');

      pending=null;
      clearTimeout(pollTimer);
      pollTimer=0;
      setStatus('YANDEX MUSIC CONNECTED');

      if(window.AndroidBridge&&typeof window.AndroidBridge.saveYandexToken==='function'){
        window.AndroidBridge.saveYandexToken(token);
      }else{
        try{localStorage.setItem('burzh.web.yandex.token.v1',token)}catch(e){}
        location.reload();
      }
    }catch(e){
      const code=String(e&&e.oauth||'');
      const msg=String(e&&e.message||e);

      if(code==='authorization_pending'||/authorization_pending/i.test(msg)){
        setStatus('WAITING FOR CONFIRMATION…');
        schedulePoll();
      }else if(code==='slow_down'){
        schedulePoll((pending.interval+5)*1000);
      }else if(code==='expired_token'||code==='invalid_grant'){
        const root=$('yandexLoginMount');
        pending=null;
        if(root)renderStart(root);
        setStatus('CODE EXPIRED OR INVALID · TAP CONNECT AGAIN',true);
      }else if(code==='access_denied'){
        const root=$('yandexLoginMount');
        pending=null;
        if(root)renderStart(root);
        setStatus('YANDEX MUSIC ACCESS WAS NOT APPROVED',true);
      }else{
        console.warn('BURZH Yandex Music token poll:',e);
        setStatus(msg,true);
        schedulePoll(8000);
      }
    }finally{
      polling=false;
    }
  }

  function mount(parentId){
    const root=document.getElementById(parentId);
    if(!root)return;
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