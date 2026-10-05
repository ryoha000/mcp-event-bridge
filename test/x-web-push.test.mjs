import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createConsolidatedRuntime} from '../consolidated-runtime.mjs';
import {createTweetLookup,createXWebPushAdapter,X_WEB_PUSH_EVENT,readXWebPushConfig,statusRefFrom,tweetFromPush} from '../lib/adapters/x-web-push.mjs';
import {createEventService} from '../lib/events/service.mjs';
import {createEventStore} from '../lib/events/store.mjs';

const channel='100000000000000600',owner='google:fixture',resource='https://bridge.example/mcp/discord',xResource='https://bridge.example/mcp/x';
function memory(){
 const data=new Map();
 return {durable:true,async read(k){return structuredClone(data.get(k)??null);},async update(k,fn){const next=fn(structuredClone(data.get(k)??null));if(Object.hasOwn(next,'value'))data.set(k,structuredClone(next.value));return next.result;}};
}

test('X Web Push adapter preserves raw JSON and derives a stable event ID',async()=>{
 let at=Date.parse('2026-10-05T00:00:00.000Z');
 const adapter=createXWebPushAdapter({sourceId:'@owner',now:()=>at});
 const raw={title:'owner posted',body:'raw tweet text',data:{url:'https://x.com/owner/status/123'}};
 const first=await adapter.normalize(raw);at+=1000;const second=await adapter.normalize(raw);
 assert.equal(first.eventId,second.eventId);
 assert.equal(first.source,'x');assert.equal(first.name,X_WEB_PUSH_EVENT);
 assert.deepEqual(first.data.payload,raw);
 assert.deepEqual(adapter.callbackData(first).payload,raw);
 // lookup 未設定でも status URL 参照があれば通知由来の partial tweet が付く
 assert.equal(first.data.tweet.partial,true);
 assert.equal(first.data.tweet.id,'123');assert.equal(first.data.tweet.url,'https://x.com/owner/status/123');
 assert.equal(first.data.tweet.text,'raw tweet text');assert.equal(first.data.tweet.author.name,'owner posted');
 assert.equal(first.data.tweet.author.screen_name,'owner');
 assert.equal(adapter.callbackData(first).tweet.partial,true);
 assert.deepEqual(adapter.subscriptionInputSchema,{type:'object',properties:{},additionalProperties:false});
 assert.throws(()=>adapter.validateSubscriptionArguments({anything:'else'}));
 await assert.rejects(adapter.normalize({body:'x'.repeat(13000)}));
 assert.deepEqual(readXWebPushConfig({}),{enabled:false});
 assert.deepEqual(readXWebPushConfig({X_WEB_PUSH_SOURCE_ID:''}),{enabled:false});
 assert.deepEqual(readXWebPushConfig({X_WEB_PUSH_SOURCE_ID:'@owner'}),{enabled:true,sourceId:'@owner',tweetApi:'https://api.fxtwitter.com'});
 assert.deepEqual(readXWebPushConfig({X_WEB_PUSH_SOURCE_ID:'@owner',X_WEB_PUSH_TWEET_API:'none'}),{enabled:true,sourceId:'@owner',tweetApi:null});
 assert.throws(()=>readXWebPushConfig({X_WEB_PUSH_SOURCE_ID:'invalid source'}));
 assert.throws(()=>readXWebPushConfig({X_WEB_PUSH_SOURCE_ID:'@owner',X_WEB_PUSH_TWEET_API:'http://lookup.example'}));
 assert.throws(()=>readXWebPushConfig({X_WEB_PUSH_SOURCE_ID:'@owner',X_WEB_PUSH_TWEET_API:'https://user@lookup.example'}));
});

test('statusRefFrom finds the first status URL inside bounded untrusted JSON',()=>{
 assert.deepEqual(statusRefFrom({data:{url:'https://x.com/owner/status/123'}}),{user:'owner',id:'123',url:'https://x.com/owner/status/123'});
 assert.deepEqual(statusRefFrom({a:[1,{b:'see https://twitter.com/a_b/statuses/456?x=1'}]}),{user:'a_b',id:'456',url:'https://twitter.com/a_b/statuses/456'});
 assert.deepEqual(statusRefFrom({data:{uri:'https://x.com/i/web/status/789'}}),{id:'789',url:'https://x.com/i/web/status/789'});
 assert.deepEqual(statusRefFrom('open https://mobile.twitter.com/o/status/42'),{user:'o',id:'42',url:'https://mobile.twitter.com/o/status/42'});
 assert.equal(statusRefFrom({data:{url:'https://x.com/owner'}}),null);
 assert.equal(statusRefFrom('https://evil.example/owner/status/123'),null);
 assert.equal(statusRefFrom({deep:{deep:{deep:{deep:{deep:{deep:{deep:{deep:'https://x.com/o/status/1'}}}}}}}}),null);
 const wide={};for(let i=0;i<80;i++)wide['k'+i]=i;wide.k79='https://x.com/o/status/1';assert.equal(statusRefFrom(wide),null);
});

