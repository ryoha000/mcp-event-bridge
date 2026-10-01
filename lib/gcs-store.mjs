import { createHash } from 'node:crypto';
import { Storage, CRC32C, IdempotencyStrategy } from '@google-cloud/storage';
import { createRequire } from 'node:module';
// Use the auth-library version resolved by the Storage SDK. Its v9 request
// adapter expects object headers; a top-level v11 Compute returns Headers.
const storageRequire = createRequire(import.meta.resolve('@google-cloud/storage'));
const { Compute } = storageRequire('google-auth-library');

const hash = value => createHash('sha256').update(value).digest('hex');
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fault = (code = 'STORAGE_UNAVAILABLE') => Object.assign(new Error('Durable storage operation failed'), { code });
const conflict = () => fault('STORAGE_CONFLICT');
const isConflict = error => error?.code === 'STORAGE_CONFLICT';
const httpCode = error => Number(error?.code);
const isString = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max;
const validProbe = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);

// Lazy runtime-identity client. No metadata request is made during construction.
export function createRuntimeStorage() {
  return new Storage({
    authClient: new Compute({ scopes: ['https://www.googleapis.com/auth/devstorage.read_write'] }),
    timeout: 5000,
    retryOptions: { autoRetry: false, maxRetries: 0, idempotencyStrategy: IdempotencyStrategy.RetryNever },
  });
}

/**
 * JSON compare-and-swap backend. Construction performs no network operation.
 *
 * The configured bucket MUST already be private, encrypted at rest, protected
 * from public access and lifecycle deletion, and accessible only to the approved
 * runtime identity. This module never creates buckets, changes IAM/ACLs, signs
 * URLs, accepts key files, or deletes objects. Production uses the attached
 * runtime identity through Google's metadata-backed Compute auth client, the
 * runtime source of ADC, without local credential-file fallback.
 * The injected SDK interface exists for offline tests, not alternate credentials.
 *
 * Each key is one independently atomic object. There are NO transactions across
 * keys. Callers needing atomic consume/revocation must keep their related state
 * in ONE bounded aggregate. update's synchronous mutator may run multiple times
 * on contention and must have no external side effects. Return { value, result }
 * to commit, or { result } to perform no write. Never reset missing-state security
 * invariants by deleting these objects or changing their namespace.
 */
export function createGcsObjectBackend({
  bucketName,
  storage,
  prefix = 'synthetic-mcp/v1/',
  maxBytes = 1024 * 1024,
  maxAttempts = 5,
} = {}) {
  if (!isString(bucketName, 222) || !/^[a-z0-9][a-z0-9._-]+[a-z0-9]$/.test(bucketName) ||
      !isString(prefix, 128) || !/^[a-zA-Z0-9/_-]+\/$/.test(prefix) ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 128 || maxBytes > 16 * 1024 * 1024 ||
      !Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
    throw fault('STORAGE_CONFIGURATION');
  }
  if (!storage) {
    if (process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.STORAGE_EMULATOR_HOST) {
      throw fault('STORAGE_CONFIGURATION');
    }
    storage = createRuntimeStorage();
  }
  const bucket = storage.bucket(bucketName);
  function objectName(key) {
    if (!isString(key, 4096)) throw fault('STORAGE_INPUT');
    return `${prefix}${hash(key)}.json`;
  }
  async function snapshot(name) {
    let metadata;
    try { [metadata] = await bucket.file(name).getMetadata(); }
    catch (error) {
      if (httpCode(error) === 404) return { value: null, generation: 0 };
      throw fault();
    }
    const generation = String(metadata?.generation ?? '');
    const size = Number(metadata?.size);
    // This SDK converts file-generation selectors to Number. Refuse values it
    // cannot represent exactly instead of silently reading a different version.
    if (!/^[1-9][0-9]*$/.test(generation) || !Number.isSafeInteger(Number(generation)) ||
        !Number.isSafeInteger(size) || size < 1 || size > maxBytes || metadata.contentEncoding) {
      throw fault('STORAGE_CORRUPT');
    }
    let bytes;
    try {
      [bytes] = await bucket.file(name, { generation }).download({ decompress: false, validation: 'crc32c' });
    } catch (error) {
      // The object may have been replaced between metadata and generation-pinned
      // download. A missing generation is contention, never an empty object.
      if ([404, 412].includes(httpCode(error))) throw conflict();
      throw fault();
    }
    if (!Buffer.isBuffer(bytes) || bytes.length !== size || bytes.length > maxBytes) throw fault('STORAGE_CORRUPT');
    let value;
    try { value = JSON.parse(bytes.toString('utf8')); }
    catch { throw fault('STORAGE_CORRUPT'); }
    if (!record(value)) throw fault('STORAGE_CORRUPT');
    return { value, generation };
  }
  async function commit(name, generation, value) {
    if (!record(value)) throw fault('STORAGE_INPUT');
    let bytes;
    try {
      const json = JSON.stringify(value);
      if (json === undefined) throw fault();
      bytes = Buffer.from(json);
    } catch { throw fault('STORAGE_INPUT'); }
    if (bytes.length > maxBytes) throw fault('STORAGE_CAPACITY');
    const crc32c = new CRC32C();
    crc32c.update(bytes);
    try {
      await bucket.file(name).save(bytes, {
        resumable: false,
        timeout: 5000,
        // Server-side checksum validation, without the SDK's potentially
        // destructive delete-on-client-checksum-mismatch cleanup.
        validation: false,
        preconditionOpts: { ifGenerationMatch: generation },
        metadata: { contentType: 'application/json', cacheControl: 'no-store', crc32c: crc32c.toString() },
      });
    } catch (error) {
      if (httpCode(error) === 412) throw conflict();
      // A timeout/error may follow a committed write. Do not retry it or infer
      // success: claims remain consumed and the caller must not send anything.
      throw fault();
    }
  }
  return Object.freeze({
    durable: true,
    async read(key) {
      const name = objectName(key);
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try { return (await snapshot(name)).value; }
        catch (error) { if (!isConflict(error)) throw error; }
      }
      throw conflict();
    },
    async update(key, mutator) {
      if (typeof mutator !== 'function') throw fault('STORAGE_INPUT');
      const name = objectName(key);
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        let current;
        try { current = await snapshot(name); }
        catch (error) { if (isConflict(error)) continue; throw error; }
        const next = mutator(current.value);
        if (!record(next) || typeof next.then === 'function') throw fault('STORAGE_INPUT');
        if (!own(next, 'value')) return next.result;
        try {
          await commit(name, current.generation, next.value);
          return next.result;
        } catch (error) { if (!isConflict(error)) throw error; }
      }
      throw conflict();
    },
  });
}

