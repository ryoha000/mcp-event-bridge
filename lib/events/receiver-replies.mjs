import {digest,exact} from './envelope.mjs';
export function createReceiverReplyExecutor({backend,adapter,retention,now=Date.now,maxClaims=128}){
  return async command=>{
    exact(command,['event','content','requestId']);const event=adapter.validate(command.event);
    if(typeof command.content!=='string'||!command.content.trim()||command.content.length>2000||typeof command.requestId!=='string')throw Error('Reply command refused');
    const legacy=await backend.read(JSON.stringify(['receiver-reply:v1',event.eventId]));const contentHash=digest(command.content);
    if(legacy){if(legacy.contentHash!==contentHash)throw Error('Reply conflict');return {requestId:command.requestId,eventId:event.eventId,...(legacy.receipt??{status:'unknown',messageId:null})};}
    const key='receiver-reply-ledger:v2';
    const claim=await backend.update(key,raw=>{
      const ledger=raw??{version:2,rows:[],retired:[]};if(ledger.version!==2||!Array.isArray(ledger.rows)||!Array.isArray(ledger.retired))throw Error('Reply ledger refused');
      const at=now();
      if(retention){ledger.retired=ledger.retired.filter(r=>r.expires>at);for(const row of [...ledger.rows]){if(!['sent','rejected'].includes(row.receipt?.status)||row.at+retention.replyMs>at)continue;const expires=row.born+retention.replayMs;if(expires>at){if(ledger.retired.length>=retention.maxRetired)continue;ledger.retired.push({eventId:row.eventId,expires});}ledger.rows=ledger.rows.filter(r=>r!==row);}}
      const old=ledger.rows.find(r=>r.eventId===event.eventId);
      if(old){if(old.contentHash!==contentHash)throw Error('Reply conflict');return {result:{claimed:false,receipt:old.receipt??{status:'unknown',messageId:null}}};}
      if(ledger.retired.some(r=>r.eventId===event.eventId))return {value:ledger,result:{claimed:false,receipt:{status:'unknown',messageId:null}}};
      const born=retention?retention.identityTime(event):at;
      if(retention&&born+retention.replyMs<=at)return {value:ledger,result:{claimed:false,receipt:{status:'rejected',messageId:null}}};
      if(born>at+300000)throw Error('Reply identity clock refused');
      if(ledger.rows.length>=maxClaims)throw Error('Reply capacity reached; reconciliation required');
      ledger.rows.push({eventId:event.eventId,contentHash,at,born});
      return {value:ledger,result:{claimed:true}};
    });
    let receipt=claim.receipt;
    if(claim.claimed){
      receipt={status:'unknown',messageId:null};
      try{const r=await adapter.reply(event,command.content);receipt={status:r?.ok===true?'sent':r?.ok===false?'rejected':'unknown',messageId:r?.ok===true?r.messageId??null:null};}catch{/* 秘匿 */}
      await backend.update(key,ledger=>{const row=ledger.rows.find(r=>r.eventId===event.eventId);if(!row||row.contentHash!==contentHash)throw Error('Reply claim lost');row.receipt=receipt;return {value:ledger};});
    }
    return {requestId:command.requestId,eventId:event.eventId,...receipt};
  };
}
