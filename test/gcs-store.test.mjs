import test from 'node:test';
import assert from 'node:assert/strict';
import { CRC32C } from '@google-cloud/storage';
import { createGcsObjectBackend, createGcsStore } from '../lib/gcs-store.mjs';
import { assertStore } from '../lib/store.mjs';
import { createHandler, EVENT, TEXT } from '../lib/probe.mjs';

// Entire GCS API is in-memory. Tests do not instantiate a real SDK client or
// resolve credentials, make network requests, create a bucket, or change IAM.
const PROBE = '00000000-0000-4000-8000-000000000000';
const OTHER_PROBE = '00000000-0000-4000-8000-000000000001';
const OWNER = 'https://issuer.example|fixture-user';
const SECRET = 'whsec_' + Buffer.alloc(32, 1).toString('base64');
const URL = 'https://receiver.example.com/private-callback';
const NOW = 10000;
const accepted = { accepted: true, status: 204, outcome: 'receipt_acknowledged' };
const unknown = { accepted: null, status: null, outcome: 'unknown' };
const error = (code, message = `secret error ${SECRET} ${URL}`) => Object.assign(new Error(message), { code });
const row = (patch = {}) => ({ id: 'sub_fixture', owner: OWNER, probe_id: PROBE, url: URL, secret: SECRET, expires: NOW + 1000, sent: false, ...patch });

class FakeStorage {
  objects = new Map();
  calls = [];
  generation = 0;
  beforeDownload;
  beforeSave;
  afterSave;
  metadataError;
  bucket(name) {
    assert.equal(name, 'private-fixture-bucket');
    const storage = this;
    return {
      file(name, options = {}) {
        return {
          async getMetadata() {
            storage.calls.push({ operation: 'metadata', name });
            if (storage.metadataError) throw storage.metadataError;
            const object = storage.objects.get(name);
            if (!object) throw error(404);
            return [{ generation: object.generation, size: String(object.bytes.length), ...object.metadata }];
          },
          async download(downloadOptions) {
            storage.calls.push({ operation: 'download', name, generation: options.generation, options: downloadOptions });
            await storage.beforeDownload?.(name, options);
            const object = storage.objects.get(name);
            if (!object || options.generation !== object.generation) throw error(404);
            return [Buffer.from(object.bytes)];
          },
          async save(bytes, options) {
            storage.calls.push({ operation: 'save', name, options });
            await storage.beforeSave?.(name, bytes, options);
            const object = storage.objects.get(name);
            assert.ok(Object.hasOwn(options.preconditionOpts, 'ifGenerationMatch'));
            const match = options.preconditionOpts.ifGenerationMatch;
            if ((!object && match !== 0) || (object && match !== object.generation)) throw error(412);
            const crc32c = new CRC32C(); crc32c.update(bytes);
            assert.equal(options.metadata.crc32c, crc32c.toString());
            storage.objects.set(name, { generation: String(++storage.generation), bytes: Buffer.from(bytes), metadata: {} });
            await storage.afterSave?.(name, bytes, options);
          },
        };
      },
    };
  }
  raw() { return JSON.parse([...this.objects.values()][0].bytes.toString()); }
  replaceRaw(value, metadata = {}) {
    const name = [...this.objects.keys()][0];
    this.objects.set(name, { generation: String(++this.generation), bytes: Buffer.from(JSON.stringify(value)), metadata });
  }
}
function fixture(options = {}) {
  const storage = options.storage ?? new FakeStorage();
  const backend = createGcsObjectBackend({ bucketName: 'private-fixture-bucket', storage, ...options });
  return { storage, backend, store: createGcsStore({ backend, now: () => NOW }) };
}

