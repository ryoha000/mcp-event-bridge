import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {createOAuth,providerConfiguration} from '../lib/oauth.mjs';
import {createRequestListener} from '../server.mjs';
import {memoryStore} from '../lib/store.mjs';
import {createEventStore} from '../lib/events/store.mjs';
import {createEventService,createCombinedHandler} from '../lib/events/service.mjs';
import {createSubscriptionAuthorizer} from '../lib/events/authorization.mjs';
import {createDiscordAdapter,BOT_ID,GUILD_ID} from '../lib/adapters/discord.mjs';
import {routeConsumerOAuth} from '../production.mjs';
import {routeSourceOAuth} from '../lib/oauth-router.mjs';
import {createOidcAdapter} from '../lib/oidc-storage.mjs';
import {createSqliteObjectBackend} from '../lib/sqlite-store.mjs';
import {mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

function backend(){const data=new Map();return {durable:true,read:async k=>structuredClone(data.get(k)??null),update:async(k,fn)=>{const next=fn(structuredClone(data.get(k)??null));if(Object.hasOwn(next,'value'))data.set(k,structuredClone(next.value));return next.result;}};}
const config={origin:'https://probe.example',resource:'https://probe.example/mcp',googleClientId:'123-fixture.apps.googleusercontent.com',ownerEmail:'fixture@gmail.com',redirects:['https://chatgpt.com/connector_platform_oauth_redirect'],cookieKeys:['EPHEMERAL-LOCAL-TEST-COOKIE-KEY-DO-NOT-DEPLOY'],jwks:{keys:[{...generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({format:'jwk'}),use:'sig',alg:'RS256',kid:'test-only'}]},discordEnabled:true};
test('Discord OAuthスコープはオプトインでresource束縛',async()=>{
  const enabled=providerConfiguration(config,backend());assert.ok(enabled.scopes.includes('discord:read'));assert.ok(enabled.scopes.includes('discord:reply'));
  const disabled=providerConfiguration({...config,discordEnabled:false},backend());assert.deepEqual(disabled.scopes,['openid','offline_access','probe']);
  assert.equal((await enabled.features.resourceIndicators.getResourceServerInfo({},config.resource)).scope,'probe discord:read discord:reply');
});

test('X専用consumer issuerはx:readだけを広告し、DiscordとOAuth state/cookieを分離する',async()=>{
  const b=backend(),xConfig={...config,origin:config.origin+'/x',resource:config.origin+'/mcp/x',discordEnabled:false,xEnabled:true,consumerOnly:true,consumerCookiePrefix:'x',oauthStateKey:'oauth-state:x:v1',discordUnattendedEnabled:true};
  const x=providerConfiguration(xConfig,b);
  assert.deepEqual(x.scopes,['openid','offline_access','x:read']);
  assert.equal(x.clientDefaults.scope,'openid offline_access x:read');
  assert.equal(x.cookies.names.session,'_x_session');
  assert.equal((await x.features.resourceIndicators.getResourceServerInfo({},xConfig.resource)).scope,'x:read');
  const A=x.adapter;await new A('Client').upsert('x-client',{client_id:'x-client'},3600);
  assert.ok(await b.read('oauth-state:x:v1'));assert.equal(await b.read('oauth-state:v1'),null);
  const discord=createOAuth({config:{...config,origin:config.origin+'/discord',resource:config.origin+'/mcp/discord',discordConsumerOnly:true},backend:b});
  const xAuth=createOAuth({config:xConfig,backend:b});
  const routed=routeSourceOAuth(discord,{discord,x:xAuth});
  assert.deepEqual(routed.consumerPaths,['/mcp/discord','/mcp/x']);
  assert.equal(routed.challengeForRequest({url:'/mcp/x'}),xAuth.challenge);
  assert.equal(routed.challengeForRequest({url:'/mcp/discord'}),discord.challenge);
});

test('複数ロールのOAuthチャレンジはprobeスコープを誤って要求しない。合成専用の既定は従来のチャレンジを維持',()=>{
  const enabled=createOAuth({config,backend:backend()});assert.ok(enabled.challenge.includes('oauth-protected-resource/mcp'));assert.equal(enabled.challenge.includes('scope="probe"'),false);
  const probe=createOAuth({config:{...config,discordEnabled:false},backend:backend()});assert.ok(probe.challenge.includes('scope="probe"'));
});
test('サブスクリプション認可はオーナー/クライアント/許可の失効・期限切れ・readスコープ削除を止める',async()=>{
  const b=backend();let at=100;const A=createOidcAdapter(b,{now:()=>at});const grant=new A('Grant'),client=new A('Client');
  await b.update('google-owner:v1',()=>({value:{sub:'123'}}));await client.upsert('client',{client_id:'client'});
  const payload={accountId:'google:123',clientId:'client',resources:{[config.resource]:'discord:read discord:reply'}};
  await grant.upsert('grant',payload,100);const authorize=createSubscriptionAuthorizer({backend:b,resource:config.resource,now:()=>at});
  const sub={grantId:'grant',clientId:'client',name:'discord.mention.created'};
  assert.equal(await authorize('google:123',sub),true);assert.equal(await authorize('google:other',sub),false);
  await grant.upsert('grant',{...payload,rejected:{resources:{[config.resource]:'discord:read'}}},100);assert.equal(await authorize('google:123',sub),false);
  await grant.upsert('grant',payload,100);at=201;assert.equal(await authorize('google:123',sub),false);at=100;
  await grant.upsert('grant',payload,100);await client.destroy('client');assert.equal(await authorize('google:123',sub),false);await client.upsert('client',{client_id:'client'});
  await grant.revokeByGrantId('grant');assert.equal(await authorize('google:123',sub),false);
});
test('実ローカルOAuthフローはDiscord readのみ付与し、コンテキスト制約を表示してreply/probeをブロックする',async t=>{
  const b=backend();let nonce='';const sends=[];const adapter=createDiscordAdapter({channelIds:['100000000000002200'],sendMessage:async(...a)=>{sends.push(a);return {ok:true};}});
  const store=createEventStore({backend:b});const events=createEventService({store,adapters:[adapter],transport:async()=>{throw Error('Offline only');}});
  const auth=createOAuth({config,backend:b,google:{verifyIdToken:async()=>({getPayload:()=>({iss:'https://accounts.google.com',aud:config.googleClientId,nonce,email:'fixture@gmail.com',email_verified:true,sub:'123'})})}});
  const server=createServer(createRequestListener({auth,store:memoryStore(),handlerFactory:probe=>createCombinedHandler(probe,events)}));
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
  const base='http://127.0.0.1:'+server.address().port,cookies=new Map();
  async function call(path,options={}){
    const url=new URL(path,config.origin);assert.equal(url.origin,config.origin);
    const r=await fetch(base+url.pathname+url.search,{...options,headers:{host:'probe.example','x-forwarded-proto':'https',cookie:[...cookies].map(([k,v])=>k+'='+v).join('; '),...options.headers},redirect:'manual'});
    for(const c of r.headers.getSetCookie()){const pair=c.split(';')[0],i=pair.indexOf('=');cookies.set(pair.slice(0,i),pair.slice(i+1));}return r;
  }
  const reg=await call('/reg',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({redirect_uris:config.redirects,token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code']})});assert.equal(reg.status,201);const client=await reg.json();
  const verifier='EPHEMERAL-TEST-PKCE-VERIFIER-012345678901234567890';const challenge=createHash('sha256').update(verifier).digest('base64url');
  const q=new URLSearchParams({client_id:client.client_id,redirect_uri:config.redirects[0],response_type:'code',scope:'openid discord:read',resource:config.resource,code_challenge:challenge,code_challenge_method:'S256',state:'test',prompt:'consent'});
  const first=await call('/auth?'+q);assert.equal(first.status,303);const loginPath=first.headers.get('location');nonce=new URL(loginPath).pathname.split('/').at(-1);
  const login=await call(loginPath,{method:'POST',headers:{'content-type':'application/json',origin:config.origin},body:JSON.stringify({action:'login',credential:'FAKE-GOOGLE-INPUT'})});assert.equal(login.status,200);
  const resume=await call((await login.json()).redirect);const consentPath=resume.headers.get('location');const html=await (await call(consentPath)).text();assert.ok(html.includes('originating channel'));assert.ok(html.includes('camera'));assert.ok(html.includes(GUILD_ID));
  const consent=await call(consentPath,{method:'POST',headers:{'content-type':'application/json',origin:config.origin},body:JSON.stringify({action:'consent'})});assert.equal(consent.status,200);
  const authorized=await call((await consent.json()).redirect);const redirect=new URL(authorized.headers.get('location'));
  const exchange=await call('/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',client_id:client.client_id,code:redirect.searchParams.get('code'),redirect_uri:config.redirects[0],code_verifier:verifier,resource:config.resource})});assert.equal(exchange.status,200);const token=(await exchange.json()).access_token;
  async function rpc(method,params={}) {const r=await call('/mcp',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});return {status:r.status,body:r.status===200?await r.json():null};}
  assert.deepEqual((await rpc('tools/list')).body.result.tools.map(t=>t.name),['discord_status','discord_read_event']);
  const health=JSON.parse((await rpc('tools/call',{name:'discord_status',arguments:{}})).body.result.content[0].text);assert.equal(health.counts.events,0);assert.deepEqual(health.authentication.resourceScopes,['discord:read']);assert.equal(health.authentication.replyScopeGranted,false);assert.equal(health.authentication.grantLifetimeKnown,true);
  const packet={op:0,t:'MESSAGE_CREATE',d:{id:'100000000000000200',channel_id:'100000000000002200',guild_id:GUILD_ID,author:{id:'100000000000002300'},type:0,mentions:[{id:BOT_ID}],content:'<@'+BOT_ID+'> hello',timestamp:'2026-10-01T00:00:00Z'}};
  const ingested=await events.ingest('google:123','discord',packet);
  assert.ok((await rpc('tools/call',{name:'discord_read_event',arguments:{event_id:ingested.eventId}})).body.result);
  assert.ok((await rpc('tools/call',{name:'discord_reply_to_event',arguments:{event_id:ingested.eventId,content:'reply'}})).body.error);
  assert.ok((await rpc('tools/call',{name:'probe_status'})).body.error);assert.equal(sends.length,0);
  const raw=await b.read('oauth-state:v1');const grantId=Object.keys(raw.records).map(k=>JSON.parse(k)).find(([model])=>model==='Grant')[1];
  await b.update('oauth-state:v1',s=>{s.records[JSON.stringify(['Grant',grantId])].payload.rejected={resources:{[config.resource]:'discord:read'}};return {value:s};});
  assert.equal((await rpc('tools/list')).status,401);
});

