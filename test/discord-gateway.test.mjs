import test from 'node:test';
import assert from 'node:assert/strict';
import {createDiscordGateway} from '../lib/adapters/discord-gateway.mjs';
import {BOT_ID} from '../lib/adapters/discord.mjs';
import {createDiscordRest} from '../lib/adapters/discord-rest.mjs';

function fixture({dispatch=async()=>{},saved=null}={}) {
  let stored=saved,at=1000;
  const backend={durable:true,read:async()=>structuredClone(stored),update:async(k,fn)=>{const r=fn(structuredClone(stored));if(Object.hasOwn(r,'value'))stored=structuredClone(r.value);return r.result;}};
  const sockets=[],tasks=new Map();let n=0;const fatal=[];
  class FakeSocket {
    listeners=new Map();sent=[];readyState=1;closed=[];
    constructor(url){this.url=url;sockets.push(this);}
    addEventListener(name,fn){this.listeners.set(name,fn);}
    send(text){this.sent.push(JSON.parse(text));}
    emit(packet){this.listeners.get('message')({data:JSON.stringify(packet)});}
    close(code){this.closed.push(code);this.readyState=3;this.listeners.get('close')?.({code});}
  }
  const timers={setTimeout:(fn,delay)=>{tasks.set(++n,{fn,delay});return n;},clearTimeout:id=>tasks.delete(id)};
  const options={token:'FAKE-TEST-TOKEN',onDispatch:dispatch,backend,sessionKey:'fake-gateway',WebSocketClass:FakeSocket,timers,random:()=>.5,onFatal:m=>fatal.push(m),now:()=>at};
  const gateway=createDiscordGateway(options);
  const tick=async delay=>{const entry=[...tasks.entries()].find(([id,t])=>t.delay===delay);assert.ok(entry,'タイマー未設定 '+delay);tasks.delete(entry[0]);await entry[1].fn();};
  return {gateway,sockets,backend,options,tick,fatal,stored:()=>stored,advance:ms=>at+=ms};
}
const ready=()=>({op:0,t:'READY',s:1,d:{user:{id:BOT_ID},session_id:'fake-session',resume_gateway_url:'wss://gateway-us-east1-b.discord.gg/'}});
test('GatewayはGUILDSとGUILD_MESSAGESのみでidentifyし、bot IDを検証してREADYを永続化する',async()=>{
  const f=fixture();await f.gateway.start();const ws=f.sockets[0];ws.emit({op:10,d:{heartbeat_interval:40000}});await f.gateway.flush();
  assert.equal(ws.sent[0].op,2);assert.equal(ws.sent[0].d.intents,513);assert.equal(ws.url,'wss://gateway.discord.gg/?v=10&encoding=json');
  ws.emit(ready());await f.gateway.flush();assert.equal(f.stored().session.seq,1);f.gateway.stop();
});
test('Gatewayのreadyは検証済み永続READYの後にのみ発行され、失敗時は数値コードのみ公開する',async()=>{
 const f=fixture(),states=[];const gateway=createDiscordGateway({...f.options,onState:(...args)=>states.push(args)});await gateway.start();
 f.sockets[0].emit(ready());await gateway.flush();assert.deepEqual(states,[['ready',undefined]]);assert.equal(f.stored().session.seq,1);
 f.sockets[0].close(4014);assert.deepEqual(states.at(-1),['failed',4014]);
});
test('Gatewayはディスパッチを直列化し、永続取り込み後にのみ再開シーケンスを進める',async()=>{
  let release;const calls=[];const f=fixture({dispatch:async p=>{calls.push(p.s);if(p.s===2)await new Promise(r=>release=r);}});
  await f.gateway.start();const ws=f.sockets[0];ws.emit(ready());await f.gateway.flush();
  ws.emit({op:0,t:'MESSAGE_CREATE',s:2,d:{}});ws.emit({op:0,t:'MESSAGE_CREATE',s:3,d:{}});
  await new Promise(r=>setImmediate(r));assert.deepEqual(calls,[2]);assert.equal(f.stored().session.seq,1);
  release();await f.gateway.flush();assert.deepEqual(calls,[2,3]);assert.equal(f.stored().session.seq,3);
  ws.emit({op:0,t:'MESSAGE_CREATE',s:2,d:{}});await f.gateway.flush();assert.deepEqual(calls,[2,3]);f.gateway.stop();
});
test('永続取り込みの失敗は、失われたイベントを越えたチェックポイントやエラー漏洩なしに停止する',async()=>{
  const f=fixture({dispatch:async()=>{throw Error('FAKE-TEST-TOKEN private detail');}});await f.gateway.start();const ws=f.sockets[0];ws.emit(ready());await f.gateway.flush();ws.emit({op:0,t:'MESSAGE_CREATE',s:2,d:{}});await f.gateway.flush();
  assert.equal(f.stored().session.seq,1);assert.equal(f.fatal.length,1);assert.equal(f.fatal[0].includes('TOKEN'),false);assert.equal(ws.closed.at(-1),1000);
});
test('Gatewayは切断後に永続セッションを再開し、リプレイシーケンスを維持する',async()=>{
  const f=fixture();await f.gateway.start();let ws=f.sockets[0];ws.emit(ready());await f.gateway.flush();ws.close(4000);await f.tick(5000);ws=f.sockets[1];ws.emit({op:10,d:{heartbeat_interval:40000}});
  assert.equal(ws.sent[0].op,6);assert.equal(ws.sent[0].d.seq,1);assert.ok(ws.url.startsWith('wss://gateway-us-east1-b.discord.gg/'));f.gateway.stop();
});
test('ハートビートはACKを要求。ACK欠落は再接続し、致命的クローズコードで停止する',async()=>{
  const f=fixture();await f.gateway.start();const ws=f.sockets[0];ws.emit({op:10,d:{heartbeat_interval:40002}});await f.gateway.flush();await f.tick(20001);assert.equal(ws.sent.at(-1).op,1);
  ws.emit({op:11});await f.tick(40002);assert.equal(ws.closed.length,0);await f.tick(40002);assert.ok(ws.closed.includes(4000));await f.tick(5000);f.sockets[1].close(4014);assert.equal(f.fatal.length,1);
});
test('無効セッションは永続再開状態を消去し、バックオフ後に再identifyする',async()=>{
  const f=fixture();await f.gateway.start();f.sockets[0].emit(ready());await f.gateway.flush();f.sockets[0].emit({op:9,d:false});await f.gateway.flush();assert.equal(f.stored().session,null);await f.tick(5000);f.sockets[1].emit({op:10,d:{heartbeat_interval:40000}});await f.gateway.flush();assert.equal(f.sockets[1].sent[0].op,2);f.gateway.stop();
});
test('永続Gatewayリースは第2プロセスを拒否し、期限切れ後にのみ引き継ぎを許す',async()=>{
  const f=fixture();await f.gateway.start();const second=createDiscordGateway(f.options);await assert.rejects(second.start());assert.equal(f.sockets.length,1);
  f.gateway.stop();f.advance(60001);await second.start();assert.equal(f.sockets.length,2);second.stop();
});
test('Gatewayは不安全な再開URLと不一致の認証済みbotを拒否する',async()=>{
  const f=fixture({saved:{version:1,session:{id:'fake',seq:4,resumeUrl:'wss://evil.example/'}}});await assert.rejects(f.gateway.start());assert.equal(f.sockets.length,0);
  const g=fixture();await g.gateway.start();const r=ready();r.d.user.id='100000000000002500';g.sockets[0].emit(r);await g.gateway.flush();assert.equal(g.fatal.length,1);
});

