import { readFile } from 'node:fs/promises';
export async function readProductionConfig(env) {
 if(env.GOOGLE_APPLICATION_CREDENTIALS)throw Error('Use runtime identity, not a key file');
 const origin=new URL(env.PROBE_ORIGIN ?? '');
 if(origin.protocol!=='https:'||origin.origin!==env.PROBE_ORIGIN||origin.username||origin.password)throw Error('Exact HTTPS origin required');
 if(!/^[0-9]+-[a-zA-Z0-9_-]+\.apps\.googleusercontent\.com$/.test(env.GOOGLE_CLIENT_ID??''))throw Error('Google web client required');
 if(!env.GOOGLE_ALLOWED_EMAIL || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(env.GOOGLE_ALLOWED_EMAIL))throw Error('Owner email required');
 if(!env.PROBE_BUCKET || !/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/.test(env.PROBE_BUCKET))throw Error('Private bucket required');
 const redirects=JSON.parse(env.PROBE_REDIRECT_URIS??'[]');
 if(!Array.isArray(redirects)||!redirects.length||redirects.length>8||redirects.some(raw=>{try{const u=new URL(raw);return u.protocol!=='https:'||u.origin!=='https://chatgpt.com'||u.search||u.hash||!(u.pathname==='/connector_platform_oauth_redirect'||/^\/connector\/oauth\/[a-zA-Z0-9_-]+$/.test(u.pathname));}catch{return true;}}))throw Error('Verified connector redirect allowlist required');
 if(!env.PROBE_AUTH_SECRET_FILE)throw Error('Approved mounted secret required');
 const secret=JSON.parse(await readFile(env.PROBE_AUTH_SECRET_FILE,'utf8'));
 if(!Array.isArray(secret.cookieKeys)||secret.cookieKeys.length<1||secret.cookieKeys.some(k=>typeof k!=='string'||Buffer.byteLength(k)<32)||!Array.isArray(secret.jwks?.keys)||!secret.jwks.keys.length||secret.jwks.keys.some(k=>!k.d||k.kty!=='RSA'||!k.n||!k.e))throw Error('Production signing/cookie material required');
 if(env.DISCORD_ENABLE!==undefined&&!['true','false'].includes(env.DISCORD_ENABLE))throw Error('Invalid Discord enable flag');
 if(env.DISCORD_UNATTENDED_ENABLE!==undefined&&!['true','false'].includes(env.DISCORD_UNATTENDED_ENABLE))throw Error('Invalid unattended enable flag');
 if(env.DISCORD_UNATTENDED_ENABLE==='true'&&env.DISCORD_ENABLE!=='true')throw Error('Discord must be enabled first');
 if(env.X_WEB_PUSH_ENABLE!==undefined&&!['true','false'].includes(env.X_WEB_PUSH_ENABLE))throw Error('Invalid X Web Push enable flag');
 return {origin:origin.origin,resource:origin.origin+'/mcp',googleClientId:env.GOOGLE_CLIENT_ID,ownerEmail:env.GOOGLE_ALLOWED_EMAIL.toLowerCase(),bucket:env.PROBE_BUCKET,redirects,jwks:secret.jwks,cookieKeys:secret.cookieKeys,discordEnabled:env.DISCORD_ENABLE==='true',discordUnattendedEnabled:env.DISCORD_UNATTENDED_ENABLE==='true',xEnabled:env.X_WEB_PUSH_ENABLE==='true'};
}
