// アダプタ契約。全メソッドはオーナー単位でスコープされる。claim はインスタンスを
// またいでアトミックに永続的な (owner, probe_id) トゥームストーンを作る。
// 購読解除でも失効しない。
export function assertStore(store, production = false) {
  for (const name of ['get', 'put', 'remove', 'byProbe', 'claim', 'receipt', 'status']) {
    if (typeof store?.[name] !== 'function') throw new Error('Storage adapter incomplete');
  }
  if (production && store.durable !== true) throw new Error('Durable storage required');
  return store;
}
// テスト専用。Cloud Run の再起動/複数インスタンスでの永続性は担保しない。
export function memoryStore() {
  const rows = new Map(), claims = new Set();
  const owned = (id, owner) => rows.get(id)?.owner === owner ? rows.get(id) : null;
  return {
    durable: false,
    get: async (id, owner) => structuredClone(owned(id, owner)),
    put: async sub => { const old = owned(sub.id, sub.owner); rows.set(sub.id, structuredClone({ ...sub, sent: old?.sent || sub.sent || claims.has(JSON.stringify([sub.owner, sub.probe_id])) })); },
    remove: async (id, owner) => { if (owned(id, owner)) rows.delete(id); },
    byProbe: async (owner, probe) => structuredClone([...rows.values()].filter(x => x.owner === owner && x.probe_id === probe).sort((a,b) => b.expires-a.expires)[0] ?? null),
    claim: async (id, owner) => {
      const sub = owned(id, owner);
      if (!sub || sub.expires <= Date.now()) return false;
      const key = JSON.stringify([owner, sub.probe_id]);
      if (claims.has(key)) return false;
      claims.add(key); sub.sent = true; return true;
    },
    receipt: async (id, owner, receipt) => { const sub = owned(id, owner); if (sub) sub.receipt = structuredClone(receipt); },
    status: async owner => [...rows.values()].filter(x => x.owner === owner).map(({probe_id, expires, sent, receipt}) => ({probe_id, expires, sent, receipt})),
  };
}
