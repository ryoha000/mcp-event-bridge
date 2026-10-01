import test from 'node:test';import assert from 'node:assert/strict';import {Readable} from 'node:stream';
import {createRequestListener,loadProductionAdapters} from '../server.mjs';import {memoryStore} from '../lib/store.mjs';
// テスト専用の検証器。意図的にエクスポートせず、起動設定から読み込めない。
const auth={challenge:'Bearer resource_metadata="https://probe.example/.well-known/oauth-protected-resource"',handleHttp:async()=>false,authenticate:async req=>req.headers.authorization==='Bearer dummy-fixture'?{owner:'test-issuer|test-owner'}:null};
async function run(body,headers={},url='/mcp',method='POST'){
 const req=Readable.from([Buffer.from(typeof body==='string'?body:JSON.stringify(body))]);Object.assign(req,{url,method,headers:{'content-type':'application/json',...headers}});
 const res={headersSent:false,writeHead(status,headers){this.status=status;this.headers=headers;this.headersSent=true;},end(body){this.body=body;}};
 await createRequestListener({auth,store:memoryStore(),transport:()=>{throw Error('No networking in tests');}})(req,res);return res;
}
const rpc={jsonrpc:'2.0',id:1,method:'server/discover'};
test('設定済みOAuthと永続ストレージがなければ起動はフェイルクローズ',async()=>assert.rejects(loadProductionAdapters({}),/Startup refused/));
test('呼び出し側が供給するIDヘッダでOAuthを回避できない',async()=>{const r=await run(rpc,{'oai-authenticated-user-id':'forged'});assert.equal(r.status,401);assert.equal(r.headers['www-authenticate'],auth.challenge);});
test('標準Nodeハンドラ経由の認証済みRPCディスカバリ',async()=>{const r=await run(rpc,{authorization:'Bearer dummy-fixture'});assert.equal(r.status,200);assert.equal(JSON.parse(r.body).result.serverInfo.name,'synthetic-event-probe');});
test('不正なJSON、params、過大ボディを拒否',async()=>{for(const body of ['{',null,[],{...rpc,params:null},{...rpc,params:[]},{...rpc,id:{}}])assert.equal((await run(body,{authorization:'Bearer dummy-fixture'})).status,400);assert.equal((await run('x'.repeat(32769),{authorization:'Bearer dummy-fixture'})).status,413);});
test('通知としてミューテーションを持ち込めない',async()=>{const r=await run({jsonrpc:'2.0',method:'tools/call',params:{name:'emit_probe'}},{authorization:'Bearer dummy-fixture'});assert.equal(r.status,400);});