for(const storageKind of ['memory','sqlite'])test('分離コンシューマissuerはPKCEを完了し、ディスカバリを絞り、probeをブロックし、オリジン限定ツールを維持する ('+storageKind+')',async t=>{
  const consumerConfig={...config,origin:config.origin+'/discord',resource:config.origin+'/mcp/discord',discordConsumerOnly:true,discordUnattendedEnabled:true};
  const b=storageKind==='sqlite'?createSqliteObjectBackend({filename:join(mkdtempSync(join(tmpdir(),'discord-oauth-sqlite-')),'state.sqlite3')}):backend();t.after(()=>b.close?.());let nonce='';const sends=[];const adapter=createDiscordAdapter({channelIds:['100000000000002200'],sendMessage:async(...a)=>{sends.push(a);return {ok:true};}});
  const store=createEventStore({backend:b});const events=createEventService({store,adapters:[adapter],queueReplies:true,transport:async(_url,options)=>({ok:true,json:async()=>({challenge:JSON.parse(options.body).challenge})})});
  const oauthLogs=[];const auth=createOAuth({config:consumerConfig,backend:b,diagnosticSink:text=>oauthLogs.push(JSON.parse(text)),google:{verifyIdToken:async()=>({getPayload:()=>({iss:'https://accounts.google.com',aud:config.googleClientId,nonce,email:'fixture@gmail.com',email_verified:true,sub:'123'})})}});
  auth.discordConsumerEnabled=true;const server=createServer(createRequestListener({auth,store:memoryStore(),handlerFactory:probe=>createCombinedHandler(probe,events,{consumerResource:consumerConfig.resource})}));
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
  const base='http://127.0.0.1:'+server.address().port,cookies=new Map();
  async function call(path,options={}){
    const url=new URL(path,config.origin);assert.equal(url.origin,config.origin);
    const r=await fetch(base+url.pathname+url.search,{...options,headers:{host:'probe.example','x-forwarded-proto':'https',cookie:[...cookies].map(([k,v])=>k+'='+v).join('; '),...options.headers},redirect:'manual'});
    for(const c of r.headers.getSetCookie()){const pair=c.split(';')[0],i=pair.indexOf('=');cookies.set(pair.slice(0,i),pair.slice(i+1));}return r;
  }
  const metadata=await (await call('/.well-known/oauth-protected-resource/mcp/discord')).json();assert.equal(metadata.resource,consumerConfig.resource);assert.deepEqual(metadata.scopes_supported,['discord:read','discord:reply','openid','offline_access']);
  for(const path of ['/discord/.well-known/openid-configuration','/.well-known/oauth-authorization-server/discord']){const discovery=await (await call(path)).json();assert.equal(discovery.issuer,consumerConfig.origin);assert.equal(discovery.registration_endpoint,consumerConfig.origin+'/reg');assert.equal(discovery.scopes_supported.includes('probe'),false);}
  const denied=await call('/discord/auth?scope=openid%20probe');assert.equal(denied.status,400);
  const reg=await call('/discord/reg',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({redirect_uris:config.redirects,token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code']})});assert.equal(reg.status,201);const client=await reg.json();
  assert.equal(client.scope,'openid offline_access discord:read discord:reply');
  for(const scope of ['openid probe','openid other:scope']){const bad=await call('/discord/reg',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({redirect_uris:config.redirects,token_endpoint_auth_method:'none',scope})});assert.equal(bad.status,400);}
  const verifier='EPHEMERAL-TEST-PKCE-VERIFIER-012345678901234567890';const challenge=createHash('sha256').update(verifier).digest('base64url');
  const q=new URLSearchParams({client_id:client.client_id,redirect_uri:config.redirects[0],response_type:'code',scope:'openid offline_access discord:read discord:reply',resource:consumerConfig.resource,code_challenge:challenge,code_challenge_method:'S256',state:'test'});
  const first=await call('/discord/auth?'+q);assert.equal(first.status,303);const loginPath=first.headers.get('location');nonce=new URL(loginPath).pathname.split('/').at(-1);
  const login=await call(loginPath,{method:'POST',headers:{'content-type':'application/json',origin:config.origin},body:JSON.stringify({action:'login',credential:'FAKE-GOOGLE-INPUT'})});assert.equal(login.status,200);
  const resume=await call((await login.json()).redirect);const consentPath=resume.headers.get('location');const html=await (await call(consentPath)).text();assert.ok(html.includes('originating channel'));assert.ok(html.includes('camera'));assert.ok(html.includes(GUILD_ID));
  const consent=await call(consentPath,{method:'POST',headers:{'content-type':'application/json',origin:config.origin},body:JSON.stringify({action:'consent'})});assert.equal(consent.status,200);
  const authorized=await call((await consent.json()).redirect);const redirect=new URL(authorized.headers.get('location'));
  const exchange=await call('/discord/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',client_id:client.client_id,code:redirect.searchParams.get('code'),redirect_uri:config.redirects[0],code_verifier:verifier,resource:consumerConfig.resource})});assert.equal(exchange.status,200);const issued=await exchange.json();assert.equal(typeof issued.refresh_token,'string');const token=issued.access_token;let rpcToken=token;const principal=await auth.authenticate({headers:{authorization:'Bearer '+token}});assert.equal(principal.resource,consumerConfig.resource);assert.ok(principal.grantExpiresAt-Date.now()>89*86400000);
  assert.ok(oauthLogs.some(row=>row.phase==='token_completed'&&row.status===200&&row.grantType==='authorization_code'&&row.refreshTokenIssued===true));
  const invalidToken=await call('/discord/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',accept:'application/json'},body:new URLSearchParams({grant_type:'refresh_token',client_id:client.client_id,refresh_token:'FAKE-INVALID-TOKEN',resource:consumerConfig.resource})});assert.equal(invalidToken.status,400);assert.ok(oauthLogs.some(row=>row.phase==='token_failed'&&row.errorCode==='invalid_grant'));
  const main=createOAuth({config,backend:b});assert.equal(await main.authenticate({headers:{authorization:'Bearer '+token}}),null);
  async function rpc(method,params={}) {const r=await call('/mcp/discord',{method:'POST',headers:{authorization:'Bearer '+rpcToken,'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});return {status:r.status,body:r.status===200?await r.json():null};}
  for(const method of ['initialize','server/discover']){const metadata=(await rpc(method,{protocolVersion:'2026-07-28'})).body.result;assert.equal(metadata.serverInfo.version,'0.1.4');assert.equal(metadata.serverInfo.name,'synthetic-event-probe');assert.deepEqual(metadata.capabilities.tools,{});}
  assert.deepEqual((await rpc('tools/list')).body.result.tools.map(t=>t.name),['discord_status','discord_read_event','discord_reply_to_event']);
  const subscribed=await rpc('events/subscribe',{name:'discord.mention.created',arguments:{guild_id:GUILD_ID},delivery:{mode:'webhook',url:'https://callback.example/',secret:'whsec_'+Buffer.alloc(32,1).toString('base64')}});assert.equal(subscribed.body.error,undefined);const saved=(await b.read(JSON.stringify(['source-events-owner:v1','google:123']))).subscriptions[0];assert.equal(saved.resource,consumerConfig.resource);
  const packet={op:0,t:'MESSAGE_CREATE',d:{id:'100000000000000200',channel_id:'100000000000002200',guild_id:GUILD_ID,author:{id:'100000000000002300'},type:0,mentions:[{id:BOT_ID}],content:'<@'+BOT_ID+'> hello',timestamp:'2026-10-01T00:00:00Z'}};
  const ingested=await events.ingest('google:123','discord',packet);
  assert.ok((await rpc('tools/call',{name:'discord_read_event',arguments:{event_id:ingested.eventId}})).body.result);
  assert.equal((await rpc('tools/call',{name:'discord_reply_to_event',arguments:{event_id:ingested.eventId,content:'reply'}})).body.error,undefined);
  const command=await store.claimQueuedReply('google:123','fake-request');assert.equal(command.authorization.resource,consumerConfig.resource);
  const check=createSubscriptionAuthorizer({backend:b,resource:config.resource,allowedResources:[config.resource,consumerConfig.resource]});assert.equal(await check('google:123',{...command.authorization,name:'discord.mention.created'},['discord:read','discord:reply']),true);
  assert.equal(await check('google:123',{...command.authorization,resource:'https://unrelated.example/mcp',name:'discord.mention.created'}),false);
  t.mock.timers.enable({apis:['Date'],now:Date.now()});t.mock.timers.tick(16*60000);assert.equal(await auth.authenticate({headers:{authorization:'Bearer '+token}}),null);
  const refreshed=await call('/discord/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',client_id:client.client_id,refresh_token:issued.refresh_token,resource:consumerConfig.resource})});assert.equal(refreshed.status,200);const successor=await refreshed.json();assert.notEqual(successor.refresh_token,issued.refresh_token);assert.equal((await auth.authenticate({headers:{authorization:'Bearer '+successor.access_token}})).resource,consumerConfig.resource);rpcToken=successor.access_token;
  assert.ok((await rpc('tools/call',{name:'probe_status'})).body.error);assert.equal(sends.length,0);
  const raw=await b.read('oauth-state:v1');const grantId=Object.keys(raw.records).map(k=>JSON.parse(k)).find(([model])=>model==='Grant')[1];
  await b.update('oauth-state:v1',s=>{s.records[JSON.stringify(['Grant',grantId])].payload.rejected={resources:{[consumerConfig.resource]:'discord:read discord:reply'}};return {value:s};});
  assert.equal((await rpc('tools/list')).status,401);assert.equal(await check('google:123',{...command.authorization,name:'discord.mention.created'},['discord:read','discord:reply']),false);
});

