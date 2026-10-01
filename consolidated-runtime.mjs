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
// No old bridge HTTP calls, receiver spool, poll nonce or second send ledger.
// New issuer/state belongs to this instance; old probe/consumer grants stay put.
export async function createConsolidatedRuntime({backend,auth,resource,channelIds,token,sendMessage,transport,repliesEnabled=false,gatewayFactory=createDiscordGateway,gatewayOwnership='durable-lease',gatewaySessionKey='consolidated-gateway:v1',authorizeSubscription,now=Date.now,timers={setTimeout,clearTimeout},onError=()=>{},onFatal=()=>{},onGatewayState=()=>{},reaction,onTiming=()=>{},inlineMentions=false,channelScope='allowlist'}){
 if(backend?.durable!==true||!resource?.endsWith('/mcp/discord')||!auth)throw Error('Consolidated runtime configuration refused');
 const store=createEventStore({backend,retention:discordRetention,requireLiveSubscription:true,now});
 const adapter=createDiscordAdapter({channelIds,sendMessage,inlineMentions,channelScope});
 const requestContext=new AsyncLocalStorage(),timing=(phase,details)=>{try{onTiming(phase,details);}catch{}};
 const authorize=authorizeSubscription??createSubscriptionAuthorizer({backend,resource});
 const worker=createLocalEventWorker({store,adapter,transport,authorizeSubscription:authorize,repliesEnabled,now,timers,onError,onTiming:timing});
 const events=createEventService({store,adapters:[adapter],transport,queueReplies:true,authorizeQueuedReply:authorize,subscriptionTtlMs:8*3600000,diagnosticSink:()=>{},statusConfiguration:{channelAllowlistCount:channelScope==='allowlist'?channelIds.length:null,channelAccessPolicy:channelScope,receiverRoutesEnabled:false,workloadAuthEnabled:false,replyExecution:'queued_locally',mechanicalEyesEnabled:!!reaction,inlineMentionPayload:inlineMentions}});
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
     if(error?.code==='EVENT_EXPIRED')return; // Intentional aged discard; no reply/admission is possible.
     if(!['EVENT_SUBSCRIPTION_PAUSED','EVENT_CAPACITY','STORAGE_CAPACITY'].includes(error?.code))throw error;
     try{onError('Consolidated ingest paused; Gateway sequence retained');}catch{}
     await new Promise(done=>{releasePressure=done;pressureTimer=timers.setTimeout(done,15000);});
    }
   }
   throw Error('Consolidated receiver stopped before durable ingest');
  },onFatal:()=>{stop();try{onFatal();}catch{}}});
 function stop(){stopped=true;timers.clearTimeout(pressureTimer);releasePressure?.();worker.stop();gateway.stop();}
 const listener=createRequestListener({auth:{...auth,discordConsumerEnabled:true},store:memoryStore(),handlerFactory:probe=>{
  const handle=createCombinedHandler(probe,events,{consumerResource:resource,diagnosticSink:()=>{}});
  return async(method,params,owner,principal)=>{
   if(stopped)throw Error('Consolidated runtime stopping');
   if(principal.resource!==resource||principal.scopes?.some(s=>!['discord:read','discord:reply'].includes(s)))throw Error('Consumer scopes required');
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
  if(path==='/mcp'||path.startsWith('/receiver/')||path.startsWith('/ingest/')){res.writeHead(404);res.end();return;}
  if(stopped){res.writeHead(503);res.end();return;}
  if(path===new URL(resource).pathname){const requestTrace=randomUUID(),began=performance.now();res.setHeader('X-Discord-Trace',requestTrace);timing('mcp_request_received',{requestTrace});res.once('finish',()=>timing('mcp_request_completed',{requestTrace,httpStatus:res.statusCode,durationMs:performance.now()-began}));await requestContext.run({requestTrace},()=>listener(req,res));}
  else await listener(req,res);
 };
 try{
  await gateway.start();const pinned=await backend.read('google-owner:v1');if(pinned?.sub)await worker.wake('google:'+pinned.sub);
 }catch(error){stop();await gateway.release?.();throw error;}
 return {requestListener,store,events,worker,gateway,reaction,stop,async shutdown(){stop();await worker.shutdown();await reaction?.shutdown();await gateway.release?.();}};
}
