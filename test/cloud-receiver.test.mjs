import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkloadReceiverAuth} from '../lib/adapters/workload-auth.mjs';
import {createWorkloadCredential} from '../lib/adapters/workload-credential.mjs';
import {createCloudReceiverState} from '../lib/events/cloud-receiver-state.mjs';
import {startCloudReceiver} from '../cloud-receiver.mjs';
import {createDiscordGateway} from '../lib/adapters/discord-gateway.mjs';
import {createReceiverReplyExecutor} from '../lib/events/receiver-replies.mjs';
import {createPcReceiver} from '../pc-receiver.mjs';
import {createDiscordAdapter,GUILD_ID,BOT_ID} from '../lib/adapters/discord.mjs';

const origin='https://synthetic-fixture.run.app',at=2000000000000,subject='123456789012345678901';
const email='discord-mention-receiver@example-project.iam.gserviceaccount.com';
const roles=['discord:ingest','discord:receive-replies'];
function memory(){const data=new Map();return {durable:true,read:async k=>structuredClone(data.get(k)??null),update:async(k,f)=>{const n=f(structuredClone(data.get(k)??null));if(Object.hasOwn(n,'value'))data.set(k,structuredClone(n.value));return n.result;}};}
const delegation=()=>({version:1,enabled:true,owner:'google:owner',subject,email,audience:origin,scopes:roles,approvedAt:at-1000,expiresAt:at+86400000});
const claims=()=>({iss:'https://accounts.google.com',aud:origin,sub:subject,email,email_verified:true,iat:Math.floor(at/1000),exp:Math.floor(at/1000)+3600});
test('ワークロードブリッジは有効で厳密な委任・検証済みID・レシーバー専用経路を要求する',async()=>{
 const b=memory();await b.update('google-owner:v1',()=>({value:{sub:'owner'}}));let p=claims(),calls=0;
 const base={challenge:'Bearer fixture',authenticate:async()=>null,handleHttp:async()=>false};const auth=createWorkloadReceiverAuth({base,backend:b,origin,now:()=>at,verifyIdentity:async()=>{calls++;return p;}});const req=path=>({url:path,headers:{authorization:'Bearer FAKE-SIGNED-FIXTURE'}});
 assert.equal(await auth.authenticate(req('/ingest/discord')),null);assert.equal(calls,0);
 await b.update('workload-receiver:v1',()=>({value:delegation()}));const principal=await auth.authenticate(req('/receiver/discord/claim'));assert.deepEqual(principal.scopes,roles);assert.equal(principal.owner,'google:owner');
 for(const path of ['/mcp','/mcp/discord'])assert.equal(await auth.authenticate(req(path)),null);
 for(const patch of [{aud:origin+'/other'},{sub:'987654321'},{email:'other@example-project.iam.gserviceaccount.com'},{email_verified:false},{iss:'https://evil.example'},{exp:at/1000-1},{iat:at/1000+100}]){p={...claims(),...patch};assert.equal(await auth.authenticate(req('/ingest/discord')),null);}p=claims();
 for(const patch of [{enabled:false},{owner:'google:other'},{expiresAt:at},{expiresAt:at+91*86400000},{scopes:[...roles,'probe']}]){await b.update('workload-receiver:v1',()=>({value:{...delegation(),...patch}}));assert.equal(await auth.authenticate(req('/ingest/discord')),null);}
});
test('ワークロード認証情報は注入されたメタデータIDをsingle-flight+短期キャッシュで使い、ファイルは使わない',async()=>{
 let now=at,calls=0;const token=()=>['fixture',Buffer.from(JSON.stringify({aud:origin,exp:Math.floor(now/1000)+3600})).toString('base64url'),'signature'].join('.');const obtain=createWorkloadCredential({origin,now:()=>now,fetchIdentity:async()=>{calls++;return token();}});
 const issued=await Promise.all([obtain(),obtain(),obtain()]);assert.equal(calls,1);assert.equal(new Set(issued).size,1);await obtain();assert.equal(calls,1);now+=300001;await obtain();assert.equal(calls,2);
 await assert.rejects(createWorkloadCredential({origin,now:()=>now,fetchIdentity:async()=>token().replace(token().split('.')[1],Buffer.from(JSON.stringify({aud:'https://other.example',exp:now/1000+3600})).toString('base64url'))})());
});
class Storage{objects=new Map();generation=0;bucket(name){assert.equal(name,'private-fixture-state');const s=this;return {file(key,o={}){assert.match(key,/^discord-receiver\/v1\/[a-f0-9]{64}\.json$/);return {getMetadata:async()=>{const v=s.objects.get(key);if(!v)throw Object.assign(Error(),{code:404});return [{generation:v.g,size:String(v.bytes.length)}];},download:async()=>{const v=s.objects.get(key);if(!v||v.g!==o.generation)throw Object.assign(Error(),{code:404});return [v.bytes];},save:async(bytes,opts)=>{const v=s.objects.get(key);if(opts.preconditionOpts.ifGenerationMatch!==(v?.g??0))throw Object.assign(Error(),{code:412});s.objects.set(key,{g:String(++s.generation),bytes:Buffer.from(bytes)});}};}};}}
test('外部CAS状態は新ホストでも残り、競合クレームを拒否し、不確かな送信を再送しない',async()=>{
 const storage=new Storage(),a=createCloudReceiverState({bucketName:'private-fixture-state',storage}),b=createCloudReceiverState({bucketName:'private-fixture-state',storage});
 await a.update('reply-claim',old=>({value:{status:'unknown',nonce:'fixture'},result:true}));assert.deepEqual(await b.read('reply-claim'),{status:'unknown',nonce:'fixture'});
 const won=await Promise.all([a.update('lease',old=>old?{result:false}:{value:{holder:'A'},result:true}),b.update('lease',old=>old?{result:false}:{value:{holder:'B'},result:true})]);assert.equal(won.filter(Boolean).length,1);
 await assert.rejects(a.update('oversize',()=>({value:{text:'x'.repeat(1024*1024)}})));
 let sends=0;const adapter={validate:e=>e,reply:async()=>{sends++;throw Error('Fixture connection lost after possible send');}};
 const command={event:{eventId:'fixture-event'},content:'ordinary reply',requestId:'fixture-request'};
 assert.equal((await createReceiverReplyExecutor({backend:a,adapter,now:()=>at})(command)).status,'unknown');
 assert.equal((await createReceiverReplyExecutor({backend:b,adapter,now:()=>at})(command)).status,'unknown');assert.equal(sends,1);
});
test('ホスト型起動はオプトイン。マウント済みフェイクbot入力・注入された永続状態のみ使い、返信は無効',async()=>{
 let reads=0;const b=memory(),timers={setTimeout:()=>1,clearTimeout:()=>{}};const config={CLOUD_DISCORD_RECEIVER_ENABLE:'true',BRIDGE_ORIGIN:origin,DISCORD_RECEIVER_STATE_BUCKET:'private-fixture-state',DISCORD_CHANNEL_IDS:'["100000000000000600"]'};const deps={backend:b,readSecret:async path=>{assert.equal(path,'/var/run/secrets/discord-bot/token');reads++;return 'FAKE-BOT-NOT-A-REAL-CREDENTIAL';},gatewayFactory:()=>({start:async()=>{},stop:()=>{}}),getAccessToken:async()=>'FAKE',bridgeRequest:async()=>({command:null}),forwardEnvelope:async()=>({status:200}),timers};
 await assert.rejects(startCloudReceiver({...config,CLOUD_DISCORD_RECEIVER_ENABLE:'false'},deps));assert.equal(reads,0);
 const r=await startCloudReceiver(config,{...deps,validateDiscord:async()=>({botMatches:true}),diagnosticSink:()=>{}});await new Promise(done=>setImmediate(done));await r.shutdown();assert.equal(reads,1);assert.equal((await r.store.status('cloud-discord-receiver')).events,0);
});
test('Gatewayのリリースで即再起動でき、停止済みの古いホストは後続リースを削除できない',async()=>{
 const b=memory(),timers={setTimeout:()=>1,clearTimeout:()=>{}};class Socket{addEventListener(){}close(){}}const create=()=>createDiscordGateway({token:'FAKE',backend:b,sessionKey:'lease',onDispatch:async()=>{},WebSocketClass:Socket,timers,now:()=>at});const first=create(),second=create();await first.start();await assert.rejects(second.start());await first.release();await second.start();assert.equal(await first.release(),false);assert.notEqual((await b.read('lease')).holder,null);await second.release();
});

