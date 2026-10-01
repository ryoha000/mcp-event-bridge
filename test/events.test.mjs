import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {Webhook} from 'standardwebhooks';
import {createSqliteBackend} from '../lib/events/sqlite-backend.mjs';
import {createEventStore} from '../lib/events/store.mjs';
import {validateEnvelope,digest,eventIdFor} from '../lib/events/envelope.mjs';
import {createEventService,createCombinedHandler} from '../lib/events/service.mjs';
import {deliverNext} from '../lib/events/delivery.mjs';
import {createDiscordAdapter,GUILD_ID,BOT_ID,DISCORD_EVENT} from '../lib/adapters/discord.mjs';
import {createHandler} from '../lib/probe.mjs';
import {memoryStore} from '../lib/store.mjs';

const OWNER='google:123456789';
const principal={owner:OWNER,clientId:'fake-client',grantId:'fake-grant',scopes:['probe','discord:read','discord:reply']};
const SECRET='whsec_'+Buffer.alloc(32,3).toString('base64');
export const packet=(patch={})=>({op:0,t:'MESSAGE_CREATE',s:4,d:{id:'100000000000000200',channel_id:'100000000000002200',guild_id:GUILD_ID,author:{id:'100000000000002300',bot:false},type:0,mentions:[{id:BOT_ID}],content:'<@'+BOT_ID+'> hello',timestamp:'2026-10-01T00:00:00.000Z',...patch}});
async function fixture(t,options={}) {
  const dir=await mkdtemp(join(tmpdir(),'codex-discord-test-'));const dbPath=join(dir,'events.sqlite');
  const backend=createSqliteBackend(dbPath);let at=Date.now();
  const store=createEventStore({backend,now:()=>at,...options});
  const sends=[],callbacks=[];
  const adapter=createDiscordAdapter({channelIds:['100000000000002200'],sendMessage:async(channel,body)=>{sends.push({channel,body});return {ok:true,messageId:'100000000000002400'};}});
  const transport=async(url,request)=>{callbacks.push({url,request});return {ok:true,status:200,json:async()=>({challenge:JSON.parse(request.body).challenge})};};
  const service=createEventService({store,adapters:[adapter],transport});
  t.after(async()=>{backend.close();assert.ok(resolve(dir).startsWith(resolve(tmpdir())+'\\codex-discord-test-')||resolve(dir).startsWith(resolve(tmpdir())+'/codex-discord-test-'));await rm(dir,{recursive:true,force:true});});
  return {backend,store,service,adapter,sends,callbacks,transport,dbPath,advance:ms=>{at+=ms;}};
}
const subArgs=()=>({name:DISCORD_EVENT,arguments:{guild_id:GUILD_ID},delivery:{mode:'webhook',url:'https://callback.example/wake',secret:SECRET}});
async function subscribe(f,p=principal) { return f.service.handle('events/subscribe',subArgs(),p); }

test('Discordのリリースメタデータは厳密なコンシューマresourceに限定され、プローブのディスカバリを維持する',async t=>{
  const f=await fixture(t),resource='https://probe.example/mcp/discord';
  const probe=createHandler(memoryStore(),f.transport),handle=createCombinedHandler(probe,f.service,{consumerResource:resource});
  const consumer={...principal,resource,scopes:['discord:read','discord:reply']};
  for(const method of ['initialize','server/discover']){
    const input={protocolVersion:'2026-07-28'},old=await probe(method,input);
    const current=await handle(method,input,OWNER,consumer);
    assert.deepEqual(current,{...old,serverInfo:{...old.serverInfo,version:'0.1.4'}});
    assert.deepEqual(await handle(method,input,OWNER,{...principal,resource:'https://probe.example/mcp'}),old);
    assert.deepEqual(await handle(method,input,OWNER,{...consumer,resource:'https://other.example/mcp/discord'}),old);
  }
  assert.deepEqual((await handle('tools/list',{},OWNER,consumer)).tools.map(x=>x.name),['discord_status','discord_read_event','discord_reply_to_event']);
  assert.deepEqual((await handle('events/list',{},OWNER,consumer)).events.map(x=>x.name),['discord.mention.created']);
  assert.deepEqual(await handle('ping',{},OWNER,consumer),{});assert.equal(f.sends.length,0);assert.equal(f.callbacks.length,0);
});

