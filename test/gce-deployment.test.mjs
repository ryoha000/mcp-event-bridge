import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {generateKeyPairSync} from 'node:crypto';
import {CRC32C} from '@google-cloud/storage';
import {fetchGceSecrets} from '../scripts/fetch-gce-secrets.mjs';
import {renderGceTemplate,validateGceConfig} from '../scripts/render-gce-config.mjs';

const settings={host:'discord.example.com',googleClientId:'123-fixture.apps.googleusercontent.com',channelIds:['100000000000000600']};
test('GCE templates render without selecting a domain, injecting syntax or leaving placeholders',async()=>{
 for(const name of ['runtime.env.example','nginx-bootstrap.conf.example','nginx-https.conf.example','nginx-proxy.conf']){const text=renderGceTemplate(await readFile(new URL('../deployment/gce/'+name,import.meta.url),'utf8'),settings);assert(!text.includes('@@'));assert(text.includes(settings.host));}
 const env=renderGceTemplate(await readFile(new URL('../deployment/gce/runtime.env.example',import.meta.url),'utf8'),settings);assert(env.includes("DISCORD_CHANNEL_SCOPE=guild-visible"));assert(!env.includes("DISCORD_CHANNEL_IDS="));
 for(const host of ['192.0.2.1','evil.example;command','evil.example\nEnvironment=bad','bad..example','-bad.example','discord.example.com/route','example.run.app'])assert.throws(()=>validateGceConfig({...settings,host}));
});
test('prepared systemd/proxy/firewalls keep secrets out of environment and private routes out of ingress',async()=>{
 const unit=await readFile(new URL('../deployment/gce/discord-mcp.service',import.meta.url),'utf8');assert(unit.includes('User=discord-mcp'));assert(unit.includes('StateDirectoryMode=0700'));assert(unit.includes('LoadCredential='));assert(unit.includes('/usr/bin/flock --nonblock'));assert(unit.includes('ProtectSystem=strict'));assert(!unit.includes('bot-token='));
 const proxy=renderGceTemplate(await readFile(new URL('../deployment/gce/nginx-proxy.conf',import.meta.url),'utf8'),settings);assert(proxy.includes('X-Forwarded-Proto https'));assert(proxy.includes('Host discord.example.com'));assert(proxy.includes('127.0.0.1:8080'));
 const web=await readFile(new URL('../deployment/gce/nginx-https.conf.example',import.meta.url),'utf8');assert(web.includes('ssl_reject_handshake on'));assert(web.includes('access_log off'));assert(!web.includes('location /receiver'));assert(!web.includes('location /ingest'));assert(web.includes('location / { return 404; }'));
});

const auth=Buffer.from(JSON.stringify({cookieKeys:['FAKE-EPHEMERAL-COOKIE-KEY-012345678901234567890'],jwks:{keys:[{...generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({format:'jwk'}),use:'sig',alg:'RS256',kid:'fake-only'}]}}));
function fake({identityWrong=false,versionWrong=false,crcWrong=false,invalidAuth=false}={}){
 const calls=[],writes=[];
 const fetchImpl=async(url,options)=>{calls.push({url,options});
  if(url.endsWith('/email'))return new Response(identityWrong?'unexpected@fixture.invalid':'discord-mcp-gce@example-project.iam.gserviceaccount.com',{headers:{'Metadata-Flavor':'Google'}});
  if(url.endsWith('/token'))return Response.json({access_token:'FAKE-EPHEMERAL-VM-ACCESS',token_type:'Bearer',expires_in:3600},{headers:{'Metadata-Flavor':'Google'}});
  const bot=url.includes('/discord-mention-bot-token/'),bytes=bot?Buffer.from('FAKE-BOT-TOKEN'):invalidAuth?Buffer.from('{}'):auth,crc=new CRC32C();crc.update(bytes);
  return Response.json({name:'projects/123456789012/secrets/'+(bot?'discord-mention-bot-token':'discord-consolidated-auth')+'/versions/'+(versionWrong?'9':bot?'2':'1'),payload:{data:bytes.toString('base64'),dataCrc32c:crcWrong?'0':String(crc.toBuffer().readUInt32BE(0))}});
 };
 return {calls,writes,fetchImpl,writeSecret:async(name,bytes)=>{writes.push({name,bytes});}};
}
test('VM-only secret loader verifies identity, exact versions and CRC before publishing the pair; fake I/O only',async()=>{
 const f=fake();assert.deepEqual(await fetchGceSecrets(f),{loaded:true,pinnedVersionsVerified:true});assert.deepEqual(f.writes.map(x=>x.name),['bot-token','auth.json']);assert.equal(f.calls.length,4);assert(f.calls.every(x=>x.options.redirect==='error'));assert(f.calls[2].url.endsWith('/versions/2:access'));assert(f.calls[3].url.endsWith('/versions/1:access'));
});
test('VM-only secret loader rejects wrong identity/version/checksum/material without writes or private errors',async()=>{
 for(const options of [{identityWrong:true},{versionWrong:true},{crcWrong:true},{invalidAuth:true}]){const f=fake(options);await assert.rejects(fetchGceSecrets(f),error=>{assert(!error.message.includes('FAKE'));assert(!error.message.includes('projects/'));return true;});assert.equal(f.writes.length,0);}
});
