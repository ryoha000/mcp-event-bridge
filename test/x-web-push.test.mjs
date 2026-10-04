import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createConsolidatedRuntime} from '../consolidated-runtime.mjs';
import {createXWebPushAdapter,X_WEB_PUSH_EVENT,readXWebPushConfig} from '../lib/adapters/x-web-push.mjs';
import {createEventService} from '../lib/events/service.mjs';
import {createEventStore} from '../lib/events/store.mjs';

const channel='100000000000000600',owner='google:fixture',resource='https://bridge.example/mcp/discord',xResource='https://bridge.example/mcp/x';
function memory(){
 const data=new Map();
 return {durable:true,async read(k){return structuredClone(data.get(k)??null);},async update(k,fn){const next=fn(structuredClone(data.get(k)??null));if(Object.hasOwn(next,'value'))data.set(k,structuredClone(next.value));return next.result;}};
}

test('X Web Push adapter preserves raw JSON and derives a stable event ID',()=>{
 let at=Date.parse('2026-10-05T00:00:00.000Z');
 const adapter=createXWebPushAdapter({sourceId:'@owner',now:()=>at});
 const raw={title:'owner posted',body:'raw tweet text',data:{url:'https://x.com/owner/status/123'}};
 const first=adapter.normalize(raw);at+=1000;const second=adapter.normalize(raw);
 assert.equal(first.eventId,second.eventId);
 assert.equal(first.source,'x');assert.equal(first.name,X_WEB_PUSH_EVENT);
 assert.deepEqual(first.data.payload,raw);
 assert.deepEqual(adapter.callbackData(first).payload,raw);
 assert.deepEqual(adapter.subscriptionInputSchema,{type:'object',properties:{},additionalProperties:false});
 assert.throws(()=>adapter.validateSubscriptionArguments({anything:'else'}));
 assert.throws(()=>adapter.normalize({body:'x'.repeat(13000)}));
 assert.deepEqual(readXWebPushConfig({}),{enabled:false});
 assert.deepEqual(readXWebPushConfig({X_WEB_PUSH_SOURCE_ID:''}),{enabled:false});
 assert.deepEqual(readXWebPushConfig({X_WEB_PUSH_SOURCE_ID:'@owner'}),{enabled:true,sourceId:'@owner'});
 assert.throws(()=>readXWebPushConfig({X_WEB_PUSH_SOURCE_ID:'invalid source'}));
});

test('host-local X ingest fans raw payload into MCP Events and remains read-only',async t=>{
 const backend=memory();await backend.update('google-owner:v1',()=>({value:{sub:'fixture'}}));
 const at=Date.now(),callbacks=[],adapter=createXWebPushAdapter({sourceId:'@owner',now:()=>at});
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
 const empty=JSON.parse((await rpc('tools/call',{name:'x_status',arguments:{}})).result.content[0].text);
 assert.equal(empty.counts.events,0);assert.equal(empty.counts.subscriptions.unexpired,0);assert.equal(empty.configuration.sourceConfigured,true);assert.equal(callbacks.length,0);
 const unauthenticated=await fetch(base+'/mcp/x',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'x_status',arguments:{}}})});assert.equal(unauthenticated.status,401);
 for(const denied of [{...principal,scopes:['discord:read']},{...principal,resource,scopes:['x:read']},{...principal,scopes:[]},{...principal,grantExpiresAt:at-1}]){
  activePrincipal=denied;assert.ok((await rpc('tools/call',{name:'x_status',arguments:{}})).error);
 }
 activePrincipal=principal;
 const subscription=await rpc('events/subscribe',{name:X_WEB_PUSH_EVENT,arguments:{},delivery:{mode:'webhook',url:'https://callback.example/wake',secret:'whsec_'+Buffer.alloc(32,8).toString('base64')}});
 assert.equal(subscription.error,undefined);
 const listed=await rpc('tools/list');assert.deepEqual(listed.result.tools.map(x=>x.name),['x_status','x_read_event']);assert.equal(listed.result.tools[0].annotations.readOnlyHint,true);
 const raw={title:'owner posted',body:'raw tweet text',data:{url:'https://x.com/owner/status/123'}};
 const ingested=await fetch(base+'/internal/x-web-push',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(raw)});
 assert.equal(ingested.status,202);assert.equal((await ingested.json()).duplicate,false);
 await runtime.worker.flush();
 assert.equal(callbacks.length,1);assert.equal(callbacks[0].name,X_WEB_PUSH_EVENT);assert.deepEqual(callbacks[0].data.payload,raw);
 const eventId=callbacks[0].data.event_id;
 const read=await rpc('tools/call',{name:'x_read_event',arguments:{event_id:eventId}});
 assert.deepEqual(JSON.parse(read.result.content[0].text).data.payload,raw);
 const reply=await rpc('tools/call',{name:'x_reply_to_event',arguments:{event_id:eventId,content:'nope'}});assert.ok(reply.error);
 const duplicate=await fetch(base+'/internal/x-web-push',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(raw)});
 assert.equal((await duplicate.json()).duplicate,true);await runtime.worker.flush();assert.equal(callbacks.length,1);
});

test('X status is read-only and filters owner, source and tenant without returning private values',async()=>{
 const backend=memory(),at=Date.now(),store=createEventStore({backend,now:()=>at});
 const adapter=createXWebPushAdapter({sourceId:'@private-account',now:()=>at});
 const service=createEventService({store,adapters:[adapter]});
 const principal={owner,clientId:'PRIVATE-CLIENT',grantId:'PRIVATE-GRANT',grantExpiresAt:at+3600000,resource:xResource,scopes:['x:read']};
 const secret='PRIVATE-SUBSCRIPTION-SECRET',url='https://private-callback.example/wake';
 await store.subscribe(owner,{id:'sub_fixture',name:X_WEB_PUSH_EVENT,tenantId:adapter.tenantId,clientId:principal.clientId,grantId:principal.grantId,resource:xResource,url,secret,expires:at+3600000});
 await store.ingest(owner,adapter.normalize({body:'PRIVATE-NOTIFICATION',endpoint:'PRIVATE-PUSH-CREDENTIAL'}));
 const otherTenant=createXWebPushAdapter({sourceId:'@other-tenant',now:()=>at});
 await store.ingest(owner,otherTenant.normalize({body:'PRIVATE-OTHER-TENANT'}));
 await store.ingest('google:other-owner',adapter.normalize({body:'PRIVATE-OTHER-OWNER'}));
 const otherSource={...adapter.normalize({body:'PRIVATE-DISCORD-CONTENT'}),source:'discord',name:'discord.mention.created'};
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
