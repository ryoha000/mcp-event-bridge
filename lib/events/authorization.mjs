// 配送ごとに、元のオーナー・有効なクライアント・許可を再検査する。
// OAuth集約は失効トゥームストーンを含めて1回のスナップショットで読む。
export function createSubscriptionAuthorizer({backend,resource,allowedResources=[resource],stateKeyForResource=()=> 'oauth-state:v1',now=()=>Math.floor(Date.now()/1000)}) {
  if (!backend || typeof backend.read!=='function' || !resource) throw Error('Authorization configuration required');
  return async (owner,sub,requiredScopes) => {
    const pinned=await backend.read('google-owner:v1');
    if(!pinned || owner!=='google:'+pinned.sub)return false;
    const target=sub.resource??resource;if(!allowedResources.includes(target))return false;
    const state=await backend.read(stateKeyForResource(target));
    const grant=state?.records?.[JSON.stringify(['Grant',sub.grantId])];
    const client=state?.records?.[JSON.stringify(['Client',sub.clientId])];
    const at=now();
    if(!grant || !client || state.revoked?.[sub.grantId] || (grant.expires!==null&&grant.expires<=at) ||
      (client.expires!==null&&client.expires<=at) || grant.payload.exp<=at ||
      grant.payload.accountId!==owner || grant.payload.clientId!==sub.clientId)return false;
    const scope=sub.name.split('.')[0]+':read';
    const granted=new Set(String(grant.payload.resources?.[target]??'').split(' '));
    const rejected=new Set(String(grant.payload.rejected?.resources?.[target]??'').split(' '));
    return (requiredScopes??[scope]).every(s=>granted.has(s)&&!rejected.has(s));
  };
}
