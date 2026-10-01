import test from 'node:test';
import assert from 'node:assert/strict';
import {Webhook} from 'standardwebhooks';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {createEventStore} from '../lib/events/store.mjs';
import {createEventService,createCombinedHandler} from '../lib/events/service.mjs';
import {eventDiagnostic} from '../lib/events/diagnostics.mjs';
import {createDiscordAdapter,GUILD_ID} from '../lib/adapters/discord.mjs';
import {createHandler} from '../lib/probe.mjs';
import {memoryStore} from '../lib/store.mjs';
import {createDiscordCallbackTransport} from '../lib/events/callback-transport.mjs';

const resource='https://fixture.example/mcp/discord';
const caller={owner:'PRIVATE-OWNER',clientId:'PRIVATE-CLIENT',grantId:'PRIVATE-GRANT',resource,scopes:['discord:read','discord:reply'],grantExpiresAt:Date.now()+3600000};
const secret='whsec_'+Buffer.alloc(32,7).toString('base64'),url='https://private-callback.example/PRIVATE-PATH';
const args=()=>({name:'discord.mention.created',arguments:{guild_id:GUILD_ID},delivery:{mode:'webhook',url,secret},cursor:null,ttlMs:null});
function fixture({transport,failCommit=false,sink}={}){
  const data=new Map(),logs=[],calls=[];let fail=failCommit;
  const backend={durable:true,read:async k=>structuredClone(data.get(k)??null),update:async(k,fn)=>{const n=fn(structuredClone(data.get(k)??null));if(Object.hasOwn(n,'value'))data.set(k,structuredClone(n.value));if(fail){fail=false;throw Object.assign(Error(url+' '+secret),{code:'STORAGE_UNAVAILABLE'});}return n.result;}};
  const callback=transport??(async(_url,request)=>{const body=new Webhook(secret).verify(request.body,request.headers);calls.push({body,id:request.headers['X-MCP-Subscription-Id']});return {ok:true,status:200,json:async()=>({challenge:body.challenge})};});
  const store=createEventStore({backend}),diagnosticSink=sink??(text=>logs.push(JSON.parse(text)));
  const svc=createEventService({store,adapters:[createDiscordAdapter({channelIds:['100000000000000600']})],transport:callback,diagnosticSink});
  const handler=createCombinedHandler(createHandler(memoryStore(),callback),svc,{consumerResource:resource,diagnosticSink});
  return {store,logs,calls,svc,handler,callback};
}
function redacted(logs){
  const serialized=JSON.stringify(logs);
  for(const value of [secret,url,'PRIVATE-PATH',caller.owner,caller.clientId,caller.grantId,GUILD_ID,'PRIVATE-ERROR','PRIVATE-CHALLENGE'])assert.equal(serialized.includes(value),false);
  for(const row of logs)assert.ok(Object.keys(row).every(k=>['kind','method','phase','status','errorCode','rpcCode','reason'].includes(k)));
}
test('署名付き合成/コンシューマのサブスクリプションチャレンジは同一コールバック契約を使い、厳密なコンシューマresourceを保持する',async()=>{
  const f=fixture();
  const probe=createHandler(memoryStore(),f.callback);
  await probe('events/subscribe',{name:'probe.created',arguments:{probe_id:'00000000-0000-4000-8000-000000000000'},delivery:{mode:'webhook',url,secret}},caller.owner);
  const first=await f.handler('events/subscribe',args(),caller.owner,caller);
  const refreshed=await f.handler('events/subscribe',args(),caller.owner,caller);assert.equal(refreshed.id,first.id);
  assert.equal(f.calls.length,3);for(const c of f.calls){assert.deepEqual(Object.keys(c.body).sort(),['challenge','type']);assert.equal(c.body.type,'verification');assert.ok(c.id.startsWith('sub_'));}
  assert.equal(f.calls[1].id,first.id);assert.equal(f.calls[2].id,first.id);
  assert.equal((await f.store.sourceStatus(caller.owner,{source:'discord',name:'discord.mention.created',tenantId:GUILD_ID,clientId:caller.clientId,grantId:caller.grantId,resource})).subscriptions.currentConnectionActive,1);
  const phases=f.logs.filter(x=>x.kind==='discord_subscription_diagnostic').map(x=>x.phase);
  assert.ok(phases.includes('callback_verify_complete'));assert.ok(phases.includes('persistence_complete'));
  assert.equal(f.logs.filter(x=>x.phase==='request_completed').length,2);redacted(f.logs);
});
test('コンシューマ失敗診断はプライベートデータなしに検証・コールバック・曖昧な永続化を識別する',async()=>{
  const cases=[
    {phase:'validate_scope',caller:{...caller,scopes:['discord:reply']},rpcCode:-32603},
    {phase:'validate_arguments',args:{...args(),arguments:{guild_id:'wrong'}},rpcCode:-32602},
    {phase:'validate_secret',args:{...args(),delivery:{...args().delivery,secret:'PRIVATE-ERROR'}},rpcCode:-32603},
    {phase:'validate_ttl',args:{...args(),ttlMs:-1},rpcCode:-32603},
    {phase:'validate_grant_lifetime',caller:{...caller,grantExpiresAt:Date.now()-1},rpcCode:-32603},
    {phase:'callback_response',transport:async()=>({ok:false,status:502}),rpcCode:-32015},
    {phase:'callback_challenge_compare',transport:async()=>({ok:true,status:200,json:async()=>({challenge:'PRIVATE-CHALLENGE'})}),rpcCode:-32015},
    {phase:'callback_challenge_compare',transport:async()=>({ok:true,status:200,json:async()=>{throw Error('PRIVATE-ERROR '+url);}}),rpcCode:-32015},
    {phase:'callback_verify_start',transport:async()=>{throw Object.assign(Error(url+' '+secret),{code:'PRIVATE-ERROR'});},rpcCode:-32015},
    {phase:'persistence_start',failCommit:true,rpcCode:-32603},
  ];
  for(const c of cases){
    const f=fixture(c);await assert.rejects(f.handler('events/subscribe',c.args??args(),caller.owner,c.caller??caller));
    const failed=f.logs.filter(x=>x.kind==='discord_subscription_diagnostic'&&x.rpcCode!==undefined).at(-1);
    assert.equal(failed.phase,c.phase);assert.equal(failed.rpcCode,c.rpcCode);assert.equal(f.logs.at(-1).phase,'request_failed');redacted(f.logs);
    if(c.failCommit){await f.handler('events/subscribe',args(),caller.owner,caller);assert.equal((await f.store.sourceStatus(caller.owner,{source:'discord',name:'discord.mention.created',tenantId:GUILD_ID,clientId:caller.clientId,grantId:caller.grantId,resource})).subscriptions.total,1);}
    else assert.equal((await f.store.sourceStatus(caller.owner,{source:'discord',name:'discord.mention.created',tenantId:GUILD_ID,clientId:caller.clientId,grantId:caller.grantId,resource})).subscriptions.total,0);
  }
});
test('診断は任意フィールドと例外テキストを捨てる。シンク失敗で有効なサブスクリプションは失敗しない',async()=>{
  const rows=[];eventDiagnostic('subscription','PRIVATE-ERROR','PRIVATE-ERROR',{url,secret,body:'PRIVATE-CHALLENGE',error:{code:'PRIVATE-ERROR',message:url},status:999},text=>rows.push(JSON.parse(text)));
  assert.deepEqual(rows,[{kind:'discord_subscription_diagnostic',method:'unknown',phase:'unknown',rpcCode:-32603}]);redacted(rows);
  const f=fixture({sink:()=>{throw Error('PRIVATE-ERROR');}});await f.handler('events/subscribe',args(),caller.owner,caller);assert.equal(f.calls.length,1);
});

