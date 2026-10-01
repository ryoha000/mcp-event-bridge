import {writeFile,rename,lstat} from 'node:fs/promises';
import {createPrivateKey,randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {CRC32C} from '@google-cloud/storage';

const project=process.env.MCP_GCP_PROJECT??'example-project',projectNumber=process.env.MCP_GCP_PROJECT_NUMBER??'123456789012';
const identity=process.env.MCP_GCP_SERVICE_ACCOUNT??'discord-mcp-gce@'+project+'.iam.gserviceaccount.com';
const root='/run/discord-mcp-secrets';
const metadata='http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/';
async function bounded(response,max=65536){if(!response.ok)throw Error();let size=0;const chunks=[];for await(const chunk of response.body??[]){size+=chunk.length;if(size>max)throw Error();chunks.push(Buffer.from(chunk));}return Buffer.concat(chunks).toString('utf8');}
function authValid(bytes){const data=JSON.parse(bytes.toString('utf8'));if(!Array.isArray(data.cookieKeys)||!data.cookieKeys.length||data.cookieKeys.length>2||data.cookieKeys.some(k=>typeof k!=='string'||Buffer.byteLength(k)<32||Buffer.byteLength(k)>256)||!Array.isArray(data.jwks?.keys)||!data.jwks.keys.length||data.jwks.keys.length>2)throw Error();for(const jwk of data.jwks.keys){const key=createPrivateKey({key:jwk,format:'jwk'});if(key.asymmetricKeyType!=='rsa'||key.asymmetricKeyDetails.modulusLength<2048)throw Error();}}
async function writePrivate(name,bytes){const stat=await lstat(root);if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==0||(stat.mode&0o777)!==0o700)throw Error();const temp=root+'/'+name+'.'+randomUUID()+'.tmp';await writeFile(temp,bytes,{flag:'wx',mode:0o600});await rename(temp,root+'/'+name);}
// デプロイ専用エントリポイント。ローカルのビルド/テストからは呼ばれない。
// 本番ではVMメタデータIDを使い、PCの認証情報ファイル、gcloudトークン出力、
// 環境変数シークレットは一切使わない。値はすべてメモリ/root限定の /run
// ファイルに留め、診断は固定語彙のみ。
export async function fetchGceSecrets({fetchImpl=fetch,writeSecret=writePrivate}={}){
 try{
  const getMeta=async name=>{const r=await fetchImpl(metadata+name,{headers:{'Metadata-Flavor':'Google'},redirect:'error',signal:AbortSignal.timeout(8000)});if(r.headers.get('metadata-flavor')!=='Google')throw Error();return bounded(r);};
  if((await getMeta('email')).trim()!==identity)throw Error();
  const issued=JSON.parse(await getMeta('token'));if(issued.token_type!=='Bearer'||typeof issued.access_token!=='string'||!issued.access_token||issued.access_token.length>16384||/\s/.test(issued.access_token)||!Number.isFinite(issued.expires_in)||issued.expires_in<60)throw Error();
  async function secret(name,version){
   const r=await fetchImpl('https://secretmanager.googleapis.com/v1/projects/'+project+'/secrets/'+name+'/versions/'+version+':access',{headers:{authorization:'Bearer '+issued.access_token},redirect:'error',signal:AbortSignal.timeout(8000)});
   // latest はAPI側で解決済み番号が返るため、数字のバージョン名であることだけ確認する
   const row=JSON.parse(await bounded(r)),ok=[project,projectNumber].some(p=>{const base='projects/'+p+'/secrets/'+name+'/versions/';if(!row.name?.startsWith(base))return false;const resolved=row.name.slice(base.length);return version==='latest'?/^[0-9]+$/.test(resolved):resolved===version;});if(!ok)throw Error();
   const encoded=row.payload?.data;if(typeof encoded!=='string'||!encoded||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))throw Error();const bytes=Buffer.from(encoded,'base64'),crc=new CRC32C();crc.update(bytes);if(String(crc.toBuffer().readUInt32BE(0))!==String(row.payload.dataCrc32c))throw Error();return bytes;
  }
  const bot=await secret(process.env.MCP_DISCORD_BOT_SECRET??'discord-mention-bot-token',process.env.MCP_DISCORD_BOT_SECRET_VERSION??'latest'),auth=await secret(process.env.MCP_AUTH_SECRET??'discord-consolidated-auth',process.env.MCP_AUTH_SECRET_VERSION??'latest');
  const token=bot.toString('utf8').trim();if(!token||token.length>4096||/\s/.test(token))throw Error();authValid(auth);
  // 2つのペア全体を検証してから、ランタイムファイルを公開する。
  await writeSecret('bot-token',bot);await writeSecret('auth.json',auth);
  return {loaded:true,versionsVerified:true};
 }catch{throw Error('VMの秘密情報を安全に読み込めませんでした。秘密値は表示していません');}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){try{await fetchGceSecrets();console.info('2つの秘密情報を一時メモリへ読み込みました');}catch{console.error('秘密情報の読み込みを拒否しました。秘密値は表示していません');process.exitCode=1;}}
