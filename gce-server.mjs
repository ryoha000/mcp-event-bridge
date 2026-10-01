import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {isIP} from 'node:net';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createSqliteObjectBackend} from './lib/sqlite-store.mjs';
import {readProductionConfig} from './lib/production-config.mjs';
import {createOAuth} from './lib/oauth.mjs';
import {createConsolidatedRuntime} from './consolidated-runtime.mjs';
import {readDiscordChannelPolicy} from './lib/adapters/discord.mjs';
import {createDiscordRest} from './lib/adapters/discord-rest.mjs';
import {validateDiscordReceiver,receiverDiagnostic} from './lib/adapters/discord-preflight.mjs';
import {createDiscordCallbackTransport} from './lib/events/callback-transport.mjs';
import {createDiscordEyes} from './lib/adapters/discord-reaction.mjs';
import {createTimingSink} from './lib/events/timing.mjs';

// 準備はローカルのみ。このエントリポイントは VM、IAM、DNS、証明書、シークレットを
// 一切プロビジョニングしない。systemd が credentials ディレクトリから承認済み
// ファイルを供給し、公開HTTPSは nginx -> 127.0.0.1:8080 の固定経路。
export async function prepareGceServer(env,dependencies={}){
 if(env.GCE_DISCORD_ENABLE!=='true'||env.GOOGLE_APPLICATION_CREDENTIALS||env.STORAGE_EMULATOR_HOST||env.PROBE_BUCKET||env.CONSOLIDATED_DISCORD_ENABLE)throw Error('GCE deployment configuration required');
 const origin=new URL(env.GCE_DISCORD_ORIGIN??'');
 if(origin.protocol!=='https:'||origin.origin!==env.GCE_DISCORD_ORIGIN||origin.username||origin.password||origin.port||isIP(origin.hostname)||!origin.hostname.includes('.')||origin.hostname==='synthetic-fixture.run.app'||origin.hostname.endsWith('.run.app'))throw Error('Dedicated named HTTPS origin required');
 if(env.GCE_DISCORD_SQLITE_FILE!=='/var/lib/discord-mcp/state.sqlite3'||env.GCE_DISCORD_SYSTEMD_LOCK!=='held'||env.CREDENTIALS_DIRECTORY!=='/run/credentials/discord-mcp.service'||!['true','false'].includes(env.GCE_DISCORD_REPLIES_ENABLE??'false'))throw Error('Pinned persistent state and systemd credentials required');
 const backend=dependencies.backend??createSqliteObjectBackend({filename:env.GCE_DISCORD_SQLITE_FILE});
 if(backend?.localSingleton!==true)throw Error('SQLite process lock required');
 try{
  const config=await(dependencies.readConfig??readProductionConfig)({...env,PROBE_ORIGIN:origin.origin,PROBE_BUCKET:'local-placeholder-unused',PROBE_AUTH_SECRET_FILE:env.CREDENTIALS_DIRECTORY+'/auth.json',DISCORD_ENABLE:'true',DISCORD_RECEIVER_ENABLE:'false',DISCORD_UNATTENDED_ENABLE:'true'});
  const resource=origin.origin+'/mcp/discord',auth=dependencies.auth??createOAuth({config:{...config,origin:origin.origin+'/discord',resource,discordConsumerOnly:true},backend});
  const {channelIds,channelScope}=readDiscordChannelPolicy(env),token=(await(dependencies.readSecret??readFile)(env.CREDENTIALS_DIRECTORY+'/bot-token','utf8')).trim();
  await(dependencies.validateDiscord??validateDiscordReceiver)({token,channelIds,channelScope});
  const onTiming=dependencies.onTiming??createTimingSink(),reaction=dependencies.reaction??createDiscordEyes({token,channelIds,channelScope,onTiming});
  const runtime=await createConsolidatedRuntime({backend,auth,resource,channelIds,channelScope,token,reaction,onTiming,inlineMentions:true,gatewayOwnership:'local-singleton',gatewaySessionKey:'gce-gateway:v1',sendMessage:dependencies.sendMessage??createDiscordRest({token,onTiming}),transport:dependencies.transport??createDiscordCallbackTransport(),repliesEnabled:env.GCE_DISCORD_REPLIES_ENABLE==='true',...(dependencies.gatewayFactory?{gatewayFactory:dependencies.gatewayFactory}:{}),...(dependencies.timers?{timers:dependencies.timers}:{}),onError:()=>console.error('保存済み状態を保持して処理を一時停止しました'),onGatewayState:(state,code)=>receiverDiagnostic('gateway_'+state,{gatewayCode:code,repliesEnabled:env.GCE_DISCORD_REPLIES_ENABLE==='true'}),onFatal:dependencies.onFatal??(()=>{process.exitCode=1;})});
  let shutdown;return {...runtime,backend,shutdown(){return shutdown??=(async()=>{try{await runtime.shutdown();}finally{backend.close();}})();}};
 }catch(error){backend.close();throw error;}
}
async function main(){
 let runtime,server,termination;
 const terminate=()=>termination??=(async()=>{runtime?.stop();server?.close();const timer=setTimeout(()=>process.exit(process.exitCode??0),20000);timer.unref();try{await runtime?.shutdown();server?.closeAllConnections();}catch{process.exitCode=1;}})();
 try{
  runtime=await prepareGceServer(process.env,{onFatal:()=>{process.exitCode=1;void terminate();}});
  server=createServer({maxHeaderSize:16384},runtime.requestListener);server.requestTimeout=15000;server.headersTimeout=10000;server.timeout=15000;server.keepAliveTimeout=1000;
  await new Promise((done,fail)=>{server.once('error',fail);server.listen(8080,'127.0.0.1',done);});process.once('SIGTERM',()=>void terminate());process.once('SIGINT',()=>void terminate());
 }catch{console.error('起動を拒否しました。秘密情報は表示していません');process.exitCode=1;await terminate();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)void main();
