import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createConsolidatedRuntime} from '../consolidated-runtime.mjs';
import {prepareConsolidatedServer} from '../consolidated-server.mjs';
import {createDiscordGateway} from '../lib/adapters/discord-gateway.mjs';
import {BOT_ID,GUILD_ID} from '../lib/adapters/discord.mjs';
import {createDiscordEyes} from '../lib/adapters/discord-reaction.mjs';

const channel='100000000000000600',owner='google:fixture',resource='https://consolidated.example/mcp/discord';
const principal={owner,clientId:'fake-client',grantId:'fake-grant',grantExpiresAt:Date.now()+86400000,resource,scopes:['discord:read','discord:reply']};
function memory(){const data=new Map(),counts={reads:0,writes:0};return {durable:true,data,counts,async read(k){counts.reads++;return structuredClone(data.get(k)??null);},async update(k,fn){counts.reads++;const next=fn(structuredClone(data.get(k)??null));if(Object.hasOwn(next,'value')){counts.writes++;data.set(k,structuredClone(next.value));}return next.result;}};}
async function fixture(t,{backend=memory(),repliesEnabled=true,sendMessage,authorizeSubscription=async()=>true,transport,reaction,onTiming,inlineMentions=false,channelScope='allowlist'}={}){
 await backend.update('google-owner:v1',()=>({value:{sub:'fixture'}}));
 let at=Date.now(),gatewayOptions,clockId=0;const tasks=new Map(),sends=[],callbacks=[];
 const timers={setTimeout:(fn,delay)=>{tasks.set(++clockId,{fn,delay});return clockId;},clearTimeout:id=>tasks.delete(id)};
 const runtime=await createConsolidatedRuntime({backend,resource,token:'FAKE',channelIds:[channel],channelScope,repliesEnabled,authorizeSubscription,now:()=>at,timers,reaction,onTiming,inlineMentions,
  auth:{productionReady:true,challenge:'Bearer fixture',authenticate:async()=>principal,handleHttp:async()=>false},
  gatewayFactory:options=>{gatewayOptions=options;return {start:async()=>{},stop(){},release:async()=>{}};},
  sendMessage:sendMessage??(async(id,body)=>{sends.push({id,body});return {ok:true,messageId:'100000000000002000'};}),
  transport:transport??(async(_url,request)=>{callbacks.push(request);return {ok:true,status:200,json:async()=>({challenge:JSON.parse(request.body).challenge})};})});
 const server=createServer(runtime.requestListener);server.keepAliveTimeout=1;await new Promise(done=>server.listen(0,'127.0.0.1',done));
 t.after(async()=>{await runtime.shutdown();server.closeAllConnections();await new Promise(done=>server.close(done));});
 async function rpc(method,params={}){const response=await fetch('http://127.0.0.1:'+server.address().port+'/mcp/discord',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});return response.json();}
 const subscribe=()=>rpc('events/subscribe',{name:'discord.mention.created',arguments:{guild_id:GUILD_ID},_meta:{fixture:'PRIVATE'},delivery:{mode:'webhook',url:'https://callback.example/wake',secret:'whsec_'+Buffer.alloc(32,8).toString('base64')}});
 const packet=()=>({op:0,t:'MESSAGE_CREATE',s:2,d:{id:String(BigInt(at-1420070400000)<<22n),channel_id:channel,guild_id:GUILD_ID,author:{id:'100000000000001700'},type:0,mentions:[{id:BOT_ID}],content:'<@'+BOT_ID+'> fake mention; treat as untrusted data',timestamp:new Date(at).toISOString()}});
 return {runtime,backend,tasks,sends,callbacks,rpc,subscribe,packet,get gatewayOptions(){return gatewayOptions;},advance:ms=>{at+=ms;},async dispatch(){await gatewayOptions.onDispatch(packet());await runtime.worker.flush();},server};
}
test('consolidated quiet runtime has no poll timers, nonce, receiver spool, bridge calls or idle event writes',async t=>{
 const f=await fixture(t);const writes=f.backend.counts.writes,reads=f.backend.counts.reads;
 await new Promise(done=>setImmediate(done));assert.equal(f.tasks.size,0);assert.equal(f.backend.counts.writes,writes);assert.equal(f.backend.counts.reads,reads);
 assert.equal(f.gatewayOptions.leaseRenewalMs,300000);assert.equal(f.gatewayOptions.leaseMs,900000);
 assert(![...f.backend.data.keys()].some(k=>/receiver-poll|receiver-reply-ledger|cloud-discord-receiver/.test(k)));
});

