import {OAuth2Client} from 'google-auth-library';
const paths=new Set(['/ingest/discord','/receiver/discord/claim','/receiver/discord/receipt','/receiver/discord/drain']);
const receiverScopes=['discord:ingest','discord:receive-replies'];
// Enabled only by explicit deployment configuration and a live owner-approved
// delegation record. Runtime never receives the OAuth aggregate or user refresh.
export function createWorkloadReceiverAuth({base,backend,origin,verifyIdentity,now=Date.now}){
 const u=new URL(origin);if(u.protocol!=='https:'||u.origin!==origin||typeof backend?.read!=='function')throw Error('Workload configuration refused');
 const google=verifyIdentity?null:new OAuth2Client({transporterOptions:{timeout:5000,retry:false}});
 const verify=verifyIdentity??(async token=>(await google.verifyIdToken({idToken:token,audience:origin})).getPayload());
 return {...base,async authenticate(req){
  if(!paths.has(new URL(req.url,origin).pathname))return base.authenticate(req);
  const existing=await base.authenticate(req);if(existing)return existing;
  const header=req.headers.authorization;if(typeof header!=='string'||!/^Bearer [A-Za-z0-9._~-]+$/.test(header)||header.length>8192)return null;
  try{
   const [record,owner]=await Promise.all([backend.read('workload-receiver:v1'),backend.read('google-owner:v1')]);
   const at=now();if(!record||record.version!==1||record.enabled!==true||!owner?.sub||record.owner!=='google:'+owner.sub||!Number.isSafeInteger(record.approvedAt)||!Number.isSafeInteger(record.expiresAt)||record.approvedAt>at||record.expiresAt<=at||record.expiresAt-record.approvedAt>90*86400000||record.audience!==origin||!/^\d{6,30}$/.test(record.subject??'')||!/^discord-mention-receiver@example-project\.iam\.gserviceaccount\.com$/.test(record.email??'')||!Array.isArray(record.scopes)||record.scopes.length!==2||!receiverScopes.every(s=>record.scopes.includes(s)))return null;
   const p=await verify(header.slice(7));if(!p||!['accounts.google.com','https://accounts.google.com'].includes(p.iss)||p.aud!==origin||p.sub!==record.subject||p.email!==record.email||p.email_verified!==true||!Number.isSafeInteger(p.exp)||p.exp*1000<=at||!Number.isSafeInteger(p.iat)||p.iat<0||p.iat*1000>at+30000||p.exp<=p.iat||p.exp-p.iat>3600)return null;
   return {owner:record.owner,clientId:'workload:'+record.subject,grantId:'workload:'+record.subject+':'+record.approvedAt,grantExpiresAt:record.expiresAt,resource:origin+'/mcp',scopes:[...receiverScopes]};
  }catch{return null;}
 }};
}
