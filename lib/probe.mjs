import { diagnostic } from './diagnostics.mjs';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { Webhook } from 'standardwebhooks';
export const EVENT='probe.created';
export const TEXT='Synthetic MCP connection probe';
const props={probe_id:{type:'string',pattern:'^[a-f0-9-]{36}$',description:'Random UUID identifying this synthetic experiment'}};
export const definition={name:EVENT,description:'One synthetic test notification with fixed text and a random probe ID. Contains no external-source data.',delivery:['webhook'],inputSchema:{type:'object',properties:props,required:['probe_id'],additionalProperties:false},payloadSchema:{type:'object',properties:{...props,text:{type:'string',const:TEXT}},required:['probe_id','text'],additionalProperties:false}};
export function validArgs(a){return a && Object.keys(a).length===1 && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(a.probe_id);}
export function secretBytes(s){if(typeof s!=='string'||!/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(s))throw new Error('invalid_secret');const b=Buffer.from(s.slice(6),'base64');if(b.length<24||b.length>64)throw new Error('invalid_secret');return b;}
export function subscriptionId(owner,p){return 'sub_'+createHash('sha256').update(JSON.stringify([owner,p.delivery.url,p.name,{probe_id:p.arguments.probe_id}])).digest('hex');}
export function safeEqual(a,b){return typeof a==='string'&&typeof b==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));}
export async function signedPost(sub,payload,transport){const body=JSON.stringify(payload);const id=payload.eventId || 'verify_'+randomUUID();const now=new Date();return transport(sub.url,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json','webhook-id':id,'webhook-timestamp':String(Math.floor(now.getTime()/1000)),'webhook-signature':new Webhook(sub.secret).sign(id,now,body),'X-MCP-Subscription-Id':sub.id},body});}
export function createHandler(store,transport){return async function handle(method,p={},owner){
 if(method==='server/discover')return {resultType:'complete',supportedVersions:['2026-07-28'],serverInfo:{name:'synthetic-event-probe',version:'0.1.0'},capabilities:{tools:{},events:{}}};
 if(method==='initialize')return {protocolVersion:p.protocolVersion==='2026-07-28'?'2026-07-28':'2025-06-18',serverInfo:{name:'synthetic-event-probe',version:'0.1.0'},capabilities:{tools:{},events:{}}};
 if(method==='ping')return {};
 if(method==='tools/list')return {tools:[{name:'probe_status',description:'Read synthetic probe delivery status. Never returns callback URLs or secrets.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true}},{name:'emit_probe',description:'Send a single fixed-text synthetic probe to an existing verified subscription. Idempotent per probe ID.',inputSchema:definition.inputSchema,annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true}}]};
 if(method==='events/list')return {events:[definition]};
 if(!owner)throw Object.assign(new Error('Authentication required'),{code:-32001});
 if(method==='events/subscribe'||method==='events/unsubscribe'){
  diagnostic(method,'subscription_validate_name');if(p.name!==EVENT)throw Object.assign(new Error('Invalid event name'),{code:-32602});
  diagnostic(method,'subscription_validate_arguments');if(!validArgs(p.arguments))throw Object.assign(new Error('Invalid event arguments'),{code:-32602});
  diagnostic(method,'subscription_validate_delivery');if(p.delivery?.mode!=='webhook'||typeof p.delivery.url!=='string')throw Object.assign(new Error('Invalid delivery'),{code:-32602});
  const id=subscriptionId(owner,p);
  if(method==='events/unsubscribe'){await store.remove(id,owner);return {};}
  diagnostic(method,'subscription_validate_secret');try{secretBytes(p.delivery.secret);}catch{throw Object.assign(new Error('Invalid signing secret'),{code:-32602});}
  diagnostic(method,'subscription_validate_ttl');if(p.ttlMs!==undefined&&p.ttlMs!==null&&(!Number.isSafeInteger(p.ttlMs)||p.ttlMs<=0))throw Object.assign(new Error('Invalid TTL'),{code:-32602});
  diagnostic(method,'subscription_read');const old=await store.get(id,owner);const sub={id,owner,probe_id:p.arguments.probe_id,url:p.delivery.url,secret:p.delivery.secret,expires:Date.now()+Math.min(p.ttlMs??3600000,3600000),sent:old?.sent??false};
  diagnostic(method,'callback_verify_start');try{const challenge=randomUUID();const response=await signedPost(sub,{type:'verification',challenge},transport);diagnostic(method,'callback_response',{status:response.status});if(!response.ok)throw new Error('challenge_failed');const body=await response.json();diagnostic(method,'callback_challenge_compare');if(!safeEqual(body.challenge,challenge))throw new Error('challenge_failed');}catch{diagnostic(method,'callback_verify_failed');throw Object.assign(new Error('Callback verification failed'),{code:-32015,data:{reason:'challenge_failed'}});}
  diagnostic(method,'subscription_persist');await store.put(sub);diagnostic(method,'subscription_complete');return {id,refreshBefore:new Date(sub.expires).toISOString(),cursor:null,truncated:false};
 }
 if(method==='tools/call'&&p.name==='probe_status')return {content:[{type:'text',text:JSON.stringify({mode:'synthetic_only',subscriptions:await store.status(owner)})}]};
 if(method==='tools/call'&&p.name==='emit_probe'){
  if(!validArgs(p.arguments))throw Object.assign(new Error('Invalid probe ID'),{code:-32602});
  const sub=await store.byProbe(owner,p.arguments.probe_id);if(!sub||sub.expires<=Date.now())throw new Error('No active subscription');
  if(sub.sent)return {content:[{type:'text',text:'Probe already claimed. No duplicate was sent.'}]};
  // Claim before outbound I/O: ambiguous delivery is never blindly retried.
  if(!await store.claim(sub.id,owner))return {content:[{type:'text',text:'Probe already claimed.'}]};
  const event={eventId:'evt_'+sub.probe_id,name:EVENT,timestamp:new Date().toISOString(),data:{probe_id:sub.probe_id,text:TEXT},cursor:null};
  let result;try{const r=await signedPost(sub,event,transport);result={accepted:r.ok,status:r.status,outcome:r.ok?'receipt_acknowledged':'rejected'};}catch{result={accepted:null,status:null,outcome:'unknown'};}
  await store.receipt(sub.id,owner,result);return {content:[{type:'text',text:JSON.stringify({...result,probe_id:sub.probe_id,note:'Receipt alone does not prove an agent wake.'})}]};
 }
 throw Object.assign(new Error('Method not found'),{code:-32601});
};}