test('無効シーケンスとタイムアウトしたGatewayセッションは再接続前に永続再開状態を消去する',async()=>{
  for(const code of [4007,4009]){const f=fixture();await f.gateway.start();f.sockets[0].emit(ready());await f.gateway.flush();f.sockets[0].close(code);await f.gateway.flush();assert.equal(f.stored().session,null);await f.tick(5000);f.sockets[1].emit({op:10,d:{heartbeat_interval:40000}});await f.gateway.flush();assert.equal(f.sockets[1].sent[0].op,2);f.gateway.stop();}
});
test('RESTは固定Discord APIを使い、リダイレクト/リトライを無効化し、同一チャンネルの受領を検証する',async()=>{
  const calls=[];const send=createDiscordRest({token:'FAKE-TEST-TOKEN',fetchImpl:async(url,options)=>{calls.push({url,options});return new Response(JSON.stringify({id:'100000000000000200',channel_id:'100000000000002200'}),{status:200});}});
  assert.equal((await send('100000000000002200',{content:'test'})).ok,true);assert.equal(calls[0].url,'https://discord.com/api/v10/channels/100000000000002200/messages');assert.equal(calls[0].options.redirect,'error');assert.ok(calls[0].options.signal);
  await assert.rejects(send('../dm',{content:'test'}));assert.equal(calls.length,1);
  const mismatch=createDiscordRest({token:'FAKE-TEST-TOKEN',fetchImpl:async()=>new Response(JSON.stringify({id:'100000000000000200',channel_id:'100000000000002500'}))});await assert.rejects(mismatch('100000000000002200',{}));
});
test('RESTは拒否を返し応答バイトを制限する',async()=>{
  const denied=createDiscordRest({token:'FAKE-TEST-TOKEN',fetchImpl:async()=>new Response('{}',{status:429})});assert.equal((await denied('100000000000002200',{})).ok,false);
  const large=createDiscordRest({token:'FAKE-TEST-TOKEN',fetchImpl:async()=>new Response('x'.repeat(65537))});await assert.rejects(large('100000000000002200',{}));
});
test('永続identify予算はDiscordグローバル上限より先に再接続ストームを止める',async()=>{
  const f=fixture({saved:{version:1,session:null,holder:null,until:0,identify:{windowStart:0,count:100,lastAt:0}}});await f.gateway.start();f.sockets[0].emit({op:10,d:{heartbeat_interval:40000}});await f.gateway.flush();assert.equal(f.sockets[0].sent.length,0);assert.equal(f.fatal.length,1);
});
