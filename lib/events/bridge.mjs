import {validateEnvelope} from './envelope.mjs';

// レシーバーのアップリンクはアダプタで正規化済みのイベントのみを運ぶ。
// OAuthトークン取得は明示的に注入する依存であり、DiscordトークンやMCP
// コンシューマ認証情報とは分離する。環境からの暗黙的な認証情報探索や
// トークン生成は行わない。
export function createBridgeTransport({origin,getAccessToken,fetchImpl=fetch}) {
  const base=new URL(origin);
  if(base.protocol!=='https:'||base.origin!==origin||base.username||base.password||typeof getAccessToken!=='function')throw Error('Bridge configuration refused');
  return async event=>{
    validateEnvelope(event);
    const token=await getAccessToken();if(typeof token!=='string'||!token||/\s/.test(token))throw Error('Bridge credential required');
    const r=await fetchImpl(origin+'/ingest/discord',{method:'POST',redirect:'error',signal:AbortSignal.timeout(8000),headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(event)});
    let size=0;const chunks=[];for await(const c of r.body??[]){size+=c.length;if(size>16384)throw Error('Bridge response refused');chunks.push(Buffer.from(c));}
    if(r.status>=200&&r.status<300){const body=JSON.parse(Buffer.concat(chunks).toString());if(body.eventId!==event.eventId||typeof body.duplicate!=='boolean')throw Error('Bridge acknowledgement refused');}
    return {status:r.status};
  };
}
// リモートイベント配送と同じリース付き永続アウトボックスを使う。コミット済みの
// クラウド取り込みは安全にリトライできる。重複排除+ファンアウトは
// クラウド側の1回のCAS書き込みで行われる。
export async function forwardNext({store,owner,forwardEnvelope}) {
  const claim=await store.claimDelivery(owner);if(!claim)return {attempted:false};
  let status=null;try{status=(await forwardEnvelope(claim.event)).status;}catch{/* 秘匿 */}
  await store.settleDelivery(owner,claim,status);
  return {attempted:true,acknowledged:status!==null&&status>=200&&status<300,eventId:claim.eventId};
}
export function createReceiverBridgeClient({origin,getAccessToken,fetchImpl=fetch}){
  const u=new URL(origin);if(u.protocol!=='https:'||u.origin!==origin||u.username||u.password)throw Error('Bridge configuration refused');
  return async(action,body={})=>{
    if(!['claim','receipt','drain'].includes(action))throw Error('Bridge action refused');
    const token=await getAccessToken();if(typeof token!=='string'||!token||/\s/.test(token))throw Error('Bridge credential required');
    const r=await fetchImpl(origin+'/receiver/discord/'+action,{method:'POST',redirect:'error',signal:AbortSignal.timeout(12000),headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body)});
    let size=0;const chunks=[];for await(const c of r.body??[]){size+=c.length;if(size>32768)throw Error('Bridge response refused');chunks.push(Buffer.from(c));}
    if(!r.ok)throw Error('Bridge access refused');return JSON.parse(Buffer.concat(chunks).toString());
  };
}
