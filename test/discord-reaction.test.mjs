import test from 'node:test';
import assert from 'node:assert/strict';
import {createDiscordEyes} from '../lib/adapters/discord-reaction.mjs';
import {createDiscordAdapter,BOT_ID,GUILD_ID} from '../lib/adapters/discord.mjs';
import {createTimingSink} from '../lib/events/timing.mjs';
const channel='100000000000000600',adapter=createDiscordAdapter({channelIds:[channel]});
const packet=()=>{const at=Date.now();return {op:0,t:'MESSAGE_CREATE',s:1,d:{id:String(BigInt(at-1420070400000)<<22n),guild_id:GUILD_ID,channel_id:channel,author:{id:'100000000000001700'},type:0,mentions:[{id:BOT_ID}],content:'PRIVATE-SOURCE-CONTENT',timestamp:new Date(at).toISOString()}};};
const event=()=>adapter.normalize(packet());
test('eyes uses only the idempotent fixed Unicode PUT; concurrent duplicate inputs produce one request',async()=>{
 const calls=[],e=event();let release;const wait=new Promise(done=>{release=done;});
 const worker=createDiscordEyes({token:'FAKE-PRIVATE-TOKEN',channelIds:[channel],fetchImpl:async(url,options)=>{calls.push({url,options});await wait;return new Response(null,{status:204});}});
 const first=worker.react(e),second=worker.react(e);assert.equal(first,second);assert.equal(calls.length,1);release();assert.equal(await first,true);
 assert.equal(calls[0].url,'https://discord.com/api/v10/channels/'+channel+'/messages/'+e.origin.messageId+'/reactions/%F0%9F%91%80/@me');assert.equal(calls[0].options.method,'PUT');assert.equal(calls[0].options.redirect,'error');assert.equal(calls[0].options.body,undefined);assert.equal(worker.statistics().duplicates,1);await worker.shutdown();
});
test('429 waits for retry_after; 5xx/network retries are bounded; 403 is not retried',async()=>{
 let at=1000,calls=0;const waits=[];
 const worker=createDiscordEyes({token:'FAKE',channelIds:[channel],now:()=>at,sleep:async ms=>{waits.push(ms);at+=ms;},fetchImpl:async()=>++calls===1?Response.json({retry_after:.5,global:true},{status:429}):new Response(null,{status:204})});
 assert.equal(await worker.react(event()),true);assert.deepEqual(waits,[500]);assert.equal(calls,2);await worker.shutdown();
 for(const status of [503,403]){let n=0;const w=createDiscordEyes({token:'FAKE',channelIds:[channel],sleep:async()=>{},fetchImpl:async()=>{n++;return new Response(null,{status});}});assert.equal(await w.react(event()),false);assert.equal(n,status===503?3:1);await w.shutdown();}
 let n=0;const fail=createDiscordEyes({token:'FAKE',channelIds:[channel],sleep:async()=>{},fetchImpl:async()=>{n++;throw Error('PRIVATE-FAILURE');}});assert.equal(await fail.react(event()),false);assert.equal(n,3);await fail.shutdown();
});
test('long rate limits are respected without unbounded waits, and queue overflow is bounded',async()=>{
 let n=0;const limited=createDiscordEyes({token:'FAKE',channelIds:[channel],fetchImpl:async()=>{n++;return Response.json({retry_after:60},{status:429});}});assert.equal(await limited.react(event()),false);assert.equal(n,1);await limited.shutdown();
 let release;const held=new Promise(done=>{release=done;});const worker=createDiscordEyes({token:'FAKE',channelIds:[channel],maxPending:1,fetchImpl:async()=>{await held;return new Response(null,{status:204});}});
 const a=event(),b=structuredClone(a),c=structuredClone(a);b.origin.messageId=String(BigInt(a.origin.messageId)+1n);c.origin.messageId=String(BigInt(a.origin.messageId)+2n);
 for(const e of [b,c])e.eventId=adapter.normalize({...packet(),d:{...packet().d,id:e.origin.messageId}}).eventId;
 const first=worker.react(a),second=worker.react(b);assert.equal(await worker.react(c),false);assert.equal(worker.statistics().overflow,1);release();assert.equal(await first,true);assert.equal(await second,true);await worker.shutdown();
});
test('timing logs allow only correlation, fixed stages and numbers; private objects and URLs never appear',()=>{
 const lines=[],sink=createTimingSink({sink:line=>lines.push(line),now:()=>1000});sink('mcp_handler_completed',{eventId:event().eventId,requestTrace:'abcdefab-abcd-abcd-abcd-abcdefabcdef',action:'discord_read_event',durationMs:1.234567,httpStatus:200,token:'PRIVATE-TOKEN',body:'PRIVATE-CONTENT',url:'https://PRIVATE-CALLBACK',grantId:'PRIVATE-GRANT'});sink('PRIVATE-PHASE',{body:'PRIVATE'});
 assert.equal(lines.length,1);assert(!lines[0].includes('PRIVATE'));const row=JSON.parse(lines[0]);assert.equal(row.durationMs,1.235);assert.equal(row.action,'discord_read_event');assert.equal(row.kind,'discord_stage_timing');
});
