import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createBridgeCredential} from '../lib/adapters/bridge-credential.mjs';
import {readWindowsSecret,writeWindowsSecret} from '../lib/adapters/windows-secret.mjs';

test('ブリッジ認証情報は有効なアクセスをキャッシュし、承認済みissuerでのみリフレッシュし、再利用前に暗号化する',async()=>{
  let at=1000,persisted,requests=0;
  const initial={origin:'https://bridge.example',clientId:'fake-client',accessToken:'FAKE-ACCESS',refreshToken:'FAKE-REFRESH',expiresAt:100000};
  const get=createBridgeCredential({origin:initial.origin,readCredential:async()=>JSON.stringify(initial),writeCredential:async value=>persisted=JSON.parse(value),now:()=>at,fetchImpl:async(url,o)=>{requests++;assert.equal(url,'https://bridge.example/token');assert.equal(o.redirect,'error');assert.equal(o.body.get('resource'),'https://bridge.example/mcp');return new Response(JSON.stringify({access_token:'FAKE-NEW',refresh_token:'FAKE-NEW-REFRESH',expires_in:900}));}});
  assert.equal(await get(),'FAKE-ACCESS');assert.equal(requests,0);at=90000;assert.equal(await get(),'FAKE-NEW');assert.equal(persisted.accessToken,'FAKE-NEW');assert.equal(requests,1);assert.equal(await get(),'FAKE-NEW');
});
test('期限切れ許可と失敗した暗号化リフレッシュ書き込みは、新トークンを返さずフェイルクローズする',async()=>{
  const options={origin:'https://bridge.example',readCredential:async()=>JSON.stringify({origin:'https://bridge.example',clientId:'fake',accessToken:'FAKE',refreshToken:'FAKE',expiresAt:1}),now:()=>100000,writeCredential:async()=>{throw Error('storage failed');}};
  const rejected=createBridgeCredential({...options,fetchImpl:async()=>new Response('{}',{status:400})});await assert.rejects(rejected());
  const failedWrite=createBridgeCredential({...options,fetchImpl:async()=>new Response('{"access_token":"FAKE-NEW","expires_in":900}')});await assert.rejects(failedWrite());
});
test('Windows DPAPIラウンドトリップはフェイクデータでユーザー限定暗号化ローカルファイルを使う', {skip:process.platform!=='win32'}, async()=>{
  const dir=await mkdtemp(join(tmpdir(),'codex-dpapi-fake-'));const path=join(dir,'fake.dpapi');
  try{writeWindowsSecret(path,'FAKE-NON-CREDENTIAL-TEST-DATA');assert.equal(readWindowsSecret(path),'FAKE-NON-CREDENTIAL-TEST-DATA');writeWindowsSecret(path,'FAKE-ROTATED-NON-CREDENTIAL-TEST-DATA');assert.equal(readWindowsSecret(path),'FAKE-ROTATED-NON-CREDENTIAL-TEST-DATA');await assert.rejects(async()=>writeWindowsSecret(path,''));assert.equal(readWindowsSecret(path),'FAKE-ROTATED-NON-CREDENTIAL-TEST-DATA');}
  finally{assert.ok(resolve(dir).startsWith(resolve(tmpdir())+'\\codex-dpapi-fake-'));await rm(dir,{recursive:true,force:true});}
});
