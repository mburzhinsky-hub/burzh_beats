const ALLOWED_SUFFIXES = ['yandex.net','yandex.ru','yandex.com'];

function cors(req,res){
  const origin=req.headers.origin||'';
  const allowed = origin==='https://mburzhinsky-hub.github.io' || origin==='http://localhost:3000' || origin==='http://127.0.0.1:3000';
  if(allowed) res.setHeader('Access-Control-Allow-Origin',origin);
  res.setHeader('Vary','Origin');
  res.setHeader('Access-Control-Allow-Headers','Authorization, Content-Type, X-Yandex-Music-Client');
  res.setHeader('Access-Control-Allow-Methods','GET, OPTIONS');
}

function allowedHost(hostname){
  const h=String(hostname||'').toLowerCase();
  return ALLOWED_SUFFIXES.some(s=>h===s||h.endsWith('.'+s));
}

export default async function handler(req,res){
  cors(req,res);
  if(req.method==='OPTIONS') return res.status(204).end();
  if(req.method!=='GET') return res.status(405).json({error:'METHOD_NOT_ALLOWED'});

  try{
    const raw=String(req.query.url||'');
    if(!raw) return res.status(400).json({error:'MISSING_URL'});
    const target=new URL(raw);
    if(target.protocol!=='https:'||!allowedHost(target.hostname)) return res.status(400).json({error:'TARGET_NOT_ALLOWED'});

    const headers={
      'User-Agent':'BURZH-beats-web/1.0',
      'Accept-Language':'ru'
    };
    if(req.headers.authorization) headers['Authorization']=req.headers.authorization;
    if(req.headers['x-yandex-music-client']) headers['X-Yandex-Music-Client']=req.headers['x-yandex-music-client'];

    const upstream=await fetch(target.toString(),{method:'GET',headers,redirect:'follow'});
    const body=Buffer.from(await upstream.arrayBuffer());
    res.status(upstream.status);
    res.setHeader('Content-Type',upstream.headers.get('content-type')||'application/octet-stream');
    res.setHeader('Cache-Control','no-store');
    return res.send(body);
  }catch(e){
    return res.status(502).json({error:'PROXY_ERROR',message:String(e&&e.message||e)});
  }
}
