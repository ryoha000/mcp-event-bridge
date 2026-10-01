import {DatabaseSync} from 'node:sqlite';
import {constants,openSync,closeSync,lstatSync,realpathSync,chmodSync} from 'node:fs';
import {resolve,dirname,isAbsolute} from 'node:path';

const APPLICATION_ID=0x4d435044;
const fault=code=>Object.assign(Error('Durable local storage operation refused'),{code});
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function privateFile(path){
 try{const s=lstatSync(path);if(!s.isFile()||s.isSymbolicLink())throw fault('STORAGE_CONFIGURATION');}catch(e){if(e.code!=='ENOENT')throw e;}
 const fd=openSync(path,constants.O_CREAT|constants.O_RDWR|(constants.O_NOFOLLOW??0),0o600);closeSync(fd);chmodSync(path,0o600);
}
function refuseSidecarLinks(path){for(const suffix of ['-wal','-shm','-journal']){try{const s=lstatSync(path+suffix);if(!s.isFile()||s.isSymbolicLink())throw fault('STORAGE_CONFIGURATION');}catch(e){if(e.code!=='ENOENT')throw e;}}}

// GCSアダプタと同じ上限付きオブジェクトAPI。集約ごとに1トランザクション。
// 別SQLiteの EXCLUSIVE トランザクションがプロセスロックになる。クラッシュ時は
// OSが解放するため、残ったholder文字列による時間待ちの再起動は発生しない。
// systemd の flock が外側のオペレーター可視ロックを追加する。
// ネットワーク/ADC/リースタイマーは存在しない。共有/ネットワークストレージ
// ではなく、1台のVMと1つの永続ローカルディスク向け。
export function createSqliteObjectBackend({filename,maxBytes=1024*1024,maxKeys=32}={}){
 if(typeof filename!=='string'||!isAbsolute(filename)||!filename.endsWith('.sqlite3')||!Number.isSafeInteger(maxBytes)||maxBytes<128||maxBytes>16*1024*1024||!Number.isSafeInteger(maxKeys)||maxKeys<1||maxKeys>128)throw fault('STORAGE_CONFIGURATION');
 filename=resolve(filename);const parent=dirname(filename);
 let database,lock,closed=false;const sessions=new Map(),counts={reads:0,transactions:0,commits:0};
 try{
  const directory=lstatSync(parent);if(!directory.isDirectory()||directory.isSymbolicLink()||realpathSync(parent)!==parent)throw fault('STORAGE_CONFIGURATION');
  privateFile(filename+'.lock.sqlite3');refuseSidecarLinks(filename+'.lock.sqlite3');
  lock=new DatabaseSync(filename+'.lock.sqlite3');lock.exec('PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS singleton(id INTEGER PRIMARY KEY CHECK(id=1)); BEGIN EXCLUSIVE;');
  privateFile(filename);refuseSidecarLinks(filename);database=new DatabaseSync(filename);
  const app=database.prepare('PRAGMA application_id').get().application_id;
  const version=database.prepare('PRAGMA user_version').get().user_version;
  const tables=database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  if((app!==APPLICATION_ID||version!==1)&&(app!==0||version!==0||tables.length))throw fault('STORAGE_CORRUPT');
  if(database.prepare('PRAGMA quick_check').get().quick_check!=='ok')throw fault('STORAGE_CORRUPT');
  database.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=1000; PRAGMA max_page_count=16384;');
  if(app===0){database.exec(`BEGIN IMMEDIATE; CREATE TABLE state(key TEXT PRIMARY KEY NOT NULL,value TEXT NOT NULL) WITHOUT ROWID; PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=1; COMMIT;`);}
  const columns=database.prepare('PRAGMA table_info(state)').all();if(columns.length!==2||columns[0].name!=='key'||columns[1].name!=='value'||!columns[0].pk)throw fault('STORAGE_CORRUPT');
 }catch(error){try{database?.close();}catch{}try{lock?.close();}catch{}throw fault(error?.code==='STORAGE_CONFIGURATION'?'STORAGE_CONFIGURATION':'STORAGE_UNAVAILABLE');}
 const select=database.prepare('SELECT value FROM state WHERE key=?');
 const put=database.prepare('INSERT INTO state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
 const keyCount=database.prepare('SELECT count(*) AS n FROM state');
 function key(k){if(closed)throw fault('STORAGE_UNAVAILABLE');if(typeof k!=='string'||!k||k.length>4096)throw fault('STORAGE_INPUT');}
 function snapshot(k){counts.reads++;const row=select.get(k);if(!row)return null;if(Buffer.byteLength(row.value)>maxBytes)throw fault('STORAGE_CORRUPT');let value;try{value=JSON.parse(row.value);}catch{throw fault('STORAGE_CORRUPT');}if(!record(value))throw fault('STORAGE_CORRUPT');return value;}
 return Object.freeze({durable:true,localSingleton:true,kind:'sqlite',
  async read(k){key(k);try{return snapshot(k);}catch{throw fault('STORAGE_UNAVAILABLE');}},
  async update(k,mutator){
   key(k);if(typeof mutator!=='function')throw fault('STORAGE_INPUT');let mutatorError;
   try{
    database.exec('BEGIN IMMEDIATE');counts.transactions++;let next;
    try{next=mutator(snapshot(k));}catch(error){mutatorError=error;throw error;}
    if(!record(next)||typeof next.then==='function')throw fault('STORAGE_INPUT');
    if(Object.hasOwn(next,'value')){
     if(!record(next.value))throw fault('STORAGE_INPUT');let json;try{json=JSON.stringify(next.value);}catch{throw fault('STORAGE_INPUT');}
     if(Buffer.byteLength(json)>maxBytes)throw fault('STORAGE_CAPACITY');
     if(!select.get(k)&&keyCount.get().n>=maxKeys)throw fault('STORAGE_CAPACITY');put.run(k,json);
     database.exec('COMMIT');counts.commits++;
    }else database.exec('ROLLBACK');
    return next.result;
   }catch(error){try{database.exec('ROLLBACK');}catch{}if(error===mutatorError)throw error;if(['STORAGE_INPUT','STORAGE_CAPACITY'].includes(error?.code))throw error;throw fault('STORAGE_UNAVAILABLE');}
  },
  statistics(){return {...counts};},
  claimLocalSession(k,holder){key(k);if(typeof holder!=='string'||!holder||sessions.has(k))throw fault('STORAGE_SINGLETON');sessions.set(k,holder);},
  releaseLocalSession(k,holder){if(sessions.get(k)===holder)sessions.delete(k);},
  close(){if(closed)return;closed=true;try{database.close();}finally{try{lock.exec('ROLLBACK');}finally{lock.close();}};}
 });
}
