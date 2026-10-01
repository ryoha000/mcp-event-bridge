import {createDiscordAdapter} from './discord.mjs';
const delay=ms=>new Promise(done=>setTimeout(done,ms));
// bot自身のUnicodeリアクションPUTは冪等。上限付きの独立ワーカーは、
// 永続イベント取り込みやコールバック/LLM処理を遅延させない。
export function createDiscordEyes({token,channelIds,channelScope='allowlist',fetchImpl=fetch,sleep=delay,now=Date.now,onTiming=()=>{},maxPending=64,maxAttempts=3,timeoutMs=3000,maxWaitMs=2000}={}){
 if(typeof token!=='string'||!token.trim()||/\s/.test(token)||!Number.isInteger(maxPending)||maxPending<1||maxPending>128||!Number.isInteger(maxAttempts)||maxAttempts<1||maxAttempts>3)throw Error('Reaction configuration refused');
 const validate=createDiscordAdapter({channelIds,channelScope}).validate,queue=[],seen=new Map();let running=false,stopped=false,inflight=Promise.resolve(),blockedUntil=0;
 const counts={accepted:0,succeeded:0,failed:0,duplicates:0,overflow:0};
 const notice=(phase,details)=>{try{onTiming(phase,details);}catch{}};
 async function attempt(event){
  for(let number=1;number<=maxAttempts&&!stopped;number++){
   const wait=Math.max(0,blockedUntil-now());if(wait>maxWaitMs)return false;if(wait)await sleep(wait);if(stopped)return false;
   const began=performance.now();let response;notice('reaction_post_started',{eventId:event.eventId,attempt:number});
   try{
    response=await fetchImpl('https://discord.com/api/v10/channels/'+event.origin.channelId+'/messages/'+event.origin.messageId+'/reactions/%F0%9F%91%80/@me',{method:'PUT',redirect:'error',headers:{authorization:'Bot '+token},signal:AbortSignal.timeout(timeoutMs)});
    notice('reaction_post_completed',{eventId:event.eventId,attempt:number,httpStatus:response.status,durationMs:performance.now()-began});
    const reset=Number(response.headers.get('x-ratelimit-reset-after'));
    if(response.headers.get('x-ratelimit-remaining')==='0'&&Number.isFinite(reset)&&reset>=0)blockedUntil=Math.max(blockedUntil,now()+Math.ceil(reset*1000));
    if(response.status===204)return true;
    if(response.status===429){
     let bytes=0,chunks=[];for await(const chunk of response.body??[]){bytes+=chunk.length;if(bytes>8192)throw Error();chunks.push(Buffer.from(chunk));}
     let row;try{row=JSON.parse(Buffer.concat(chunks));}catch{return false;}
     const retry=Number(row.retry_after);if(!Number.isFinite(retry)||retry<0)return false;blockedUntil=Math.max(blockedUntil,now()+Math.ceil(retry*1000));
     if(blockedUntil-now()>maxWaitMs)return false;
    }else{await response.body?.cancel?.().catch(()=>{});if(response.status<500)return false;}
   }catch{notice('reaction_post_completed',{eventId:event.eventId,attempt:number,durationMs:performance.now()-began,success:false});}
   if(number<maxAttempts&&!stopped&&blockedUntil<=now())await sleep(100*number);
  }
  return false;
 }
 function pump(){if(running||stopped)return;running=true;inflight=(async()=>{try{while(queue.length&&!stopped){const task=queue.shift();let success=false;try{success=await attempt(task.event);}catch{}counts[success?'succeeded':'failed']++;notice('reaction_complete',{eventId:task.event.eventId,success});task.done(success);}}finally{running=false;}})();}
 return {
  react(input){const event=validate(input);if(stopped)return Promise.resolve(false);if(seen.has(event.eventId)){counts.duplicates++;return seen.get(event.eventId);}if(queue.length>=maxPending){counts.overflow++;notice('reaction_complete',{eventId:event.eventId,success:false});return Promise.resolve(false);}
   let done;const result=new Promise(resolve=>{done=resolve;});seen.set(event.eventId,result);queue.push({event,done});counts.accepted++;notice('reaction_queued',{eventId:event.eventId});pump();
   while(seen.size>256){const first=seen.keys().next().value;if(queue.some(x=>x.event.eventId===first))break;seen.delete(first);}return result;
  },
  async shutdown(){stopped=true;for(const task of queue.splice(0))task.done(false);await inflight;},statistics(){return {...counts,pending:queue.length,running};}
 };
}
