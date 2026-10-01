import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {createServer} from 'node:http';
import Provider from 'oidc-provider';
import {providerConfiguration} from '../lib/oauth.mjs';
import {createOidcAdapter} from '../lib/oidc-storage.mjs';
import {discordLifetime,DISCORD_GRANT_SECONDS,DISCORD_REFRESH_SECONDS} from '../lib/discord-lifetime.mjs';
import {createBridgeCredential} from '../lib/adapters/bridge-credential.mjs';
import {discordRetention} from '../lib/adapters/discord-retention.mjs';
import {createDiscordAdapter,GUILD_ID,BOT_ID} from '../lib/adapters/discord.mjs';
import {createDiscordRest} from '../lib/adapters/discord-rest.mjs';
import {createEventStore} from '../lib/events/store.mjs';
import {createEventService} from '../lib/events/service.mjs';
import {createReceiverReplyExecutor} from '../lib/events/receiver-replies.mjs';
import {forwardNext} from '../lib/events/bridge.mjs';
import {createRequestListener} from '../server.mjs';
import {memoryStore} from '../lib/store.mjs';
const CHANNEL='100000000000000600',owner='google:123',resource='https://probe.example/mcp';
function backend(){const data=new Map();return {durable:true,read:async k=>structuredClone(data.get(k)??null),update:async(k,f)=>{const next=f(structuredClone(data.get(k)??null));if(Object.hasOwn(next,'value')){assert.ok(Buffer.byteLength(JSON.stringify(next.value))<=1024*1024);data.set(k,structuredClone(next.value));}return next.result;}};}
function event(at,seq=0){const id=String((BigInt(at-1420070400000)<<22n)+BigInt(seq));return createDiscordAdapter({channelIds:[CHANNEL]}).normalize({op:0,t:'MESSAGE_CREATE',d:{id,channel_id:CHANNEL,guild_id:GUILD_ID,author:{id:'100000000000002300'},type:0,mentions:[{id:BOT_ID}],content:'<@'+BOT_ID+'> fake mention',timestamp:new Date(at).toISOString()}});}
const subscription=at=>({id:'sub',clientId:'fake-client',grantId:'fake-grant',name:'discord.mention.created',tenantId:GUILD_ID,url:'https://callback.example/',secret:'FAKE-LOCAL-ONLY',expires:at+90*86400000});

test('unattended policy isolates roles, preserves probe/mixed grants and caps the refresh family at 90 days',()=>{
 const ttl=discordLifetime({resource,discordUnattendedEnabled:true}),now=Math.floor(Date.now()/1000);
 assert.equal(ttl.Grant(null,{resources:{[resource]:'discord:read discord:reply'}}),DISCORD_GRANT_SECONDS);
 assert.equal(ttl.Grant(null,{resources:{[resource]:'discord:ingest discord:receive-replies'}}),DISCORD_GRANT_SECONDS);
 for(const scopes of ['probe','probe discord:read','discord:read discord:ingest',''])assert.equal(ttl.Grant(null,{resources:{[resource]:scopes}}),3600);
 assert.equal(ttl.RefreshToken(null,{scope:'openid offline_access discord:read',iiat:now}),DISCORD_REFRESH_SECONDS);
 assert.ok(ttl.RefreshToken(null,{scope:'discord:read',iiat:now-DISCORD_GRANT_SECONDS+60})<=60);
 assert.equal(ttl.RefreshToken(null,{scope:'probe',iiat:now}),3600);
});