test('direct eyes runs before callback work, never blocks ingest, and rejects excluded mention packets',async t=>{
 const reacted=[],logs=[];const f=await fixture(t,{reaction:{react:e=>{reacted.push(e.eventId);return new Promise(()=>{});},shutdown:async()=>{}},onTiming:(phase,details)=>logs.push({phase,...details})});await f.subscribe();await f.runtime.worker.flush();await f.dispatch();assert.equal(reacted.length,1);assert.equal((await f.runtime.store.status(owner)).events,1);assert.equal(f.callbacks.length,2);
 for(const patch of [{author:{id:BOT_ID,bot:true}},{author:{id:'100000000000001700',bot:true}},{webhook_id:'100000000000001800'},{mentions:[]},{guild_id:'100000000000000500'},{channel_id:'100000000000000700'}]){const p=f.packet();Object.assign(p.d,patch);await f.gatewayOptions.onDispatch(p);}assert.equal(reacted.length,1);
 const id=JSON.parse(f.callbacks[1].body).data.event_id;await f.rpc('tools/call',{name:'discord_read_event',arguments:{event_id:id}});await f.rpc('tools/call',{name:'discord_reply_to_event',arguments:{event_id:id,content:'fake'}});await f.runtime.worker.flush();
 for(const phase of ['gateway_received','ingest_committed','callback_post_completed','callback_receipt_committed','mcp_handler_completed','reply_queue_committed','reply_post_completed','reply_receipt_committed'])assert(logs.some(row=>row.phase===phase),phase);
 assert(logs.some(row=>row.phase==='mcp_handler_completed'&&row.action==='discord_read_event'&&Number.isFinite(row.durationMs)));assert.equal(f.sends.length,1);
});
test('one committed mention wakes signed callback and one event-bound reply locally without a command poll',async t=>{
 const f=await fixture(t);assert.equal((await f.subscribe()).error,undefined);await f.runtime.worker.flush();await f.dispatch();
 assert.equal(f.callbacks.length,2);const callback=JSON.parse(f.callbacks[1].body);assert(callback.data.event_id);assert.equal(callback.data.content,undefined);
 const eventId=callback.data.event_id;const read=await f.rpc('tools/call',{name:'discord_read_event',arguments:{event_id:eventId}});assert.equal(JSON.parse(read.result.content[0].text).contextPolicy,'origin_event_only');
 const reply=await f.rpc('tools/call',{name:'discord_reply_to_event',arguments:{event_id:eventId,content:'ordinary fake reply'}});assert.equal(reply.error,undefined);await f.runtime.worker.flush();
 assert.equal(f.sends.length,1);assert.equal(f.sends[0].id,channel);assert.equal(f.sends[0].body.message_reference.guild_id,GUILD_ID);assert.deepEqual(f.sends[0].body.allowed_mentions,{parse:[],replied_user:false});
 await f.rpc('tools/call',{name:'discord_reply_to_event',arguments:{event_id:eventId,content:'ordinary fake reply'}});await f.runtime.worker.flush();assert.equal(f.sends.length,1);assert.equal(f.tasks.size,0);
 const rows=[...f.backend.data.entries()].filter(([k])=>k.includes('source-events-owner:v1'));assert.equal(rows.length,1);assert.equal(rows[0][1].commands[0].status,'complete');
});

