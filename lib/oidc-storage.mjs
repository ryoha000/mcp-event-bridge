// プロバイダのモデルは1つの上限付きCAS集約を共有する。オブジェクトパスに
// 平文の識別子は置かない。アトミックな消費/失効を複数オブジェクトに分割しない。
import {createHash} from 'node:crypto';
import {errors} from 'oidc-provider';
export function createOidcAdapter(backend, {now=()=>Math.floor(Date.now()/1000),maxRecords=512,compactRefresh=false,maxSpent=4096,stateKey='oauth-state:v1'}={}) {
  const key=stateKey;
  function clean(state){state ||= {records:{},revoked:{}};for(const [id,r] of Object.entries(state.records))if(r.expires!==null&&r.expires<=now())delete state.records[id];if(compactRefresh){state.spent ||= {};for(const [grant,family]of Object.entries(state.spent)){for(const [id,row]of Object.entries(family.tokens))if(row[1]<=now())delete family.tokens[id];if(!Object.keys(family.tokens).length)delete state.spent[grant];}for(const [id,expiry]of Object.entries(state.revoked))if(typeof expiry==='number'&&expiry<=now())delete state.revoked[id];}return state;}
  const fingerprint=id=>createHash('sha256').update(id).digest('hex');
  const recordKey=(model,id)=>JSON.stringify([model,id]);
  return class Adapter {
    constructor(model){this.model=model;}
    async upsert(id,payload,expiresIn){
      return backend.update(key,current=>{const state=clean(current),k=recordKey(this.model,id);if(!state.records[k]&&Object.keys(state.records).length>=maxRecords)throw Error('OAuth capacity reached');
        const modelLimit={Client:16,Interaction:64,Session:64}[this.model];if(!state.records[k]&&modelLimit&&Object.keys(state.records).filter(key=>JSON.parse(key)[0]===this.model).length>=modelLimit)throw Error('OAuth model capacity reached');
        const previous=state.records[k]?.payload;if(previous?.consumed)payload={...payload,consumed:previous.consumed};
        if((payload.grantId&&state.revoked[payload.grantId])||(compactRefresh&&this.model==='Grant'&&state.revoked[id]))throw new errors.InvalidGrant('Grant revoked');
        state.records[k]={payload:structuredClone(payload),expires:Number.isFinite(expiresIn)?now()+expiresIn:null};return {value:state};});
    }
    async find(id){const state=await backend.read(key);if(compactRefresh&&this.model==='Grant'&&state?.revoked?.[id])return undefined;const row=state?.records?.[recordKey(this.model,id)];if(row&&(row.expires===null||row.expires>now())&&!(row.payload.grantId&&state.revoked[row.payload.grantId]))return structuredClone(row.payload);if(compactRefresh&&this.model==='RefreshToken'){for(const [grantId,family]of Object.entries(state?.spent??{})){const token=family.tokens[fingerprint(id)];if(token&&token[1]>now()&&!state.revoked[grantId])return {kind:'RefreshToken',jti:id,grantId,clientId:family.clientId,accountId:family.accountId,scope:family.scope,iat:token[0],exp:token[1],consumed:token[2]};}}return undefined;}
    async findByUid(uid){return this.findBy('uid',uid);}
    async findByUserCode(code){return this.findBy('userCode',code);}
    async findBy(field,value){const state=await backend.read(key);for(const [k,row] of Object.entries(state?.records??{})){if(JSON.parse(k)[0]===this.model&&row.payload[field]===value&&(row.expires===null||row.expires>now())&&!(row.payload.grantId&&state.revoked[row.payload.grantId]))return structuredClone(row.payload);}return undefined;}
    async destroy(id){return backend.update(key,current=>{const state=clean(current);delete state.records[recordKey(this.model,id)];if(compactRefresh&&this.model==='RefreshToken')for(const family of Object.values(state.spent))delete family.tokens[fingerprint(id)];return {value:state};});}
    async consume(id){
      const result=await backend.update(key,current=>{
        const state=clean(current),k=recordKey(this.model,id),row=state.records[k];
        if(compactRefresh&&this.model==='RefreshToken'){
          const spent=Object.entries(state.spent).find(([,f])=>f.tokens[fingerprint(id)]);
          const replayedGrant=spent?.[0]??(row?.payload.consumed?row.payload.grantId:null);
          if(replayedGrant){
            // 例外送出前に失効をコミットする。CASミューテータの例外はロールバック
            // するため。競合する消費者がいても、勝った側のファミリーを生かしたままにはできない。
            state.revoked[replayedGrant]=now()+90*86400;
            for(const [rk,r]of Object.entries(state.records))if(r.payload.grantId===replayedGrant||rk===recordKey('Grant',replayedGrant))delete state.records[rk];
            delete state.spent[replayedGrant];
            return {value:state,result:{replayed:true}};
          }
        }
        if(!row||row.payload.consumed||(row.payload.grantId&&state.revoked[row.payload.grantId]))throw new errors.InvalidGrant('Token unavailable');
        row.payload.consumed=now();
        if(compactRefresh&&this.model==='RefreshToken'&&row.payload.grantId){
          if(Object.values(state.spent).reduce((n,f)=>n+Object.keys(f.tokens).length,0)>=maxSpent)throw Error('Spent token capacity reached');
          const p=row.payload,family=state.spent[p.grantId] ||= {clientId:p.clientId,accountId:p.accountId,scope:p.scope,tokens:{}};
          if(family.clientId!==p.clientId||family.accountId!==p.accountId||family.scope!==p.scope)throw Error('Refresh family mismatch');
          family.tokens[fingerprint(id)]=[p.iat,row.expires,now()];delete state.records[k];
        }
        return {value:state};
      });
      if(result?.replayed)throw new errors.InvalidGrant('Refresh token already used');
    }
    async revokeByGrantId(id){return backend.update(key,current=>{const state=clean(current);if(Object.keys(state.revoked).length>=maxRecords&&!state.revoked[id])throw Error('Revocation capacity reached');state.revoked[id]=compactRefresh?Math.max(now()+90*86400,...Object.values(state.records).filter(r=>r.payload.grantId===id).map(r=>r.expires??0)):true;for(const [k,row]of Object.entries(state.records))if(row.payload.grantId===id)delete state.records[k];if(compactRefresh)delete state.spent[id];return {value:state};});}
  };
}