test('90 days of two rotating client families stay bounded, retain spent-token replay and preserve legacy state',async()=>{
 let at=100000;const b=backend(),A=createOidcAdapter(b,{now:()=>at,compactRefresh:true}),r=new A('RefreshToken'),g=new A('Grant');
 await g.upsert('legacy-probe',{exp:at+3600,resources:{[resource]:'probe'}},3600);
 for(const role of ['pc','dot'])await g.upsert(role,{kind:'Grant',clientId:role,accountId:owner,exp:at+90*86400},90*86400);
 let previous={};
 for(let step=0;step<90*96;step++){
  for(const role of ['pc','dot']){
   const id=role+'-'+step;
   await r.upsert(id,{kind:'RefreshToken',jti:id,grantId:role,clientId:role,accountId:owner,scope:role==='pc'?'discord:ingest discord:receive-replies':'discord:read discord:reply',iat:at,exp:at+86400},86400);
   if(previous[role])await r.consume(previous[role]);previous[role]=id;
  }
  if(step===1){assert.equal((await g.find('legacy-probe')).exp,100000+3600);assert.ok((await r.find('pc-0')).consumed);}
  at+=900;
 }
 const state=await b.read('oauth-state:v1');assert.ok(Object.keys(state.records).length<10);
 assert.ok(Object.values(state.spent).reduce((n,f)=>n+Object.keys(f.tokens).length,0)<=192);
 assert.ok(Buffer.byteLength(JSON.stringify(state))<50000);assert.equal(await r.find('pc-0'),undefined);
 assert.ok((await r.find('pc-'+(90*96-2))).consumed);await g.revokeByGrantId('pc');assert.equal(await r.find(previous.pc),undefined);
 at+=90*86400+1;await g.upsert('cleanup',{kind:'Grant'},10);assert.equal((await b.read('oauth-state:v1')).revoked.pc,undefined);
});