test('Discord正規化は対象ギルド内の人間の直接メンションのみ受理する',()=>{
  const a=createDiscordAdapter({channelIds:['100000000000002200']});assert.ok(a.normalize(packet()));
  for(const patch of [{guild_id:undefined},{guild_id:'100000000000002500'},{mentions:[]},{author:{id:BOT_ID}},{author:{id:'100000000000002300',bot:true}},{webhook_id:'100000000000000200'},{type:7},{channel_id:'../evil'},{timestamp:'invalid'},{content:'x'.repeat(4001)}])assert.equal(a.normalize(packet(patch)),null);
  assert.equal(a.normalize({...packet(),t:'MESSAGE_UPDATE'}),null);
  assert.equal(a.normalize({...packet(),op:1}),null);
});
test('エンベロープはdataをホワイトリスト化し、Discordの添付・埋め込み・無関係なコンテキストを捨てる',()=>{
  const a=createDiscordAdapter({channelIds:['100000000000002200']});const e=a.normalize(packet({attachments:[{url:'https://private.example'}],embeds:[{description:'private'}],dot_chat:'private',mail:'private',camera:'private'}));
  assert.deepEqual(e.data,{content:packet().d.content});assert.equal(JSON.stringify(e).includes('private'),false);
  assert.throws(()=>a.validate({...e,data:{...e.data,mail:'private'}}));
  assert.throws(()=>validateEnvelope({...e,secret:'private'}));
  assert.throws(()=>validateEnvelope({...e,eventId:'evt_'+ '0'.repeat(64)}));
});
test('安定IDはリプレイ時のGatewayシーケンスとタイムスタンプの差異を無視する',()=>{
  const a=createDiscordAdapter({channelIds:['100000000000002200']});assert.equal(a.normalize(packet()).eventId,a.normalize({...packet({timestamp:'2026-10-01T00:01:00Z'}),s:99}).eventId);
});
test('アトミックな取り込みは1回だけファンアウトし、ストア再構築や重複リプレイを越えて残る',async t=>{
  const f=await fixture(t);await subscribe(f);
  const outcomes=await Promise.all([f.service.ingest(OWNER,'discord',packet()),f.service.ingest(OWNER,'discord',packet())]);
  assert.deepEqual(outcomes.map(x=>x.duplicate).sort(),[false,true]);
  const restarted=createEventStore({backend:f.backend});assert.equal((await restarted.status(OWNER)).deliveries.length,1);
  assert.equal((await restarted.ingest(OWNER,f.adapter.normalize(packet()))).duplicate,true);
});
test('SQLiteはDBのclose/reopenを越えて残り、独立接続を調整する',async t=>{
  const f=await fixture(t);await subscribe(f);await f.service.ingest(OWNER,'discord',packet());
  const other=createSqliteBackend(f.dbPath);const s=createEventStore({backend:other});
  const claims=await Promise.all([f.store.claimDelivery(OWNER),s.claimDelivery(OWNER)]);assert.equal(claims.filter(Boolean).length,1);
  other.close();const reopened=createSqliteBackend(f.dbPath);assert.equal((await createEventStore({backend:reopened}).status(OWNER)).events,1);reopened.close();
});
test('配送リースの期限切れで保留作業を回復。遅れたワーカーは新しい受領を上書きできない',async t=>{
  const f=await fixture(t);await subscribe(f);await f.service.ingest(OWNER,'discord',packet());
  const first=await f.store.claimDelivery(OWNER);assert.equal(await f.store.claimDelivery(OWNER),null);
  f.advance(30001);const second=await f.store.claimDelivery(OWNER);assert.notEqual(first.lease,second.lease);
  assert.equal(await f.store.settleDelivery(OWNER,first,200),false);
  assert.equal(await f.store.settleDelivery(OWNER,second,204),true);
  assert.equal((await f.store.status(OWNER)).deliveries[0].status,'acknowledged');
});
test('署名付きコールバックのリトライはwebhook/event IDを安定に保ち、参照のみを運ぶ',async t=>{
  const f=await fixture(t);await subscribe(f);await f.service.ingest(OWNER,'discord',packet());
  const ids=[];
  const transport=async(url,r)=>{const b=JSON.parse(r.body);ids.push(r.headers['webhook-id']);assert.equal(b.eventId,r.headers['webhook-id']);new Webhook(SECRET).verify(r.body,r.headers);assert.deepEqual(Object.keys(b.data).sort(),['event_id','guild_id','source']);assert.equal(r.body.includes('hello'),false);return {status:ids.length===1?503:204};};
  assert.equal((await deliverNext({store:f.store,owner:OWNER,authorizeSubscription:async()=>true,transport})).acknowledged,false);
  assert.equal((await deliverNext({store:f.store,owner:OWNER,authorizeSubscription:async()=>true,transport})).attempted,false);
  f.advance(3000);assert.equal((await deliverNext({store:f.store,owner:OWNER,authorizeSubscription:async()=>true,transport})).acknowledged,true);assert.equal(ids[0],ids[1]);
});
test('曖昧なコールバックエラーはバックオフでリトライし、機微なトランスポートエラーは永続化しない',async t=>{
  const f=await fixture(t);await subscribe(f);await f.service.ingest(OWNER,'discord',packet());
  await deliverNext({store:f.store,owner:OWNER,authorizeSubscription:async()=>true,transport:async()=>{throw Error('private secret '+SECRET);}});
  const status=await f.store.status(OWNER);assert.equal(status.deliveries[0].status,'pending');assert.equal(JSON.stringify(status).includes(SECRET),false);assert.equal(JSON.stringify(status).includes('private'),false);
});
test('恒久的なコールバック拒否はリトライを止める。不確実な8回の試行で回復を打ち切る',async t=>{
  const f=await fixture(t);await subscribe(f);await f.service.ingest(OWNER,'discord',packet());
  let c=await f.store.claimDelivery(OWNER);await f.store.settleDelivery(OWNER,c,403);f.advance(40000);assert.equal(await f.store.claimDelivery(OWNER),null);
  await f.service.ingest(OWNER,'discord',packet({id:'100000000000000300'}));
  for(let i=0;i<8;i++){c=await f.store.claimDelivery(OWNER);assert.ok(c);f.advance(30001);}
  assert.equal(await f.store.claimDelivery(OWNER),null);assert.equal((await f.store.status(OWNER)).deliveries[1].status,'dead');
});
test('購読解除はリースを無効化しコールバックシークレットを消す。再購読は旧イベントを再生しない',async t=>{
  const f=await fixture(t);const sub=await subscribe(f);await f.service.ingest(OWNER,'discord',packet());const c=await f.store.claimDelivery(OWNER);
  await f.store.unsubscribe(OWNER,sub.id,principal.clientId);assert.equal(await f.store.settleDelivery(OWNER,c,200),false);
  await subscribe(f);assert.equal(await f.store.claimDelivery(OWNER),null);
  const raw=await f.backend.read(JSON.stringify(['source-events-owner:v1',OWNER]));assert.equal(raw.subscriptions.length,1);assert.notEqual(raw.subscriptions[0].revision,c.revision);
});
test('オーナー・OAuth read/replyスコープ・イベントIDがツールを制約する',async t=>{
  const f=await fixture(t);const e=f.adapter.normalize(packet());await f.store.ingest(OWNER,e);
  await assert.rejects(f.service.handle('tools/call',{name:'discord_read_event',arguments:{event_id:e.eventId}},{...principal,scopes:['probe']}));
  await assert.rejects(f.service.handle('tools/call',{name:'discord_read_event',arguments:{event_id:e.eventId}},{...principal,owner:'google:999'}));
  await assert.rejects(f.service.handle('tools/call',{name:'discord_reply_to_event',arguments:{event_id:e.eventId,content:'hello'}},{...principal,scopes:['discord:read']}));
  const read=await f.service.handle('tools/call',{name:'discord_read_event',arguments:{event_id:e.eventId}},principal);assert.deepEqual(JSON.parse(read.content[0].text),e);
  await assert.rejects(f.service.handle('tools/call',{name:'discord_read_event',arguments:{event_id:e.eventId,mail:true}},principal));
});
test('通常返信は元メンションのチャンネルに束縛され、外向きのメンションを全て抑制する',async t=>{
  const f=await fixture(t);const e=f.adapter.normalize(packet());await f.store.ingest(OWNER,e);
  const args={event_id:e.eventId,content:'hello @everyone'};
  await assert.rejects(f.service.handle('tools/call',{name:'discord_reply_to_event',arguments:{...args,channel_id:'100000000000002500'}},principal));
  await assert.rejects(f.service.handle('tools/call',{name:'discord_reply_to_event',arguments:{...args,camera:'private'}},principal));
  await f.service.handle('tools/call',{name:'discord_reply_to_event',arguments:args},principal);
  assert.equal(f.sends[0].channel,e.origin.channelId);assert.equal(f.sends[0].body.message_reference.message_id,e.origin.messageId);
  assert.deepEqual(f.sends[0].body.allowed_mentions,{parse:[],replied_user:false});assert.equal(f.sends[0].body.enforce_nonce,true);assert.equal(f.sends[0].body.nonce.length,25);
});
test('並行・再起動後の返信呼び出しは1回だけ送信。矛盾する返信本文はフェイルクローズ',async t=>{
  const f=await fixture(t);const e=f.adapter.normalize(packet());await f.store.ingest(OWNER,e);
  const call=()=>f.service.handle('tools/call',{name:'discord_reply_to_event',arguments:{event_id:e.eventId,content:'ordinary reply'}},principal);
  await Promise.all([call(),call()]);await call();assert.equal(f.sends.length,1);
  await assert.rejects(f.service.handle('tools/call',{name:'discord_reply_to_event',arguments:{event_id:e.eventId,content:'different reply'}},principal));
});
test('曖昧なDiscord送信やプロセスクラッシュのクレームで、盲目的な自動再送はしない',async t=>{
  const f=await fixture(t);const e=f.adapter.normalize(packet());await f.store.ingest(OWNER,e);let attempts=0;
  const a=createDiscordAdapter({channelIds:['100000000000002200'],sendMessage:async()=>{attempts++;throw Error('private token');}});
  const service=createEventService({store:f.store,adapters:[a],transport:f.transport});const p={name:'discord_reply_to_event',arguments:{event_id:e.eventId,content:'safe reply'}};
  const r=await service.handle('tools/call',p,principal);assert.equal(JSON.parse(r.content[0].text).status,'unknown');await service.handle('tools/call',p,principal);assert.equal(attempts,1);
  const second=f.adapter.normalize(packet({id:'100000000000000300'}));await f.store.ingest(OWNER,second);await f.store.claimReply(OWNER,second.eventId,digest('reply'));
  const restarted=createEventStore({backend:f.backend});assert.equal((await restarted.claimReply(OWNER,second.eventId,digest('reply'))).claimed,false);
});
test('曖昧な永続返信クレームのコミットは何も送らず、冪等キーを消費する',async t=>{
  const f=await fixture(t);const e=f.adapter.normalize(packet());await f.store.ingest(OWNER,e);let fail=true;
  const backend={durable:true,read:f.backend.read,update:async(k,fn)=>{const r=await f.backend.update(k,fn);if(fail){fail=false;throw Error('ambiguous write');}return r;}};
  const service=createEventService({store:createEventStore({backend}),adapters:[f.adapter],transport:f.transport});const p={name:'discord_reply_to_event',arguments:{event_id:e.eventId,content:'reply'}};
  await assert.rejects(service.handle('tools/call',p,principal));await service.handle('tools/call',p,principal);assert.equal(f.sends.length,0);
});
test('サブスクリプションはチャレンジを検証。誤ったチャレンジ・ギルド/クライアント・期限切れは安全に失敗',async t=>{
  const f=await fixture(t);
  const bad=createEventService({store:f.store,adapters:[f.adapter],transport:async()=>({ok:true,json:async()=>({challenge:'wrong'})})});
  await assert.rejects(bad.handle('events/subscribe',subArgs(),principal));assert.equal((await f.store.status(OWNER)).deliveries.length,0);
  await assert.rejects(f.service.handle('events/subscribe',{...subArgs(),arguments:{guild_id:'100000000000002500'}},principal));
  const sub=await subscribe(f);assert.equal(await f.store.unsubscribe(OWNER,sub.id,'other-client'),false);
  f.advance(3660000);await f.service.ingest(OWNER,'discord',packet());assert.equal(await f.store.claimDelivery(OWNER),null);
});
test('容量超過と破損した永続状態は、リプレイ保護を削除せずフェイルクローズする',async t=>{
  const f=await fixture(t,{maxEvents:1});const e=f.adapter.normalize(packet());await f.store.ingest(OWNER,e);
  await assert.rejects(f.store.ingest(OWNER,f.adapter.normalize(packet({id:'100000000000000300'}))));assert.equal((await f.store.status(OWNER)).events,1);
  await f.backend.update(JSON.stringify(['source-events-owner:v1',OWNER]),s=>{s.replies.push({eventId:e.eventId,contentHash:'evil',status:'sent',at:1});return {value:s};});
  await assert.rejects(f.store.status(OWNER));
});
test('統合MCPは合成ツールを維持し、Discordスコープを分離する',async t=>{
  const f=await fixture(t);const probeStore=memoryStore();const handle=createCombinedHandler(createHandler(probeStore,f.transport),f.service);
  assert.deepEqual((await handle('tools/list',{},OWNER,{...principal,scopes:['probe']})).tools.map(x=>x.name),['probe_status','emit_probe']);
  assert.deepEqual((await handle('events/list',{},OWNER,{...principal,scopes:['probe']})).events.map(x=>x.name),['probe.created']);
  assert.deepEqual((await handle('tools/list',{},OWNER,{...principal,scopes:['discord:read']})).tools.map(x=>x.name),['discord_status','discord_read_event']);
  await assert.rejects(handle('tools/call',{name:'probe_status'},OWNER,{...principal,scopes:['discord:read']}));
  const defs=(await handle('events/list',{},OWNER,principal)).events;assert.equal(defs.length,2);assert.ok(defs[1].description.includes('camera'));
});

