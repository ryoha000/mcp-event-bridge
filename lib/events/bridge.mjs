import {validateEnvelope} from './envelope.mjs';

// Receiver uplink carries only adapter-normalized events. OAuth token acquisition
// is an explicitly supplied dependency, separate from Discord token and MCP
// consumer credentials. No ambient credential discovery or token generation.
export function createBridgeTransport({origin,getAccessToken,fetchImpl=fetch}) {
  const base=new URL(origin);
  if(base.protocol!=='https:'||base.origin!==origin||base.username||base.password||typeof getAccessToken!=='function')throw Error('Bridge configuration refused');
  return async event=>{
    validateEnvelope(event);
    const token=await getAccessToken();if(typeof token!=='string'||!token||/\s/.test(token))throw Error('Bridge credential required');
    const r=await fetchImpl(origin+'/ingest/discord',{method:'POST',redirect:'error',signal:AbortSignal.timeout(8000),headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(event)});
    let size=0;const chunks=[];for await(const c of r.body??[]){size+=c.length;if(size>16384)throw Error('Bridge response refused');chunks.push(Buffer.from(c));}
    if(r.status>=200&&r.status<300){const body=JSON.parse(Buffer.concat(chunks).toString());if(body.eventId!==event.eventId||typeof body.duplicate!=='boolean')throw Error('Bridge acknowledgement refused');}
    return {status:r.status};
  };
}
// Uses the same leased durable outbox as remote event delivery. A committed
// cloud ingest can be safely retried: dedup+fanout occur in one cloud CAS write.
export async function forwardNext({store,owner,forwardEnvelope}) {
  const claim=await store.claimDelivery(owner);if(!claim)return {attempted:false};
  let status=null;try{status=(await forwardEnvelope(claim.event)).status;}catch{/* redact */}
  await store.settleDelivery(owner,claim,status);
  return {attempted:true,acknowledged:status!==null&&status>=200&&status<300,eventId:claim.eventId};
}
export function createReceiverBridgeClient({origin,getAccessToken,fetchImpl=fetch}){
  const u=new URL(origin);if(u.protocol!=='https:'||u.origin!==origin||u.username||u.password)throw Error('Bridge configuration refused');
  return async(action,body={})=>{
    if(!['claim','receipt','drain'].includes(action))throw Error('Bridge action refused');
    const token=await getAccessToken();if(typeof token!=='string'||!token||/\s/.test(token))throw Error('Bridge credential required');
    const r=await fetchImpl(origin+'/receiver/discord/'+action,{method:'POST',redirect:'error',signal:AbortSignal.timeout(12000),headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body)});
    let size=0;const chunks=[];for await(const c of r.body??[]){size+=c.length;if(size>32768)throw Error('Bridge response refused');chunks.push(Buffer.from(c));}
    if(!r.ok)throw Error('Bridge access refused');return JSON.parse(Buffer.concat(chunks).toString());
  };
}
