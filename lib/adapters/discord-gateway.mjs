import { BOT_ID, DISCORD_INTENTS } from './discord.mjs';
import {randomUUID} from 'node:crypto';

const safeGateway = raw => {
  const u = new URL(raw);
  if (u.protocol !== 'wss:' || u.username || u.password || u.port || u.hash || u.pathname !== '/' ||
      !(u.hostname === 'gateway.discord.gg' || /^gateway-[a-z0-9-]+\.discord\.gg$/.test(u.hostname))) throw Error('Gateway URL refused');
  u.search = '?v=10&encoding=json'; return u.href;
};
const fatalCodes = new Set([4004,4010,4011,4012,4013,4014]);

// 明示的に起動されるホストプロセス。インポート時にソケットを開いたり
// 認証情報を読んだりしない。直列の取り込みと、永続コミット後の
// チェックポイントによりリプレイを可能にする。
export function createDiscordGateway({token,onDispatch,backend,sessionKey,WebSocketClass=WebSocket,
  timers={setTimeout,clearTimeout},random=Math.random,onFatal=()=>{},onState=()=>{},botId=BOT_ID,now=Date.now,leaseMs=60000,leaseRenewalMs=20000,ownership='durable-lease'} = {}) {
  if (!token || typeof onDispatch !== 'function' || backend?.durable !== true || !sessionKey) throw Error('Gateway configuration refused');
  const local=ownership==='local-singleton';if(!['durable-lease','local-singleton'].includes(ownership)||local&&(backend.localSingleton!==true||typeof backend.claimLocalSession!=='function'||typeof backend.releaseLocalSession!=='function'))throw Error('Gateway local lock required');
  if(!Number.isSafeInteger(leaseMs)||!Number.isSafeInteger(leaseRenewalMs)||leaseRenewalMs<20000||leaseMs<leaseRenewalMs*3||leaseMs>900000)throw Error('Gateway lease configuration refused');
  let socket, stopped = true, session = null, heartbeatTimer, reconnectTimer, leaseTimer, ack = true, chain = Promise.resolve(), reconnects = 0;
  let pendingDispatch=0,pendingBytes=0;
  const holder=randomUUID();
  const owns=saved=>saved?.holder===holder&&(local?saved.version===2&&saved.mode==='local-singleton':saved.until>now());
  const send = packet => { if (socket?.readyState === 1) socket.send(JSON.stringify(packet)); };
  const checkpoint = async () => backend.update(sessionKey, saved => {
    if(!owns(saved))throw Error('Gateway ownership lost');
    return {value:{...saved,version:local?2:1,session,holder,...(local?{mode:'local-singleton'}:{until:now()+leaseMs})}};
  });
  const reserveIdentify=async()=>backend.update(sessionKey,saved=>{
    if(!owns(saved))throw Error('Gateway ownership lost');
    const at=now();let budget=saved.identify;
    if(!budget||at-budget.windowStart>=86400000)budget={windowStart:at,count:0,lastAt:0};
    if(!Number.isSafeInteger(budget.count)||budget.count<0||budget.count>=100||(budget.count>0&&at-budget.lastAt<5000))throw Error('Gateway identify budget exhausted');
    return {value:{...saved,identify:{...budget,count:budget.count+1,lastAt:at}}};
  });
  function renewLease(){leaseTimer=timers.setTimeout(async()=>{if(stopped)return;try{await checkpoint();if(!stopped)renewLease();}catch{fatal();}},leaseRenewalMs);}
  const state=(phase,code)=>{try{onState(phase,code);}catch{}};
  const fatal = code => { if(stopped)return;stop(); state('failed',Number.isInteger(code)?code:undefined);onFatal('Discord Gateway stopped; operator review required'); };
  function clearHeartbeat() { if (heartbeatTimer !== undefined) timers.clearTimeout(heartbeatTimer); heartbeatTimer = undefined; }
  function reconnect() {
    clearHeartbeat();
    if (stopped || reconnectTimer !== undefined) return;
    reconnectTimer = timers.setTimeout(() => { reconnectTimer = undefined; if (!stopped) connect(); }, Math.min(60000,5000*2**Math.min(reconnects++,4)));
  }
  function heartbeat(interval, first = false) {
    heartbeatTimer = timers.setTimeout(() => {
      if (stopped) return;
      if (!ack) { socket?.close(4000); reconnect(); return; }
      ack = false; send({op:1,d:session?.seq ?? null}); heartbeat(interval);
    }, first ? interval*random() : interval);
  }
  function connect() {
    if (stopped) return;
    let url; try { url = safeGateway(session?.resumeUrl ?? 'wss://gateway.discord.gg/'); } catch { fatal(); return; }
    const current = new WebSocketClass(url); socket = current; ack = true;
    current.addEventListener('message', event => {
      if (stopped || current !== socket) return;
      let p; try { if (typeof event.data !== 'string' || event.data.length > 1024*1024) throw Error(); p = JSON.parse(event.data); } catch { current.close(4000); reconnect(); return; }
      if (p.op === 11) { ack = true; return; }
      if (p.op === 1) { ack=false;send({op:1,d:session?.seq ?? null}); return; }
      if (p.op === 10) {
        if (!Number.isSafeInteger(p.d?.heartbeat_interval) || p.d.heartbeat_interval < 1000) { fatal(); return; }
        clearHeartbeat(); heartbeat(p.d.heartbeat_interval,true);
        if (session) send({op:6,d:{token,session_id:session.id,seq:session.seq}});
        else chain=chain.then(async()=>{await reserveIdentify();if(!stopped&&current===socket)send({op:2,d:{token,intents:DISCORD_INTENTS,properties:{os:process.platform,browser:'native-mcp-discord',device:'native-mcp-discord'}}});}).catch(fatal);
        return;
      }
      if (p.op === 7) { current.close(4000); reconnect(); return; }
      if (p.op === 9) {
        chain = chain.then(async () => { if (!p.d) { session = null; await checkpoint(); } current.close(4000); reconnect(); }).catch(fatal); return;
      }
      if (p.op !== 0 || !Number.isSafeInteger(p.s) || p.s < 0) return;
      const receivedAtMs=now(),bytes=Buffer.byteLength(event.data);
      if(pendingDispatch>=128||pendingBytes+bytes>4*1024*1024){current.close(4000);reconnect();return;}
      pendingDispatch++;pendingBytes+=bytes;
      chain = chain.then(async () => {
        if (stopped || current !== socket) return;
        if (p.t === 'READY') {
          if (p.d?.user?.id !== botId || typeof p.d.session_id !== 'string' || p.d.session_id.length > 512) throw Error();
          session = {id:p.d.session_id,resumeUrl:safeGateway(p.d.resume_gateway_url),seq:p.s};
          reconnects = 0; await checkpoint();state('ready'); return;
        }
        if (!session) throw Error();
        if (p.s <= session.seq) return;
        await onDispatch(p,{receivedAtMs});
        session = {...session,seq:p.s}; await checkpoint();
        if (p.t === 'RESUMED'){reconnects = 0;state('resumed');}
      }).catch(() => { // 未コミットのイベントを越えて進むより、フェイルクローズする。
        fatal();
      }).finally(()=>{pendingDispatch--;pendingBytes-=bytes;});
    });
    current.addEventListener('close', event => { if (current !== socket || stopped) return; if (fatalCodes.has(event.code)) fatal(event.code); else if([4007,4009].includes(event.code))chain=chain.then(async()=>{session=null;await checkpoint();reconnect();}).catch(fatal);else reconnect(); });
    current.addEventListener('error', () => { if (current === socket && !stopped) { current.close(4000); reconnect(); } });
  }
  function stop() { stopped = true; clearHeartbeat();if(leaseTimer!==undefined)timers.clearTimeout(leaseTimer); if (reconnectTimer !== undefined) timers.clearTimeout(reconnectTimer); reconnectTimer = undefined; socket?.close(1000); }
  return {
    async start() {
      if (!stopped) throw Error('Gateway already started');
      if(local)backend.claimLocalSession(sessionKey,holder);
      try{await backend.update(sessionKey,saved=>{
        if(saved!==null){
          if(saved.version!==(local?2:1) || local&&saved.mode!=='local-singleton' || (saved.session!==null&&(!Number.isSafeInteger(saved.session?.seq)||saved.session.seq<0||typeof saved.session?.id!=='string'||!saved.session.id||saved.session.id.length>512)))throw Error('Gateway session refused');
          if(!local&&saved.holder&&saved.until>now())throw Error('Gateway already held');
          session=saved.session;if(session)safeGateway(session.resumeUrl);
        }
        return {value:{...saved,version:local?2:1,session,holder,...(local?{mode:'local-singleton'}:{until:now()+leaseMs})}};
      });}catch(error){if(local)backend.releaseLocalSession(sessionKey,holder);throw error;}
      stopped = false;if(!local)renewLease(); connect();
    },
    stop,
    async release(){
      stop();await chain;
      try{return await backend.update(sessionKey,saved=>saved?.holder!==holder?{result:false}:{value:{...saved,holder:null,...(local?{}:{until:now()})},result:true});}finally{if(local)backend.releaseLocalSession(sessionKey,holder);}
    },
    async flush() { await chain; },
  };
}
