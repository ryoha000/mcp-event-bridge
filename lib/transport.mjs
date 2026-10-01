import { resolve4 } from 'node:dns/promises';
import { request } from 'node:https';
import { checkServerIdentity } from 'node:tls';
import ipaddr from 'ipaddr.js';

export function validateUrl(raw) {
  const u = new URL(raw);
  if (u.protocol !== 'https:' || u.username || u.password || u.hash ||
      (u.port && u.port !== '443') || ipaddr.isValid(u.hostname) ||
      !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(u.hostname)) {
    throw new Error('Invalid callback');
  }
  return u;
}
export function publicAddress(ip) {
  return typeof ip === 'string' && ipaddr.isValid(ip) &&
    ipaddr.parse(ip).kind() === 'ipv4' && ipaddr.parse(ip).range() === 'unicast';
}
// 試行ごとに検証済みDNSスナップショットを1回だけ使う。プーリングもリダイレクト追従もしない。
export function pinnedOptions(u, address, headers, body) {
  return {
    protocol: 'https:', hostname: u.hostname, port: 443,
    path: u.pathname + u.search, method: 'POST', agent: false,
    servername: u.hostname, rejectUnauthorized: true,
    checkServerIdentity: (_name, cert) => checkServerIdentity(u.hostname, cert),
    lookup: (_hostname, options, cb) => {
      if (typeof options === 'function') { cb = options; options = {}; }
      if (options?.all) cb(null, [{ address, family: 4 }]);
      else cb(null, address, 4);
    },
    headers: { ...headers, host: u.hostname, connection: 'close',
      'accept-encoding': 'identity', 'content-length': Buffer.byteLength(body) },
    maxHeaderSize: 16384,
  };
}
export function createTransport({ resolve = resolve4, send = request, timeoutMs = 8000, maxBytes = 65536 } = {}) {
  return async (raw, options) => {
    const u = validateUrl(raw);
    if (options.method !== 'POST' || typeof options.body !== 'string' || Buffer.byteLength(options.body) > 32768) throw new Error('Invalid callback request');
    const started = Date.now();
    let timer;
    let addresses;
    try {
      addresses = await Promise.race([resolve(u.hostname), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('DNS timeout')), Math.min(3000, timeoutMs));
      })]);
    } finally { clearTimeout(timer); }
    if (!Array.isArray(addresses) || !addresses.length || addresses.length > 64 || !addresses.every(publicAddress)) throw new Error('Callback address rejected');
    const remaining = timeoutMs - (Date.now() - started);
    if (remaining <= 0) throw new Error('Callback timeout');
    return new Promise((resolveResponse, reject) => {
      let req, response, settled = false, deadline;
      const finish = (err, result) => {
        if (settled) return;
        settled = true; clearTimeout(deadline);
        if (err) { response?.destroy(); req?.destroy(); reject(new Error('Callback transport failed')); }
        else resolveResponse(result);
      };
      deadline = setTimeout(() => finish(new Error('Timeout')), remaining);
      try {
        req = send(pinnedOptions(u, addresses[0], options.headers, options.body), res => {
          response = res;
          const status = res.statusCode;
          if (!Number.isInteger(status) || status < 200 || status > 599 || (status >= 300 && status < 400) || (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity')) {
            finish(new Error('Unsupported response')); return;
          }
          const chunks = []; let size = 0;
          res.on('error', finish);
          res.on('aborted', () => finish(new Error('Aborted response')));
          res.on('data', chunk => {
            size += chunk.length;
            if (size > maxBytes) { finish(new Error('Response too large')); return; }
            chunks.push(chunk);
          });
          res.on('end', () => {
            if (!res.complete) { finish(new Error('Incomplete response')); return; }
            const body = Buffer.concat(chunks).toString('utf8');
            finish(null, { status, ok: status >= 200 && status < 300, json: async () => JSON.parse(body) });
          });
        });
        req.on('error', finish);
        req.end(options.body);
      } catch (err) { finish(err); }
    });
  };
}
export const callbackTransport = createTransport();