test('construction is offline; names are hashed and writes use explicit generation CAS', async () => {
  const { storage, store } = fixture();
  assert.equal(storage.calls.length, 0);
  assert.equal(assertStore(store, true), store);
  await store.put(row());
  await store.put(row({ expires: NOW + 2000 }));
  const saves = storage.calls.filter(call => call.operation === 'save');
  assert.deepEqual(saves.map(call => call.options.preconditionOpts.ifGenerationMatch), [0, '1']);
  for (const call of storage.calls) {
    assert.match(call.name, /^synthetic-mcp\/v1\/[a-f0-9]{64}\.json$/);
    assert.ok(!call.name.includes(OWNER) && !call.name.includes(PROBE));
  }
  assert.equal(saves[0].options.resumable, false);
  assert.equal(saves[0].options.validation, false);
  assert.equal(saves[0].options.metadata.cacheControl, 'no-store');
  assert.equal(saves[0].options.predefinedAcl, undefined);
  assert.equal(saves[0].options.public, undefined);
  const download = storage.calls.find(call => call.operation === 'download');
  assert.equal(download.generation, '1');
  assert.deepEqual(download.options, { decompress: false, validation: 'crc32c' });
});

test('claim and receipt survive refresh, unsubscribe, URL changes, expiry and new instances', async () => {
  const { storage, store } = fixture();
  await store.put(row());
  assert.equal(await store.claim('sub_fixture', OWNER), true);
  await store.receipt('sub_fixture', OWNER, accepted);
  await store.put(row({ secret: 'refreshed-fixture', expires: NOW + 2000, sent: false }));
  assert.equal((await store.get('sub_fixture', OWNER)).sent, true);
  assert.deepEqual((await store.get('sub_fixture', OWNER)).receipt, accepted);
  await store.remove('sub_fixture', OWNER);
  assert.deepEqual(await store.status(OWNER), []);
  const persisted = storage.raw();
  assert.equal(persisted.subscriptions.length, 0);
  assert.equal(persisted.claims.length, 1);
  assert.ok(!JSON.stringify(persisted).includes(URL));
  assert.ok(!JSON.stringify(persisted).includes('refreshed-fixture'));
  const restarted = fixture({ storage }).store;
  await restarted.put(row({ id: 'new_subscription', url: 'https://new.example/callback', expires: NOW + 9000 }));
  assert.equal(await restarted.claim('new_subscription', OWNER), false);
  assert.deepEqual((await restarted.byProbe(OWNER, PROBE)).receipt, accepted);
});

test('different processes contend on one owner object and only one probe claim succeeds', async () => {
  const { storage, store } = fixture();
  await store.put(row());
  const stores = Array.from({ length: 6 }, () => fixture({ storage }).store);
  const results = await Promise.all(stores.map(store => store.claim('sub_fixture', OWNER)));
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(storage.raw().claims.length, 1);
});

test('refresh and claim CAS races preserve both the winning claim and refreshed credentials', async () => {
  const { storage, store } = fixture();
  const peer = fixture({ storage }).store;
  await store.put(row());
  await Promise.all([store.put(row({ secret: 'new-signing-fixture', expires: NOW + 5000 })), peer.claim('sub_fixture', OWNER)]);
  const refreshed = await store.get('sub_fixture', OWNER);
  assert.equal(refreshed.secret, 'new-signing-fixture');
  assert.equal(refreshed.expires, NOW + 5000);
  assert.equal(refreshed.sent, true);
  assert.equal(await peer.claim('sub_fixture', OWNER), false);
});

test('unsubscribe and late receipt preserve permanent claim without callback credentials', async () => {
  const { storage, store } = fixture();
  await store.put(row());
  await store.claim('sub_fixture', OWNER);
  await store.remove('sub_fixture', OWNER);
  await store.receipt('sub_fixture', OWNER, unknown);
  await store.receipt('sub_fixture', OWNER, accepted); // First receipt is immutable.
  assert.deepEqual(storage.raw().claims[0].receipt, unknown);
  await store.put(row());
  assert.deepEqual((await store.get('sub_fixture', OWNER)).receipt, unknown);
  assert.equal(await store.claim('sub_fixture', OWNER), false);
});

test('unsubscribe racing with claim either prevents claim or retains a permanent claim', async () => {
  const { storage, store } = fixture();
  await store.put(row());
  const [claimed] = await Promise.all([store.claim('sub_fixture', OWNER), store.remove('sub_fixture', OWNER)]);
  assert.equal(await store.get('sub_fixture', OWNER), null);
  assert.equal(storage.raw().claims.length, claimed ? 1 : 0);
  if (claimed) {
    await store.put(row());
    assert.equal(await store.claim('sub_fixture', OWNER), false);
  }
});

