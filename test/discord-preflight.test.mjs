import test from 'node:test';
import assert from 'node:assert/strict';
import {validateDiscordReceiver,receiverDiagnostic} from '../lib/adapters/discord-preflight.mjs';
import {BOT_ID,GUILD_ID,readDiscordChannelPolicy} from '../lib/adapters/discord.mjs';
const channel='100000000000000600';
const fixture=(patch={})=>async(url,options)=>{
 assert.equal(options.method,'GET');assert.equal(options.redirect,'error');assert.equal(options.headers.authorization,'Bot FAKE');
 const path=new URL(url).pathname;assert.equal(new URL(url).origin,'https://discord.com');
 const values={'/api/v10/users/@me':{id:BOT_ID,bot:true,username:'PRIVATE'},['/api/v10/guilds/'+GUILD_ID]:{id:GUILD_ID,name:'PRIVATE'},['/api/v10/channels/'+channel]:{id:channel,guild_id:GUILD_ID,name:'PRIVATE'}};
 assert(Object.hasOwn(values,path));return new Response(JSON.stringify(patch[path]??values[path]),{status:200});
};
test('ランタイムbot/guild/allowlistプレフライトは固定メタデータのみ読み、上限付きで安全なreadinessを出力する',async()=>{
 const logs=[];const ready=await validateDiscordReceiver({token:'FAKE',channelIds:[channel],fetchImpl:fixture(),diagnosticSink:line=>logs.push(line)});
 assert.deepEqual(ready,{botMatches:true,guildMatches:true,channelCount:1,intentMask:513});assert.equal(logs.length,3);
 assert(!logs.join('').includes('FAKE'));assert(!logs.join('').includes('PRIVATE'));assert(!logs.join('').includes(channel));
});
test('ランタイムプレフライトは誤ったbot・誤ったguild/channel・不正設定・リダイレクト・過大応答を拒否する',async()=>{
 const base={token:'FAKE',channelIds:[channel],diagnosticSink:()=>{}};
 for(const patch of [{'/api/v10/users/@me':{id:'other',bot:true}},{['/api/v10/guilds/'+GUILD_ID]:{id:'other'}},{['/api/v10/channels/'+channel]:{id:channel,guild_id:'other'}}])await assert.rejects(validateDiscordReceiver({...base,fetchImpl:fixture(patch)}));
 for(const channelIds of [[],[channel,channel],['bad']])await assert.rejects(validateDiscordReceiver({...base,channelIds,fetchImpl:()=>{throw Error('Should not call');}}));
 await assert.rejects(validateDiscordReceiver({...base,fetchImpl:async()=>new Response('PRIVATE',{status:302})}),error=>error.code==='DISCORD_HTTP_REFUSED'&&error.status===302);
 await assert.rejects(validateDiscordReceiver({...base,fetchImpl:async()=>new Response('x'.repeat(262145))}),error=>error.code==='DISCORD_RESPONSE_REFUSED');
});
test('レシーバー診断はcontent/identity/tokenフィールドを除外し、失敗するシンクを無視する',()=>{
 const row=receiverDiagnostic('gateway_ready',{token:'PRIVATE',botId:'PRIVATE',body:'PRIVATE',repliesEnabled:false,gatewayCode:4014,code:'PRIVATE'},()=>{throw Error('PRIVATE');});
 assert.deepEqual(row,{kind:'discord_receiver_diagnostic',phase:'gateway_ready',repliesEnabled:false,gatewayCode:4014});
});

test('guild-visibleプレフライトは既存の固定bot/guildメタデータのみ使い、静的ID・チャンネル列挙・メッセージ読み取り・権限書き込みをしない',async()=>{
 const paths=[],fetchImpl=fixture();const result=await validateDiscordReceiver({token:'FAKE',channelIds:[],channelScope:'guild-visible',diagnosticSink:()=>{},fetchImpl:async(url,options)=>{paths.push(new URL(url).pathname);return fetchImpl(url,options);}});assert.equal(result.channelScope,'guild-visible');assert.equal(result.channelCount,null);assert.deepEqual(paths,['/api/v10/users/@me','/api/v10/guilds/'+GUILD_ID]);
 assert.deepEqual(readDiscordChannelPolicy({DISCORD_CHANNEL_SCOPE:'guild-visible'}),{channelScope:'guild-visible',channelIds:[]});assert.deepEqual(readDiscordChannelPolicy({DISCORD_CHANNEL_SCOPE:'guild-visible',DISCORD_CHANNEL_IDS:'obsolete ignored'}),{channelScope:'guild-visible',channelIds:[]});assert.throws(()=>readDiscordChannelPolicy({DISCORD_CHANNEL_SCOPE:'all-guilds'}));
});
