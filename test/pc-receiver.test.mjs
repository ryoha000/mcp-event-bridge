import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createSqliteBackend} from '../lib/events/sqlite-backend.mjs';
import {createEventStore} from '../lib/events/store.mjs';
import {createEventService} from '../lib/events/service.mjs';
import {createDiscordAdapter,GUILD_ID,BOT_ID,readDiscordChannels} from '../lib/adapters/discord.mjs';
import {createReceiverReplyExecutor} from '../lib/events/receiver-replies.mjs';
import {createBridgeTransport,createReceiverBridgeClient} from '../lib/events/bridge.mjs';
import {createPcReceiver} from '../pc-receiver.mjs';
import {createRequestListener} from '../server.mjs';
import {memoryStore} from '../lib/store.mjs';
import {createServer} from 'node:http';
import {createReceiverRequest} from '../production.mjs';

const CHANNEL='100000000000002200',OWNER='google:123';
const consumer={owner:OWNER,clientId:'fake-dot-client',grantId:'fake-dot-grant',scopes:['discord:read','discord:reply']};
const receiver={owner:OWNER,clientId:'fake-pc-client',grantId:'fake-pc-grant',scopes:['discord:ingest','discord:receive-replies']};
const packet=()=>({op:0,t:'MESSAGE_CREATE',d:{id:'100000000000000200',channel_id:CHANNEL,guild_id:GUILD_ID,author:{id:'100000000000002300'},type:0,mentions:[{id:BOT_ID}],content:'<@'+BOT_ID+'> ordinary hello',timestamp:'2026-10-01T00:00:00Z'}});
async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'codex-pc-bridge-'));const db=createSqliteBackend(join(dir,'state.sqlite'));
  const store=createEventStore({backend:db});const sends=[];const adapter=createDiscordAdapter({channelIds:[CHANNEL],sendMessage:async(channel,body)=>{sends.push({channel,body});return {ok:true,messageId:'100000000000002400'};}});
  const cloud=createEventService({store,adapters:[createDiscordAdapter({channelIds:[CHANNEL]})],queueReplies:true});
  t.after(async()=>{db.close();assert.ok(resolve(dir).startsWith(resolve(tmpdir())+'\\codex-pc-bridge-')||resolve(dir).startsWith(resolve(tmpdir())+'/codex-pc-bridge-'));await rm(dir,{recursive:true,force:true});});
  return {db,store,adapter,cloud,sends};
}
test('空のallowlistはイベントを受理しない。検証済みチャンネル一覧は必須で厳密に検証される',()=>{
  assert.equal(createDiscordAdapter().normalize(packet()),null);
  assert.equal(createDiscordAdapter({channelIds:['100000000000002500']}).normalize(packet()),null);
  assert.throws(()=>readDiscordChannels({}));assert.throws(()=>readDiscordChannels({DISCORD_CHANNEL_IDS:JSON.stringify([CHANNEL,CHANNEL])}));
  assert.deepEqual(readDiscordChannels({DISCORD_CHANNEL_IDS:JSON.stringify([CHANNEL])}),[CHANNEL]);
});
test('クラウド返信ツールはbotトークンなしでコマンドをキュー化。PCは起点チャンネルへ1回だけ実行する',async t=>{
  const f=await fixture(t);const ingested=await f.cloud.ingestNormalized(receiver,f.adapter.normalize(packet()));
  const p={name:'discord_reply_to_event',arguments:{event_id:ingested.eventId,content:'ordinary response'}};
  const r=await f.cloud.handle('tools/call',p,consumer);assert.equal(JSON.parse(r.content[0].text).status,'queued');assert.equal(f.sends.length,0);
  const a=await f.cloud.receiverRequest(receiver,'claim',{requestId:'stable-local-request'});
  const repeated=await f.cloud.receiverRequest(receiver,'claim',{requestId:'stable-local-request'});assert.deepEqual(a,repeated);
  assert.equal((await f.cloud.receiverRequest(receiver,'claim',{requestId:'other-request'})).command,null);
  const execute=createReceiverReplyExecutor({backend:f.db,adapter:f.adapter});const receipt=await execute(a.command);await execute(a.command);assert.equal(f.sends.length,1);assert.equal(f.sends[0].channel,CHANNEL);
  await f.cloud.receiverRequest(receiver,'receipt',receipt);assert.equal((await f.cloud.receiverRequest(receiver,'claim',{requestId:'stable-local-request'})).complete,true);
  assert.equal((await f.store.status(OWNER)).replies[0].status,'sent');await f.cloud.handle('tools/call',p,consumer);assert.equal(f.sends.length,1);
});
test('コンシューマは取り込みや返信コマンド受信ができず、レシーバーは通常のread/replyツールを使えない',async t=>{
  const f=await fixture(t);const e=f.adapter.normalize(packet());
  await assert.rejects(f.cloud.ingestNormalized(consumer,e));await assert.rejects(f.cloud.receiverRequest(consumer,'claim',{requestId:'x'}));
  await f.cloud.ingestNormalized(receiver,e);await assert.rejects(f.cloud.handle('tools/call',{name:'discord_read_event',arguments:{event_id:e.eventId}},receiver));
  await assert.rejects(f.cloud.receiverRequest({...receiver,scopes:['discord:ingest']},'claim',{requestId:'x'}));
});
test('曖昧なローカル返信クレームと失われたクラウド受領はDiscord POSTを再送しない',async t=>{
  const f=await fixture(t);const e=f.adapter.normalize(packet());const command={event:e,content:'safe reply',requestId:'stable'};let fail=true;
  const wrapped={durable:true,read:f.db.read,update:async(k,fn)=>{const r=await f.db.update(k,fn);if(fail){fail=false;throw Error('ambiguous');}return r;}};
  const exec=createReceiverReplyExecutor({backend:wrapped,adapter:f.adapter});await assert.rejects(exec(command));assert.equal((await exec(command)).status,'unknown');assert.equal(f.sends.length,0);
});
test('ブリッジトランスポートは固定HTTPSエンドポイント・リダイレクトなし・同一イベントの上限付きACKを使う',async()=>{
  const e=createDiscordAdapter({channelIds:[CHANNEL]}).normalize(packet());const calls=[];
  const forward=createBridgeTransport({origin:'https://bridge.example',getAccessToken:async()=>'FAKE-ACCESS',fetchImpl:async(url,o)=>{calls.push({url,o});return new Response(JSON.stringify({eventId:e.eventId,duplicate:false}));}});
  assert.equal((await forward(e)).status,200);assert.equal(calls[0].url,'https://bridge.example/ingest/discord');assert.equal(calls[0].o.redirect,'error');assert.ok(calls[0].o.signal);
  const mismatch=createBridgeTransport({origin:'https://bridge.example',getAccessToken:async()=>'FAKE',fetchImpl:async()=>new Response(JSON.stringify({eventId:'wrong',duplicate:false}))});await assert.rejects(mismatch(e));
  assert.throws(()=>createBridgeTransport({origin:'http://localhost',getAccessToken:async()=>''}));
  const client=createReceiverBridgeClient({origin:'https://bridge.example',getAccessToken:async()=>'FAKE',fetchImpl:async(url,o)=>{assert.equal(url,'https://bridge.example/receiver/discord/claim');return new Response('{"command":null}');}});assert.equal((await client('claim',{requestId:'x'})).command,null);await assert.rejects(client('../evil'));
});
test('ポータブルPCレシーバーはメンションを永続スプールし、botトークンを公開せずクラウドブリッジを使う',async t=>{
  const f=await fixture(t);let gatewayOptions;const forwarded=[],bridgeCalls=[];
  const fakeGateway=options=>{gatewayOptions=options;return {start:async()=>{},stop:()=>{}};};
  const client=await createPcReceiver({backend:f.db,adapter:f.adapter,token:'FAKE-BOT-LOCAL-ONLY',gatewayFactory:fakeGateway,timers:{setTimeout:()=>1,clearTimeout:()=>{}},
    forwardEnvelope:async e=>{forwarded.push(e);return {status:200};},bridgeRequest:async(action,p)=>{bridgeCalls.push({action,p});return {command:null};}});
  await new Promise(r=>setImmediate(r));await gatewayOptions.onDispatch(packet());await new Promise(r=>setImmediate(r));await client.pump();client.stop();
  assert.equal(forwarded.length,1);assert.equal(JSON.stringify(forwarded).includes('FAKE-BOT'),false);assert.equal(JSON.stringify(bridgeCalls).includes('FAKE-BOT'),false);
  assert.equal((await client.store.status('windows-discord-receiver')).events,1);
});
test('HTTPブリッジは認証済みレシーバースコープを要求し、未設定/別チャンネルのイングレスを拒否する',async t=>{
  const f=await fixture(t);let principal=consumer;
  const auth={challenge:'Bearer resource_metadata="https://bridge.example/.well-known/oauth-protected-resource/mcp"',handleHttp:async()=>false,authenticate:async()=>principal};
  const server=createServer(createRequestListener({auth,store:memoryStore(),ingestEvent:f.cloud.ingestNormalized,receiverRequest:f.cloud.receiverRequest}));
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
  const base='http://127.0.0.1:'+server.address().port;const e=f.adapter.normalize(packet());
  const post=(path,p)=>fetch(base+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(p)});
  assert.equal((await post('/ingest/discord',e)).status,403);principal=receiver;const r=await post('/ingest/discord',e);assert.equal(r.status,200);assert.equal((await r.json()).duplicate,false);
  assert.equal((await post('/ingest/discord',{...e,origin:{...e.origin,channelId:'100000000000002500'}})).status,400);
  assert.equal((await post('/receiver/discord/claim',{requestId:'x'})).status,200);principal=null;assert.equal((await post('/receiver/discord/claim',{requestId:'x'})).status,401);
});
test('PCクレーム前に元コンシューマ許可がread/reply権を失えば、キュー済み返信はキャンセルされる',async t=>{
  const f=await fixture(t);const e=f.adapter.normalize(packet());await f.cloud.ingestNormalized(receiver,e);
  await f.cloud.handle('tools/call',{name:'discord_reply_to_event',arguments:{event_id:e.eventId,content:'reply'}},consumer);
  const revoked=createEventService({store:f.store,adapters:[createDiscordAdapter({channelIds:[CHANNEL]})],queueReplies:true,authorizeQueuedReply:async(owner,authorization,scopes)=>{assert.equal(authorization.grantId,consumer.grantId);assert.deepEqual(scopes,['discord:read','discord:reply']);return false;}});
  const r=await revoked.receiverRequest(receiver,'claim',{requestId:'revoked-request'});assert.equal(r.command,null);assert.equal(r.complete,true);assert.equal(f.sends.length,0);assert.equal((await f.store.status(OWNER)).replies[0].status,'rejected');
});

