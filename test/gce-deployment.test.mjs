import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {generateKeyPairSync} from 'node:crypto';
import {CRC32C} from '@google-cloud/storage';
import {fetchGceSecrets} from '../scripts/fetch-gce-secrets.mjs';
import {renderGceTemplate,validateGceConfig} from '../scripts/render-gce-config.mjs';

const settings={host:'discord.example.com',googleClientId:'123-fixture.apps.googleusercontent.com',channelIds:['100000000000000600']};
test('GCEテンプレートはドメイン選択・構文注入・プレースホルダ残しなしでレンダリングされる',async()=>{
 for(const name of ['runtime.env.example','nginx-bootstrap.conf.example','nginx-https.conf.example','nginx-proxy.conf']){const text=renderGceTemplate(await readFile(new URL('../deployment/gce/'+name,import.meta.url),'utf8'),settings);assert(!text.includes('@@'));assert(text.includes(settings.host));}
 const env=renderGceTemplate(await readFile(new URL('../deployment/gce/runtime.env.example',import.meta.url),'utf8'),settings);assert(env.includes("DISCORD_CHANNEL_SCOPE=guild-visible"));assert(!env.includes("DISCORD_CHANNEL_IDS="));
 for(const host of ['192.0.2.1','evil.example;command','evil.example\nEnvironment=bad','bad..example','-bad.example','discord.example.com/route','example.run.app'])assert.throws(()=>validateGceConfig({...settings,host}));
});
test('準備済みsystemd/プロキシ/ファイアウォールはシークレットを環境に出さず、プライベート経路をイングレスから除外する',async()=>{
 const unit=await readFile(new URL('../deployment/gce/discord-mcp.service',import.meta.url),'utf8');assert(unit.includes('User=discord-mcp'));assert(unit.includes('StateDirectoryMode=0700'));assert(unit.includes('LoadCredential='));assert(unit.includes('/usr/bin/flock --nonblock'));assert(unit.includes('ProtectSystem=strict'));assert(!unit.includes('bot-token='));
 const proxy=renderGceTemplate(await readFile(new URL('../deployment/gce/nginx-proxy.conf',import.meta.url),'utf8'),settings);assert(proxy.includes('X-Forwarded-Proto https'));assert(proxy.includes('Host discord.example.com'));assert(proxy.includes('127.0.0.1:8080'));
 const web=await readFile(new URL('../deployment/gce/nginx-https.conf.example',import.meta.url),'utf8');assert(web.includes('ssl_reject_handshake on'));assert(web.includes('access_log off'));assert(web.includes('location = /mcp/discord'));assert(web.includes('location = /mcp/x'));assert(web.includes('location ^~ /x/'));assert(!web.includes('location /receiver'));assert(!web.includes('location /ingest'));assert(web.includes('location / { return 404; }'));
});

