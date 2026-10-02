import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {parseEnv} from 'node:util';
import {readDeployConfig,applyEnvOverrides,runtimeEnvKeys} from '../scripts/deploy-gce.mjs';

const TEMPLATE_KEYS=runtimeEnvKeys('NODE_ENV=production\nDISCORD_GUILD_ID=1\nDISCORD_BOT_ID=2\nGOOGLE_ALLOWED_EMAIL=x\nMCP_GCP_PROJECT=p\n');
const valid={
 DEPLOY_HOST:'discord.example.com',
 DEPLOY_GOOGLE_CLIENT_ID:'123-fixture.apps.googleusercontent.com',
 DEPLOY_CHANNEL_IDS:'[]',
 DEPLOY_PROJECT:'example-project',
 DEPLOY_PROJECT_NUMBER:'123456789012',
 DEPLOY_ZONE:'asia-northeast1-a',
 DEPLOY_INSTANCE:'discord-mcp',
 DISCORD_GUILD_ID:'100000000000000400',
 DISCORD_BOT_ID:'100000000000001800',
 GOOGLE_ALLOWED_EMAIL:'owner@example.com',
};

test('readDeployConfig は対象フィールドと必須 env キーを検証する',()=>{
 const s=readDeployConfig(valid,TEMPLATE_KEYS);
 assert.equal(s.host,'discord.example.com');
 assert.equal(s.env.DISCORD_GUILD_ID,'100000000000000400');
 for(const patch of [{DEPLOY_PROJECT:'UPPER'},{DEPLOY_PROJECT:'a;b'},{DEPLOY_PROJECT_NUMBER:'abc'},{DEPLOY_ZONE:'zone;rm -rf'},{DEPLOY_INSTANCE:'bad_name'},{DEPLOY_CERTBOT_EMAIL:'a b@c'},{DEPLOY_NODE_VERSION:'latest'},{DEPLOY_HOST:'example.run.app'},{DEPLOY_GOOGLE_CLIENT_ID:'nope'},{DEPLOY_CHANNEL_IDS:'["1"]'},{DISCORD_GUILD_ID:'not-snowflake'},{GOOGLE_ALLOWED_EMAIL:'not-an-email'},{DEPLOY_ENV_X:'a\nb'},{DEPLOY_ENV_1BAD:'x'}])
  assert.throws(()=>readDeployConfig({...valid,...patch},TEMPLATE_KEYS),JSON.stringify(patch));
 for(const patch of [{DEPLOY_ZONE:'asia-northeast1-a'},{DEPLOY_CERTBOT_EMAIL:'ops@example.com'},{DEPLOY_INSTANCE:'a'},{DEPLOY_ENV_EXTRA_FLAG:'true'},{PATH:'C:\\fake'}])
  assert.ok(readDeployConfig({...valid,...patch},TEMPLATE_KEYS));
});

test('runtime.env にはテンプレート同名キーまたは DEPLOY_ENV_ キーのみ渡る',()=>{
 const s=readDeployConfig({...valid,PATH:'C:\\Windows',DEPLOY_ENV_EXAMPLE_FLAG:'true'},TEMPLATE_KEYS);
 assert.equal(s.env.PATH,undefined);
 assert.equal(s.env.EXAMPLE_FLAG,'true');
});

test('env オーバーライドは描画行を置き換え、MCP アイデンティティを埋め、新規キーを追加する',()=>{
 const rendered='# comment\nDISCORD_GUILD_ID=1\nMCP_GCP_PROJECT=example-project\n';
 const out=applyEnvOverrides(rendered,readDeployConfig(valid,TEMPLATE_KEYS));
 assert(out.includes('# comment'));
 assert(out.includes('DISCORD_GUILD_ID=100000000000000400'));
 assert(out.includes('MCP_GCP_PROJECT=example-project'));
 assert(out.includes('MCP_GCP_PROJECT_NUMBER=123456789012'));
 assert(out.includes('MCP_GCP_SERVICE_ACCOUNT=discord-mcp@example-project.iam.gserviceaccount.com'));
 assert(out.includes('GOOGLE_ALLOWED_EMAIL=owner@example.com'));
});

test('.env.example は解析でき、実値を入れるまでプレースホルダが検証に失敗する',async()=>{
 const source=parseEnv(await readFile(new URL('../.env.example',import.meta.url),'utf8'));
 assert.equal(source.DEPLOY_HOST,'dot.ryoha.moe');
 assert.throws(()=>readDeployConfig(source,TEMPLATE_KEYS));
});

test('リモートインストーラはシークレットを含まず冪等でヘルスチェック付き',async()=>{
 const sh=await readFile(new URL('../deployment/gce/install.sh',import.meta.url),'utf8');
 assert(sh.includes('set -euo pipefail'));
 assert(sh.includes('cmp -s'));
 assert(sh.includes('/run/discord-mcp-secrets/bot-token'));
 assert(sh.includes('127.0.0.1:8080/healthz'));
 assert(sh.includes('APP_CHANGED'));
 assert(sh.includes('nginx-bootstrap.conf'));
 assert(sh.includes('node_modules')); // アーカイブに含まれないため引継ぎかnpm ciが必須
 assert(!sh.includes('LoadCredential='));
});