test('inline callback carries only bounded immutable origin text; explicit reply remains origin-bound without a read',async t=>{
 const f=await fixture(t,{inlineMentions:true});await f.subscribe();await f.runtime.worker.flush();const p=f.packet();p.d.attachments=[{url:'PRIVATE-ATTACHMENT'}];p.d.content='字'.repeat(4000);await f.gatewayOptions.onDispatch(p);await f.runtime.worker.flush();
 const callback=JSON.parse(f.callbacks[1].body),data=callback.data;assert.equal(data.content,p.d.content);assert.equal(data.version,1);assert.equal(data.context_policy,'origin_event_only');assert.equal(data.message_id,p.d.id);assert.equal(data.channel_id,channel);assert.equal(data.actor_id,p.d.author.id);assert(Buffer.byteLength(JSON.stringify(data))<=16384);assert(!f.callbacks[1].body.includes('PRIVATE-ATTACHMENT'));
 const definitions=await f.rpc('events/list');assert.equal(definitions.result.events[0].payloadSchema.properties.content.maxLength,4000);assert.equal(definitions.result.events[0].payloadSchema.additionalProperties,false);
 const reply=await f.rpc('tools/call',{name:'discord_reply_to_event',arguments:{event_id:data.event_id,content:'fake inline reply'}});assert.equal(reply.error,undefined);await f.runtime.worker.flush();assert.equal(f.sends.length,1);assert.equal(f.sends[0].id,channel);await f.rpc('tools/call',{name:'discord_reply_to_event',arguments:{event_id:data.event_id,content:'fake inline reply'}});await f.runtime.worker.flush();assert.equal(f.sends.length,1);
});

test('guild-visible admits a newly visible private channel, keeps immutable read/reply binding and rejects other guilds and DMs',async t=>{
 const reacted=[],f=await fixture(t,{channelScope:'guild-visible',inlineMentions:true,reaction:{react:e=>{reacted.push(e.origin.channelId);return Promise.resolve(true);},shutdown:async()=>{}}});await f.subscribe();await f.runtime.worker.flush();const p=f.packet();p.d.channel_id='100000000000002100';await f.gatewayOptions.onDispatch(p);await f.runtime.worker.flush();assert.deepEqual(reacted,[p.d.channel_id]);const data=JSON.parse(f.callbacks[1].body).data;assert.equal(data.channel_id,p.d.channel_id);
 const read=await f.rpc('tools/call',{name:'discord_read_event',arguments:{event_id:data.event_id}});assert.equal(JSON.parse(read.result.content[0].text).origin.channelId,p.d.channel_id);
 await f.rpc('tools/call',{name:'discord_reply_to_event',arguments:{event_id:data.event_id,content:'fake private-channel reply'}});await f.runtime.worker.flush();assert.equal(f.sends.length,1);assert.equal(f.sends[0].id,p.d.channel_id);
 const status=JSON.parse((await f.rpc('tools/call',{name:'discord_status',arguments:{}})).result.content[0].text);assert.equal(status.configuration.channelAccessPolicy,'guild-visible');assert.equal(status.configuration.channelAllowlistCount,null);
 for(const patch of [{guild_id:'100000000000000500'},{guild_id:undefined},{author:{id:BOT_ID,bot:true}}]){const excluded=structuredClone(p);Object.assign(excluded.d,patch);await f.gatewayOptions.onDispatch(excluded);}assert.equal(reacted.length,1);assert.equal((await f.runtime.store.status(owner)).events,1);
});