const auth=Buffer.from(JSON.stringify({cookieKeys:['FAKE-EPHEMERAL-COOKIE-KEY-012345678901234567890'],jwks:{keys:[{...generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({format:'jwk'}),use:'sig',alg:'RS256',kid:'fake-only'}]}}));
function fake({identityWrong=false,versionWrong=false,crcWrong=false,invalidAuth=false}={}){
 const calls=[],writes=[];
 const fetchImpl=async(url,options)=>{calls.push({url,options});
  if(url.endsWith('/email'))return new Response(identityWrong?'unexpected@fixture.invalid':'discord-mcp-gce@example-project.iam.gserviceaccount.com',{headers:{'Metadata-Flavor':'Google'}});
  if(url.endsWith('/token'))return Response.json({access_token:'FAKE-EPHEMERAL-VM-ACCESS',token_type:'Bearer',expires_in:3600},{headers:{'Metadata-Flavor':'Google'}});
  const bot=url.includes('/discord-mention-bot-token/'),xAuth=url.includes('/x-monitor-auth-token/'),xCt0=url.includes('/x-monitor-ct0/');
  const bytes=bot?Buffer.from('FAKE-BOT-TOKEN'):xAuth?Buffer.from('FAKE-X-AUTH-TOKEN'):xCt0?Buffer.from('FAKE-X-CT0'):invalidAuth?Buffer.from('{}'):auth,crc=new CRC32C();crc.update(bytes);
  const name=bot?'discord-mention-bot-token':xAuth?'x-monitor-auth-token':xCt0?'x-monitor-ct0':'discord-consolidated-auth';
  const resolved=versionWrong?'9':bot?'2':'1';
  return Response.json({name:'projects/123456789012/secrets/'+name+'/versions/'+resolved,payload:{data:bytes.toString('base64'),dataCrc32c:crcWrong?'0':String(crc.toBuffer().readUInt32BE(0))}});
 };
 return {calls,writes,fetchImpl,writeSecret:async(name,bytes)=>{writes.push({name,bytes});}};
}
function withPinnedVersions(fn){
 const keys=['MCP_DISCORD_BOT_SECRET_VERSION','MCP_AUTH_SECRET_VERSION'],saved=keys.map(k=>process.env[k]);
 process.env.MCP_DISCORD_BOT_SECRET_VERSION='2';process.env.MCP_AUTH_SECRET_VERSION='1';
 return Promise.resolve().then(fn).finally(()=>{keys.forEach((k,i)=>{saved[i]===undefined?delete process.env[k]:process.env[k]=saved[i];});});
}
test('VM専用シークレットローダーはペア公開前にID・正確なバージョン・CRCを検証する。フェイクI/Oのみ',async()=>{
 await withPinnedVersions(async()=>{const f=fake();assert.deepEqual(await fetchGceSecrets(f),{loaded:true,versionsVerified:true,xLoaded:false});assert.deepEqual(f.writes.map(x=>x.name),['bot-token','auth.json']);assert.equal(f.calls.length,4);assert(f.calls.every(x=>x.options.redirect==='error'));assert(f.calls[2].url.endsWith('/versions/2:access'));assert(f.calls[3].url.endsWith('/versions/1:access'));});
});
test('VM専用シークレットローダーはlatest指定で解決済みバージョンを受理する',async()=>{
 delete process.env.MCP_DISCORD_BOT_SECRET_VERSION;delete process.env.MCP_AUTH_SECRET_VERSION;
 const f=fake();assert.deepEqual(await fetchGceSecrets(f),{loaded:true,versionsVerified:true,xLoaded:false});assert(f.calls[2].url.endsWith('/versions/latest:access'));assert(f.calls[3].url.endsWith('/versions/latest:access'));
 const wrong=fake({identityWrong:true});await assert.rejects(fetchGceSecrets(wrong));assert.equal(wrong.writes.length,0);
});

test('X Web Push有効時は監視アカウントCookieも検証後にroot限定ランタイムへ公開する',async()=>{
 const keys=['X_WEB_PUSH_SOURCE_ID','MCP_X_AUTH_TOKEN_SECRET_VERSION','MCP_X_CT0_SECRET_VERSION'],saved=keys.map(k=>process.env[k]);
 process.env.X_WEB_PUSH_SOURCE_ID='@owner';process.env.MCP_X_AUTH_TOKEN_SECRET_VERSION='1';process.env.MCP_X_CT0_SECRET_VERSION='1';
 try{
  const f=fake();assert.deepEqual(await fetchGceSecrets(f),{loaded:true,versionsVerified:true,xLoaded:true});
  assert.deepEqual(f.writes.map(x=>x.name),['bot-token','auth.json','x-auth-token','x-ct0']);
  assert.equal(f.calls.length,6);assert(f.calls[4].url.includes('/x-monitor-auth-token/versions/1:access'));assert(f.calls[5].url.includes('/x-monitor-ct0/versions/1:access'));
 }finally{keys.forEach((k,i)=>{saved[i]===undefined?delete process.env[k]:process.env[k]=saved[i];});}
});
test('VM専用シークレットローダーは誤ったID/バージョン/チェックサム/材料を書き込み・非公開エラーなしで拒否する',async()=>{
 await withPinnedVersions(async()=>{for(const options of [{identityWrong:true},{versionWrong:true},{crcWrong:true},{invalidAuth:true}]){const f=fake(options);await assert.rejects(fetchGceSecrets(f),error=>{assert(!error.message.includes('FAKE'));assert(!error.message.includes('projects/'));return true;});assert.equal(f.writes.length,0);}});
});
