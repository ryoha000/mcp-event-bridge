import {randomUUID} from 'node:crypto';
import {deliverNext} from './delivery.mjs';
// 1つのイベント集約が永続キュー兼送信台帳。タイマーは保留作業/リトライ期限の
// ためだけに存在し、静穏状態ではポーリングもナンスも書き込みもない。
export function createLocalEventWorker({store,adapter,callbackData,transport,authorizeSubscription,now=Date.now,timers={setTimeout,clearTimeout},onError=()=>{},onTiming=()=>{}}){
 let stopped=false,running=false,owner,rerun=false,timer,inflight=Promise.resolve();const recovered=new Set();
 const notice=()=>{try{onError('Local event work paused; durable claims retained');}catch{}};
 function later(delay){if(stopped)return;timers.clearTimeout(timer);timer=timers.setTimeout(()=>{timer=undefined;void wake(owner);},Math.max(100,delay));}
 async function run(){
  if(stopped||!owner)return;
  if(!recovered.has(owner)){await store.recoverClaimedReplies(owner);recovered.add(owner);}
  let remaining=false;
  let schedule;
  for(let n=0;n<16&&!stopped;n++){
   schedule=await store.workSchedule(owner);
   let worked=schedule.deliveryAt!==null&&schedule.deliveryAt<=now()?(await deliverNext({store,owner,transport,authorizeSubscription,onTiming,callbackData:callbackData??adapter.callbackData})).attempted:false;
   if(stopped)break;
   if(schedule.pendingReplies){
    const requestId=randomUUID();let claimed=false;
    try{
     const result=await store.claimQueuedReply(owner,requestId);
     if(result.command){
      claimed=true;worked=true;
      onTiming('reply_claim_committed',{eventId:result.command.event.eventId});
      const allowed=await authorizeSubscription(owner,{...result.authorization,name:'discord.mention.created'},['discord:read','discord:reply']);
      let status='rejected',messageId=null;
      if(allowed&&!stopped){
       const began=performance.now();onTiming('reply_post_started',{eventId:result.command.event.eventId});
       status='unknown';try{const r=await adapter.reply(result.command.event,result.command.content);status=r?.ok===true?'sent':r?.ok===false?'rejected':'unknown';messageId=status==='sent'?r.messageId??null:null;onTiming('reply_post_completed',{eventId:result.command.event.eventId,httpStatus:r?.status,durationMs:performance.now()-began,success:status==='sent'});}catch{onTiming('reply_post_completed',{eventId:result.command.event.eventId,durationMs:performance.now()-began,success:false});}
      }else if(stopped){status='unknown';}
      await store.receiptQueuedReply(owner,{requestId,eventId:result.command.event.eventId,status,messageId});
      onTiming('reply_receipt_committed',{eventId:result.command.event.eventId,success:status==='sent'});
     }
    }catch{
     // 失われたCAS応答は既にクレーム/送信済みかもしれない。次の試行前に
     // unknown に整合させ、結果不明の送信を pending として再作成しない。
     await store.recoverClaimedReplies(owner);notice();if(claimed)worked=true;else throw Error('Local claim paused');
    }
   }
   if(!worked){remaining=false;break;}remaining=n===15;
  }
  if(stopped)return;
  if(remaining)schedule=await store.workSchedule(owner);
  if(remaining||schedule.pendingReplies)later(100);
  else if(schedule.deliveryAt!==null)later(schedule.deliveryAt-now());
 }
 function wake(nextOwner){
  if(stopped)return inflight;
  if(typeof nextOwner==='string'){if(owner&&owner!==nextOwner)throw Error('Local owner mismatch');owner=nextOwner;}
  if(!owner)return inflight;
  if(running){rerun=true;return inflight;}
  running=true;timers.clearTimeout(timer);timer=undefined;
  inflight=(async()=>{try{do{rerun=false;await run();}while(rerun&&!stopped);}catch{notice();later(15000);}finally{running=false;}})();
  return inflight;
 }
 return {wake,stop(){stopped=true;timers.clearTimeout(timer);},async shutdown(){this.stop();await inflight;},async flush(){await inflight;}};
}
