import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {readProductionConfig} from './lib/production-config.mjs';
import {createGcsObjectBackend} from './lib/gcs-store.mjs';
import {createOAuth} from './lib/oauth.mjs';
import {createDiscordRest} from './lib/adapters/discord-rest.mjs';
import {readDiscordChannels} from './lib/adapters/discord.mjs';
import {validateDiscordIntegration,discordDiagnostic} from './lib/adapters/discord-preflight.mjs';
import {createDiscordCallbackTransport} from './lib/events/callback-transport.mjs';
import {createConsolidatedRuntime} from './consolidated-runtime.mjs';

// ローカルのソース準備のみ。認証情報/リソース/イングレスは一切作成しない。
export async function prepareConsolidatedServer(env,dependencies={}){
 if(env.CONSOLIDATED_DISCORD_ENABLE!=='true'||env.GOOGLE_APPLICATION_CREDENTIALS||env.STORAGE_EMULATOR_HOST)throw Error('Consolidated deployment approval/configuration required');
 const publicOrigin=new URL(env.CONSOLIDATED_ORIGIN??'');
 if(publicOrigin.origin!==env.CONSOLIDATED_ORIGIN||publicOrigin.protocol!=='https:'||publicOrigin.username||publicOrigin.password||publicOrigin.hostname==='synthetic-fixture.run.app')throw Error('Separate public consolidated origin required');
 if(env.CONSOLIDATED_BUCKET!=='discord-receiver-state-123456789012-uswest1')throw Error('Separate receiver state bucket required');
 if(env.CONSOLIDATED_AUTH_SECRET_FILE!=='/var/run/secrets/discord-auth/secret.json')throw Error('Dedicated Discord auth-secret mount required');
 if(env.CONSOLIDATED_REPLIES_ENABLE!==undefined&&!['true','false'].includes(env.CONSOLIDATED_REPLIES_ENABLE))throw Error('Explicit reply gate required');
 const config=await (dependencies.readConfig??readProductionConfig)({...env,PROBE_ORIGIN:publicOrigin.origin,PROBE_BUCKET:env.CONSOLIDATED_BUCKET,PROBE_AUTH_SECRET_FILE:env.CONSOLIDATED_AUTH_SECRET_FILE,DISCORD_ENABLE:'true',DISCORD_UNATTENDED_ENABLE:'true'});
 const backend=dependencies.backend??createGcsObjectBackend({bucketName:env.CONSOLIDATED_BUCKET,prefix:'discord-consolidated/v1/',maxBytes:1024*1024,maxAttempts:5});
 const resource=publicOrigin.origin+'/mcp/discord';
 const auth=dependencies.auth??createOAuth({config:{...config,origin:publicOrigin.origin+'/discord',resource,discordConsumerOnly:true},backend});
 const channelIds=readDiscordChannels(env);
 const token=(await (dependencies.readSecret??readFile)('/var/run/secrets/discord-bot/token','utf8')).trim();
 await (dependencies.validateDiscord??validateDiscordIntegration)({token,channelIds});
 return createConsolidatedRuntime({backend,auth,resource,channelIds,token,sendMessage:dependencies.sendMessage??createDiscordRest({token}),transport:dependencies.transport??createDiscordCallbackTransport(),repliesEnabled:env.CONSOLIDATED_REPLIES_ENABLE==='true',
  ...(dependencies.gatewayFactory?{gatewayFactory:dependencies.gatewayFactory}:{}),...(dependencies.timers?{timers:dependencies.timers}:{}),onError:()=>console.error('Consolidated work paused; durable state retained'),onGatewayState:(state,code)=>discordDiagnostic('gateway_'+state,{gatewayCode:code,repliesEnabled:env.CONSOLIDATED_REPLIES_ENABLE==='true'}),onFatal:dependencies.onFatal??(()=>{process.exitCode=1;})});
}
async function main(){
 let runtime,server;const terminate=async()=>{runtime?.stop();server?.close();const timer=setTimeout(()=>process.exit(process.exitCode??0),8000);timer.unref();try{await runtime?.shutdown();}catch{process.exitCode=1;}};
 try{
  runtime=await prepareConsolidatedServer(process.env,{onFatal:()=>{process.exitCode=1;void terminate();}});
  server=createServer({maxHeaderSize:16384},runtime.requestListener);server.requestTimeout=15000;server.headersTimeout=10000;server.timeout=15000;server.keepAliveTimeout=1000;
  const port=Number(process.env.PORT??8080);if(!Number.isInteger(port)||port<1||port>65535)throw Error();
  await new Promise((yes,no)=>{server.once('error',no);server.listen(port,'0.0.0.0',yes);});process.once('SIGTERM',()=>void terminate());process.once('SIGINT',()=>void terminate());
 }catch{console.error('Consolidated startup refused; no private values displayed');process.exitCode=1;await terminate();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)void main();
