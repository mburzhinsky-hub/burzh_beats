import http from 'node:http';
import { URL } from 'node:url';

const PORT = process.env.PORT || 10000;
const ALLOWED_SUFFIXES = ['yandex.net','yandex.ru','yandex.com'];
const ALLOWED_ORIGINS = new Set([
  'https://mburzhinsky-hub.github.io'
]);

function allowedHost(hostname){
  const h=String(hostname||'').toLowerCase();
  return ALLOWED_SUFFIXES.some(s=>h===s||h.endsWith('.'+s));
}
function setCors(req,res){
  const origin=String(req.headers.origin||'');
  if(ALLOWED_ORIGINS.has(origin)) res.setHeader('Access-Control-Allow-Origin',origin);
  res.setHeader('Vary','Origin');
  res.setHeader('Access-Control-Allow-Headers','Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods','GET, OPTIONS');
  res.setHeader('Access-Control-Max-Age','600');
}
function sendJson(res,status,obj){
  const body=Buffer.from(JSON.stringify(obj));
  res.statusCode=status;
  res.setHeader('Content-Type','application/json; charset=utf-8');
  res.setHeader('Content-Length',String(body.length));
  res.end(body);
}

const server=http.createServer(async (req,res)=>{
  setCors(req,res);
  if(req.method==='OPTIONS'){res.statusCode=204;return res.end();}
  if(req.method!=='GET') return sendJson(res,405,{error:'METHOD_NOT_ALLOWED'});

  try{
    const incoming=new URL(req.url,'http://localhost');
    if(incoming.pathname==='/health') return sendJson(res,200,{ok:true});
    if(incoming.pathname!=='/yandex') return sendJson(res,404,{error:'NOT_FOUND'});

    const raw=incoming.searchParams.get('url')||'';
    if(!raw) return sendJson(res,400,{error:'MISSING_URL'});
    const target=new URL(raw);
    if(target.protocol!=='https:'||!allowedHost(target.hostname)){
      return sendJson(res,400,{error:'TARGET_NOT_ALLOWED'});
    }

    const headers={
      'User-Agent':'BURZH-beats-web/1.0',
      'Accept-Language':'ru'
    };
    if(req.headers.authorization) headers.Authorization=req.headers.authorization;

    const upstream=await fetch(target.toString(),{method:'GET',headers,redirect:'follow'});
    const body=Buffer.from(await upstream.arrayBuffer());
    res.statusCode=upstream.status;
    res.setHeader('Content-Type',upstream.headers.get('content-type')||'application/octet-stream');
    res.setHeader('Cache-Control','no-store');
    res.setHeader('Content-Length',String(body.length));
    res.end(body);
  }catch(e){
    sendJson(res,502,{error:'PROXY_ERROR',message:String(e&&e.message||e)});
  }
});

server.listen(PORT,'0.0.0.0',()=>console.log('BURZH proxy listening on',PORT));
