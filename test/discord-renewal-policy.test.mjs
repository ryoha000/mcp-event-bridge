import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareDiscordOfflineConsent,discordOAuthDiagnostic} from '../lib/discord-oauth-diagnostics.mjs';
test('offline同意の正規化は、prompt省略時に明示的に要求された無人コンシューマコード許可のみに作用する',()=>{
 const config={discordConsumerOnly:true,discordUnattendedEnabled:true};
 const make=()=>new URL('https://fixture.example/discord/auth?response_type=code&scope=openid+offline_access+discord%3Aread+discord%3Areply&state=PRIVATE');
 const u=make();assert.equal(prepareDiscordOfflineConsent(u,config),true);assert.equal(u.searchParams.get('prompt'),'consent');assert.equal(u.searchParams.get('scope'),'openid offline_access discord:read discord:reply');assert.equal(u.searchParams.get('state'),'PRIVATE');
 for(const prompt of ['none','login','select_account','consent']){const p=make();p.searchParams.set('prompt',prompt);const before=p.href;assert.equal(prepareDiscordOfflineConsent(p,config),false);assert.equal(p.href,before);}
 for(const c of [{...config,discordConsumerOnly:false},{...config,discordUnattendedEnabled:false}]){const p=make();const before=p.href;assert.equal(prepareDiscordOfflineConsent(p,c),false);assert.equal(p.href,before);}
 const noOffline=make();noOffline.searchParams.set('scope','openid discord:read');assert.equal(prepareDiscordOfflineConsent(noOffline,config),false);assert.equal(noOffline.searchParams.has('prompt'),false);
});
test('OAuth診断は許可リスト済みの真偽値・グラント種別・status/error語彙のみ公開する',()=>{
 const logs=[];const row=discordOAuthDiagnostic('token_completed',{grantType:'refresh_token',status:200,offlineAccessRequested:true,refreshTokenIssued:true,refreshToken:'PRIVATE',scope:'PRIVATE',clientId:'PRIVATE',url:'PRIVATE'},text=>logs.push(text));
 assert.deepEqual(row,{kind:'discord_oauth_diagnostic',phase:'token_completed',offlineAccessRequested:true,refreshTokenIssued:true,grantType:'refresh_token',status:200});assert.equal(logs.join('').includes('PRIVATE'),false);
 assert.deepEqual(discordOAuthDiagnostic('PRIVATE',{errorCode:'PRIVATE',status:999,grantType:'PRIVATE'},()=>{throw Error('PRIVATE');}),{kind:'discord_oauth_diagnostic',phase:'unknown'});
});
