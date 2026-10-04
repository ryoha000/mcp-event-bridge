import {createEventStore} from './lib/events/store.mjs';
import {createEventService,createCombinedHandler} from './lib/events/service.mjs';
import {createLocalEventWorker} from './lib/events/local-worker.mjs';
import {createDiscordAdapter} from './lib/adapters/discord.mjs';
import {createDiscordGateway} from './lib/adapters/discord-gateway.mjs';
import {discordRetention} from './lib/adapters/discord-retention.mjs';
import {createSubscriptionAuthorizer} from './lib/events/authorization.mjs';
import {createRequestListener} from './server.mjs';
import {memoryStore} from './lib/store.mjs';
import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID} from 'node:crypto';
// Gateway はこのプロセス内で保持し、外部ブリッジや別プロセスのスプールは存在しない。
// issuer/状態はこのインスタンスに属し、旧プローブ/コンシューマの許可(grant)はそのまま残る。
export async function createConsolidatedRuntime({backend,auth,resource,sourceResources={},oauthStateKeys={},channelIds,token,sendMessage,transport,gatewayFactory=createDiscordGateway,gatewayOwnership='durable-lease',gatewaySessionKey='consolidated-gateway:v1',authorizeSubscription,now=Date.now,timers={setTimeout,clearTimeout},onError=()=>{},onFatal=()=>{},onGatewayState=()=>{},reaction,onTiming=()=>{},inlineMentions=false,channelScope='allowlist',extraAdapters=[],localIngestRoutes=[]}){
 if(backend?.durable!==true||!resource?.endsWith('/mcp/discord')||!auth)throw Error('Consolidated runtime configuration refused');
 const mixedRetention={...discordRetention,identityTime:event=>event.source==='discord'?discordRetention.identityTime(event):Date.parse(event.timestamp)};
 const store=createEventStore({backend,retention:mixedRetention,requireLiveSubscription:true,now});
 const adapter=createDiscordAdapter({channelIds,sendMessage,inlineMentions,channelScope});
 if(!Array.isArray(extraAdapters)||extraAdapters.some(a=>!a||typeof a.source!=='string'||typeof a.normalize!=='function'||typeof a.validate!=='function'))throw Error('Invalid extra event adapters');
 const adapters=[adapter,...extraAdapters];
 if(new Set(adapters.map(a=>a.source)).size!==adapters.length)throw Error('Duplicate event source');
 const resources={discord:resource,...sourceResources};
 for(const a of adapters)resources[a.source]??=resource;
 const resourceSources=new Map();
 for(const [source,target] of Object.entries(resources)){if(typeof target!=='string'||!target.startsWith('https://'))throw Error('Invalid source resource');const set=resourceSources.get(target)??new Set();set.add(source);resourceSources.set(target,set);}
 const allowedResources=[...resourceSources.keys()];
 const resourcePaths=new Set(allowedResources.map(target=>new URL(target).pathname));
 const ingestRoutes=new Map();
 for(const route of localIngestRoutes){
  if(!route||typeof route.path!=='string'||!route.path.startsWith('/internal/')||typeof route.source!=='string'||!adapters.some(a=>a.source===route.source)||ingestRoutes.has(route.path))throw Error('Invalid local ingest route');
  ingestRoutes.set(route.path,route.source);
 }
 const requestContext=new AsyncLocalStorage(),timing=(phase,details)=>{try{onTiming(phase,details);}catch{}};
 const authorize=authorizeSubscription??createSubscriptionAuthorizer({backend,resource,allowedResources,stateKeyForResource:target=>oauthStateKeys[target]??'oauth-state:v1'});
 const callbackData=event=>{const sourceAdapter=adapters.find(a=>a.source===event.source);return sourceAdapter?.callbackData?sourceAdapter.callbackData(event):{event_id:event.eventId,source:event.source,guild_id:event.origin.tenantId};};
 const worker=createLocalEventWorker({store,adapter,callbackData,transport,authorizeSubscription:authorize,now,timers,onError,onTiming:timing});
 const events=createEventService({store,adapters,transport,queueReplies:true,authorizeQueuedReply:authorize,subscriptionTtlMs:8*3600000,diagnosticSink:()=>{},statusConfiguration:{channelAllowlistCount:channelScope==='allowlist'?channelIds.length:null,channelAccessPolicy:channelScope,replyExecution:'queued_locally',mechanicalEyesEnabled:!!reaction,inlineMentionPayload:inlineMentions}});
 let stopped=false,pressureTimer,releasePressure;
 const gateway=gatewayFactory({token,backend,sessionKey:gatewaySessionKey,ownership:gatewayOwnership,leaseMs:900000,leaseRenewalMs:300000,onState:onGatewayState,now,timers,
  onDispatch:async(packet,metadata={})=>{
   const event=adapter.normalize(packet);if(!event)return;
   const born=discordRetention.identityTime(event);if(born+discordRetention.replayMs<=now()||born>now()+300000)return;
   timing('gateway_received',{eventId:event.eventId,atMs:metadata.receivedAtMs??now(),sourceTimestamp:event.timestamp});
   try{void reaction?.react(event)?.catch(()=>{});}catch{}
   while(!stopped){
    try{
     const pinned=await backend.read('google-owner:v1');if(!pinned?.sub)throw Object.assign(Error('Owner consent pending'),{code:'EVENT_SUBSCRIPTION_PAUSED'});
     const owner='google:'+pinned.sub,began=performance.now();timing('ingest_started',{eventId:event.eventId});await store.ingest(owner,event);timing('ingest_committed',{eventId:event.eventId,durationMs:performance.now()-began});void worker.wake(owner);return;
    }catch(error){
     if(error?.code==='EVENT_EXPIRED')return; // 意図的な経過時間切れ破棄。返信/受理は不可能。
     if(!['EVENT_SUBSCRIPTION_PAUSED','EVENT_CAPACITY','STORAGE_CAPACITY'].includes(error?.code))throw error;
     try{onError('Consolidated ingest paused; Gateway sequence retained');}catch{}
     await new Promise(done=>{releasePressure=done;pressureTimer=timers.setTimeout(done,15000);});
    }
   }
   throw Error('Consolidated runtime stopped before durable ingest');
  },onFatal:()=>{stop();try{onFatal();}catch{}}});
 function stop(){stopped=true;timers.clearTimeout(pressureTimer);releasePressure?.();worker.stop();gateway.stop();}
 const listener=createRequestListener({auth:{...auth,discordConsumerEnabled:true},store:memoryStore(),handlerFactory:probe=>{
  const handle=createCombinedHandler(probe,events,{consumerResources:allowedResources,diagnosticSink:()=>{}});
  return async(method,params,owner,principal)=>{
   if(stopped)throw Error('Consolidated runtime stopping');
   const sourceSet=resourceSources.get(principal.resource);if(!sourceSet)throw Error('Consumer resource required');
   const allowedScopes=new Set(adapters.filter(a=>sourceSet.has(a.source)).flatMap(a=>[a.source+':read',...(typeof a.reply==='function'?[a.source+':reply']:[])]));
   if(principal.scopes?.some(scope=>!allowedScopes.has(scope)))throw Error('Consumer scopes required');
   const requestTrace=requestContext.getStore()?.requestTrace,eventId=params?.arguments?.event_id,action=method==='tools/call'?params?.name:method,began=performance.now();
   timing('mcp_handler_started',{requestTrace,eventId,action});let result;
   try{result=await handle(method,params,owner,principal);}finally{timing('mcp_handler_completed',{requestTrace,eventId,action,durationMs:performance.now()-began});}
   if(method==='tools/call'&&params?.name==='discord_reply_to_event'){let outcome;try{outcome=JSON.parse(result.content[0].text);}catch{}if(outcome?.status==='queued'&&!outcome.duplicate)timing('reply_queue_committed',{requestTrace,eventId});}
   if(['events/subscribe','events/unsubscribe'].includes(method)||method==='tools/call'&&params?.name==='discord_reply_to_event'){
    releasePressure?.();void worker.wake(owner);
   }
   return result;
  };
 }});
 const requestListener=async(req,res)=>{
  const path=new URL(req.url,'https://routing.invalid').pathname;
  if(path==='/mcp'){res.writeHead(404);res.end();return;}
  if(stopped){res.writeHead(503);res.end();return;}
  const ingestSource=ingestRoutes.get(path);
  if(ingestSource){
   if(req.method!=='POST'||!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']??'')){res.writeHead(req.method==='POST'?415:405,{'cache-control':'no-store'});res.end();return;}
   if(Number(req.headers['content-length'])>32768){res.writeHead(413,{'cache-control':'no-store'});res.end();return;}
   let size=0;const chunks=[];
   for await(const chunk of req){size+=chunk.length;if(size>32768){res.writeHead(413,{'cache-control':'no-store'});res.end();return;}chunks.push(chunk);}
   let packet;try{packet=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{res.writeHead(400,{'cache-control':'no-store'});res.end();return;}
   try{
    const pinned=await backend.read('google-owner:v1');if(!pinned?.sub){res.writeHead(503,{'cache-control':'no-store'});res.end();return;}
    const owner='google:'+pinned.sub,outcome=await events.ingest(owner,ingestSource,packet);if(!outcome.ignored)void worker.wake(owner);
    res.writeHead(202,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(outcome));
   }catch{res.writeHead(422,{'cache-control':'no-store'});res.end();}
   return;
  }
  if(resourcePaths.has(path)){const requestTrace=randomUUID(),began=performance.now();res.setHeader('X-MCP-Trace',requestTrace);if(path===new URL(resource).pathname)res.setHeader('X-Discord-Trace',requestTrace);timing('mcp_request_received',{requestTrace});res.once('finish',()=>timing('mcp_request_completed',{requestTrace,httpStatus:res.statusCode,durationMs:performance.now()-began}));await requestContext.run({requestTrace},()=>listener(req,res));}
  else await listener(req,res);
 };
 try{
  await gateway.start();const pinned=await backend.read('google-owner:v1');if(pinned?.sub)await worker.wake('google:'+pinned.sub);
 }catch(error){stop();await gateway.release?.();throw error;}
 return {requestListener,store,events,worker,gateway,reaction,stop,async shutdown(){stop();await worker.shutdown();await reaction?.shutdown();await gateway.release?.();}};
}
