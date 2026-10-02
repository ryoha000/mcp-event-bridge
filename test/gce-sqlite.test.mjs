import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createServer} from 'node:http';
import {createSqliteObjectBackend} from '../lib/sqlite-store.mjs';
import {createDiscordGateway} from '../lib/adapters/discord-gateway.mjs';
import {createConsolidatedRuntime} from '../consolidated-runtime.mjs';
import {prepareGceServer} from '../gce-server.mjs';
import {BOT_ID,GUILD_ID} from '../lib/adapters/discord.mjs';
import {digest} from '../lib/events/envelope.mjs';

const path=()=>join(mkdtempSync(join(tmpdir(),'discord-sqlite-test-')),'state.sqlite3');
test('SQLiteトランザクションのロールバック・上限付き入力・読み取り専用ミューテータ・コミット済み再オープンで状態が残る',async()=>{
 const filename=path();let b=createSqliteObjectBackend({filename,maxBytes:256,maxKeys:1});
 await b.update('state',()=>({value:{counter:1}}));
 const before=b.statistics().commits;await b.update('state',value=>({result:value.counter}));assert.equal(b.statistics().commits,before);
 await assert.rejects(b.update('state',value=>{value.counter=2;throw Error('fake mutator failure');}));
 await assert.rejects(b.update('state',async()=>({value:{counter:3}})),{code:'STORAGE_INPUT'});
 await assert.rejects(b.update('state',()=>({value:{large:'X'.repeat(300)}})),{code:'STORAGE_CAPACITY'});
 await assert.rejects(b.update('other',()=>({value:{counter:4}})),{code:'STORAGE_CAPACITY'});
 assert.deepEqual(await b.read('state'),{counter:1});b.close();b=createSqliteObjectBackend({filename,maxBytes:256,maxKeys:1});assert.deepEqual(await b.read('state'),{counter:1});b.close();
});
test('SQLiteプロセスロックは2番目の保持者を拒否し、close後の後続を即座に許可する',()=>{
 const filename=path(),b=createSqliteObjectBackend({filename});assert.throws(()=>createSqliteObjectBackend({filename}));b.close();const next=createSqliteObjectBackend({filename});next.close();
});
test('突然のプロセス終了でもWALコミットが残り、リース待ちなしでプロセスロックが解放される',async()=>{
 const filename=path(),moduleUrl=new URL('../lib/sqlite-store.mjs',import.meta.url).href;
 const code=`const {createSqliteObjectBackend}=await import(process.argv[1]);const b=createSqliteObjectBackend({filename:process.argv[2]});await b.update('fake-claim',()=>({value:{status:'claimed'}}));process.exit(23);`;
 const child=spawnSync(process.execPath,['--input-type=module','--eval',code,moduleUrl,filename],{encoding:'utf8',timeout:10000});assert.equal(child.status,23);
 const b=createSqliteObjectBackend({filename});assert.deepEqual(await b.read('fake-claim'),{status:'claimed'});b.close();
});
test('破損したSQLiteファイルはリセットせず拒否する',()=>{
 const filename=path();writeFileSync(filename,'fake non-SQLite corruption');const original=readFileSync(filename);assert.throws(()=>createSqliteObjectBackend({filename}));assert.deepEqual(readFileSync(filename),original);
});
test('ローカルGatewayは更新タイマーを持たず、同プロセスの重複を排除し、再起動後にコミット済みシーケンスを再開する',async()=>{
 const filename=path();let b=createSqliteObjectBackend({filename}),socket;const tasks=new Map();let timer=0,at=Date.now(),dispatches=0;
 const timers={setTimeout:(fn,delay)=>{tasks.set(++timer,{fn,delay});return timer;},clearTimeout:id=>tasks.delete(id)};
 class Socket{constructor(){socket=this;this.listeners={};this.readyState=1;this.sent=[];}addEventListener(k,v){this.listeners[k]=v;}send(body){this.sent.push(JSON.parse(body));}close(){}emit(p){this.listeners.message({data:JSON.stringify(p)});}}
 const make=()=>createDiscordGateway({token:'FAKE',backend:b,sessionKey:'gce-gateway:v1',ownership:'local-singleton',WebSocketClass:Socket,timers,now:()=>at,onDispatch:async()=>{dispatches++;}});
 const first=make();await first.start();assert.equal(tasks.size,0);const duplicate=make();await assert.rejects(duplicate.start());
 socket.emit({op:0,t:'READY',s:1,d:{user:{id:BOT_ID},session_id:'fake-session',resume_gateway_url:'wss://gateway.discord.gg/'}});await first.flush();
 socket.emit({op:0,t:'MESSAGE_CREATE',s:2,d:{}});await first.flush();assert.equal(dispatches,1);assert.equal(tasks.size,0);
 const before=b.statistics().commits;at+=900000;await new Promise(done=>setImmediate(done));assert.equal(b.statistics().commits,before);
 // クラッシュの再現: リリースせずにソケットを止め、OSと同様にDBを閉じる。
 // 永続化されたholderは残るが、OSロックは新プロセスが直ちに再取得する。
 first.stop();b.close();b=createSqliteObjectBackend({filename});const next=make();await next.start();assert.equal(tasks.size,0);
 socket.emit({op:10,d:{heartbeat_interval:40000}});await next.flush();assert.equal(socket.sent[0].op,6);assert.equal(socket.sent[0].d.seq,2);await next.release();b.close();
 assert.throws(()=>createDiscordGateway({token:'FAKE',backend:{durable:true},sessionKey:'bad',onDispatch:async()=>{},ownership:'local-singleton'}));
});