test('every operation is owner-scoped; expired subscriptions cannot be claimed', async () => {
  const { store } = fixture();
  await store.put(row());
  await store.remove('sub_fixture', 'other-owner');
  assert.equal(await store.get('sub_fixture', 'other-owner'), null);
  assert.equal(await store.byProbe('other-owner', PROBE), null);
  assert.equal(await store.claim('sub_fixture', 'other-owner'), false);
  await store.receipt('sub_fixture', 'other-owner', accepted);
  assert.deepEqual(await store.status('other-owner'), []);
  assert.equal((await store.get('sub_fixture', OWNER)).sent, false);
  await store.put(row({ expires: NOW }));
  assert.equal(await store.claim('sub_fixture', OWNER), false);
  await store.put(row({ owner: 'other-owner' }));
  assert.equal(await store.claim('sub_fixture', 'other-owner'), true);
});

test('latest-expiring subscription is selected; every subscription for one probe shares the claim', async () => {
  const { store } = fixture();
  await store.put(row());
  await store.put(row({ id: 'other-url', expires: NOW + 8000 }));
  assert.equal((await store.byProbe(OWNER, PROBE)).id, 'other-url');
  assert.equal(await store.claim('sub_fixture', OWNER), true);
  assert.equal((await store.get('other-url', OWNER)).sent, true);
  assert.equal(await store.claim('other-url', OWNER), false);
});

test('status has a fixed safe schema; receipt strips additional sensitive diagnostics', async () => {
  const { store } = fixture();
  await store.put(row());
  await store.claim('sub_fixture', OWNER);
  await store.receipt('sub_fixture', OWNER, { ...accepted, secret: SECRET, callback: URL, headers: { secret: SECRET } });
  const status = await store.status(OWNER);
  assert.deepEqual(status, [{ probe_id: PROBE, expires: NOW + 1000, sent: true, receipt: accepted }]);
  const text = JSON.stringify(status);
  for (const sensitive of [OWNER, URL, SECRET, 'sub_fixture']) assert.ok(!text.includes(sensitive));
  await assert.rejects(store.receipt('sub_fixture', OWNER, { ...accepted, outcome: URL }), { code: 'STORAGE_INPUT' });
});

test('definite write conflicts retry finitely; permission and ambiguous errors do not retry or leak', async () => {
  const { storage, store } = fixture({ maxAttempts: 3 });
  storage.beforeSave = () => { throw error(412); };
  await assert.rejects(store.put(row()), { code: 'STORAGE_CONFLICT' });
  assert.equal(storage.calls.filter(call => call.operation === 'save').length, 3);
  storage.calls.length = 0;
  storage.beforeSave = () => { throw error(403); };
  await assert.rejects(store.put(row()), failure => {
    assert.equal(failure.code, 'STORAGE_UNAVAILABLE');
    assert.equal(failure.message, 'Durable storage operation failed');
    assert.equal(failure.cause, undefined);
    return true;
  });
  assert.equal(storage.calls.filter(call => call.operation === 'save').length, 1);
});

test('write timeout after persisted claim fails closed and cannot lead to a second claim', async () => {
  const { storage, store } = fixture();
  await store.put(row());
  let attempts = 0;
  storage.afterSave = () => { attempts++; throw error(503); };
  await assert.rejects(store.claim('sub_fixture', OWNER), { code: 'STORAGE_UNAVAILABLE' });
  assert.equal(attempts, 1);
  storage.afterSave = undefined;
  const restarted = fixture({ storage }).store;
  assert.equal(await restarted.claim('sub_fixture', OWNER), false);
  assert.equal((await restarted.get('sub_fixture', OWNER)).sent, true);
});

test('generation-pinned read retries if old generation vanishes; never combines old metadata with new bytes', async () => {
  const { storage, backend } = fixture();
  await backend.update('oauth-state:v1', () => ({ value: { count: 1 } }));
  let replaced = false;
  storage.beforeDownload = () => {
    if (!replaced) { replaced = true; storage.replaceRaw({ count: 2 }); }
  };
  assert.deepEqual(await backend.read('oauth-state:v1'), { count: 2 });
  const downloads = storage.calls.filter(call => call.operation === 'download');
  assert.deepEqual(downloads.map(call => call.generation), ['1', '2']);
});