test('real provider rotates refresh tokens, revokes replayed family, and leaves the separate probe grant intact',async t=>{
 const b=backend();await b.update('google-owner:v1',()=>({value:{sub:'123'}}));
 const config={origin:'https://probe.example',resource,googleClientId:'123-fixture.apps.googleusercontent.com',redirects:['http://127.0.0.1:8766/callback'],cookieKeys:['FAKE-LOCAL-ONLY-COOKIE-KEY-100000000000000100'],jwks:{keys:[{...generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({format:'jwk'}),use:'sig',alg:'RS256',kid:'fake'}]},discordEnabled:true,discordReceiverEnabled:true,discordUnattendedEnabled:true};
 const configuration=providerConfiguration(config,b);configuration.clients=[{client_id:'fake-pc',redirect_uris:config.redirects,token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code']}];
 const Base=configuration.adapter;let raceTarget,raceCount=0,releaseRace;
 configuration.adapter=class extends Base{async find(id){const row=await super.find(id);if(this.model==='RefreshToken'&&id===raceTarget&&!row?.consumed){raceCount++;if(raceCount===2)releaseRace();else await new Promise(r=>releaseRace=r);}return row;}};
 const provider=new Provider(config.origin,configuration);provider.proxy=true;
 const grant=new provider.Grant({accountId:owner,clientId:'fake-pc'});grant.addOIDCScope('openid offline_access');grant.addResourceScope(resource,'discord:ingest discord:receive-replies');const grantId=await grant.save();
 assert.ok((await provider.Grant.find(grantId)).exp-Math.floor(Date.now()/1000)>89*86400);
 const probe=new provider.Grant({accountId:owner,clientId:'fake-pc'});probe.addResourceScope(resource,'probe');const probeId=await probe.save();assert.ok((await provider.Grant.find(probeId)).exp-Math.floor(Date.now()/1000)<=3600);
 const client=await provider.Client.find('fake-pc');const rt=new provider.RefreshToken({client,accountId:owner,grantId,resource,scope:'openid offline_access discord:ingest discord:receive-replies',expiresWithSession:false});const original=await rt.save();
 const server=createServer(provider.callback());await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const refresh=token=>fetch('http://127.0.0.1:'+server.address().port+'/token',{method:'POST',headers:{host:'probe.example','x-forwarded-proto':'https','content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',client_id:'fake-pc',refresh_token:token,resource})});
 const first=await refresh(original);assert.equal(first.status,200);const tokens=await first.json();assert.equal(tokens.expires_in,900);assert.notEqual(tokens.refresh_token,original);
 const second=await refresh(tokens.refresh_token);assert.equal(second.status,200);const latest=await second.json();
 assert.equal((await refresh(original)).status,400);assert.equal((await refresh(latest.refresh_token)).status,400);assert.ok(await provider.Grant.find(probeId));
 const racedGrant=new provider.Grant({accountId:owner,clientId:'fake-pc'});racedGrant.addResourceScope(resource,'discord:ingest discord:receive-replies');const racedId=await racedGrant.save();
 raceTarget=await new provider.RefreshToken({client,accountId:owner,grantId:racedId,resource,scope:'offline_access discord:ingest discord:receive-replies',expiresWithSession:false}).save();
 const responses=await Promise.all([refresh(raceTarget),refresh(raceTarget)]);assert.equal(raceCount,2);assert.ok(responses.every(r=>[200,400].includes(r.status)));assert.ok((await b.read('oauth-state:v1')).revoked[racedId]);assert.equal(await provider.Grant.find(racedId),undefined);
 for(const response of responses)if(response.status===200){const winning=await response.json();assert.equal((await refresh(winning.refresh_token)).status,400);assert.equal(await provider.AccessToken.find(winning.access_token),undefined);}
 assert.ok(await provider.Grant.find(probeId));
});

test('refresh is single-flight; lost response persists a fail-closed marker across restart',async()=>{
 let saved={origin:'https://bridge.example',clientId:'fake',accessToken:'FAKE',refreshToken:'FAKE-R',expiresAt:1},calls=0;
 const options={origin:saved.origin,readCredential:async()=>JSON.stringify(saved),writeCredential:async s=>{saved=JSON.parse(s);},now:()=>100000};
 const get=createBridgeCredential({...options,fetchImpl:async()=>{calls++;await new Promise(r=>setImmediate(r));return new Response(JSON.stringify({access_token:'FAKE-NEW',refresh_token:'FAKE-ROTATED',expires_in:900}));}});
 assert.deepEqual(await Promise.all([get(),get(),get()]),['FAKE-NEW','FAKE-NEW','FAKE-NEW']);assert.equal(calls,1);assert.equal(saved.refreshPending,false);
 saved.expiresAt=1;const lost=createBridgeCredential({...options,fetchImpl:async()=>{calls++;throw Error('lost response');}});await assert.rejects(lost());assert.equal(saved.refreshPending,true);
 const restarted=createBridgeCredential({...options,fetchImpl:async()=>{calls++;throw Error('must not call');}});const before=calls;await assert.rejects(restarted());assert.equal(calls,before);
});

test('rolling retention frees acknowledged events, deduplicates retired IDs and never drops pending or unknown work',async()=>{
 let at=Date.parse('2026-10-01T00:00:00Z');const born=at,b=backend(),store=createEventStore({backend:b,now:()=>at,maxEvents:3,retention:discordRetention});
 await store.subscribe(owner,subscription(at));const [a,p,u]=[0,1,2].map(i=>event(born,i));for(const e of [a,p,u])await store.ingest(owner,e);
 await store.settleDelivery(owner,await store.claimDelivery(owner),200);
 const {digest}=await import('../lib/events/envelope.mjs');await store.claimReply(owner,u.eventId,digest('fake'));await store.settleReply(owner,u.eventId,'unknown');
 at+=25*3600000;await store.ingest(owner,event(at,3));assert.equal(await store.getEvent(owner,a.eventId),null);assert.ok(await store.getEvent(owner,p.eventId));assert.ok(await store.getEvent(owner,u.eventId));
 assert.equal((await store.ingest(owner,a)).duplicate,true);assert.equal((await store.status(owner)).retired,1);
 await assert.rejects(store.ingest(owner,event(at,4)),e=>e.code==='EVENT_CAPACITY');at=born+8*86400000;
 await assert.rejects(store.ingest(owner,{...a,timestamp:new Date(at).toISOString()}),e=>e.code==='EVENT_EXPIRED');assert.ok(await store.getEvent(owner,p.eventId));
});

test('expired subscription pauses existing work and admission until refresh; no successful zero-fanout acknowledgement',async()=>{
 let at=Date.parse('2026-10-01T00:00:00Z');const store=createEventStore({backend:backend(),now:()=>at,retention:discordRetention,requireLiveSubscription:true});
 const e=event(at);await assert.rejects(store.ingest(owner,e),x=>x.code==='EVENT_SUBSCRIPTION_PAUSED');assert.equal((await store.status(owner)).events,0);
 const sub={...subscription(at),expires:at+1000};await store.subscribe(owner,sub);await store.ingest(owner,e);at+=1001;
 assert.equal(await store.claimDelivery(owner),null);assert.equal((await store.status(owner)).deliveries[0].status,'pending');await assert.rejects(store.ingest(owner,event(at)),x=>x.code==='EVENT_SUBSCRIPTION_PAUSED');
 await store.subscribe(owner,{...sub,expires:at+86400000});assert.equal((await store.claimDelivery(owner)).eventId,e.eventId);
});

test('quiet-period maintenance uses an eight-hour subscription cap, idempotent refresh and grant deadline',async()=>{
 const store=createEventStore({backend:backend()});const service=createEventService({store,adapters:[createDiscordAdapter({channelIds:[CHANNEL]})],subscriptionTtlMs:8*3600000,transport:async(_url,request)=>new Response(JSON.stringify({challenge:JSON.parse(request.body).challenge}))});
 const principal={owner,clientId:'fake-dot',grantId:'fake-grant',grantExpiresAt:Date.now()+90*86400000,scopes:['discord:read','discord:reply']};
 const p={name:'discord.mention.created',arguments:{guild_id:GUILD_ID},delivery:{mode:'webhook',url:'https://callback.example/',secret:'whsec_'+Buffer.alloc(32,1).toString('base64')}};
 const before=Date.now(),first=await service.handle('events/subscribe',p,principal);assert.ok(Date.parse(first.refreshBefore)<=Date.now()+8*3600000);assert.ok(Date.parse(first.refreshBefore)>=before+8*3600000);
 const again=await service.handle('events/subscribe',{...p,ttlMs:90*86400000},principal);assert.equal(again.id,first.id);assert.equal((await store.status(owner)).events,0);
 const ending=await service.handle('events/subscribe',p,{...principal,grantExpiresAt:Date.now()+60000});assert.ok(Date.parse(ending.refreshBefore)<=Date.now()+60000);
});

test('PC uplink retains mentions after repeated auth, capacity and storage errors until cloud acknowledgement',async()=>{
 let at=Date.parse('2026-10-01T00:00:00Z');const store=createEventStore({backend:backend(),now:()=>at,retryUntilAcknowledged:true});await store.subscribe(owner,subscription(at));await store.ingest(owner,event(at));
 for(let n=0;n<12;n++){assert.equal((await forwardNext({store,owner,forwardEnvelope:async()=>({status:n%2?403:503})})).acknowledged,false);at+=300001;}
 assert.equal((await store.status(owner)).deliveries[0].status,'pending');assert.equal((await forwardNext({store,owner,forwardEnvelope:async()=>({status:200})})).acknowledged,true);
});

test('Discord 5xx remains uncertain across retries; bounded local receipt ledger rejects expired replies',async()=>{
 const at=Date.parse('2026-10-01T00:00:00Z'),b=backend();let calls=0;
 const adapter=createDiscordAdapter({channelIds:[CHANNEL],sendMessage:createDiscordRest({token:'FAKE',fetchImpl:async()=>{calls++;return new Response('{}',{status:500});}})});
 const command={event:event(at),content:'fake reply',requestId:'fake-request'},execute=createReceiverReplyExecutor({backend:b,adapter,retention:discordRetention,now:()=>at});
 assert.equal((await execute(command)).status,'unknown');assert.equal((await execute(command)).status,'unknown');assert.equal(calls,1);
 const expired=createReceiverReplyExecutor({backend:b,adapter,retention:discordRetention,now:()=>at+25*3600000});assert.equal((await expired({...command,event:event(at,1)})).status,'rejected');assert.equal(calls,1);
});

test('HTTP capacity and storage errors are retryable 503 rather than terminal authorization denial',async t=>{
 const auth={challenge:'Bearer realm="test"',handleHttp:async()=>false,authenticate:async()=>({owner})};
 const server=createServer(createRequestListener({auth,store:memoryStore(),ingestEvent:async()=>{throw Object.assign(Error('fake'),{code:'EVENT_CAPACITY'});}}));await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const r=await fetch('http://127.0.0.1:'+server.address().port+'/ingest/discord',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});assert.equal(r.status,503);
});