const channel='100000000000000600',owner='google:fixture',resource='https://gce.example/mcp/discord';
async function fixture(t,{filename=path(),sendMessage,backendWrapper}={}){
 const backing=createSqliteObjectBackend({filename}),backend=backendWrapper?backendWrapper(backing):backing;await backing.update('google-owner:v1',()=>({value:{sub:'fixture'}}));
 let options;const tasks=new Map(),sends=[],callbacks=[];let timer=0;
 const runtime=await createConsolidatedRuntime({backend,resource,token:'FAKE',channelIds:[channel],gatewayOwnership:'local-singleton',gatewaySessionKey:'gce-gateway:v1',authorizeSubscription:async()=>true,
  timers:{setTimeout:(fn,delay)=>{tasks.set(++timer,{fn,delay});return timer;},clearTimeout:id=>tasks.delete(id)},
  auth:{productionReady:true,challenge:'Bearer fake',authenticate:async()=>({owner,clientId:'fake-client',grantId:'fake-grant',grantExpiresAt:Date.now()+86400000,resource,scopes:['discord:read','discord:reply']}),handleHttp:async()=>false},
  gatewayFactory:o=>{options=o;return {start:async()=>{},stop(){},release:async()=>{}};},
  sendMessage:sendMessage??(async(id,body)=>{sends.push({id,body});return {ok:true,messageId:'100000000000002000'};}),
  transport:async(_url,req)=>{const data=JSON.parse(req.body);callbacks.push(data);return {ok:true,status:200,json:async()=>({challenge:data.challenge})};}});
 const server=createServer(runtime.requestListener);server.keepAliveTimeout=1;await new Promise(done=>server.listen(0,'127.0.0.1',done));let closed=false;
 async function close(){if(closed)return;closed=true;await runtime.shutdown();server.closeAllConnections();await new Promise(done=>server.close(done));backing.close();}
 t.after(close);
 async function rpc(method,params={}){const r=await fetch('http://127.0.0.1:'+server.address().port+'/mcp/discord',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});assert.equal(r.status,200);const data=await r.json();assert.equal(data.error,undefined);await runtime.worker.flush();return data.result;}
 async function subscribe(){await rpc('events/subscribe',{name:'discord.mention.created',arguments:{guild_id:GUILD_ID},delivery:{mode:'webhook',url:'https://callback.example/wake',secret:'whsec_'+Buffer.alloc(32,2).toString('base64')}});}
 function packet(){const at=Date.now();return {op:0,t:'MESSAGE_CREATE',s:2,d:{id:String(BigInt(at-1420070400000)<<22n),channel_id:channel,guild_id:GUILD_ID,author:{id:'100000000000001700'},type:0,mentions:[{id:BOT_ID}],content:'fake mention',timestamp:new Date(at).toISOString()}};}
 return {filename,runtime,backing,options,tasks,sends,callbacks,rpc,subscribe,packet,close,async dispatch(p=packet()){await options.onDispatch(p);await runtime.worker.flush();return callbacks.at(-1).data.event_id;}};
}
test('SQLite統合のメンション/コールバック/読み取り/返信は再起動後もオリジン束縛で重複なし',async t=>{
 const f=await fixture(t);await f.subscribe();const p=f.packet(),id=await f.dispatch(p);await f.dispatch(p);assert.equal(f.callbacks.filter(c=>c.data?.event_id===id).length,1);
 const read=await f.rpc('tools/call',{name:'discord_read_event',arguments:{event_id:id}});assert.equal(JSON.parse(read.content[0].text).contextPolicy,'origin_event_only');
 await f.rpc('tools/call',{name:'discord_reply_to_event',arguments:{event_id:id,content:'fake ordinary reply'}});assert.equal(f.sends.length,1);assert.equal(f.sends[0].id,channel);assert.deepEqual(f.sends[0].body.allowed_mentions,{parse:[],replied_user:false});
 const status=await f.rpc('tools/call',{name:'discord_status',arguments:{}});assert.equal(JSON.parse(status.content[0].text).configuration.replyExecution,'queued_locally');assert.equal(f.tasks.size,0);const writes=f.backing.statistics().commits;await f.runtime.worker.wake(owner);assert.equal(f.backing.statistics().commits,writes);
 await f.close();const next=await fixture(t,{filename:f.filename});await next.rpc('tools/call',{name:'discord_reply_to_event',arguments:{event_id:id,content:'fake ordinary reply'}});assert.equal(next.sends.length,0);
});
test('起動時に回復されたSQLiteのクレーム済み送信はunknownとなり再送されない',async t=>{
 const f=await fixture(t);await f.subscribe();const id=await f.dispatch();await f.runtime.store.claimReply(owner,id,digest('fake'),'fake',{clientId:'fake-client',grantId:'fake-grant'});await f.runtime.store.claimQueuedReply(owner,'fake-crashed-send');await f.close();
 const next=await fixture(t,{filename:f.filename});assert.equal(next.sends.length,0);assert.equal((await next.runtime.store.status(owner)).replies[0].status,'unknown');
});
test('SQLiteで失われた受領応答はDiscordの重複送信を生まない',async t=>{
 let fail=true,sends=0;const f=await fixture(t,{sendMessage:async()=>{sends++;return {ok:true,messageId:'100000000000002000'};},backendWrapper:b=>({...b,update:async(k,fn)=>{const r=await b.update(k,raw=>{const next=fn(raw);if(fail&&next.value?.replies?.some(x=>x.status==='sent')){fail=false;throw Error('fake write failure after Discord send');}return next;});return r;}})});
 await f.subscribe();const id=await f.dispatch();await f.rpc('tools/call',{name:'discord_reply_to_event',arguments:{event_id:id,content:'fake'}});assert.equal(sends,1);assert.equal((await f.runtime.store.status(owner)).replies[0].status,'unknown');await f.close();const next=await fixture(t,{filename:f.filename});assert.equal(next.sends.length,0);
});
test('GCEブートストラップは読み取り前に、未承認/クラウドの状態パス・IPオリジン・認証情報フォールバックを拒否する',async()=>{
 const env={GCE_DISCORD_ENABLE:'true',GCE_DISCORD_ORIGIN:'https://gce.example',GCE_DISCORD_SQLITE_FILE:'/var/lib/discord-mcp/state.sqlite3',GCE_DISCORD_SYSTEMD_LOCK:'held',CREDENTIALS_DIRECTORY:'/run/credentials/discord-mcp.service'};let reads=0;
 const deps={readConfig:async()=>{reads++;throw Error('fake read forbidden');}};
 for(const patch of [{GCE_DISCORD_ENABLE:'false'},{GCE_DISCORD_ORIGIN:'https://192.0.2.1'},{GCE_DISCORD_ORIGIN:'https://synthetic-fixture.run.app'},{GCE_DISCORD_SQLITE_FILE:'/tmp/reset.sqlite3'},{GCE_DISCORD_SYSTEMD_LOCK:'false'},{CREDENTIALS_DIRECTORY:'/tmp/private'},{GOOGLE_APPLICATION_CREDENTIALS:'private-file'},{PROBE_BUCKET:'old-bucket'}])await assert.rejects(prepareGceServer({...env,...patch},deps));assert.equal(reads,0);
});
