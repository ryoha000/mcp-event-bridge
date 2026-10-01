import { DatabaseSync } from 'node:sqlite';
import { fault } from './envelope.mjs';

// PC/VM向け永続バックエンド。共有データベースで独立プロセスに対応する。
// 同期の純粋ミューテータを BEGIN IMMEDIATE 配下で実行し、ネットワークI/Oは外に出さない。
export function createSqliteBackend(path) {
  if(typeof path!=='string'||!path||path===':memory:'||path.startsWith('file:'))throw fault('EVENT_STORAGE');
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS aggregates (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const select = db.prepare('SELECT value FROM aggregates WHERE key = ?');
  const put = db.prepare('INSERT INTO aggregates VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  const read = key => { const row = select.get(key); return row ? JSON.parse(row.value) : null; };
  return {
    durable: true,
    async read(key) { return read(key); },
    async update(key, mutator) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const next = mutator(read(key));
        if (!next || typeof next.then === 'function') throw fault();
        if (Object.hasOwn(next,'value')) {
          const json = JSON.stringify(next.value); if (Buffer.byteLength(json) > 1024*1024) throw fault('EVENT_CAPACITY'); put.run(key,json);
        }
        db.exec('COMMIT'); return next.result;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    close() { db.close(); },
  };
}