function validateOwner(owner) {
  if (!isString(owner, 512)) throw fault('STORAGE_INPUT');
}
function validateId(id) {
  if (!isString(id, 256)) throw fault('STORAGE_INPUT');
}
function subscription(value) {
  if (!record(value)) throw fault('STORAGE_INPUT');
  validateOwner(value.owner); validateId(value.id);
  if (!validProbe(value.probe_id) || !isString(value.url, 8192) || !isString(value.secret, 256) ||
      !Number.isSafeInteger(value.expires) || value.expires < 0 ||
      (value.sent !== undefined && typeof value.sent !== 'boolean')) throw fault('STORAGE_INPUT');
  return { id: value.id, owner: value.owner, probe_id: value.probe_id, url: value.url, secret: value.secret, expires: value.expires };
}
function safeReceipt(value) {
  if (!record(value) || !['receipt_acknowledged', 'rejected', 'unknown'].includes(value.outcome)) throw fault('STORAGE_INPUT');
  const { accepted, status, outcome } = value;
  if (outcome === 'unknown') {
    if (accepted !== null || status !== null) throw fault('STORAGE_INPUT');
  } else if (typeof accepted !== 'boolean' || !Number.isInteger(status) || status < 100 || status > 599 ||
             accepted !== (status >= 200 && status < 300) ||
             accepted !== (outcome === 'receipt_acknowledged')) throw fault('STORAGE_INPUT');
  // Explicitly whitelist scalar fields. Never persist/log arbitrary transport
  // errors, callback URLs, headers or signing data as receipt diagnostics.
  return { accepted, status, outcome };
}

/**
 * Probe contract implemented as one bounded object per owner. The subscriptions,
 * permanent (owner, probe_id) claims and their receipts share one CAS boundary.
 * Unsubscribe removes callback credentials but NEVER removes claims. No list or
 * secondary-index writes are needed. No claim expiry or automatic pruning exists.
 * At capacity, writes fail closed; growth/throughput are deliberately bounded for
 * this one-shot experiment. Restoring an old object or deleting it breaks replay
 * protection and is forbidden while a probe ID can recur.
 */
