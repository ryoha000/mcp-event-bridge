import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {isIP} from 'node:net';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

export function validateGceConfig({host,googleClientId,channelIds=[]}){
 if(typeof host!=='string'||host!==host.toLowerCase()||host.length>253||isIP(host)||!host.includes('.')||host.endsWith('.run.app')||host.split('.').some(s=>!s||s.length>63||!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(s)))throw Error('HTTPSホスト名を確認してください');
 if(!/^[0-9]+-[a-zA-Z0-9_-]+\.apps\.googleusercontent\.com$/.test(googleClientId??'')||!Array.isArray(channelIds)||channelIds.length>100||channelIds.some(c=>!/^\d{17,20}$/.test(c))||new Set(channelIds).size!==channelIds.length)throw Error('既存Google設定と承認済みチャンネルを確認してください');
 return {host,googleClientId,channelIds};
}
export function renderGceTemplate(text,settings){const s=validateGceConfig(settings);const rendered=text.replaceAll('@@HOST@@',s.host).replaceAll('@@EXISTING_GOOGLE_WEB_CLIENT_ID@@',s.googleClientId).replaceAll('@@APPROVED_CHANNEL_IDS_JSON@@',JSON.stringify(s.channelIds));if(rendered.includes('@@'))throw Error('未確定の設定があります');return rendered;}
// Local rendering only. Exact host choice must be supplied; never chooses a
// domain, signs up for DNS, writes IAM, launches services or fetches credentials.
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{
  if(process.argv.length!==3)throw Error();const settings=validateGceConfig(JSON.parse(await readFile(process.argv[2],'utf8'))),directory=new URL('../deployment/gce/',import.meta.url),out=new URL('rendered/',directory);await mkdir(out,{recursive:true});
  for(const [source,target] of [['runtime.env.example','runtime.env'],['nginx-bootstrap.conf.example','nginx-bootstrap.conf'],['nginx-https.conf.example','nginx-https.conf'],['nginx-proxy.conf','nginx-proxy.conf']])await writeFile(new URL(target,out),renderGceTemplate(await readFile(new URL(source,directory),'utf8'),settings),{mode:0o600});
  console.info('GCE設定をローカルで生成しました。クラウドへの変更や起動は行っていません');
 }catch{console.error('GCE設定の生成を拒否しました。指定内容を確認してください');process.exitCode=1;}
}