test('Discord statusはイベントなしで成功し、スコープ付き件数とプリンシパルメタデータのみ公開し、I/O書き込みを行わない',async t=>{
  const f=await fixture(t);let writes=0;const update=f.backend.update;f.backend.update=async(...args)=>{writes++;return update(...args);};
  const expiry=Date.now()+3600000,p={...principal,scopes:['discord:read','discord:reply'],resource:'https://bridge.example/mcp/discord',grantExpiresAt:expiry};
  const call=()=>f.service.handle('tools/call',{name:'discord_status',arguments:{}},p);
  const empty=JSON.parse((await call()).content[0].text);assert.equal(empty.counts.events,0);assert.equal(empty.counts.subscriptions.currentConnectionActive,0);assert.equal(writes,0);assert.equal(f.callbacks.length,0);assert.equal(f.sends.length,0);
  assert.equal(JSON.parse((await f.service.handle('tools/call',{name:'discord_status'},p)).content[0].text).counts.events,0);assert.equal(writes,0);
  await subscribe(f,p);await f.service.ingest(OWNER,'discord',packet({content:'PRIVATE-SOURCE-FIXTURE'}));
  const another={...f.adapter.normalize(packet()),source:'example',name:'example.mention.created',data:{content:'ANOTHER-SOURCE-FIXTURE'}};
  another.origin.tenantId='other-tenant';another.eventId=eventIdFor(another.source,another.origin.tenantId,another.origin.messageId,another.name);await f.store.ingest(OWNER,another);
  const before=writes,callbacks=f.callbacks.length,r=JSON.parse((await call()).content[0].text);
  assert.deepEqual(r.authentication.resourceScopes,['discord:read','discord:reply']);assert.equal(r.authentication.resource,p.resource);assert.equal(r.authentication.grantExpiresUtc,new Date(expiry).toISOString());
  assert.equal(r.authentication.consumerScopesOnly,true);assert.equal(r.authentication.replyScopeGranted,true);
  assert.equal(r.counts.events,1);assert.equal(r.counts.subscriptions.currentConnectionActive,1);assert.equal(r.counts.deliveries.pending,1);assert.equal(writes,before);assert.equal(f.callbacks.length,callbacks);assert.equal(f.sends.length,0);
  const text=JSON.stringify(r);for(const value of ['PRIVATE-SOURCE-FIXTURE','ANOTHER-SOURCE-FIXTURE','other-tenant',SECRET,'callback.example',p.owner,p.clientId,p.grantId,packet().d.id])assert.equal(text.includes(value),false);
});