function deferred(){let resolve;const promise=new Promise(yes=>{resolve=yes;});return {promise,resolve};}

test('シャットダウンは遅延クレームの返却までレシーバーリースを保持し、その後Discord送信を開始しない',async()=>{
 const b=memory(),entered=deferred(),reply=deferred(),timers={setTimeout:()=>1,clearTimeout:()=>{}};
 let sends=0,releases=0,requestId;
 const adapter={validate:e=>e,reply:async()=>{sends++;return {ok:true,messageId:'100000000000002400'};}};
 const receiver=await createPcReceiver({backend:b,adapter,token:'FAKE',repliesEnabled:true,owner:'cloud-discord-receiver',timers,
  gatewayFactory:()=>({start:async()=>{},stop:()=>{},release:async()=>{releases++;}}),
  forwardEnvelope:async()=>({status:200}),bridgeRequest:async(action,p)=>{assert.equal(action,'claim');requestId=p.requestId;entered.resolve();return reply.promise;}});
 await entered.promise;const shutdown=receiver.shutdown();await new Promise(done=>setImmediate(done));
 assert.equal(releases,0);assert.equal(sends,0);
 reply.resolve({command:{event:{eventId:'fixture-delayed-claim'},content:'ordinary reply',requestId}});
 await shutdown;assert.equal(releases,1);assert.equal(sends,0);
 assert.equal((await b.read('receiver-poll:v1')).requestId,requestId);
});

