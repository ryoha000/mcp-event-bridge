import test from 'node:test';
import assert from 'node:assert/strict';
import {createGcsObjectBackend} from '../lib/gcs-store.mjs';
import {createEventStore} from '../lib/events/store.mjs';
import {createDiscordAdapter,GUILD_ID,BOT_ID,DISCORD_EVENT} from '../lib/adapters/discord.mjs';
import {digest} from '../lib/events/envelope.mjs';

class FakeStorage {
  objects=new Map();generation=0;ambiguous=false;
  bucket(name){assert.equal(name,'private-fake-events');const s=this;return {file(path,selector={}){return {
    async getMetadata(){const row=s.objects.get(path);if(!row)throw Object.assign(Error(),{code:404});return [{generation:row.generation,size:String(row.bytes.length)}];},
    async download(){const row=s.objects.get(path);if(!row||selector.generation!==row.generation)throw Object.assign(Error(),{code:404});return [Buffer.from(row.bytes)];},
    async save(bytes,options){const row=s.objects.get(path),match=options.preconditionOpts.ifGenerationMatch;if((!row&&match!==0)||(row&&match!==row.generation))throw Object.assign(Error(),{code:412});s.objects.set(path,{generation:String(++s.generation),bytes:Buffer.from(bytes)});if(s.ambiguous){s.ambiguous=false;throw Object.assign(Error('FAKE private diagnostic'),{code:504});}},
  };}};}
}
const OWNER='google:123';
const adapter=createDiscordAdapter({channelIds:['100000000000002200']});
const event=()=>adapter.normalize({op:0,t:'MESSAGE_CREATE',d:{id:'100000000000000200',channel_id:'100000000000002200',guild_id:GUILD_ID,author:{id:'100000000000002300'},type:0,mentions:[{id:BOT_ID}],content:'ordinary fake mention',timestamp:'2026-10-01T00:00:00Z'}});
const sub=()=>({id:'fake-sub',clientId:'fake-client',grantId:'fake-grant',name:DISCORD_EVENT,tenantId:GUILD_ID,url:'https://callback.example',secret:'whsec_'+Buffer.alloc(32,5).toString('base64'),expires:Date.now()+3600000});
test('新規イベントのファンアウトと配送クレームは独立したGCS裏付けストア間でアトミック',async()=>{
  const storage=new FakeStorage();const options={bucketName:'private-fake-events',storage,prefix:'source-events/v1/'};
  const a=createEventStore({backend:createGcsObjectBackend(options)}),b=createEventStore({backend:createGcsObjectBackend(options)});
  await a.subscribe(OWNER,sub());const ingests=await Promise.all([a.ingest(OWNER,event()),b.ingest(OWNER,event())]);assert.deepEqual(ingests.map(r=>r.duplicate).sort(),[false,true]);
  const claims=await Promise.all([a.claimDelivery(OWNER),b.claimDelivery(OWNER)]);assert.equal(claims.filter(Boolean).length,1);assert.equal((await b.status(OWNER)).deliveries.length,1);
  assert.ok([...storage.objects.keys()].every(k=>/^source-events\/v1\/[a-f0-9]{64}\.json$/.test(k)));
});
test('曖昧なGCSクレーム書き込みは再起動後も消費済みのまま。キュー済みコマンドは重複しない',async()=>{
  const storage=new FakeStorage(),backend=createGcsObjectBackend({bucketName:'private-fake-events',storage,prefix:'source-events/v1/'}),a=createEventStore({backend});const e=event();await a.ingest(OWNER,e);
  storage.ambiguous=true;await assert.rejects(a.claimReply(OWNER,e.eventId,digest('reply'),'reply',{clientId:'fake-client',grantId:'fake-grant'}));
  const b=createEventStore({backend});const repeated=await b.claimReply(OWNER,e.eventId,digest('reply'),'reply',{clientId:'fake-client',grantId:'fake-grant'});assert.equal(repeated.claimed,false);assert.equal(repeated.status,'queued');
  assert.ok((await b.claimQueuedReply(OWNER,'stable-pc-request')).command);assert.equal((await b.claimQueuedReply(OWNER,'second-pc-request')).command,null);
});