test('Discord statusは状態読み取り前に、不正スコープ・任意パラメータ・期限切れ許可を拒否する',async()=>{
  let reads=0;const store={sourceStatus:async()=>{reads++;return {};}};
  const a=createDiscordAdapter({channelIds:['100000000000002200']});const svc=createEventService({store,adapters:[a]});
  for(const scopes of [['probe'],['discord:ingest','discord:receive-replies'],['discord:reply']]){
    assert.equal(svc.tools({...principal,scopes}).some(t=>t.name==='discord_status'),false);
    await assert.rejects(svc.handle('tools/call',{name:'discord_status',arguments:{}},{...principal,scopes}));
  }
  await assert.rejects(svc.handle('tools/call',{name:'discord_status',arguments:{owner:'other'}},principal));
  await assert.rejects(svc.handle('tools/call',{name:'discord_status',arguments:{}},{...principal,grantExpiresAt:Date.now()-1}));assert.equal(reads,0);
});
test('第2ソースアダプタはDiscord変更なしに永続アウトボックスとスコープ付きIFを再利用する',async t=>{
  const f=await fixture(t);const discord=f.adapter.normalize(packet());
  const other={source:'example',eventName:'example.mention.created',tenantId:'tenant-example',normalize:()=>null,validate:validateEnvelope,reply:async()=>({ok:true,messageId:'example-reply'})};
  const {eventIdFor}=await import('../lib/events/envelope.mjs');
  const e={...discord,source:'example',name:other.eventName,origin:{...discord.origin,tenantId:other.tenantId},eventId:eventIdFor('example',other.tenantId,discord.origin.messageId,other.eventName)};
  await f.store.ingest(OWNER,e);const svc=createEventService({store:f.store,adapters:[f.adapter,other],transport:f.transport});
  assert.equal(svc.tools({...principal,scopes:['example:read']})[0].name,'example_read_event');
  assert.equal(JSON.parse((await svc.handle('tools/call',{name:'example_read_event',arguments:{event_id:e.eventId}},{...principal,scopes:['example:read']})).content[0].text).source,'example');
  await assert.rejects(f.service.handle('tools/call',{name:'discord_read_event',arguments:{event_id:e.eventId}},principal));
});
test('配送時に失効済み許可を再検査し、永続アウトボックスのクレーム後でも送信しない',async t=>{
  const f=await fixture(t);await subscribe(f);await f.service.ingest(OWNER,'discord',packet());let calls=0;
  const r=await deliverNext({store:f.store,owner:OWNER,transport:async()=>{calls++;},authorizeSubscription:async()=>false});
  assert.equal(r.revoked,true);assert.equal(calls,0);assert.equal((await f.store.status(OWNER)).deliveries[0].status,'revoked');
});
test('MCPサブスクリプションはnull cursor/TTLを許し、二重署名でwebhookシークレットをローテートする',async t=>{
  const f=await fixture(t);const args={...subArgs(),cursor:null,ttlMs:null};const before=await f.service.handle('events/subscribe',args,principal);
  const replacement='whsec_'+Buffer.alloc(32,4).toString('base64');const after=await f.service.handle('events/subscribe',{...args,delivery:{...args.delivery,secret:replacement}},principal);assert.equal(after.id,before.id);
  await f.service.ingest(OWNER,'discord',packet());
  await deliverNext({store:f.store,owner:OWNER,authorizeSubscription:async()=>true,transport:async(url,r)=>{new Webhook(SECRET).verify(r.body,r.headers);new Webhook(replacement).verify(r.body,r.headers);return {status:204};}});
  await assert.rejects(f.service.handle('events/subscribe',{...args,cursor:'unsupported-replay'},principal));
});