test('X専用issuerは新規clientにx:readだけを付与し、X-only consentを経てtokenを発行する',async t=>{
  const b=backend(),xConfig={...config,origin:config.origin+'/x',resource:config.origin+'/mcp/x',discordEnabled:false,xEnabled:true,consumerOnly:true,consumerCookiePrefix:'x',oauthStateKey:'oauth-state:x:v1',discordUnattendedEnabled:true};let nonce='';
  const auth=createOAuth({config:xConfig,backend:b,google:{verifyIdToken:async()=>({getPayload:()=>({iss:'https://accounts.google.com',aud:config.googleClientId,nonce,email:'fixture@gmail.com',email_verified:true,sub:'123'})})}});
  const routed=routeSourceOAuth(auth,{x:auth});const server=createServer(createRequestListener({auth:routed,store:memoryStore()}));await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
  const base='http://127.0.0.1:'+server.address().port,cookies=new Map();
  async function call(path,options={}){
    const r=await fetch(base+path,{...options,headers:{host:'probe.example','x-forwarded-proto':'https',cookie:[...cookies].map(([k,v])=>k+'='+v).join('; '),...options.headers},redirect:'manual'});
    for(const c of r.headers.getSetCookie()){const pair=c.split(';')[0],i=pair.indexOf('=');cookies.set(pair.slice(0,i),pair.slice(i+1));}return r;
  }
  const metadata=await (await call('/.well-known/oauth-protected-resource/mcp/x')).json();assert.equal(metadata.resource,xConfig.resource);assert.deepEqual(metadata.scopes_supported,['x:read','openid','offline_access']);
  const discovery=await (await call('/.well-known/oauth-authorization-server/x')).json();assert.equal(discovery.issuer,xConfig.origin);assert.deepEqual(discovery.scopes_supported,['openid','offline_access','x:read']);
  const reg=await call('/x/reg',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({redirect_uris:config.redirects,token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code']})});assert.equal(reg.status,201);const client=await reg.json();assert.equal(client.scope,'openid offline_access x:read');
  const verifier='EPHEMERAL-X-PKCE-VERIFIER-012345678901234567890';const challenge=createHash('sha256').update(verifier).digest('base64url');
  const q=new URLSearchParams({client_id:client.client_id,redirect_uri:config.redirects[0],response_type:'code',scope:'openid offline_access x:read',resource:xConfig.resource,code_challenge:challenge,code_challenge_method:'S256',state:'x-test'});
  const first=await call('/x/auth?'+q);assert.equal(first.status,303);const loginPath=first.headers.get('location');nonce=new URL(loginPath).pathname.split('/').at(-1);
  const login=await call(loginPath,{method:'POST',headers:{'content-type':'application/json',origin:config.origin},body:JSON.stringify({action:'login',credential:'FAKE-GOOGLE-INPUT'})});assert.equal(login.status,200);
  const resume=await call((await login.json()).redirect);const consentPath=resume.headers.get('location');const html=await (await call(consentPath)).text();assert.ok(html.includes('X access is read-only'));assert.equal(html.includes('Discord access for guild'),false);
  const consent=await call(consentPath,{method:'POST',headers:{'content-type':'application/json',origin:config.origin},body:JSON.stringify({action:'consent'})});assert.equal(consent.status,200);
  const authorized=await call((await consent.json()).redirect);const redirect=new URL(authorized.headers.get('location'));
  const exchange=await call('/x/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',client_id:client.client_id,code:redirect.searchParams.get('code'),redirect_uri:config.redirects[0],code_verifier:verifier,resource:xConfig.resource})});assert.equal(exchange.status,200);const issued=await exchange.json();
  const principal=await auth.authenticate({headers:{authorization:'Bearer '+issued.access_token}});assert.equal(principal.resource,xConfig.resource);assert.deepEqual(principal.scopes,['x:read']);assert.ok(principal.grantExpiresAt-Date.now()>89*86400000);
});

test('コンシューマルーティングはメインissuerを維持し、認証前にエンドポイント固有のチャレンジを返す',async t=>{
 const main=createOAuth({config,backend:backend()}),consumer=createOAuth({config:{...config,origin:config.origin+'/discord',resource:config.origin+'/mcp/discord',discordConsumerOnly:true},backend:backend()});
 const routed=routeConsumerOAuth(main,consumer);const server=createServer(createRequestListener({auth:routed,store:memoryStore()}));await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));const base='http://127.0.0.1:'+server.address().port;
 for(const [path,expected]of [['/mcp',main.challenge],['/mcp/discord',consumer.challenge]]){const r=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});assert.equal(r.status,401);assert.equal(r.headers.get('www-authenticate'),expected);}
 const original=await(await fetch(base+'/.well-known/openid-configuration')).json();assert.equal(original.issuer,config.origin);assert(original.scopes_supported.includes('probe'));
 const minimal=await(await fetch(base+'/.well-known/oauth-authorization-server/discord')).json();assert.equal(minimal.issuer,config.origin+'/discord');assert.deepEqual(minimal.scopes_supported,['openid','offline_access','discord:read','discord:reply']);
});
