import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntimeStorage } from '../lib/gcs-store.mjs';

test('Storage SDKは互換ランタイムComputeクライアントのAuthorizationを保持する', async () => {
  const storage = createRuntimeStorage();
  const auth = await storage.authClient.getClient();
  assert.equal(auth.constructor.name, 'Compute');
  // ダミーのインメモリフィクスチャのみ。実メタデータ・認証情報・HTTPリクエストはない。
  auth.setCredentials({ access_token: 'SYNTHETIC-LOCAL-TEST-ONLY', expiry_date: Date.now()+3600000 });
  const options = await storage.authClient.authorizeRequest({ uri: 'https://storage.googleapis.com/storage/v1/b/synthetic-fixture/o' });
  assert.equal(options.headers.Authorization, 'Bearer SYNTHETIC-LOCAL-TEST-ONLY');
});