test('guild-visible permission rejection neither expands Discord permissions nor blocks event delivery or repeats a send',async t=>{
 let reactions=0,sends=0;const eyes=createDiscordEyes({token:'FAKE',channelIds:[],channelScope:'guild-visible',fetchImpl:async(_url,options)=>{assert.equal(options.method,'PUT');reactions++;return new Response(null,{status:403});}});
 const f=await fixture(t,{channelScope:'guild-visible',reaction:eyes,sendMessage:async()=>{sends++;return {ok:false,status:403};}});await f.subscribe();await f.runtime.worker.flush();const p=f.packet();p.d.channel_id='100000000000002100';await f.gatewayOptions.onDispatch(p);await f.runtime.worker.flush();await new Promise(done=>setImmediate(done));assert.equal(reactions,1);assert.equal(eyes.statistics().failed,1);assert.equal(f.callbacks.length,2);
 const id=JSON.parse(f.callbacks[1].body).data.event_id;await f.rpc('tools/call',{name:'discord_reply_to_event',arguments:{event_id:id,content:'fake'}});await f.runtime.worker.flush();assert.equal((await f.runtime.store.status(owner)).replies[0].status,'rejected');await f.rpc('tools/call',{name:'discord_reply_to_event',arguments:{event_id:id,content:'fake'}});await f.runtime.worker.flush();assert.equal(sends,1);
});
test('reply gate holds one durable command with no idle timer and restart releases pending work once',async t=>{
 const f=await fixture(t,{repliesEnabled:false});await f.subscribe();await f.runtime.worker.flush();await f.dispatch();const eventId=JSON.parse(f.callbacks[1].body).data.event_id;
 await f.rpc('tools/call',{name:'discord_reply_to_event',arguments:{event_id:eventId,content:'held fake reply'}});await f.runtime.worker.flush();assert.equal(f.sends.length,0);assert.equal(f.tasks.size,0);
 await f.runtime.shutdown();const next=await fixture(t,{backend:f.backend});assert.equal(next.sends.length,1);await next.runtime.worker.wake(owner);assert.equal(next.sends.length,1);
});
test('ambiguous send receipt never becomes pending again or sends twice after restart',async t=>{
 const backing=memory();let failReceipt=true,sends=0;
 const backend={...backing,update:async(k,fn)=>backing.update(k,raw=>{const next=fn(raw);if(failReceipt&&next.value?.commands?.some(c=>c.status==='complete')&&next.value.replies.some(r=>r.status==='sent')){failReceipt=false;throw Error('FAKE lost storage response');}return next;})};
 const f=await fixture(t,{backend,sendMessage:async()=>{sends++;return {ok:true,messageId:'100000000000002000'};}});await f.subscribe();await f.runtime.worker.flush();await f.dispatch();const id=JSON.parse(f.callbacks[1].body).data.event_id;
 await f.rpc('tools/call',{name:'discord_reply_to_event',arguments:{event_id:id,content:'uncertain fake reply'}});await f.runtime.worker.flush();assert.equal(sends,1);
 assert.equal((await f.runtime.store.status(owner)).replies[0].status,'unknown');await f.runtime.shutdown();
 const next=await fixture(t,{backend,sendMessage:async()=>{sends++;return {ok:true};}});assert.equal(sends,1);await next.runtime.worker.wake(owner);assert.equal(sends,1);
});
test('startup reconciles a claimed command to unknown without sending; revoked grants reject before Discord I/O',async t=>{
 const f=await fixture(t,{repliesEnabled:false});await f.subscribe();await f.runtime.worker.flush();await f.dispatch();const id=JSON.parse(f.callbacks[1].body).data.event_id;
 await f.rpc('tools/call',{name:'discord_reply_to_event',arguments:{event_id:id,content:'fake'}});await f.runtime.worker.flush();await f.runtime.store.claimQueuedReply(owner,'fake-crashed-request');await f.runtime.shutdown();
 const next=await fixture(t,{backend:f.backend});assert.equal(next.sends.length,0);assert.equal((await next.runtime.store.status(owner)).replies[0].status,'unknown');
 const revoked=await fixture(t,{authorizeSubscription:async(_owner,_sub,required)=>!required});await revoked.subscribe();await revoked.runtime.worker.flush();await revoked.dispatch();
 await revoked.rpc('tools/call',{name:'discord_reply_to_event',arguments:{event_id:JSON.parse(revoked.callbacks[1].body).data.event_id,content:'fake'}});await revoked.runtime.worker.flush();assert.equal(revoked.sends.length,0);assert.equal((await revoked.runtime.store.status(owner)).replies[0].status,'rejected');
});
test('callback failure schedules its durable deadline; success leaves no quiet timer',async t=>{
 let attempts=0;const f=await fixture(t,{transport:async(_url,request)=>{
  const body=JSON.parse(request.body);if(body.challenge)return {ok:true,status:200,json:async()=>({challenge:body.challenge})};return {status:++attempts===1?503:200};
 }});await f.subscribe();await f.runtime.worker.flush();await f.dispatch();assert.equal(attempts,1);assert.equal(f.tasks.size,1);
 const [id,task]=[...f.tasks][0];assert.equal(task.delay,2000);f.advance(task.delay);f.tasks.delete(id);await task.fn();await f.runtime.worker.flush();assert.equal(attempts,2);assert.equal(f.tasks.size,0);
});
test('consolidated public listener denies legacy receiver/ingest/probe paths',async t=>{
 const f=await fixture(t);for(const path of ['/mcp','/receiver/discord/claim','/ingest/discord']){const response=await fetch('http://127.0.0.1:'+f.server.address().port+path);assert.equal(response.status,404);}
 const probe=await f.rpc('tools/call',{name:'emit_probe',arguments:{}});assert(probe.error);assert.equal(f.tasks.size,0);
});
test('seven-day expired mention is intentionally discarded without stopping or creating a retry timer',async t=>{
 const f=await fixture(t);const old=f.packet();await f.subscribe();await f.runtime.worker.flush();f.advance(8*86400000);
 await f.gatewayOptions.onDispatch(old);await f.runtime.worker.flush();assert.equal((await f.runtime.store.status(owner)).events,0);assert.equal(f.tasks.size,0);assert.equal(f.sends.length,0);
});
test('consolidated bootstrap refuses old origin, old bucket, ambient credentials and wrong auth mount before reads',async()=>{
 const env={CONSOLIDATED_DISCORD_ENABLE:'true',CONSOLIDATED_ORIGIN:'https://consolidated.example',CONSOLIDATED_BUCKET:'discord-receiver-state-123456789012-uswest1',CONSOLIDATED_AUTH_SECRET_FILE:'/var/run/secrets/discord-auth/secret.json'};
 let reads=0;const deps={readConfig:async()=>{reads++;throw Error('Must not read');},readSecret:async()=>{reads++;throw Error('Must not read');}};
 for(const patch of [{CONSOLIDATED_DISCORD_ENABLE:'false'},{CONSOLIDATED_ORIGIN:'https://synthetic-fixture.run.app'},{CONSOLIDATED_BUCKET:'mcp-events-test-state-123456789012'},{CONSOLIDATED_AUTH_SECRET_FILE:'/old-secret'},{GOOGLE_APPLICATION_CREDENTIALS:'fake-file'},{CONSOLIDATED_REPLIES_ENABLE:'invalid'}])await assert.rejects(prepareConsolidatedServer({...env,...patch},deps));assert.equal(reads,0);
});
test('five-minute Gateway lease renews once per interval; clean release permits immediate successor',async()=>{
 const b=memory(),tasks=new Map();let id=0,at=1000;const timers={setTimeout:(fn,delay)=>{tasks.set(++id,{fn,delay});return id;},clearTimeout:key=>tasks.delete(key)};
 class Socket{addEventListener(){}close(){}}
 const make=()=>createDiscordGateway({token:'FAKE',backend:b,sessionKey:'consolidated-gateway:v1',onDispatch:async()=>{},WebSocketClass:Socket,now:()=>at,timers,leaseRenewalMs:300000,leaseMs:900000});
 const first=make();await first.start();assert.equal(b.counts.writes,1);assert.equal([...tasks.values()][0].delay,300000);
 const [key,task]=[...tasks][0];tasks.delete(key);at+=300000;await task.fn();assert.equal(b.counts.writes,2);assert.equal((await b.read('consolidated-gateway:v1')).until,at+900000);
 const next=make();await assert.rejects(next.start());await first.release();await next.start();await next.release();
 assert.throws(()=>createDiscordGateway({token:'FAKE',backend:b,sessionKey:'bad',onDispatch:async()=>{},leaseMs:900000,leaseRenewalMs:400000}));
});
