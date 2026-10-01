import {createWorkloadReceiverAuth} from './lib/adapters/workload-auth.mjs';
import {readProductionConfig} from './lib/production-config.mjs';
import {createGcsObjectBackend,createGcsStore} from './lib/gcs-store.mjs';
import {createOAuth} from './lib/oauth.mjs';
import {createEventStore} from './lib/events/store.mjs';
import {createEventService,createCombinedHandler} from './lib/events/service.mjs';
import {createDiscordAdapter,readDiscordChannels} from './lib/adapters/discord.mjs';
import {callbackTransport} from './lib/transport.mjs';
import {createSubscriptionAuthorizer} from './lib/events/authorization.mjs';
import {deliverNext} from './lib/events/delivery.mjs';
import {discordRetention} from './lib/adapters/discord-retention.mjs';
import {createDiscordCallbackTransport} from './lib/events/callback-transport.mjs';
export async function createProductionAdapters(env){
 const config=await readProductionConfig(env);
 const backend=createGcsObjectBackend({bucketName:config.bucket});
 const base={auth:createOAuth({config,backend}),store:createGcsStore({backend})};
 const consumerResource=config.origin+'/mcp/discord';
 if(config.discordEnabled){const main=base.auth;const consumer=createOAuth({config:{...config,origin:config.origin+'/discord',resource:consumerResource,redirects:config.redirects.filter(u=>u.startsWith('https://chatgpt.com/')),discordReceiverEnabled:false,discordConsumerOnly:true},backend});base.auth=routeConsumerOAuth(main,consumer);}
 if(env.DISCORD_WORKLOAD_RECEIVER_ENABLE==='true'){if(!config.discordReceiverEnabled)throw Error('Receiver routes required');base.auth=createWorkloadReceiverAuth({base:base.auth,backend,origin:config.origin});}
 if(!config.discordEnabled)return base;
 const eventBackend=createGcsObjectBackend({bucketName:config.bucket,prefix:'source-events/v1/'});
 const eventStore=createEventStore({backend:eventBackend,retention:discordRetention,requireLiveSubscription:true});
 const authorizeSubscription=createSubscriptionAuthorizer({backend,resource:config.resource,allowedResources:[config.resource,consumerResource]});
 const channels=readDiscordChannels(env);
 const events=createEventService({store:eventStore,adapters:[createDiscordAdapter({channelIds:channels})],transport:createDiscordCallbackTransport(),queueReplies:true,authorizeQueuedReply:authorizeSubscription,subscriptionTtlMs:config.discordUnattendedEnabled?8*3600000:3600000,statusConfiguration:{channelAllowlistCount:channels.length,receiverRoutesEnabled:env.DISCORD_RECEIVER_ENABLE==='true',workloadAuthEnabled:env.DISCORD_WORKLOAD_RECEIVER_ENABLE==='true'}});
 const receiverRequest=createReceiverRequest({events,store:eventStore,transport:callbackTransport,authorizeSubscription});
 return {...base,handlerFactory:probe=>createCombinedHandler(probe,events,{consumerResource}),...(env.DISCORD_RECEIVER_ENABLE==='true'?{ingestEvent:events.ingestNormalized,receiverRequest}:{})};
}
// One authenticated idle request advances delivery and polls the reply queue.
// Combined claim requires both receiver scopes before any callback I/O.
export function createReceiverRequest({events,store,transport,authorizeSubscription}){
 return async(principal,action,p)=>{
  if(action==='claim'){
   await events.receiverRequest(principal,'drain',{});
   const result=await events.receiverRequest(principal,'claim',p);
   await deliverNext({store,owner:principal.owner,transport,authorizeSubscription});
   return result;
  }
  const result=await events.receiverRequest(principal,action,p);
  return action==='drain'?deliverNext({store,owner:principal.owner,transport,authorizeSubscription}):result;
 };
}

// Dedicated issuer/resource keeps dot discovery free of probe/receiver scopes.
export function routeConsumerOAuth(main,consumer){
 const selected=req=>{const p=new URL(req.url,'https://routing.invalid').pathname;return p==='/mcp/discord'||p.startsWith('/discord/')||p==='/.well-known/oauth-protected-resource/mcp/discord'||p==='/.well-known/oauth-authorization-server/discord'||p==='/.well-known/openid-configuration/discord'?consumer:main;};
 return {productionReady:true,discordConsumerEnabled:true,challenge:main.challenge,challengeForRequest:req=>selected(req).challenge,authenticate:req=>selected(req).authenticate(req),handleHttp:(req,res)=>selected(req).handleHttp(req,res)};
}
