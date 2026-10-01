import Provider, { errors } from 'oidc-provider';
import { OAuth2Client } from 'google-auth-library';
import { createOidcAdapter } from './oidc-storage.mjs';
import { createOwnerVerifier } from './google-owner.mjs';
import { discordLifetime } from './discord-lifetime.mjs';
import { discordOAuthDiagnostic,prepareDiscordOfflineConsent } from './discord-oauth-diagnostics.mjs';
const js=value=>JSON.stringify(value).replace(/</g,'\\u003c');
const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function providerConfiguration(config,backend) {
 const resourceScopes = config.discordConsumerOnly ? ['discord:read','discord:reply'] : config.discordEnabled ? ['probe','discord:read','discord:reply',...(config.discordReceiverEnabled?['discord:ingest','discord:receive-replies']:[])] : ['probe'];
 return {
  adapter:createOidcAdapter(backend,{compactRefresh:config.discordUnattendedEnabled===true}),jwks:config.jwks,
  cookies:{keys:config.cookieKeys,...(config.discordConsumerOnly?{names:{session:'_discord_session',interaction:'_discord_interaction',resume:'_discord_resume'}}:{}),long:{httpOnly:true,secure:true,sameSite:'lax'},short:{httpOnly:true,secure:true,sameSite:'lax'}},
  clients:[],clientDefaults:{token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code'],...(config.discordConsumerOnly?{scope:'openid offline_access discord:read discord:reply'}:{})},
  clientAuthMethods:['none'],responseTypes:['code'],scopes:['openid','offline_access',...resourceScopes],claims:{openid:['sub']},
  pkce:{required:()=>true},
  features:{pushedAuthorizationRequests:{enabled:false},dPoP:{enabled:false},mTLS:{enabled:false},devInteractions:{enabled:false},registration:{enabled:true,issueRegistrationAccessToken:false},registrationManagement:{enabled:false},clientIdMetadataDocument:{enabled:false},resourceIndicators:{enabled:true,defaultResource:()=>config.resource,useGrantedResource:()=>true,getResourceServerInfo:async(_ctx,resource)=>{if(resource!==config.resource)throw new errors.InvalidTarget();return {scope:resourceScopes.join(' '),audience:config.resource,accessTokenFormat:'opaque',accessTokenTTL:900};}},revocation:{enabled:true},userinfo:{enabled:false}},
  extraClientMetadata:{properties:['probe_policy'],validator(_ctx,_key,_value,m){
   if(config.discordConsumerOnly&&String(m.scope??'').split(' ').some(s=>!['openid','offline_access','discord:read','discord:reply'].includes(s)))throw new errors.InvalidClientMetadata('Consumer scopes only');
   if(m.token_endpoint_auth_method!=='none'||!Array.isArray(m.redirect_uris)||!m.redirect_uris.length||m.redirect_uris.some(u=>!config.redirects.includes(u))||m.grant_types?.some(g=>!['authorization_code','refresh_token'].includes(g))||m.response_types?.some(r=>r!=='code')||m.jwks_uri||m.jwks||m.sector_identifier_uri||m.request_uris?.length)throw new errors.InvalidClientMetadata('Only approved public connector clients are supported');
  }},
  interactions:{url:(_ctx,interaction)=>config.origin+'/interaction/'+interaction.uid},
  findAccount:async(_ctx,id)=>{const owner=await backend.read('google-owner:v1');if(!owner||id!=='google:'+owner.sub)return undefined;return {accountId:id,claims:async()=>({sub:id})};},
  rotateRefreshToken:true,
  ttl:{AccessToken:900,AuthorizationCode:60,IdToken:900,Interaction:600,Session:3600,...(config.discordUnattendedEnabled?discordLifetime(config):{Grant:3600,RefreshToken:3600})},
  renderError:async ctx=>{ctx.type='text/plain';ctx.body='Authorization could not be completed';},
 };
}
async function readJson(req){let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>20000)throw Error('Request too large');chunks.push(chunk);}return JSON.parse(Buffer.concat(chunks).toString());}
const json=(res,status,body)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(body));};
export function createOAuth({config,backend,google=new OAuth2Client({clientId:config.googleClientId,transporterOptions:{timeout:5000,retry:false}}),ProviderClass=Provider,diagnosticSink=console.info}) {
 const resourceScopes = config.discordConsumerOnly ? ['discord:read','discord:reply'] : config.discordEnabled ? ['probe','discord:read','discord:reply',...(config.discordReceiverEnabled?['discord:ingest','discord:receive-replies']:[])] : ['probe'];
 const provider=new ProviderClass(config.origin,providerConfiguration(config,backend));
 if(config.discordConsumerOnly){
  provider.use(async(ctx,next)=>{
   try{await next();}catch(error){if(ctx.path==='/token')discordOAuthDiagnostic('token_failed',{status:error?.statusCode,errorCode:error?.error},diagnosticSink);throw error;}if(ctx.path!=='/token')return;
   const source=ctx.oidc?.entities?.AuthorizationCode??ctx.oidc?.entities?.RefreshToken;
   discordOAuthDiagnostic(ctx.status>=400?'token_failed':'token_completed',{status:ctx.status,grantType:ctx.oidc?.params?.grant_type,refreshTokenIssued:typeof ctx.body?.refresh_token==='string',offlineAccessInSource:source?.scopes?.has('offline_access'),refreshGrantAllowed:ctx.oidc?.client?.grantTypeAllowed('refresh_token'),errorCode:ctx.body?.error},diagnosticSink);
  });
  provider.on('authorization.success',ctx=>discordOAuthDiagnostic('authorization_completed',{offlineAccessRequested:ctx.oidc?.requestParamScopes?.has('offline_access')},diagnosticSink));
 }
 // Cloud Run がTLSを終端する。デプロイは任意のプロキシチェーンではなく直接
 // イングレスでなければならず、issuer/URLは転送された Host から決して導かない。
 provider.proxy=true;
 const verifyOwner=createOwnerVerifier({google,config,backend});
 const callback=provider.callback();
 const limits=new Map();
 function allowRequest(path){const registration=path==='/reg';const key=registration?'registration':'oauth';const now=Date.now();const windowMs=registration?3600000:60000;const max=registration?4:60;let limit=limits.get(key);if(!limit||now>=limit.until){limit={until:now+windowMs,count:0};limits.set(key,limit);}return ++limit.count<=max;}
 async function handleInteraction(req,res,path){
  const details=await provider.interactionDetails(req,res);
  if(path!=='/interaction/'+details.uid)throw Error('Interaction mismatch');
  if(req.method==='GET'){
   if(!['login','consent'].includes(details.prompt.name))throw Error('Unsupported interaction');
   const login=details.prompt.name==='login';
   const script=login?`window.onGoogleLogin=async response=>{const r=await fetch(location.pathname,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'login',credential:response.credential})});const v=await r.json();if(r.ok)location.assign(v.redirect);else document.getElementById('status').textContent='Login was not accepted';};window.onGoogleReady=()=>{google.accounts.id.initialize({client_id:${js(config.googleClientId)},callback:onGoogleLogin,nonce:${js(details.uid)},auto_select:false});google.accounts.id.renderButton(document.getElementById('google-button'),{theme:'outline',size:'large'});};`:`window.confirmProbe=async()=>{const r=await fetch(location.pathname,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'consent'})});const v=await r.json();if(r.ok)location.assign(v.redirect);else document.getElementById('status').textContent='Consent was not accepted';};`;
   res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','referrer-policy':'no-referrer','x-frame-options':'DENY','content-security-policy':"default-src 'none'; script-src 'unsafe-inline' https://accounts.google.com/gsi/client; frame-src https://accounts.google.com; connect-src 'self' https://accounts.google.com; style-src 'unsafe-inline' https://accounts.google.com; img-src https://*.googleusercontent.com; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"});
   const requested = String(details.params.scope ?? '').split(' ');
   const discordConsent = config.discordEnabled && requested.some(s => s.startsWith('discord:'));
   const consent = discordConsent ? 'Allow requested Discord scopes for guild 100000000000000400: read stored bot mention events and, if discord:reply is requested, send one ordinary reply only to each originating channel. No dot private chat, mail, camera, channel history, or attachments may be used. '+(config.discordUnattendedEnabled&&!requested.includes('probe')?'Separate Discord-role grants last up to 90 days, with rotating refresh tokens expiring after 24 hours without use and access tokens lasting 15 minutes. Mixed consumer/receiver roles remain limited to one hour. ':'Access lasts up to one hour. ')+'If discord:ingest is requested, authorize this separate receiver to submit only allowlisted Discord mention events. Synthetic probe permissions apply only if probe is also requested.' : 'Allow this ChatGPT connection to subscribe to and send fixed synthetic probe events, read their delivery status, and maintain access for up to one hour. No Discord or private-source data is included.';
   res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>MCP connection consent</title><h1>MCP connection consent</h1><p>${login?'Sign in with the approved Google account.':consent}</p>${login?'<div id="google-button"></div>':'<button onclick="confirmProbe()">Allow requested access</button>'}<p id="status"></p><script>${script}</script>${login?'<script src="https://accounts.google.com/gsi/client" async defer onload="onGoogleReady()"></script>':''}`);return;
  }
  if(req.method!=='POST'||req.headers.origin!==new URL(config.origin).origin||!/^application\/json(?:;|$)/i.test(req.headers['content-type']??''))throw Error('Invalid interaction request');
  const body=await readJson(req);let redirect;
  if(body.action==='login'&&details.prompt.name==='login'){
   const accountId=await verifyOwner(body.credential,details.uid);
   redirect=await provider.interactionResult(req,res,{login:{accountId}},{mergeWithLastSubmission:false});
  }else if(body.action==='consent'&&details.prompt.name==='consent'){
   const owner=await backend.read('google-owner:v1');if(!owner||details.session?.accountId!=='google:'+owner.sub)throw Error('Owner session required');
   let grant=details.grantId?await provider.Grant.find(details.grantId):undefined;
   grant ||= new provider.Grant({accountId:details.session.accountId,clientId:details.params.client_id});
   const missing=details.prompt.details;
   if(missing.missingOIDCScope)grant.addOIDCScope(missing.missingOIDCScope.join(' '));
   if(missing.missingOIDCClaims)grant.addOIDCClaims(missing.missingOIDCClaims);
   for(const [resource,scopes]of Object.entries(missing.missingResourceScopes??{})){if(resource!==config.resource||scopes.some(s=>!resourceScopes.includes(s)))throw Error('Invalid scope');grant.addResourceScope(resource,scopes.join(' '));}
   const grantId=await grant.save();redirect=await provider.interactionResult(req,res,{consent:{grantId}},{mergeWithLastSubmission:true});
  }else throw Error('Invalid interaction');
  if(!redirect.startsWith(config.origin+'/'))throw Error('Invalid resume');json(res,200,{redirect});
 }
 return {
  productionReady:true,
  challenge:`Bearer resource_metadata="${new URL(config.origin).origin}/.well-known/oauth-protected-resource${new URL(config.resource).pathname}"${config.discordEnabled?'':', scope="probe"'}`,
  async authenticate(req){
   const header=req.headers.authorization;if(typeof header!=='string'||!/^Bearer [A-Za-z0-9._~-]+$/.test(header)||header.length>8192)return null;
   try{const token=await provider.AccessToken.find(header.slice(7));const owner=await backend.read('google-owner:v1');if(!token||!owner||token.accountId!=='google:'+owner.sub||token.aud!==config.resource||!resourceScopes.some(s=>token.scopes.has(s))||token.isExpired||token.isSenderConstrained())return null;const grant=token.grantId?await provider.Grant.find(token.grantId):null;const client=await provider.Client.find(token.clientId);if(!grant||grant.isExpired||!client||grant.clientId!==token.clientId||grant.accountId!==token.accountId)return null;const granted=new Set(grant.getResourceScope(config.resource).split(' '));const scopes=resourceScopes.filter(s=>token.scopes.has(s)&&granted.has(s));if(!scopes.length)return null;return {owner:token.accountId,clientId:token.clientId,grantId:token.grantId,grantExpiresAt:grant.exp*1000,resource:config.resource,scopes};}catch{return null;}
  },
  async handleHttp(req,res){
   const parsed=new URL(req.url,config.origin);const mount=new URL(config.origin).pathname.replace(/\/$/,'');let path=parsed.pathname;
   if(mount){
    if(path===new URL(config.resource).pathname||path==='/.well-known/oauth-protected-resource'+new URL(config.resource).pathname){}
    else if(path=== '/.well-known/oauth-authorization-server'+mount||path==='/.well-known/openid-configuration'+mount)path=path.slice(0,-mount.length);
    else if(path.startsWith(mount+'/'))path=path.slice(mount.length);
    else return false;
   }
   // 転送されたauthorityがプロバイダ生成のエンドポイント/resume URLを変えることは許さない。
   if(config.discordConsumerOnly&&path==='/auth'){
    discordOAuthDiagnostic('authorization_received',{offlineAccessRequested:String(parsed.searchParams.get('scope')??'').split(' ').includes('offline_access'),consentPromptRequested:String(parsed.searchParams.get('prompt')??'').split(' ').includes('consent'),resourceMatches:parsed.searchParams.get('resource')===config.resource},diagnosticSink);
    if(prepareDiscordOfflineConsent(parsed,config))discordOAuthDiagnostic('authorization_consent_requested',{offlineAccessRequested:true,consentPromptRequested:true},diagnosticSink);
   }
   req.url=path+parsed.search;req.baseUrl=mount;delete req.originalUrl;req.headers.host=new URL(config.origin).host;
   req.headers['x-forwarded-host']=req.headers.host;req.headers['x-forwarded-proto']='https';delete req.headers.forwarded;
   if(path===new URL(config.resource).pathname||path==='/healthz'||(config.discordReceiverEnabled&&['/ingest/discord','/receiver/discord/claim','/receiver/discord/receipt','/receiver/discord/drain'].includes(path)))return false;
   try{
    if(path==='/.well-known/oauth-protected-resource'+new URL(config.resource).pathname||path==='/.well-known/oauth-protected-resource'){
     if(req.method!=='GET'){json(res,405,{error:'GET required'});return true;}
     json(res,200,{resource:config.resource,authorization_servers:[config.origin],bearer_methods_supported:['header'],scopes_supported:[...resourceScopes,'openid','offline_access']});return true;
    }
    if(config.discordConsumerOnly&&path==='/auth'&&String(parsed.searchParams.get('scope')??'').split(' ').some(s=>s&&!['openid','offline_access','discord:read','discord:reply'].includes(s))){json(res,400,{error:'Consumer scopes only'});return true;}
    if(!allowRequest(path)){res.writeHead(429,{'retry-after':'60','cache-control':'no-store'});res.end('Please try again later');return true;}
    if(path.startsWith('/interaction/')){await handleInteraction(req,res,path);return true;}
    await callback(req,res);return true;
   }catch{if(!res.headersSent)json(res,400,{error:'Authorization could not be completed'});else res.end();return true;}
  },
 };
}
