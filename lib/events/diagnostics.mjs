// 固定のスカラー語彙のみ。リクエスト、プリンシパル、コールバック宛先/
// 署名データ、チャレンジ本文、任意の例外テキストを直列化してはならない。
const methods=new Set(['initialize','server/discover','ping','tools/list','tools/call','events/list','events/subscribe','events/unsubscribe']);
const phases=new Set(['request_received','request_completed','request_failed','validate_name','validate_scope','validate_arguments','validate_delivery','validate_secret','validate_ttl','validate_grant_lifetime','callback_verify_start','callback_response','callback_challenge_compare','callback_verify_complete','callback_dns_start','callback_dns_complete','callback_dns_failed','callback_connect_start','callback_tls_connected','callback_connection_failed','persistence_start','persistence_complete','unsubscribe_start','unsubscribe_complete']);
const errorCodes=new Set(['EVENT_INPUT','EVENT_SCOPE','EVENT_VERIFY','EVENT_CAPACITY','EVENT_CORRUPT','EVENT_ROTATION_IN_PROGRESS','EVENT_SUBSCRIPTION_IMMUTABLE','STORAGE_INPUT','STORAGE_CAPACITY','STORAGE_CORRUPT','STORAGE_UNAVAILABLE','STORAGE_CONFLICT','ENOTFOUND','ENODATA','EAI_AGAIN','ECONNRESET','ECONNREFUSED','ETIMEDOUT','ERR_TLS_CERT_ALTNAME_INVALID','CERT_HAS_EXPIRED','UNABLE_TO_VERIFY_LEAF_SIGNATURE','DEPTH_ZERO_SELF_SIGNED_CERT']);
const rpcCodes=new Set([-32001,-32015,-32601,-32602,-32603]);
const rejectionReasons=new Set(['unexpected_request_fields','invalid_metadata_shape','invalid_argument_shape','unsupported_cursor','guild_mismatch']);
export function eventDiagnostic(kind,method,phase,details={},sink=console.info){
  const entry={kind:kind==='subscription'?'discord_subscription_diagnostic':kind==='callback'?'discord_callback_diagnostic':'discord_mcp_diagnostic',method:methods.has(method)?method:'unknown',phase:phases.has(phase)?phase:'unknown'};
  if(Number.isInteger(details.status)&&details.status>=100&&details.status<=599)entry.status=details.status;
  if(rejectionReasons.has(details.error?.subscriptionReason))entry.reason=details.error.subscriptionReason;
  if(errorCodes.has(details.error?.code))entry.errorCode=details.error.code;
  if(details.error&&kind!=='callback')entry.rpcCode=rpcCodes.has(details.error.code)?details.error.code:-32603;
  try{sink(JSON.stringify(entry));}catch{/* 診断は配送や認可を変えてはならない。 */}
  return entry;
}