test('tweetFromPush assembles a partial tweet from fields the notification already carries',()=>{
 const ref={id:'42',url:'https://x.com/i/web/status/42'};
 const tweet=tweetFromPush({title:'@owner',body:'hello',icon:'https://pbs.twimg.com/profile_images/x.jpg',timestamp:1791221317000,image:'https://pbs.twimg.com/media/y.jpg',data:{lang:'ja',uri:'https://x.com/i/web/status/42'}},ref);
 assert.deepEqual(tweet,{partial:true,url:'https://x.com/i/web/status/42',id:'42',text:'hello',created_timestamp:1791221317,lang:'ja',author:{screen_name:'owner',avatar_url:'https://pbs.twimg.com/profile_images/x.jpg'},media:{photos:[{url:'https://pbs.twimg.com/media/y.jpg'}]}});
 assert.deepEqual(tweetFromPush({title:'Display Name',body:'b'},{id:'1'}),{partial:true,id:'1',text:'b',author:{name:'Display Name'}});
 assert.deepEqual(tweetFromPush({body:'b'},{user:'u',id:'1'}),{partial:true,id:'1',text:'b',author:{screen_name:'u'}});
 assert.deepEqual(tweetFromPush({title:'t',body:'b',icon:'http://insecure.example/x.jpg',image:'javascript:alert(1)',timestamp:-1},{id:'1'}),{partial:true,id:'1',text:'b',author:{name:'t'}});
});

test('fxtwitter lookup builds a fixed-host URL and curates bounded tweet fields',async()=>{
 const calls=[];
 const lookup=createTweetLookup({api:'https://api.fxtwitter.com/',fetchImpl:async(url,init)=>{
  calls.push({url,init});
  return {ok:true,headers:{get:()=>'4096'},text:async()=>JSON.stringify({code:200,tweet:{
   url:'https://x.com/u/status/1',id:'1',text:'hi',created_at:'Tue Oct 06 00:00:00 +0000 2026',created_timestamp:1,lang:'ja',
   possibly_sensitive:true,is_note_tweet:true,replies:1,retweets:2,likes:3,bookmarks:4,quotes:5,views:6,
   replying_to:{screen_name:'other'},replying_to_status:['42'],extra:'dropped',
   author:{name:'n',screen_name:'u',avatar_url:'https://a',description:'x'.repeat(5000),followers:1},
   media:{photos:[{type:'photo',url:'https://pbs.twimg.com/media/x.jpg',width:1,height:2,altText:'alt'}],videos:[{type:'video',url:'https://v.twimg.com/v.mp4',thumbnail_url:'https://v.twimg.com/t.jpg',width:3,height:4,duration:5}],all:[{url:'https://skip.example'}]},
   quote:{id:'2',text:'q',author:{name:'qn'},quote:{id:'3',text:'too deep'}}
  }})};
 }});
 const tweet=await lookup({user:'u',id:'1'});
 assert.equal(calls.length,1);
 assert.equal(calls[0].url,'https://api.fxtwitter.com/u/status/1');
 await lookup({id:'1'});
 assert.equal(calls[1].url,'https://api.fxtwitter.com/status/1');
 assert.equal(calls[0].init.headers.accept,'application/json');
 assert.deepEqual(tweet,{
  url:'https://x.com/u/status/1',id:'1',text:'hi',created_at:'Tue Oct 06 00:00:00 +0000 2026',created_timestamp:1,lang:'ja',
  possibly_sensitive:true,is_note_tweet:true,replies:1,retweets:2,likes:3,bookmarks:4,quotes:5,views:6,
  replying_to:'other',replying_to_status:'42',
  author:{name:'n',screen_name:'u'},
  media:{photos:[{url:'https://pbs.twimg.com/media/x.jpg',width:1,height:2,alt:'alt'}],videos:[{url:'https://v.twimg.com/v.mp4',thumbnail_url:'https://v.twimg.com/t.jpg',width:3,height:4,duration:5,type:'video'}]},
  quote:{id:'2',text:'q',author:{name:'qn'}}
 });
 for(const fetchImpl of [async()=>({ok:false}),async()=>{throw Error('net')},async()=>({ok:true,headers:{get:()=>'999999'},text:async()=>'{}'}),async()=>({ok:true,headers:{get:()=>'10'},text:async()=>'not json'})])assert.equal(await createTweetLookup({fetchImpl})({user:'u',id:'1'}),null);
 assert.throws(()=>createTweetLookup({api:'http://lookup.example'}));
});

