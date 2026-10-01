import test from 'node:test';import assert from 'node:assert/strict';import {Webhook} from 'standardwebhooks';
import {createHandler,EVENT,TEXT} from '../lib/probe.mjs';import {memoryStore,assertStore} from '../lib/store.mjs';
// Public fixed fixtures, never real credentials or source data.
const PROBE='00000000-0000-4000-8000-000000000000';
const SECRET='whsec_'+Buffer.alloc(32,1).toString('base64');
const params=()=>({name:EVENT,arguments:{probe_id:PROBE},delivery:{mode:'webhook',url:'https://receiver.example.com/probe',secret:SECRET}});
function fixture(){const store=memoryStore(),calls=[];const transport=async(url,options)=>{const value=new Webhook(SECRET).verify(options.body,options.headers);calls.push(value);return {ok:true,status:200,json:async()=>({challenge:value.challenge})};};return {store,calls,handle:createHandler(store,transport)};}
test('reused discovery and event schemas remain synthetic only',async()=>{const f=fixture();assert.deepEqual((await f.handle('server/discover')).supportedVersions,['2026-07-28']);assert.equal((await f.handle('events/list')).events[0].payloadSchema.properties.text.const,TEXT);});
test('signed challenge, idempotent subscription, one fixed-payload delivery, redacted status',async()=>{
 const f=fixture(),p=params();const a=await f.handle('events/subscribe',p,'owner');const b=await f.handle('events/subscribe',p,'owner');assert.equal(a.id,b.id);
 const emit={name:'emit_probe',arguments:p.arguments};await Promise.all([f.handle('tools/call',emit,'owner'),f.handle('tools/call',emit,'owner')]);
 const events=f.calls.filter(x=>x.name===EVENT);assert.equal(events.length,1);assert.deepEqual(events[0].data,{probe_id:PROBE,text:TEXT});
 const status=JSON.stringify(await f.handle('tools/call',{name:'probe_status'},'owner'));assert.ok(!status.includes(SECRET)&&!status.includes('receiver.example.com'));assert.ok(status.includes('receipt_acknowledged'));
});
test('wrong challenge never persists subscription',async()=>{const store=memoryStore();await assert.rejects(createHandler(store,async()=>({ok:true,json:async()=>({challenge:'wrong'})}))('events/subscribe',params(),'owner'),{code:-32015});assert.deepEqual(await store.status('owner'),[]);});
test('owner isolation, expiration and authorization',async()=>{const f=fixture(),p=params();const {id}=await f.handle('events/subscribe',p,'owner');await f.handle('events/unsubscribe',p,'other');assert.ok(await f.store.get(id,'owner'));assert.equal(await f.store.get(id,'other'),null);await assert.rejects(f.handle('tools/call',{name:'probe_status'}),{code:-32001});const s=await f.store.get(id,'owner');s.expires=0;await f.store.put(s);await assert.rejects(f.handle('tools/call',{name:'emit_probe',arguments:p.arguments},'owner'));});
test('ambiguous delivery is not retried even after unsubscribe and URL change',async()=>{const f=fixture(),p=params();await f.handle('events/subscribe',p,'owner');let calls=0;const h=createHandler(f.store,async()=>{calls++;throw Error('unknown');});const emit={name:'emit_probe',arguments:p.arguments};await h('tools/call',emit,'owner');await f.handle('events/unsubscribe',p,'owner');p.delivery.url='https://other.example.com/probe';await f.handle('events/subscribe',p,'owner');await h('tools/call',emit,'owner');assert.equal(calls,1);});
test('in-memory store is rejected for production',()=>assert.throws(()=>assertStore(memoryStore(),true),/Durable/));