export function createGcsStore({ backend, now = Date.now, ...gcsOptions } = {}) {
  backend ??= createGcsObjectBackend(gcsOptions);
  if (backend?.durable !== true || typeof backend.read !== 'function' || typeof backend.update !== 'function' || typeof now !== 'function') {
    throw fault('STORAGE_CONFIGURATION');
  }
  const keyFor = owner => { validateOwner(owner); return JSON.stringify(['probe-owner:v1', owner]); };
  function stateFor(value, owner) {
    if (value === null) return { version: 1, ownerHash: hash(owner), subscriptions: [], claims: [] };
    try {
      if (!record(value) || value.version !== 1 || value.ownerHash !== hash(owner) ||
          !Array.isArray(value.subscriptions) || !Array.isArray(value.claims)) throw fault();
      const ids = new Set(), probes = new Set(), claimingIds = new Set();
      for (const row of value.subscriptions) {
        subscription(row);
        if (row.owner !== owner || ids.has(row.id)) throw fault();
        ids.add(row.id);
      }
      for (const claim of value.claims) {
        if (!record(claim) || !validProbe(claim.probe_id) || probes.has(claim.probe_id) ||
            !isString(claim.subscription_id, 256) || claimingIds.has(claim.subscription_id) || !Number.isSafeInteger(claim.claimed_at) || claim.claimed_at < 0) throw fault();
        if (own(claim, 'receipt')) safeReceipt(claim.receipt);
        probes.add(claim.probe_id); claimingIds.add(claim.subscription_id);
      }
      return value;
    } catch { throw fault('STORAGE_CORRUPT'); }
  }
  const findClaim = (state, probe) => state.claims.find(item => item.probe_id === probe);
  function view(state, row) {
    if (!row) return null;
    const claim = findClaim(state, row.probe_id);
    return { ...subscription(row), sent: Boolean(claim), ...(claim?.receipt ? { receipt: safeReceipt(claim.receipt) } : {}) };
  }
  const read = async owner => stateFor(await backend.read(keyFor(owner)), owner);
  const mutate = (owner, callback) => backend.update(keyFor(owner), value => callback(stateFor(value, owner)));
  const instant = () => {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0) throw fault('STORAGE_INPUT');
    return value;
  };
  return Object.freeze({
    durable: true,
    async get(id, owner) {
      validateId(id);
      const state = await read(owner);
      return view(state, state.subscriptions.find(item => item.id === id));
    },
    async put(input) {
      const sub = subscription(input);
      const alreadySent = input.sent === true;
      return mutate(sub.owner, state => {
        const index = state.subscriptions.findIndex(item => item.id === sub.id);
        if ((index !== -1 && state.subscriptions[index].probe_id !== sub.probe_id) ||
            state.claims.some(item => item.subscription_id === sub.id && item.probe_id !== sub.probe_id)) throw fault('STORAGE_INPUT');
        if (index === -1) state.subscriptions.push(sub);
        else state.subscriptions[index] = sub;
        // Conservative import/refresh: a supplied sent flag can consume, never
        // release, a probe. Ordinary writes derive sent/receipt only from claims.
        if (alreadySent && !findClaim(state, sub.probe_id)) {
          state.claims.push({ probe_id: sub.probe_id, subscription_id: sub.id, claimed_at: instant() });
        }
        return { value: state };
      });
    },
    async remove(id, owner) {
      validateId(id);
      return mutate(owner, state => {
        const index = state.subscriptions.findIndex(item => item.id === id);
        if (index === -1) return {};
        state.subscriptions.splice(index, 1);
        return { value: state };
      });
    },
    async byProbe(owner, probe) {
      if (!validProbe(probe)) throw fault('STORAGE_INPUT');
      const state = await read(owner);
      const rows = state.subscriptions.filter(item => item.probe_id === probe)
        .sort((a, b) => b.expires - a.expires || a.id.localeCompare(b.id));
      return view(state, rows[0]);
    },
    async claim(id, owner) {
      validateId(id);
      return mutate(owner, state => {
        const sub = state.subscriptions.find(item => item.id === id);
        const at = instant();
        if (!sub || sub.expires <= at || findClaim(state, sub.probe_id)) return { result: false };
        state.claims.push({ probe_id: sub.probe_id, subscription_id: id, claimed_at: at });
        return { value: state, result: true };
      });
    },
    async receipt(id, owner, input) {
      validateId(id);
      const receipt = safeReceipt(input);
      return mutate(owner, state => {
        // Match the claiming subscription even if it was removed meanwhile.
        const claim = state.claims.find(item => item.subscription_id === id);
        if (!claim || own(claim, 'receipt')) return {};
        claim.receipt = receipt;
        return { value: state };
      });
    },
    async status(owner) {
      const state = await read(owner);
      return state.subscriptions.map(row => {
        const { probe_id, expires, sent, receipt } = view(state, row);
        return { probe_id, expires, sent, ...(receipt ? { receipt } : {}) };
      });
    },
  });
}
