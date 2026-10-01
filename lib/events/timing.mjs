const phases=new Set(['gateway_received','ingest_started','ingest_committed','callback_claim_committed','callback_post_started','callback_post_completed','callback_receipt_committed','mcp_request_received','mcp_request_completed','mcp_handler_started','mcp_handler_completed','reply_queue_committed','reply_claim_committed','reply_post_started','reply_post_completed','reply_receipt_committed','discord_post_started','discord_post_headers','discord_post_completed','reaction_queued','reaction_post_started','reaction_post_completed','reaction_complete']);
const actions=new Set(['discord_read_event','discord_reply_to_event','discord_status','tools/list','tools/call','events/list','events/subscribe','events/unsubscribe','initialize','notifications/initialized','ping']);
export function createTimingSink({sink=console.info,now=Date.now}={}){
 return (phase,details={})=>{
  if(!phases.has(phase))return;const row={kind:'discord_stage_timing',phase,wallTime:new Date(Number.isSafeInteger(details.atMs)?details.atMs:now()).toISOString()};
  if(/^evt_[a-f0-9]{64}$/.test(details.eventId??''))row.eventId=details.eventId;
  if(/^[a-f0-9-]{36}$/.test(details.requestTrace??''))row.requestTrace=details.requestTrace;
  if(actions.has(details.action))row.action=details.action;
  if(Number.isFinite(details.durationMs)&&details.durationMs>=0&&details.durationMs<=3600000)row.durationMs=Math.round(details.durationMs*1000)/1000;
  if(Number.isInteger(details.httpStatus)&&details.httpStatus>=100&&details.httpStatus<=599)row.httpStatus=details.httpStatus;
  if(Number.isInteger(details.attempt)&&details.attempt>=1&&details.attempt<=3)row.attempt=details.attempt;
  if(typeof details.success==='boolean')row.success=details.success;
  if(typeof details.sourceTimestamp==='string'&&details.sourceTimestamp.length<=32&&Number.isFinite(Date.parse(details.sourceTimestamp)))row.sourceTimestamp=new Date(details.sourceTimestamp).toISOString();
  try{sink(JSON.stringify(row));}catch{}
 };
}
