const phases=new Set(['authorization_received','authorization_consent_requested','authorization_completed','token_completed','token_failed']);
const errors=new Set(['invalid_request','invalid_client','invalid_grant','invalid_scope','invalid_target','unsupported_grant_type','server_error','temporarily_unavailable','access_denied','login_required','consent_required']);
export function discordOAuthDiagnostic(phase,details={},sink=console.info){
 const row={kind:'discord_oauth_diagnostic',phase:phases.has(phase)?phase:'unknown'};
 for(const field of ['offlineAccessRequested','consentPromptRequested','offlineAccessInSource','refreshTokenIssued','refreshGrantAllowed','resourceMatches'])if(typeof details[field]==='boolean')row[field]=details[field];
 if(['authorization_code','refresh_token'].includes(details.grantType))row.grantType=details.grantType;
 if(Number.isInteger(details.status)&&details.status>=100&&details.status<=599)row.status=details.status;
 if(errors.has(details.errorCode))row.errorCode=details.errorCode;
 try{sink(JSON.stringify(row));}catch{}
 return row;
}
// Enforce consent for an explicitly requested offline grant when a public
// consumer omits prompt. Do not add scopes or rewrite explicit prompt=none/login.
export function prepareDiscordOfflineConsent(parsed,config){
 if(!config.discordConsumerOnly||!config.discordUnattendedEnabled||parsed.searchParams.get('response_type')!=='code'||!String(parsed.searchParams.get('scope')??'').split(' ').includes('offline_access')||parsed.searchParams.has('prompt'))return false;
 parsed.searchParams.set('prompt','consent');return true;
}