test('シャットダウンは開始済みDiscord送信とその永続受領を待ってからリースを解放する',async()=>{
 const b=memory(),entered=deferred(),sent=deferred(),timers={setTimeout:()=>1,clearTimeout:()=>{}},order=[];
 let sends=0,releases=0;
 const adapter={validate:e=>e,reply:async()=>{sends++;order.push('send-start');entered.resolve();const receipt=await sent.promise;order.push('send-finish');return receipt;}};
 const receiver=await createPcReceiver({backend:b,adapter,token:'FAKE',repliesEnabled:true,owner:'cloud-discord-receiver',timers,
  gatewayFactory:()=>({start:async()=>{},stop:()=>{},release:async()=>{releases++;order.push('release');}}),
  forwardEnvelope:async()=>({status:200}),bridgeRequest:async(action,p)=>{
   if(action==='claim')return {command:{event:{eventId:'fixture-inflight-send'},content:'ordinary reply',requestId:p.requestId}};
   assert.equal(action,'receipt');assert.equal(p.status,'sent');order.push('receipt');return {accepted:true};
  }});
 await entered.promise;const shutdown=receiver.shutdown();await new Promise(done=>setImmediate(done));
 assert.equal(releases,0);assert.equal(sends,1);
 sent.resolve({ok:true,messageId:'100000000000002400'});await shutdown;
 assert.equal(releases,1);assert.equal(sends,1);assert.deepEqual(order,['send-start','send-finish','receipt','release']);
 const ledger=await b.read('receiver-reply-ledger:v2');assert.equal(ledger.rows[0].receipt.status,'sent');
 assert.equal((await b.read('receiver-poll:v1')).requestId,null);
});

test('クラウドのバイト容量圧力ではディスパッチを保持し、永続回復後にのみGatewayチェックポイントを進める',async()=>{
 const durable=memory(),tasks=new Map(),sockets=[],notices=[];let timerId=0,failures=0,fatals=0,gateway;
 const timers={setTimeout:(fn,delay)=>{tasks.set(++timerId,{fn,delay});return timerId;},clearTimeout:id=>tasks.delete(id)};
 const backend={durable:true,read:durable.read,update:async(key,mutate)=>durable.update(key,old=>{
  const next=mutate(old);
  if(key===JSON.stringify(['source-events-owner:v1','cloud-discord-receiver'])&&next.value?.events.length&&failures===0){failures++;throw Object.assign(Error('Fake bounded cloud storage full'),{code:'STORAGE_CAPACITY'});}
  return next;
 })};
 class Socket{
  listeners=new Map();readyState=1;
  constructor(){sockets.push(this);}
  addEventListener(name,fn){this.listeners.set(name,fn);}
  send(){}
  emit(packet){this.listeners.get('message')({data:JSON.stringify(packet)});}
  close(code){this.readyState=3;this.listeners.get('close')?.({code});}
 }
 const channel='100000000000000600',adapter=createDiscordAdapter({channelIds:[channel]});
 const receiver=await createPcReceiver({backend,adapter,token:'FAKE',owner:'cloud-discord-receiver',now:()=>at,pollIntervalMs:60000,timers,
  gatewayFactory:options=>{gateway=createDiscordGateway({...options,WebSocketClass:Socket,timers,now:()=>at});return gateway;},
  forwardEnvelope:async()=>({status:200}),bridgeRequest:async()=>({command:null}),onError:message=>notices.push(message),onFatal:()=>{fatals++;}});
 await new Promise(done=>setImmediate(done));
 sockets[0].emit({op:0,t:'READY',s:1,d:{user:{id:BOT_ID},session_id:'fake-capacity-session',resume_gateway_url:'wss://gateway.discord.gg/'}});await gateway.flush();
 const messageId=String(BigInt(at-1420070400000)<<22n);
 sockets[0].emit({op:0,t:'MESSAGE_CREATE',s:2,d:{id:messageId,channel_id:channel,guild_id:GUILD_ID,author:{id:'100000000000002300'},type:0,mentions:[{id:BOT_ID}],content:'fake capacity mention',timestamp:new Date(at).toISOString()}});
 await new Promise(done=>setImmediate(done));
 assert.equal(failures,1);assert.equal(fatals,0);assert.equal((await backend.read('receiver-gateway:v1')).session.seq,1);
 assert.equal((await receiver.store.status('cloud-discord-receiver')).events,0);assert(notices.some(message=>message.includes('checkpoint paused')));
 const pressure=[...tasks.entries()].find(([,task])=>task.delay===15000);assert(pressure);tasks.delete(pressure[0]);await pressure[1].fn();await gateway.flush();
 assert.equal((await receiver.store.status('cloud-discord-receiver')).events,1);assert.equal((await backend.read('receiver-gateway:v1')).session.seq,2);assert.equal(fatals,0);
 await receiver.shutdown();
});
