import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { createHandler } from './lib/probe.mjs';
import { callbackTransport } from './lib/transport.mjs';
import { assertStore } from './lib/store.mjs';

const MAX_BODY = 32768;
const json = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
export function assertAuth(auth) {
  if (!auth || typeof auth.authenticate !== 'function' || typeof auth.handleHttp !== 'function' ||
      typeof auth.challenge !== 'string' || /[\r\n]/.test(auth.challenge) || !auth.challenge.startsWith('Bearer ')) throw new Error('OAuth adapter required');
}
// 呼び出し側が制御できるIDヘッダは一切信用しない。OAuthアダプタは
// audience/scope/有効期限の検査の後、検証済み issuer+subject の安定したオーナーIDを返す。
export function createRequestListener({auth, store, transport = callbackTransport, handlerFactory, ingestEvent, receiverRequest}) {
  assertAuth(auth); assertStore(store);
  const probe = createHandler(store, transport);
  const handle = handlerFactory ? handlerFactory(probe) : probe;
  return async (req, res) => {
    try {
      if (req.url === '/healthz' && req.method === 'GET') { json(res, 200, {ok:true}); return; }
      if (await auth.handleHttp(req, res)) return;
      const discordConsumer=req.url==='/mcp/discord'&&auth.discordConsumerEnabled===true;
      const ingest=req.url==='/ingest/discord'&&typeof ingestEvent==='function';
      const receiver=typeof receiverRequest==='function'&&['/receiver/discord/claim','/receiver/discord/receipt','/receiver/discord/drain'].includes(req.url);
      if (req.url !== '/mcp'&&!discordConsumer&&!ingest&&!receiver) { json(res, 404, {error:'Not found'}); return; }
      // ディスカバリにも認証を要求する。メタデータは auth アダプタ経由で提供する。
      const principal = await auth.authenticate(req);
      if (!principal || typeof principal.owner !== 'string' || !principal.owner || principal.owner.length > 512) {
        res.writeHead(401, {'www-authenticate':typeof auth.challengeForRequest==='function'?auth.challengeForRequest(req):auth.challenge, 'cache-control':'no-store'}); res.end(); return;
      }
      if (req.method !== 'POST') { res.writeHead(405, {allow:'POST'}); res.end(); return; }
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) { json(res, 415, {error:'JSON required'}); return; }
      if (Number(req.headers['content-length']) > MAX_BODY) { json(res, 413, {error:'Too large'}); return; }
      const chunks = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY) { json(res, 413, {error:'Too large'}); return; }
        chunks.push(chunk);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { json(res, 400, {error:'Invalid JSON'}); return; }
      if(ingest){
        try{const result=await ingestEvent(principal,body);json(res,200,result);}catch(error){const status=error.code==='EVENT_SCOPE'?403:error.code==='EVENT_INPUT'?400:error.code==='EVENT_EXPIRED'?409:503;json(res,status,{error:status===503?'Ingest paused; retry durable event':'Ingest refused'});}return;
      }
      if(receiver){try{json(res,200,await receiverRequest(principal,req.url.split('/').at(-1),body));}catch(error){json(res,error.code==='EVENT_SCOPE'?403:error.code==='EVENT_INPUT'?400:503,{error:'Receiver request paused'});}return;}
      if (!body || Array.isArray(body) || body.jsonrpc !== '2.0' || typeof body.method !== 'string' ||
          (body.id !== undefined && body.id !== null && typeof body.id !== 'string' && typeof body.id !== 'number') ||
          (body.params !== undefined && (!body.params || typeof body.params !== 'object' || Array.isArray(body.params)))) {
        json(res, 400, {error:'Invalid request'}); return;
      }
      if (body.id === undefined) {
        if (body.method === 'notifications/initialized') { res.writeHead(202); res.end(); }
        else json(res, 400, {error:'Request ID required'});
        return;
      }
      try {
        const result = await handle(body.method, body.params, principal.owner, principal);
        json(res, 200, {jsonrpc:'2.0', id:body.id, result});
      } catch (err) {
        const code = [-32001,-32015,-32601,-32602].includes(err.code) ? err.code : -32603;
        json(res, 200, {jsonrpc:'2.0', id:body.id, error:{code,message:code===-32015?'Callback verification failed':'Request failed',...(code===-32015?{data:{reason:'challenge_failed'}}:{})}});
      }
    } catch { if (!res.headersSent) json(res, 500, {error:'Request failed'}); else res.end(); }
  };
}
export async function loadProductionAdapters(env = process.env) {
  if (!env.PROBE_ADAPTER_MODULE) throw new Error('Startup refused: configure reviewed OAuth 2.1 and durable storage adapters');
  const module = await import(pathToFileURL(resolve(env.PROBE_ADAPTER_MODULE)).href);
  if (typeof module.createProductionAdapters !== 'function') throw new Error('Invalid adapter module');
  const adapters = await module.createProductionAdapters(env);
  assertAuth(adapters.auth); assertStore(adapters.store, true);
  if (adapters.auth.productionReady !== true) throw new Error('Production OAuth adapter required');
  return adapters;
}
export async function start(env = process.env) {
  const adapters = await loadProductionAdapters(env);
  const port = Number(env.PORT ?? 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  const server = createServer({maxHeaderSize:16384}, createRequestListener(adapters));
  server.requestTimeout = 15000; server.headersTimeout = 10000; server.timeout = 15000; server.keepAliveTimeout = 1000;
  server.listen(port, '0.0.0.0');
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  start().catch(() => { console.error('Startup refused: reviewed OAuth and durable storage configuration required'); process.exitCode = 1; });
}
