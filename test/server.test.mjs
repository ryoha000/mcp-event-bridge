import test from 'node:test';import assert from 'node:assert/strict';import {Readable} from 'node:stream';
import {createRequestListener,loadProductionAdapters} from '../server.mjs';import {memoryStore} from '../lib/store.mjs';
// Test-only verifier, deliberately unexported and never loadable by startup config.
const auth={challenge:'Bearer resource_metadata="https://probe.example/.well-known/oauth-protected-resource"',handleHttp:async()=>false,authenticate:async req=>req.headers.authorization==='Bearer dummy-fixture'?{owner:'test-issuer|test-owner'}:null};
async function run(body,headers={},url='/mcp',method='POST'){
 const req=Readable.from([Buffer.from(typeof body==='string'?body:JSON.stringify(body))]);Object.assign(req,{url,method,headers:{'content-type':'application/json',...headers}});
 const res={headersSent:false,writeHead(status,headers){this.status=status;this.headers=headers;this.headersSent=true;},end(body){this.body=body;}};
 await createRequestListener({auth,store:memoryStore(),transport:()=>{throw Error('No networking in tests');}})(req,res);return res;
}
const rpc={jsonrpc:'2.0',id:1,method:'server/discover'};
test('startup fails closed without configured OAuth and durable storage',async()=>assert.rejects(loadProductionAdapters({}),/Startup refused/));
test('caller-supplied identity header cannot bypass OAuth',async()=>{const r=await run(rpc,{'oai-authenticated-user-id':'forged'});assert.equal(r.status,401);assert.equal(r.headers['www-authenticate'],auth.challenge);});
test('authenticated RPC discovery through standard Node handler',async()=>{const r=await run(rpc,{authorization:'Bearer dummy-fixture'});assert.equal(r.status,200);assert.equal(JSON.parse(r.body).result.serverInfo.name,'synthetic-event-probe');});
test('bad JSON, params and oversized bodies rejected',async()=>{for(const body of ['{',null,[],{...rpc,params:null},{...rpc,params:[]},{...rpc,id:{}}])assert.equal((await run(body,{authorization:'Bearer dummy-fixture'})).status,400);assert.equal((await run('x'.repeat(32769),{authorization:'Bearer dummy-fixture'})).status,413);});
test('mutations cannot be smuggled as notifications',async()=>{const r=await run({jsonrpc:'2.0',method:'tools/call',params:{name:'emit_probe'}},{authorization:'Bearer dummy-fixture'});assert.equal(r.status,400);});