test('標準MCPリクエストメタデータはDiscordフィルタを弱めず・露出せずに無視される',async()=>{
  const f=fixture();const metadata={progressToken:'PRIVATE-ERROR',nested:{token:secret,context:'PRIVATE-CHALLENGE'}};
  const subscribed=await f.handler('events/subscribe',{...args(),_meta:metadata},caller.owner,caller);assert.ok(subscribed.id);
  await f.handler('events/unsubscribe',{name:args().name,arguments:args().arguments,delivery:{mode:'webhook',url},_meta:metadata},caller.owner,caller);
  const counts=await f.store.sourceStatus(caller.owner,{source:'discord',name:args().name,tenantId:GUILD_ID,clientId:caller.clientId,grantId:caller.grantId,resource});assert.equal(counts.subscriptions.total,0);redacted(f.logs);
  for(const [input,reason]of [[{...args(),unexpected:'PRIVATE-ERROR'},'unexpected_request_fields'],[{...args(),_meta:'PRIVATE-ERROR'},'invalid_metadata_shape'],[{...args(),arguments:{guild_id:GUILD_ID,channel_id:'PRIVATE-ERROR'}},'invalid_argument_shape'],[{...args(),cursor:'PRIVATE-ERROR'},'unsupported_cursor'],[{...args(),arguments:{guild_id:'wrong'}},'guild_mismatch']]){
    await assert.rejects(f.handler('events/subscribe',input,caller.owner,caller));assert.ok(f.logs.some(x=>x.reason===reason));
  }
  assert.equal(f.calls.length,1);redacted(f.logs);
});