test('oversized tweet enrichment shrinks to fit the event envelope while keeping media URLs',async()=>{
 const photo=i=>({url:'https://pbs.twimg.com/media/'+'A'.repeat(15)+i+'.jpg',alt:'あ'.repeat(1024)});
 const adapter=createXWebPushAdapter({sourceId:'@owner',lookup:async()=>({text:'あ'.repeat(4000),author:{name:'n'},media:{photos:[photo(1),photo(2),photo(3),photo(4)]},quote:{id:'9',text:'q'.repeat(4000)}})});
 const e=await adapter.normalize({data:{url:'https://x.com/o/status/1'}});
 assert.ok(Buffer.byteLength(JSON.stringify(e))<=15000);
 assert.equal(e.data.tweet.quote,undefined);
 assert.ok(e.data.tweet.text.length<=2000);
 assert.ok(e.data.tweet.media.photos.every(p=>p.url&&p.alt===undefined));
});

test('grossly oversized tweet enrichment degrades to the partial push-assembled tweet',async()=>{
 const adapter=createXWebPushAdapter({sourceId:'@owner',lookup:async()=>({text:'あ'.repeat(4000),author:{name:'n'.repeat(128)},media:{photos:[{url:'https://pbs.twimg.com/media/'+'A'.repeat(15)+'.jpg',alt:'あ'.repeat(1024)}]},quote:{id:'9',text:'q'.repeat(4000)},junk:'x'.repeat(30000)})});
 const e=await adapter.normalize({title:'owner posted',body:'short text',data:{url:'https://x.com/o/status/1'}});
 assert.ok(Buffer.byteLength(JSON.stringify(e))<=15000);
 assert.equal(e.data.tweet.partial,true);
 assert.equal(e.data.tweet.id,'1');assert.equal(e.data.tweet.text,'short text');
});