test('generic aggregate update is atomic, returns mutator results, and supports no-write', async () => {
  const { storage, backend } = fixture();
  assert.equal(await backend.read('oauth-state:v1'), null);
  await backend.update('oauth-state:v1', () => ({ value: { consumed: false, revoked: false } }));
  const consume = () => backend.update('oauth-state:v1', state => state.consumed ? { result: false } : { value: { ...state, consumed: true }, result: true });
  const results = await Promise.all([consume(), consume(), consume()]);
  assert.equal(results.filter(Boolean).length, 1);
  await backend.update('oauth-state:v1', state => ({ value: { ...state, revoked: true } }));
  assert.deepEqual(await backend.read('oauth-state:v1'), { consumed: true, revoked: true });
  const before = storage.calls.filter(call => call.operation === 'save').length;
  assert.equal(await consume(), false);
  assert.equal(storage.calls.filter(call => call.operation === 'save').length, before);
  await assert.rejects(backend.update('oauth-state:v1', async state => ({ value: state })), { code: 'STORAGE_INPUT' });
});

test('capacity, malformed state and unsupported metadata fail closed without deleting data', async () => {
  const { storage, backend, store } = fixture({ maxBytes: 1024 });
  await store.put(row());
  const original = Buffer.from([...storage.objects.values()][0].bytes);
  await assert.rejects(store.put(row({ url: 'x'.repeat(2000) })), { code: 'STORAGE_CAPACITY' });
  assert.deepEqual([...storage.objects.values()][0].bytes, original);
  storage.replaceRaw({ not: 'a store' });
  await assert.rejects(store.status(OWNER), { code: 'STORAGE_CORRUPT' });
  storage.replaceRaw(null);
  await assert.rejects(backend.read(JSON.stringify(['probe-owner:v1', OWNER])), { code: 'STORAGE_CORRUPT' });
  storage.replaceRaw({}, { contentEncoding: 'gzip' });
  await assert.rejects(store.status(OWNER), { code: 'STORAGE_CORRUPT' });
  storage.replaceRaw({});
  [...storage.objects.values()][0].generation = '9007199254740993';
  await assert.rejects(store.status(OWNER), { code: 'STORAGE_CORRUPT' });
});

test('invalid owners, probe IDs, subscription remapping and mutable sent flags cannot reopen claims', async () => {
  const { store } = fixture();
  await assert.rejects(store.put(row({ owner: '' })), { code: 'STORAGE_INPUT' });
  await assert.rejects(store.put(row({ probe_id: URL })), { code: 'STORAGE_INPUT' });
  await store.put(row({ sent: true }));
  assert.equal(await store.claim('sub_fixture', OWNER), false);
  await store.put(row({ sent: false }));
  assert.equal(await store.claim('sub_fixture', OWNER), false);
  await store.remove('sub_fixture', OWNER);
  await assert.rejects(store.put(row({ probe_id: OTHER_PROBE })), { code: 'STORAGE_INPUT' });
});

test('protocol running on mocked GCS emits at most once, including ambiguous delivery and URL changes', async () => {
  const { backend } = fixture();
  const store = createGcsStore({ backend });
  let deliveries = 0;
  const transport = async (_url, request) => {
    const body = JSON.parse(request.body);
    if (body.type === 'verification') return { ok: true, status: 200, json: async () => ({ challenge: body.challenge }) };
    assert.equal(body.name, EVENT);
    assert.deepEqual(body.data, { probe_id: PROBE, text: TEXT });
    deliveries++;
    throw Error('ambiguous fixture response');
  };
  const handle = createHandler(store, transport);
  const params = { name: EVENT, arguments: { probe_id: PROBE }, delivery: { mode: 'webhook', url: URL, secret: SECRET } };
  await handle('events/subscribe', params, OWNER);
  const emit = { name: 'emit_probe', arguments: params.arguments };
  await Promise.all([handle('tools/call', emit, OWNER), handle('tools/call', emit, OWNER)]);
  assert.equal(deliveries, 1);
  await handle('events/unsubscribe', params, OWNER);
  params.delivery.url = 'https://new.example/callback';
  await handle('events/subscribe', params, OWNER);
  await handle('tools/call', emit, OWNER);
  assert.equal(deliveries, 1);
  assert.deepEqual((await store.status(OWNER))[0].receipt, unknown);
});
