import {readFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {createSqliteBackend} from './lib/events/sqlite-backend.mjs';
import {createEventStore} from './lib/events/store.mjs';
import {createBridgeTransport,createReceiverBridgeClient,forwardNext} from './lib/events/bridge.mjs';
import {createReceiverReplyExecutor} from './lib/events/receiver-replies.mjs';
import {createDiscordAdapter,readDiscordChannels,DISCORD_EVENT,GUILD_ID} from './lib/adapters/discord.mjs';
import {createDiscordGateway} from './lib/adapters/discord-gateway.mjs';
import {createDiscordRest} from './lib/adapters/discord-rest.mjs';
import {readWindowsSecret} from './lib/adapters/windows-secret.mjs';
import {writeWindowsSecret} from './lib/adapters/windows-secret.mjs';
import {createBridgeCredential} from './lib/adapters/bridge-credential.mjs';
import {discordRetention} from './lib/adapters/discord-retention.mjs';

// Portable receiver orchestration. Network, credential access and timers are
// dependencies so the whole flow is exercised offline. Bot token stays here.
export async function createPcReceiver({backend,adapter,token,forwardEnvelope,bridgeRequest,
  gatewayFactory=createDiscordGateway,timers={setTimeout,clearTimeout},onError=()=>{},onFatal=()=>{},onGatewayState=()=>{},retention,now=Date.now,pollIntervalMs=30000,repliesEnabled=false,owner='windows-discord-receiver'}){
  const store=createEventStore({backend,retryUntilAcknowledged:true,retention,now});
  const execute=createReceiverReplyExecutor({backend,adapter,retention,now});
  await store.subscribe(owner,{id:'local-cloud-uplink',clientId:'local-receiver',grantId:'local-spool',name:DISCORD_EVENT,tenantId:GUILD_ID,url:'https://cloud-uplink.invalid/',secret:'unused-local-placeholder',expires:8640000000000000});
  let timer,pressureTimer,releasePressure,stopped=false,busy=false,pumpDone=Promise.resolve();
  async function pump(){
    if(stopped||busy)return;busy=true;timers.clearTimeout(timer);
    let finishPump;pumpDone=new Promise(done=>{finishPump=done;});
    try{
      for(let n=0;n<8&&!stopped;n++)if(!(await forwardNext({store,owner,forwardEnvelope})).attempted)break;
      if(stopped)return;
      const key='receiver-poll:v1';
      const requestId=await backend.update(key,old=>old?.requestId?{result:old.requestId}:{value:{requestId:randomUUID()},result:undefined});
      const savedId=requestId??(await backend.read(key)).requestId;
      const response=await bridgeRequest('claim',{requestId:savedId});
      if(stopped)return; // Keep request identity/claim; successor can reconcile.
      if(response.command){
        if(response.command.requestId!==savedId)throw Error('Reply request mismatch');
        if(repliesEnabled!==true){onError('Reply held; live validation gate has not enabled Discord sends');return;}
        const receipt=await execute(response.command);
        const ack=await bridgeRequest('receipt',receipt);if(ack.accepted!==true)throw Error('Reply receipt refused');
        await backend.update(key,()=>({value:{requestId:null}}));
      }else if(response.complete||response.command===null){await backend.update(key,()=>({value:{requestId:null}}));}
    }catch{onError('Receiver bridge paused; durable events and reply claims retained');}
    finally{busy=false;finishPump();if(!stopped)timer=timers.setTimeout(pump,pollIntervalMs);}
  }
  const gateway=gatewayFactory({token,backend,sessionKey:'receiver-gateway:v1',onState:onGatewayState,
    onDispatch:async packet=>{const event=adapter.normalize(packet);if(event){
      while(!stopped){try{await store.ingest(owner,event);void pump();return;}catch(error){if(!['EVENT_CAPACITY','STORAGE_CAPACITY'].includes(error.code))throw error;onError('Receiver spool full; unprocessed mention retained, Gateway checkpoint paused');void pump();await new Promise(done=>{releasePressure=done;pressureTimer=timers.setTimeout(done,15000);});}}
      throw Error('Receiver stopped before durable ingest');
    }},
    onFatal:message=>{onError(message);stop();onFatal();}});
  function stop(){stopped=true;timers.clearTimeout(timer);timers.clearTimeout(pressureTimer);releasePressure?.();gateway.stop();}
  await gateway.start();void pump();return {stop,pump,store,shutdown:async()=>{stop();await pumpDone;await gateway.release?.();}};
}
export async function startPcReceiver(config){
  if(config.enabled!==true||!config.botSecretFile||!config.bridgeAccessSecretFile||!config.stateDirectory)throw Error('Approved receiver configuration required');
  const channels=readDiscordChannels({DISCORD_CHANNEL_IDS:JSON.stringify(config.channelIds)});
  const token=readWindowsSecret(resolve(config.botSecretFile));
  const directory=resolve(config.stateDirectory);await mkdir(directory,{recursive:true});const backend=createSqliteBackend(resolve(directory,'receiver.sqlite'));
  const adapter=createDiscordAdapter({channelIds:channels,sendMessage:createDiscordRest({token})});
  const credentialPath=resolve(config.bridgeAccessSecretFile);
  const getAccessToken=createBridgeCredential({origin:config.bridgeOrigin,readCredential:()=>readWindowsSecret(credentialPath),writeCredential:value=>writeWindowsSecret(credentialPath,value)});
  try{
    let closed=false;const close=()=>{if(!closed){closed=true;backend.close();}};
    const receiver=await createPcReceiver({backend,adapter,token,retention:discordRetention,repliesEnabled:config.repliesEnabled===true,forwardEnvelope:createBridgeTransport({origin:config.bridgeOrigin,getAccessToken}),bridgeRequest:createReceiverBridgeClient({origin:config.bridgeOrigin,getAccessToken}),onError:message=>console.error(message),onFatal:()=>{process.exitCode=1;setImmediate(close);}});
    const stop=()=>{void receiver.shutdown().finally(close);};process.once('SIGINT',stop);process.once('SIGTERM',stop);return receiver;
  }catch(error){backend.close();throw error;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  if(!process.argv[2]){console.error('Receiver startup refused; approved config file required');process.exitCode=1;}
  else startPcReceiver(JSON.parse(await readFile(resolve(process.argv[2]),'utf8'))).catch(()=>{console.error('Receiver startup refused; reviewed local configuration required');process.exitCode=1;});
}