test('host-local X ingest fans raw payload and bounded tweet into MCP Events and remains read-only',async t=>{
 const backend=memory();await backend.update('google-owner:v1',()=>({value:{sub:'fixture'}}));
 const at=Date.now(),callbacks=[],lookups=[];
 const tweet={url:'https://x.com/owner/status/123',id:'123',text:'full tweet text',author:{name:'owner',screen_name:'owner'},media:{photos:[{url:'https://pbs.twimg.com/media/a.jpg'}]}};
 const adapter=createXWebPushAdapter({sourceId:'@owner',now:()=>at,lookup:async ref=>{lookups.push(ref);return tweet;}});
 const principal={owner,clientId:'fake-client',grantId:'fake-grant',grantExpiresAt:at+86400000,resource:xResource,scopes:['x:read']};
 let activePrincipal=principal;
 const runtime=await createConsolidatedRuntime({
  backend,resource,sourceResources:{x:xResource},token:'FAKE',channelIds:[channel],extraAdapters:[adapter],localIngestRoutes:[{path:'/internal/x-web-push',source:'x'}],authorizeSubscription:async()=>true,now:()=>at,
  auth:{productionReady:true,consumerPaths:['/mcp/x'],challenge:'Bearer fixture',authenticate:async req=>req.headers.authorization==='Bearer fixture'?activePrincipal:null,handleHttp:async()=>false},
  gatewayFactory:()=>({start:async()=>{},stop(){},release:async()=>{}}),
  sendMessage:async()=>({ok:true,messageId:'100000000000002000'}),
  transport:async(_url,request)=>{
   const body=JSON.parse(request.body);
   if(body.type==='verification')return {ok:true,status:200,json:async()=>({challenge:body.challenge})};
   callbacks.push(body);return {status:204};
  }
 });
 const server=createServer(runtime.requestListener);server.keepAliveTimeout=1;await new Promise(done=>server.listen(0,'127.0.0.1',done));
 t.after(async()=>{await runtime.shutdown();server.closeAllConnections();await new Promise(done=>server.close(done));});
 const base='http://127.0.0.1:'+server.address().port;
 const rpc=async(method,params={})=>(await fetch(base+'/mcp/x',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer fixture'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})})).json();
 const subscription=await rpc('events/subscribe',{name:X_WEB_PUSH_EVENT,arguments:{},delivery:{mode:'webhook',url:'https://callback.example/wake',secret:'whsec_'+Buffer.alloc(32,8).toString('base64')}});
 assert.equal(subscription.error,undefined);
 const listed=await rpc('tools/list');assert.deepEqual(listed.result.tools.map(x=>x.name),['x_status','x_read_event']);assert.equal(listed.result.tools[0].annotations.readOnlyHint,true);
 const raw={title:'owner posted',body:'raw tweet text',data:{url:'https://x.com/owner/status/123'}};
 const ingested=await fetch(base+'/internal/x-web-push',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(raw)});
 assert.equal(ingested.status,202);assert.equal((await ingested.json()).duplicate,false);
 assert.deepEqual(lookups,[{user:'owner',id:'123',url:'https://x.com/owner/status/123'}]);
 await runtime.worker.flush();
 assert.equal(callbacks.length,1);assert.equal(callbacks[0].name,X_WEB_PUSH_EVENT);assert.deepEqual(callbacks[0].data.payload,raw);assert.deepEqual(callbacks[0].data.tweet,tweet);
 const eventId=callbacks[0].data.event_id;
 const read=await rpc('tools/call',{name:'x_read_event',arguments:{event_id:eventId}});
 const stored=JSON.parse(read.result.content[0].text);
 assert.deepEqual(stored.data.payload,raw);assert.deepEqual(stored.data.tweet,tweet);
 const reply=await rpc('tools/call',{name:'x_reply_to_event',arguments:{event_id:eventId,content:'nope'}});assert.ok(reply.error);
 const duplicate=await fetch(base+'/internal/x-web-push',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(raw)});
 assert.equal((await duplicate.json()).duplicate,true);await runtime.worker.flush();assert.equal(callbacks.length,1);assert.equal(lookups.length,2);
});

test('X Web Push ingest falls back to a push-assembled partial tweet when the lookup fails',async t=>{
 const backend=memory();await backend.update('google-owner:v1',()=>({value:{sub:'fixture'}}));
 const at=Date.now(),callbacks=[];
 const adapter=createXWebPushAdapter({sourceId:'@owner',now:()=>at,lookup:async()=>{throw Error('fake lookup down');}});
 const principal={owner,clientId:'fake-client',grantId:'fake-grant',grantExpiresAt:at+86400000,resource:xResource,scopes:['x:read']};
 const runtime=await createConsolidatedRuntime({
  backend,resource,sourceResources:{x:xResource},token:'FAKE',channelIds:[channel],extraAdapters:[adapter],localIngestRoutes:[{path:'/internal/x-web-push',source:'x'}],authorizeSubscription:async()=>true,now:()=>at,
  auth:{productionReady:true,consumerPaths:['/mcp/x'],challenge:'Bearer fixture',authenticate:async req=>req.headers.authorization==='Bearer fixture'?principal:null,handleHttp:async()=>false},
  gatewayFactory:()=>({start:async()=>{},stop(){},release:async()=>{}}),
  sendMessage:async()=>({ok:true,messageId:'100000000000002000'}),
  transport:async(_url,request)=>{const body=JSON.parse(request.body);if(body.type==='verification')return {ok:true,status:200,json:async()=>({challenge:body.challenge})};callbacks.push(body);return {status:204};}
 });
 const server=createServer(runtime.requestListener);server.keepAliveTimeout=1;await new Promise(done=>server.listen(0,'127.0.0.1',done));
 t.after(async()=>{await runtime.shutdown();server.closeAllConnections();await new Promise(done=>server.close(done));});
 const base='http://127.0.0.1:'+server.address().port;
 const rpc=async(method,params={})=>(await fetch(base+'/mcp/x',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer fixture'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})})).json();
 await rpc('events/subscribe',{name:X_WEB_PUSH_EVENT,arguments:{},delivery:{mode:'webhook',url:'https://callback.example/wake',secret:'whsec_'+Buffer.alloc(32,8).toString('base64')}});
 const raw={title:'owner posted',body:'raw tweet text',data:{url:'https://x.com/owner/status/123'}};
 const first=await fetch(base+'/internal/x-web-push',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(raw)});
 assert.equal(first.status,202);
 await runtime.worker.flush();
 assert.equal(callbacks.length,1);assert.deepEqual(callbacks[0].data.payload,raw);
 assert.equal(callbacks[0].data.tweet.partial,true);assert.equal(callbacks[0].data.tweet.text,'raw tweet text');assert.equal(callbacks[0].data.tweet.id,'123');
 const notice={title:'dm notice',body:'no status link'};
 const second=await fetch(base+'/internal/x-web-push',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(notice)});
 assert.equal(second.status,202);
 await runtime.worker.flush();
 assert.equal(callbacks.length,2);assert.equal('tweet' in callbacks[1].data,false);
});