test('コールバック診断ラッパーは固定HTTPSオプションを維持し、本文・アドレス・宛先をログに出さない',async()=>{
  const logs=[];let destination;
  const transport=createDiscordCallbackTransport({resolve:async()=>['8.8.8.8'],diagnosticSink:text=>logs.push(JSON.parse(text)),send:(options,listener)=>{
    destination=options;const req=new EventEmitter();req.destroy=()=>{};
    req.end=()=>queueMicrotask(()=>{const socket=new EventEmitter();req.emit('socket',socket);socket.emit('secureConnect');const response=Readable.from([Buffer.from('{"challenge":"PRIVATE-CHALLENGE"}')]);response.statusCode=200;response.headers={};response.complete=true;listener(response);});return req;
  }});
  const reply=await transport(url,{method:'POST',headers:{},body:'{"type":"verification","challenge":"PRIVATE-CHALLENGE"}'});assert.equal(reply.status,200);
  assert.equal(destination.servername,'private-callback.example');assert.equal(destination.rejectUnauthorized,true);assert.equal(destination.agent,false);
  let pinned;destination.lookup('ignored',{},(_error,address,family)=>{pinned={address,family};});assert.deepEqual(pinned,{address:'8.8.8.8',family:4});
  assert.ok(logs.some(x=>x.phase==='callback_tls_connected'));redacted(logs);assert.equal(JSON.stringify(logs).includes('8.8.8.8'),false);
});
test('DNS/接続失敗コードは上限付きで、公開アドレス拒否は接続を阻止する',async()=>{
  for(const code of ['ENOTFOUND','ECONNREFUSED']){
    const logs=[];const error=Object.assign(Error(url+' '+secret),{code});
    const transport=createDiscordCallbackTransport({diagnosticSink:text=>logs.push(JSON.parse(text)),resolve:async()=>{if(code==='ENOTFOUND')throw error;return ['8.8.8.8'];},send:()=>{const req=new EventEmitter();req.destroy=()=>{};req.end=()=>req.emit('error',error);return req;}});
    await assert.rejects(transport(url,{method:'POST',headers:{},body:'{}'}));assert.ok(logs.some(x=>x.errorCode===code));redacted(logs);
  }
  let connections=0;const logs=[];
  const blocked=createDiscordCallbackTransport({resolve:async()=>['127.0.0.1'],send:()=>{connections++;throw Error('never');},diagnosticSink:text=>logs.push(JSON.parse(text))});
  await assert.rejects(blocked(url,{method:'POST',headers:{},body:'{}'}));assert.equal(connections,0);redacted(logs);assert.equal(JSON.stringify(logs).includes('127.0.0.1'),false);
});
