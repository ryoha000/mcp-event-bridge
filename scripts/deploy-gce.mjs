import {mkdtemp,writeFile,copyFile,readFile,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseEnv} from 'node:util';
import {renderGceTemplate,validateGceConfig} from './render-gce-config.mjs';

// コミット済みツリーを IAP SSH 経由で GCE インスタンスへデプロイする。
// git archive で追跡ファイルのみを送り、秘密情報は Secret Manager から出さない。
// リモート処理は冪等で、リビジョンや設定が変わっていなければ再起動しない。
//
// 設定は process.env（CI の secrets/vars）またはローカルの .env から読む。
// 実環境変数が常に優先する。DEPLOY_* キーがデプロイ自体を制御し、
// runtime.env.example と同名のキー（および DEPLOY_ENV_* 接頭辞の追加キー）が
// その描画結果を上書きする。
const REQUIRED_ENV=['DISCORD_GUILD_ID','DISCORD_BOT_ID','GOOGLE_ALLOWED_EMAIL'];
const ENV_PREFIX='DEPLOY_ENV_';
export function runtimeEnvKeys(text){return new Set([...text.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map(m=>m[1]));}
export function readDeployConfig(source,templateKeys){
 const raw={host:source.DEPLOY_HOST,googleClientId:source.DEPLOY_GOOGLE_CLIENT_ID,channelIds:JSON.parse(source.DEPLOY_CHANNEL_IDS??'[]')};
 const render=validateGceConfig(raw);
 if(!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(source.DEPLOY_PROJECT??''))throw Error('DEPLOY_PROJECTを確認してください');
 if(!/^[0-9]{6,15}$/.test(source.DEPLOY_PROJECT_NUMBER??''))throw Error('DEPLOY_PROJECT_NUMBERを確認してください');
 if(!/^[a-z]+-[a-z]+[0-9]+-[a-z]$/.test(source.DEPLOY_ZONE??''))throw Error('DEPLOY_ZONEを確認してください');
 if(!/^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/.test(source.DEPLOY_INSTANCE??''))throw Error('DEPLOY_INSTANCEを確認してください');
 const certbotEmail=source.DEPLOY_CERTBOT_EMAIL??'',nodeVersion=source.DEPLOY_NODE_VERSION??'22.23.3';
 if(certbotEmail!==''&&!/^[\w.+-]+@[\w-]+(\.[\w-]+)+$/.test(certbotEmail))throw Error('DEPLOY_CERTBOT_EMAILを確認してください');
 if(!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(nodeVersion))throw Error('DEPLOY_NODE_VERSIONを確認してください');
 const env={};
 for(const [key,value] of Object.entries(source)){
  if(typeof value!=='string')continue;
  if(key.startsWith(ENV_PREFIX)){env[key.slice(ENV_PREFIX.length)]=value;continue;}
  if(templateKeys.has(key))env[key]=value;
 }
 for(const key of REQUIRED_ENV)if(!env[key]||typeof env[key]!=='string')throw Error(key+'を実値で設定してください');
 for(const key of ['DISCORD_GUILD_ID','DISCORD_BOT_ID'])if(!/^[0-9]{17,20}$/.test(env[key]))throw Error(key+'はSnowflake形式で指定してください');
 if(!/^[\w.+-]+@[\w-]+(\.[\w-]+)+$/.test(env.GOOGLE_ALLOWED_EMAIL))throw Error('GOOGLE_ALLOWED_EMAILを確認してください');
 for(const [key,value] of Object.entries(env)){
  if(!/^[A-Z][A-Z0-9_]*$/.test(key)||/[\r\n]/.test(value)||value.length>2048)throw Error('envの形式を確認してください: '+key);
 }
 return {...render,project:source.DEPLOY_PROJECT,projectNumber:source.DEPLOY_PROJECT_NUMBER,zone:source.DEPLOY_ZONE,instance:source.DEPLOY_INSTANCE,certbotEmail,nodeVersion,env};
}
export function applyEnvOverrides(rendered,{env,project,projectNumber,instance}){
 const merged={MCP_GCP_PROJECT:project,MCP_GCP_PROJECT_NUMBER:projectNumber,MCP_GCP_SERVICE_ACCOUNT:instance+'@'+project+'.iam.gserviceaccount.com',...env};
 const seen=new Set(),out=rendered.split('\n').map(line=>{
  const key=/^([A-Z][A-Z0-9_]*)=/.exec(line)?.[1];
  if(key&&key in merged){seen.add(key);return key+'='+merged[key];}
  return line;
 });
 for(const [key,value] of Object.entries(merged))if(!seen.has(key))out.push(key+'='+value);
 return out.join('\n');
}
function run(cmd,args){
 const r=spawnSync(cmd,args,{stdio:'inherit',shell:false});
 if(r.status!==0)throw Error(cmd+' failed ('+(r.status??r.error?.message)+')');
}
function runGcloud(args){
 // Windows では gcloud が .cmd シムなのでシェル経由が必要。全引数を
 // 二重引用符で囲む（引数に二重引用符を含まない前提）。
 const r=process.platform==='win32'
  ?spawnSync('gcloud',args.map(a=>'"'+a.replace(/"/g,'')+'"').join(' '),{stdio:'inherit',shell:true})
  :spawnSync('gcloud',args,{stdio:'inherit',shell:false});
 if(r.status!==0)throw Error('gcloud failed ('+(r.status??r.error?.message)+')');
}
function capture(cmd,args){
 const r=spawnSync(cmd,args,{encoding:'utf8',shell:false});
 if(r.status!==0)throw Error(cmd+' failed');
 return r.stdout.trim();
}
async function deploy(envPath,dryRun){
 let source={...process.env};
 try{source={...parseEnv(await readFile(envPath,'utf8')),...source};}catch(e){if(e?.code!=='ENOENT')throw e;}
 const dir=new URL('../deployment/gce/',import.meta.url);
 const envTemplate=await readFile(new URL('runtime.env.example',dir),'utf8');
 const settings=readDeployConfig(source,runtimeEnvKeys(envTemplate));
 const dirty=capture('git',['status','--porcelain','--untracked-files=no']);
 if(dirty&&!dryRun)throw Error('未コミットの変更があります。コミットしてからデプロイしてください');
 if(dirty)console.warn('未コミットの変更があります（dry-runのため続行）');
 const revision=capture('git',['rev-parse','--verify','HEAD']);
 const staging=await mkdtemp(join(tmpdir(),'discord-mcp-deploy-'));
 const remote='/tmp/discord-mcp-deploy-'+revision.slice(0,12);
 try{
  for(const [source_,target] of [['nginx-bootstrap.conf.example','nginx-bootstrap.conf'],['nginx-https.conf.example','nginx-https.conf'],['nginx-proxy.conf','nginx-proxy.conf']]){
   await writeFile(join(staging,target),renderGceTemplate(await readFile(new URL(source_,dir),'utf8'),settings));
  }
  await writeFile(join(staging,'runtime.env'),applyEnvOverrides(renderGceTemplate(envTemplate,settings),settings),{mode:0o600});
  for(const name of ['nginx-timing.conf','nginx-timing-logrotate.conf','discord-mcp.service','discord-mcp-secrets.service','angelic-angel.service.example','install.sh'])await copyFile(new URL(name,dir),join(staging,name));
  run('git',['archive','--format=tar','HEAD','-o',join(staging,'app.tar')]);
  await writeFile(join(staging,'revision'),revision+'\n');
  if(dryRun){console.info('dry-run: ペイロードを検証しました（リモートには触れていません）');return;}
  runGcloud(['--version']);
  const base=['--quiet','--project',settings.project,'--zone',settings.zone,'--tunnel-through-iap'];
  runGcloud(['compute','ssh',settings.instance,...base,'--command','rm -rf '+remote]);
  runGcloud(['compute','scp','--recurse',staging,settings.instance+':'+remote,...base]);
  const env="HOST='"+settings.host+"' CERTBOT_EMAIL='"+settings.certbotEmail+"' NODE_VERSION='"+settings.nodeVersion+"'";
  runGcloud(['compute','ssh',settings.instance,...base,'--command','sudo env '+env+' bash '+remote+'/install.sh']);
  try{run('curl',['-fsS','--max-time','15','https://'+settings.host+'/healthz']);console.info('外部ヘルスチェック成功');}
  catch{console.warn('外部ヘルスチェック未確認 — DNS/証明書の状態を確認してください');}
 }finally{await rm(staging,{recursive:true,force:true});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{
  const args=process.argv.slice(2),i=args.indexOf('--env');
  await deploy(i>=0?args[i+1]:'.env',args.includes('--dry-run'));
 }catch(error){console.error('デプロイを中断しました: '+error.message);process.exitCode=1;}
}
