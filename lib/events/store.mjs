import { randomUUID } from 'node:crypto';
import { digest, exact, fault, text, validateEnvelope } from './envelope.mjs';

// 1つのオーナー集約。取り込み、ファンアウト、サブスクリプション、リース、
// 返信クレームが1つのCAS境界を共有する。この名前空間やリプレイ用
// トゥームストーンを削除/リセットしてはならない。
export function createEventStore({ backend, now = Date.now, maxEvents = 128, maxSubscriptions = 8, retention, retryUntilAcknowledged=false,requireLiveSubscription=false } = {}) {
  if (backend?.durable !== true || typeof backend.read !== 'function' || typeof backend.update !== 'function') throw fault('EVENT_STORAGE');
  const instant = () => { const at = now(); if (!Number.isSafeInteger(at) || at < 0) throw fault(); return at; };
  const key = owner => { if (!text(owner)) throw fault(); return JSON.stringify(['source-events-owner:v1', owner]); };
  function state(raw, owner) {
    if (raw === null) return { version: 1, ownerHash: digest(owner), events: [], subscriptions: [], deliveries: [], replies: [], commands: [] };
    if (raw.version !== 1 || raw.ownerHash !== digest(owner) || !['events','subscriptions','deliveries','replies'].every(k => Array.isArray(raw[k]))) throw fault('EVENT_CORRUPT');
    exact(raw,['version','ownerHash','events','subscriptions','deliveries','replies','commands','retired']);
    if(raw.retired!==undefined&&(!Array.isArray(raw.retired)||raw.retired.some(r=>!/^evt_[a-f0-9]{64}$/.test(r.eventId)||!Number.isSafeInteger(r.expires))||raw.retired.length>(retention?.maxRetired??4096)))throw fault('EVENT_CORRUPT');
    if(!Array.isArray(raw.commands))throw fault('EVENT_CORRUPT');
    for (const event of raw.events) validateEnvelope(event);
    if (new Set(raw.events.map(e => e.eventId)).size !== raw.events.length) throw fault('EVENT_CORRUPT');
    const events = new Set(raw.events.map(e=>e.eventId)), subs = new Set(), deliveries = new Set(), replies = new Set();
    for (const sub of raw.subscriptions) {
      exact(sub,['id','clientId','grantId','name','tenantId','url','secret','expires','revision','oldSecret','rotateUntil','resource']);
      if (!['id','clientId','grantId','name','tenantId','url','secret','revision'].every(k=>text(sub[k],k==='url'?8192:512)) || !Number.isSafeInteger(sub.expires) || sub.expires<0 || subs.has(sub.id) || (sub.oldSecret!==undefined&&(!text(sub.oldSecret)||!Number.isSafeInteger(sub.rotateUntil)))) throw fault('EVENT_CORRUPT');
      if(sub.resource!==undefined&&!text(sub.resource,512))throw fault('EVENT_CORRUPT');
      subs.add(sub.id);
    }
    for (const d of raw.deliveries) {
      exact(d,['eventId','subscriptionId','revision','status','attempts','availableAt','lease','leaseUntil','httpStatus']);
      const id=JSON.stringify([d.eventId,d.subscriptionId]);
      if (!events.has(d.eventId) || !text(d.subscriptionId) || !text(d.revision) || deliveries.has(id) ||
          !['pending','inflight','acknowledged','dead','revoked'].includes(d.status) || !Number.isSafeInteger(d.attempts) || d.attempts<0 || d.attempts>1000000 || !Number.isSafeInteger(d.availableAt) || d.availableAt<0 ||
          (d.status==='inflight'&&(!text(d.lease)||!Number.isSafeInteger(d.leaseUntil)||d.leaseUntil<0)) ||
          (d.httpStatus!==undefined&&d.httpStatus!==null&&(!Number.isInteger(d.httpStatus)||d.httpStatus<100||d.httpStatus>599))) throw fault('EVENT_CORRUPT');
      deliveries.add(id);
    }
    for (const r of raw.replies) {
      exact(r,['eventId','contentHash','status','at','messageId']);
      if (!events.has(r.eventId) || replies.has(r.eventId) || !/^[a-f0-9]{64}$/.test(r.contentHash) || !['claimed','queued','sent','rejected','unknown'].includes(r.status) || !Number.isSafeInteger(r.at) || r.at<0 || (r.messageId!==undefined&&r.messageId!==null&&!text(r.messageId,128))) throw fault('EVENT_CORRUPT');
      replies.add(r.eventId);
    }
    const commandEvents=new Set(),requests=new Set();
    for(const c of raw.commands){
      exact(c,['eventId','content','status','requestId','clientId','grantId','resource']);
      if(!events.has(c.eventId)||commandEvents.has(c.eventId)||!text(c.content,2000)||!text(c.clientId)||!text(c.grantId)||raw.replies.find(r=>r.eventId===c.eventId)?.contentHash!==digest(c.content)||!['pending','claimed','complete'].includes(c.status)||(c.requestId!==undefined&&(!text(c.requestId,128)||requests.has(c.requestId))))throw fault('EVENT_CORRUPT');
      if(c.resource!==undefined&&!text(c.resource,512))throw fault('EVENT_CORRUPT');
      commandEvents.add(c.eventId);if(c.requestId)requests.add(c.requestId);
    }
    capacity(raw);
    return raw;
  }
  const read = async owner => state(await backend.read(key(owner)), owner);
  function maintain(s){
    if(!retention)return false;const at=instant();s.retired ||= [];let changed=false;
    const before=s.retired.length;s.retired=s.retired.filter(r=>r.expires>at);changed ||= before!==s.retired.length;
    for(const c of s.commands.filter(c=>c.status==='pending')){
      const e=s.events.find(e=>e.eventId===c.eventId);
      if(retention.identityTime(e)+retention.replyMs<=at){c.status='complete';s.replies.find(r=>r.eventId===c.eventId).status='rejected';changed=true;}
    }
    for(const e of [...s.events]){
      const born=retention.identityTime(e),r=s.replies.find(r=>r.eventId===e.eventId),ds=s.deliveries.filter(d=>d.eventId===e.eventId);
      // 購読者なし、デッドコールバック、キュー/クレーム済み返信、結果不明な
      // 送信は未解決の作業として保存を継続する。容量超過はバックプレッシャーになる。
      if(born+retention.replyMs>at||!ds.length||ds.some(d=>!['acknowledged','revoked'].includes(d.status))||(r&&!['sent','rejected'].includes(r.status)))continue;
      if(born+retention.replayMs>at){if(s.retired.length>=retention.maxRetired)continue;s.retired.push({eventId:e.eventId,expires:born+retention.replayMs});}
      for(const k of ['events','deliveries','replies','commands'])s[k]=s[k].filter(row=>row.eventId!==e.eventId);
      changed=true;
    }
    return changed;
  }
  const update = (owner, fn) => backend.update(key(owner), raw => {const s=state(raw,owner),changed=maintain(s),next=fn(s);return changed&&!Object.hasOwn(next,'value')?{...next,value:s}:next;});
  const capacity = s => { if (s.events.length > maxEvents || s.subscriptions.length > maxSubscriptions || s.deliveries.length > maxEvents * maxSubscriptions || s.replies.length > maxEvents || s.commands.length>maxEvents) throw fault('EVENT_CAPACITY'); };
  const commit = (s, result) => { capacity(s); return { value: s, result }; };
  return Object.freeze({
    durable: true,
    async ingest(owner, input) {
      const event = validateEnvelope(input);
      return update(owner, s => {
        const existing = s.events.find(e => e.eventId === event.eventId);
        if (existing) return { result: { eventId: existing.eventId, duplicate: true } };
        if(s.retired?.some(r=>r.eventId===event.eventId))return {result:{eventId:event.eventId,duplicate:true,retired:true}};
        if(retention){const born=retention.identityTime(event);if(born+retention.replayMs<=instant()||born>instant()+300000)throw fault('EVENT_EXPIRED');}
        if(requireLiveSubscription&&!s.subscriptions.some(x=>x.name===event.name&&x.tenantId===event.origin.tenantId&&x.expires>instant()))throw fault('EVENT_SUBSCRIPTION_PAUSED');
        s.events.push(event);
        for (const sub of s.subscriptions.filter(x => x.name === event.name && x.tenantId === event.origin.tenantId && x.expires > instant())) {
          s.deliveries.push({ eventId: event.eventId, subscriptionId: sub.id, revision: sub.revision, status: 'pending', attempts: 0, availableAt: instant() });
        }
        return commit(s, { eventId: event.eventId, duplicate: false });
      });
    },
    async subscribe(owner, input) {
      exact(input, ['id','clientId','grantId','name','tenantId','url','secret','expires','resource']);
      if (!['id','clientId','grantId','name','tenantId','url','secret'].every(k => text(input[k], k === 'url' ? 8192 : 512)) || !Number.isSafeInteger(input.expires) || input.expires <= instant()) throw fault();
      if(input.resource!==undefined&&!text(input.resource,512))throw fault();
      return update(owner, s => {
        const old = s.subscriptions.find(x => x.id === input.id);
        if (old && old.clientId !== input.clientId) throw fault('EVENT_SCOPE');
        if (old && old.url !== input.url) throw fault('EVENT_SUBSCRIPTION_IMMUTABLE');
        const sub = { ...structuredClone(input), revision: old?.revision ?? randomUUID() };
        if(old?.oldSecret && old.rotateUntil>instant()) {sub.oldSecret=old.oldSecret;sub.rotateUntil=old.rotateUntil;}
        if(old && old.secret!==input.secret) {
          if(sub.oldSecret)throw fault('EVENT_ROTATION_IN_PROGRESS');
          sub.oldSecret=old.secret;sub.rotateUntil=instant()+300000;
        }
        if(old){delete old.oldSecret;delete old.rotateUntil;}
        if (old) Object.assign(old, sub); else s.subscriptions.push(sub);
        // 新規作成/更新されたサブスクリプションへ過去イベントのリプレイはしない。
        return commit(s, { id: sub.id, expires: sub.expires });
      });
    },
    async unsubscribe(owner, id, clientId) {
      return update(owner, s => {
        const sub = s.subscriptions.find(x => x.id === id && x.clientId === clientId);
        if (!sub) return { result: false };
        s.subscriptions = s.subscriptions.filter(x => x !== sub);
        for (const d of s.deliveries.filter(x => x.subscriptionId === id && !['acknowledged','dead'].includes(x.status))) { d.status = 'revoked'; delete d.lease; }
        return commit(s, true);
      });
    },
    async claimDelivery(owner) {
      return update(owner, s => {
        const at = instant();
        let changed=false;
        for (const d of s.deliveries) {
          const sub = s.subscriptions.find(x => x.id === d.subscriptionId && x.revision === d.revision);
          if (['pending','inflight'].includes(d.status) && !sub) { d.status='revoked';delete d.lease;changed=true;continue; }
          if(sub&&sub.expires<=at)continue;
          if (!retryUntilAcknowledged&&d.status==='inflight' && d.leaseUntil<=at && d.attempts>=8) { d.status='dead';delete d.lease;changed=true;continue; }
          if (!sub || (!retryUntilAcknowledged&&d.attempts >= 8) || !((d.status === 'pending' && d.availableAt <= at) || (d.status === 'inflight' && d.leaseUntil <= at))) continue;
          d.status = 'inflight'; d.lease = randomUUID(); d.leaseUntil = at + 30000; d.attempts=Math.min(1000000,d.attempts+1);
          const deliverySub=structuredClone(sub);if(deliverySub.rotateUntil<=at){delete deliverySub.oldSecret;delete deliverySub.rotateUntil;}
          return commit(s, { ...structuredClone(d), subscription: deliverySub, event: structuredClone(s.events.find(e => e.eventId === d.eventId)) });
        }
        return changed ? commit(s,null) : { result: null };
      });
    },
    async settleDelivery(owner, claim, status) {
      if (status !== null && (!Number.isInteger(status) || status < 100 || status > 599)) throw fault();
      return update(owner, s => {
        const d = s.deliveries.find(x => x.eventId === claim.eventId && x.subscriptionId === claim.subscriptionId && x.lease === claim.lease && x.status === 'inflight');
        if (!d) return { result: false };
        const acknowledged = status !== null && status >= 200 && status < 300;
        d.status = acknowledged ? 'acknowledged' : (!retryUntilAcknowledged&&(d.attempts >= 8 || (status !== null && status >= 400 && status < 500 && status !== 429)) ? 'dead' : 'pending');
        d.httpStatus = status; d.availableAt = instant() + Math.min(retryUntilAcknowledged?300000:3600000, 1000 * 2 ** Math.min(d.attempts,20)); delete d.lease;
        return commit(s, true);
      });
    },
    async getEvent(owner, id) { return structuredClone((await read(owner)).events.find(e => e.eventId === id) ?? null); },
    async workSchedule(owner) {
      const s=await read(owner),at=instant(),times=[];
      for(const d of s.deliveries){
        const sub=s.subscriptions.find(x=>x.id===d.subscriptionId&&x.revision===d.revision);
        if(!sub||sub.expires<=at)continue;
        if(d.status==='pending'&&(retryUntilAcknowledged||d.attempts<8))times.push(d.availableAt);
        if(d.status==='inflight')times.push(d.leaseUntil);
      }
      return {deliveryAt:times.length?Math.max(at,Math.min(...times)):null,pendingReplies:s.commands.some(c=>c.status==='pending'),claimedReplies:s.commands.some(c=>c.status==='claimed')};
    },
    async recoverClaimedReplies(owner) {
      return update(owner,s=>{
        const rows=s.commands.filter(c=>c.status==='claimed');if(!rows.length)return {result:0};
        for(const c of rows){c.status='complete';const r=s.replies.find(r=>r.eventId===c.eventId);r.status='unknown';r.messageId=null;}
        return commit(s,rows.length);
      });
    },
    async claimReply(owner, eventId, contentHash, queuedContent, authorization) {
      if (!/^[a-f0-9]{64}$/.test(contentHash)) throw fault();
      return update(owner, s => {
        if (!s.events.some(e => e.eventId === eventId)) throw fault();
        const old = s.replies.find(r => r.eventId === eventId);
        if (old) { if (old.contentHash !== contentHash) throw fault('EVENT_REPLY_CONFLICT'); return { result: { claimed: false, status: old.status } }; }
        if(retention&&retention.identityTime(s.events.find(e=>e.eventId===eventId))+retention.replyMs<=instant())throw fault('EVENT_REPLY_EXPIRED');
        if(queuedContent!==undefined&&(!text(queuedContent,2000)||digest(queuedContent)!==contentHash||!text(authorization?.grantId)||!text(authorization?.clientId)))throw fault();
        const status=queuedContent===undefined?'claimed':'queued';
        s.replies.push({ eventId, contentHash, status, at: instant() });
        if(authorization?.resource!==undefined&&!text(authorization.resource,512))throw fault();
        if(queuedContent!==undefined)s.commands.push({eventId,content:queuedContent,status:'pending',clientId:authorization.clientId,grantId:authorization.grantId,...(authorization.resource?{resource:authorization.resource}:{})});
        return commit(s, { claimed: true, status });
      });
    },
    async claimQueuedReply(owner,requestId,source='discord'){
      if(!text(requestId,128))throw fault();
      return update(owner,s=>{
        let command=s.commands.find(c=>c.requestId===requestId);
        if(command?.status==='complete')return {result:{command:null,complete:true}};
        if(!command){command=s.commands.find(c=>c.status==='pending'&&s.events.find(e=>e.eventId===c.eventId)?.source===source);if(!command)return {result:{command:null,complete:false}};command.status='claimed';command.requestId=requestId;}
        return commit(s,{command:{event:structuredClone(s.events.find(e=>e.eventId===command.eventId)),content:command.content,requestId},authorization:{clientId:command.clientId,grantId:command.grantId,...(command.resource?{resource:command.resource}:{})},complete:false});
      });
    },
    async receiptQueuedReply(owner,{requestId,eventId,status,messageId=null}){
      if(!['sent','rejected','unknown'].includes(status)||(messageId!==null&&!/^[0-9]{17,20}$/.test(messageId)))throw fault();
      return update(owner,s=>{
        const c=s.commands.find(c=>c.eventId===eventId&&c.requestId===requestId);const r=s.replies.find(r=>r.eventId===eventId);
        if(!c||!r)throw fault();if(c.status==='complete')return {result:{accepted:true}};
        c.status='complete';r.status=status;r.messageId=messageId;return commit(s,{accepted:true});
      });
    },
    async settleReply(owner, eventId, status, messageId = null) {
      if (!['sent','rejected','unknown'].includes(status) || (messageId !== null && !text(messageId,128))) throw fault();
      return update(owner, s => {
        const row = s.replies.find(r => r.eventId === eventId);
        if (!row || row.status !== 'claimed') return {};
        row.status = status; row.messageId = messageId; return commit(s);
      });
    },
    async sourceStatus(owner,{source,name,tenantId,clientId,grantId,resource}) {
      if(![source,name,tenantId,clientId,grantId].every(x=>text(x)))throw fault();
      const s=await read(owner),at=instant();
      const events=s.events.filter(e=>e.source===source&&e.name===name&&e.origin.tenantId===tenantId);
      const ids=new Set(events.map(e=>e.eventId));
      const subs=s.subscriptions.filter(x=>x.name===name&&x.tenantId===tenantId);
      const active=subs.filter(x=>x.expires>at);
      const counts=(rows,states)=>Object.fromEntries(states.map(status=>[status,rows.filter(x=>x.status===status).length]));
      return {events:events.length,capacity:maxEvents,
        subscriptions:{total:subs.length,unexpired:active.length,currentConnectionActive:active.filter(x=>x.clientId===clientId&&x.grantId===grantId&&(x.resource??resource)===resource).length},
        deliveries:counts(s.deliveries.filter(d=>ids.has(d.eventId)),['pending','inflight','acknowledged','dead','revoked']),
        replies:counts(s.replies.filter(r=>ids.has(r.eventId)),['claimed','queued','sent','rejected','unknown']),
        commands:counts(s.commands.filter(c=>ids.has(c.eventId)),['pending','claimed','complete'])};
    },
    async status(owner) {
      const s = await read(owner);
      return { events: s.events.length, capacity: maxEvents, retired:s.retired?.length??0,undelivered:s.events.filter(e=>!s.deliveries.some(d=>d.eventId===e.eventId)).length, deliveries: s.deliveries.map(({eventId,status,attempts,httpStatus}) => ({eventId,status,attempts,httpStatus})), replies: s.replies.map(({eventId,status,messageId}) => ({eventId,status,messageId})) };
    },
  });
}