test('統合クラウドポーリングは両レシーバースコープを検査し、1リクエストで配送を進める',async t=>{
  const f=await fixture(t);let io=0;
  const combined=createReceiverRequest({events:f.cloud,store:{claimDelivery:async()=>{io++;return null;}},transport:async()=>{throw Error('not needed');},authorizeSubscription:async()=>true});
  await assert.rejects(combined({...receiver,scopes:['discord:ingest']},'claim',{requestId:'x'}));assert.equal(io,0);
  await assert.rejects(combined({...receiver,scopes:['discord:receive-replies']},'claim',{requestId:'x'}));assert.equal(io,0);
  assert.deepEqual(await combined(receiver,'claim',{requestId:'x'}),{command:null,complete:false});assert.equal(io,1);
});

test('PCは明示的な実送信ゲートが有効になるまでキュー済み返信を保留し、その後同じコマンドを再開する',async t=>{
  const f=await fixture(t),e=f.adapter.normalize(packet());await f.cloud.ingestNormalized(receiver,e);
  await f.cloud.handle('tools/call',{name:'discord_reply_to_event',arguments:{event_id:e.eventId,content:'gated fake reply'}},consumer);
  const options={backend:f.db,adapter:f.adapter,token:'FAKE',gatewayFactory:()=>({start:async()=>{},stop:()=>{}}),timers:{setTimeout:()=>1,clearTimeout:()=>{}},forwardEnvelope:async()=>({status:200}),bridgeRequest:(action,p)=>f.cloud.receiverRequest(receiver,action,p)};
  const held=await createPcReceiver(options);await new Promise(r=>setImmediate(r));await held.pump();held.stop();assert.equal(f.sends.length,0);
  const resumed=await createPcReceiver({...options,repliesEnabled:true});await new Promise(r=>setImmediate(r));await resumed.pump();resumed.stop();assert.equal(f.sends.length,1);assert.equal((await f.store.status(OWNER)).replies[0].status,'sent');
});
