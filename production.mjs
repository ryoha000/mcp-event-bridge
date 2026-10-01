import {readProductionConfig} from './lib/production-config.mjs';
import {createGcsObjectBackend,createGcsStore} from './lib/gcs-store.mjs';
import {createOAuth} from './lib/oauth.mjs';
import {createEventStore} from './lib/events/store.mjs';
import {createEventService,createCombinedHandler} from './lib/events/service.mjs';
import {createDiscordAdapter,readDiscordChannels} from './lib/adapters/discord.mjs';
import {createSubscriptionAuthorizer} from './lib/events/authorization.mjs';
import {discordRetention} from './lib/adapters/discord-retention.mjs';
import {createDiscordCallbackTransport} from './lib/events/callback-transport.mjs';
export async function createProductionAdapters(env){
 const config=await readProductionConfig(env);
 const backend=createGcsObjectBackend({bucketName:config.bucket});
 const base={auth:createOAuth({config,backend}),store:createGcsStore({backend})};
 const consumerResource=config.origin+'/mcp/discord';
 if(config.discordEnabled){const main=base.auth;const consumer=createOAuth({config:{...config,origin:config.origin+'/discord',resource:consumerResource,redirects:config.redirects.filter(u=>u.startsWith('https://chatgpt.com/')),discordConsumerOnly:true},backend});base.auth=routeConsumerOAuth(main,consumer);}
 if(!config.discordEnabled)return base;
 const eventBackend=createGcsObjectBackend({bucketName:config.bucket,prefix:'source-events/v1/'});
 const eventStore=createEventStore({backend:eventBackend,retention:discordRetention,requireLiveSubscription:true});
 const authorizeSubscription=createSubscriptionAuthorizer({backend,resource:config.resource,allowedResources:[config.resource,consumerResource]});
 const channels=readDiscordChannels(env);
 const events=createEventService({store:eventStore,adapters:[createDiscordAdapter({channelIds:channels})],transport:createDiscordCallbackTransport(),queueReplies:true,authorizeQueuedReply:authorizeSubscription,subscriptionTtlMs:config.discordUnattendedEnabled?8*3600000:3600000,statusConfiguration:{channelAllowlistCount:channels.length}});
 return {...base,handlerFactory:probe=>createCombinedHandler(probe,events,{consumerResource})};
}

// 専用のissuer/resourceにより、dot側ディスカバリにプローブのスコープを混ぜない。
export function routeConsumerOAuth(main,consumer){
 const selected=req=>{const p=new URL(req.url,'https://routing.invalid').pathname;return p==='/mcp/discord'||p.startsWith('/discord/')||p==='/.well-known/oauth-protected-resource/mcp/discord'||p==='/.well-known/oauth-authorization-server/discord'||p==='/.well-known/openid-configuration/discord'?consumer:main;};
 return {productionReady:true,discordConsumerEnabled:true,challenge:main.challenge,challengeForRequest:req=>selected(req).challenge,authenticate:req=>selected(req).authenticate(req),handleHttp:(req,res)=>selected(req).handleHttp(req,res)};
}
