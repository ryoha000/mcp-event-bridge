import {readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {createCloudReceiverState} from './lib/events/cloud-receiver-state.mjs';
import {createWorkloadCredential} from './lib/adapters/workload-credential.mjs';
import {createDiscordAdapter,readDiscordChannels} from './lib/adapters/discord.mjs';
import {createDiscordRest} from './lib/adapters/discord-rest.mjs';
import {createBridgeTransport,createReceiverBridgeClient} from './lib/events/bridge.mjs';
import {createPcReceiver} from './pc-receiver.mjs';
import {discordRetention} from './lib/adapters/discord-retention.mjs';
import {validateDiscordReceiver,receiverDiagnostic} from './lib/adapters/discord-preflight.mjs';

const origin='https://synthetic-fixture.run.app';
// インポートはオフライン処理。実際の起動には承認済みイメージ/設定、マウント済み
// botシークレット、限定スコープのランタイムIAM、有効なブリッジ委任が必要。
// OAuth/DPAPIファイルは使わない。
export async function startCloudReceiver(env,dependencies={}){
 if(env.CLOUD_DISCORD_RECEIVER_ENABLE!=='true'||env.BRIDGE_ORIGIN!==origin||!env.DISCORD_RECEIVER_STATE_BUCKET||env.GOOGLE_APPLICATION_CREDENTIALS||env.STORAGE_EMULATOR_HOST)throw Error('Approved hosted receiver configuration required');
 const channels=readDiscordChannels(env);
 const token=(await (dependencies.readSecret??readFile)('/var/run/secrets/discord-bot/token','utf8')).trim();if(!token||token.length>4096)throw Error('Mounted bot credential required');
 const diagnosticSink=dependencies.diagnosticSink??console.info;
 await (dependencies.validateDiscord??validateDiscordReceiver)({token,channelIds:channels,diagnosticSink});
 const backend=dependencies.backend??createCloudReceiverState({bucketName:env.DISCORD_RECEIVER_STATE_BUCKET});
 const getAccessToken=dependencies.getAccessToken??createWorkloadCredential({origin});
 const adapter=createDiscordAdapter({channelIds:channels,sendMessage:dependencies.sendMessage??createDiscordRest({token})});
 const request=dependencies.bridgeRequest??createReceiverBridgeClient({origin,getAccessToken});let workloadLogged=false;
 return createPcReceiver({backend,adapter,token,owner:'cloud-discord-receiver',retention:discordRetention,pollIntervalMs:60000,repliesEnabled:env.CLOUD_DISCORD_REPLIES_ENABLE==='true',onGatewayState:(state,code)=>receiverDiagnostic('gateway_'+state,{gatewayCode:code,repliesEnabled:env.CLOUD_DISCORD_REPLIES_ENABLE==='true'},diagnosticSink),
  forwardEnvelope:dependencies.forwardEnvelope??createBridgeTransport({origin,getAccessToken}),bridgeRequest:async(action,body)=>{const result=await request(action,body);if(action==='claim'&&!workloadLogged){workloadLogged=true;receiverDiagnostic('workload_authorized',{receiverScopesVerified:true,repliesEnabled:env.CLOUD_DISCORD_REPLIES_ENABLE==='true'},diagnosticSink);}return result;},
  ...(dependencies.gatewayFactory?{gatewayFactory:dependencies.gatewayFactory}:{}),...(dependencies.timers?{timers:dependencies.timers}:{}),
  onError:dependencies.onError??(()=>console.error('Hosted receiver paused; durable state retained')),onFatal:dependencies.onFatal??(()=>{process.exitCode=1;})});
}
async function main(){
 let receiver;const server=createServer((_req,res)=>{res.writeHead(404);res.end();});
 const terminate=async()=>{receiver?.stop();server.close();const timer=setTimeout(()=>process.exit(process.exitCode??0),8000);timer.unref();try{await receiver?.shutdown();}catch{process.exitCode=1;console.error('Hosted shutdown incomplete; durable state retained');}};
 try{receiver=await startCloudReceiver(process.env,{onFatal:()=>{process.exitCode=1;void terminate();}});await new Promise((yes,no)=>{server.once('error',no);server.listen(Number(process.env.PORT??8080),'0.0.0.0',yes);});process.once('SIGTERM',()=>void terminate());process.once('SIGINT',()=>void terminate());}
 catch(error){receiverDiagnostic('startup_refused',{code:error?.code,status:error?.status});console.error('Hosted receiver startup refused; no credential values displayed');process.exitCode=1;receiver?.stop();server.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)void main();