test('X status is read-only and filters owner, source and tenant without returning private values',async()=>{
 const backend=memory(),at=Date.now(),store=createEventStore({backend,now:()=>at});
 const adapter=createXWebPushAdapter({sourceId:'@private-account',now:()=>at});
 const service=createEventService({store,adapters:[adapter]});
 const principal={owner,clientId:'PRIVATE-CLIENT',grantId:'PRIVATE-GRANT',grantExpiresAt:at+3600000,resource:xResource,scopes:['x:read']};
 const secret='PRIVATE-SUBSCRIPTION-SECRET',url='https://private-callback.example/wake';
 await store.subscribe(owner,{id:'sub_fixture',name:X_WEB_PUSH_EVENT,tenantId:adapter.tenantId,clientId:principal.clientId,grantId:principal.grantId,resource:xResource,url,secret,expires:at+3600000});
 await store.ingest(owner,await adapter.normalize({body:'PRIVATE-NOTIFICATION',endpoint:'PRIVATE-PUSH-CREDENTIAL'}));
 const otherTenant=createXWebPushAdapter({sourceId:'@other-tenant',now:()=>at});
 await store.ingest(owner,await otherTenant.normalize({body:'PRIVATE-OTHER-TENANT'}));
 await store.ingest('google:other-owner',await adapter.normalize({body:'PRIVATE-OTHER-OWNER'}));
 const otherSource={...await adapter.normalize({body:'PRIVATE-DISCORD-CONTENT'}),source:'discord',name:'discord.mention.created'};
 const {eventIdFor}=await import('../lib/events/envelope.mjs');
 otherSource.eventId=eventIdFor(otherSource.source,otherSource.origin.tenantId,otherSource.origin.messageId,otherSource.name);await store.ingest(owner,otherSource);
 let writes=0,reads=0;const update=backend.update,read=backend.read;
 backend.update=async(...args)=>{writes++;return update(...args);};backend.read=async(...args)=>{reads++;return read(...args);};
 const call=p=>service.handle('tools/call',{name:'x_status',arguments:{}},p);
 const response=JSON.parse((await call(principal)).content[0].text);
 assert.deepEqual(response,{source:'x',event:X_WEB_PUSH_EVENT,configuration:{sourceConfigured:true,contextPolicy:'origin_event_only'},counts:{events:1,subscriptions:{total:1,unexpired:1,currentConnectionActive:1},deliveries:{pending:1,inflight:0,acknowledged:0,dead:0,revoked:0}}});
 const text=JSON.stringify(response);for(const value of [owner,principal.clientId,principal.grantId,adapter.tenantId,secret,url,'PRIVATE','@other-tenant','google:other-owner'])assert.equal(text.includes(value),false);
 const other=JSON.parse((await call({...principal,owner:'google:no-events'})).content[0].text);assert.equal(other.counts.events,0);assert.equal(other.counts.subscriptions.total,0);
 assert.equal(writes,0);assert.equal(reads,2);
 const before=reads;
 for(const denied of [{...principal,owner:''},{...principal,clientId:''},{...principal,grantId:''},{...principal,scopes:['discord:read']},{...principal,grantExpiresAt:at-1}])await assert.rejects(call(denied));
 await assert.rejects(service.handle('tools/call',{name:'x_status',arguments:{owner:'other'}},principal));assert.equal(reads,before);
 assert.deepEqual(service.tools({...principal,scopes:['discord:read']}),[]);
 await assert.rejects(createEventService({store,adapters:[]}).handle('tools/call',{name:'x_status',arguments:{}},principal));
});
