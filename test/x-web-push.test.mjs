import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createConsolidatedRuntime} from '../consolidated-runtime.mjs';
import {createXWebPushAdapter,X_WEB_PUSH_EVENT,readXWebPushConfig} from '../lib/adapters/x-web-push.mjs';

const channel='100000000000000600',owner='google:fixture',resource='https://bridge.example/mcp/discord';
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
 assert.deepEqual(readXWebPushConfig({X_WEB_PUSH_ENABLE:'false'}),{enabled:false});
 assert.deepEqual(readXWebPushConfig({X_WEB_PUSH_ENABLE:'true',X_WEB_PUSH_SOURCE_ID:'@owner'}),{enabled:true,sourceId:'@owner'});
});

test('host-local X ingest fans raw payload into MCP Events and remains read-only',async t=>{
 const backend=memory();await backend.update('google-owner:v1',()=>({value:{sub:'fixture'}}));
 const at=Date.now(),callbacks=[],adapter=createXWebPushAdapter({sourceId:'@owner',now:()=>at});
 const principal={owner,clientId:'fake-client',grantId:'fake-grant',grantExpiresAt:at+86400000,resource,scopes:['x:read']};
 const runtime=await createConsolidatedRuntime({
  backend,resource,token:'FAKE',channelIds:[channel],extraAdapters:[adapter],localIngestRoutes:[{path:'/internal/x-web-push',source:'x'}],authorizeSubscription:async()=>true,now:()=>at,
  auth:{productionReady:true,challenge:'Bearer fixture',authenticate:async()=>principal,handleHttp:async()=>false},
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
 const rpc=async(method,params={})=>(await fetch(base+'/mcp/discord',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})})).json();
 const subscription=await rpc('events/subscribe',{name:X_WEB_PUSH_EVENT,arguments:{},delivery:{mode:'webhook',url:'https://callback.example/wake',secret:'whsec_'+Buffer.alloc(32,8).toString('base64')}});
 assert.equal(subscription.error,undefined);
 const listed=await rpc('tools/list');assert.deepEqual(listed.result.tools.map(x=>x.name),['x_read_event']);
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
