// 永続的なリフレッシュ権限は別途オペレーター承認が必要。このモジュールは
// 認証情報をプロビジョニングせず、サーバーの1時間の許可TTLも延長しない。
export function createBridgeCredential({origin,readCredential,writeCredential,fetchImpl=fetch,now=Date.now}){
  const u=new URL(origin);if(u.protocol!=='https:'||u.origin!==origin)throw Error('Credential issuer refused');
  let cached=null,inflight=null;
  async function obtain(){
    cached??=JSON.parse(await readCredential());
    if(cached.origin!==origin||typeof cached.accessToken!=='string'||typeof cached.clientId!=='string'||!Number.isSafeInteger(cached.expiresAt))throw Error('Approved bridge credential required');
    if(cached.expiresAt>now()+30000)return cached.accessToken;
    if(cached.refreshPending===true||typeof cached.refreshToken!=='string')throw Error('Receiver reauthorization required');
    // ネットワークI/Oの前に印を付ける。消費後のクラッシュ/タイムアウトで
    // 旧ローテーショントークンが再生されファミリーが失効しないようにするため。
    // 復旧には同意が必要。
    cached={...cached,refreshPending:true};await writeCredential(JSON.stringify(cached));
    const r=await fetchImpl(origin+'/token',{method:'POST',redirect:'error',signal:AbortSignal.timeout(8000),headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',refresh_token:cached.refreshToken,client_id:cached.clientId,resource:origin+'/mcp'})});
    let size=0;const parts=[];for await(const c of r.body??[]){size+=c.length;if(size>32768)throw Error('Credential response refused');parts.push(Buffer.from(c));}
    if(!r.ok)throw Error('Receiver authorization expired');const value=JSON.parse(Buffer.concat(parts).toString());
    if(typeof value.access_token!=='string'||!Number.isSafeInteger(value.expires_in)||value.expires_in<1||value.expires_in>3600)throw Error('Credential response refused');
    if(typeof value.refresh_token!=='string'||!value.refresh_token)throw Error('Rotating credential response refused');
    const next={...cached,refreshPending:false,accessToken:value.access_token,refreshToken:value.refresh_token,expiresAt:now()+value.expires_in*1000};
    await writeCredential(JSON.stringify(next));cached=next;return cached.accessToken;
  }
  return ()=>{if(!inflight)inflight=obtain().finally(()=>{inflight=null;});return inflight;};
}
