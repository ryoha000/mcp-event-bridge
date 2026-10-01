import {Compute} from 'google-auth-library';
// Metadata identity only: no ADC file fallback or service-account key.
export function createWorkloadCredential({origin,fetchIdentity,now=Date.now}){
 const u=new URL(origin);if(u.protocol!=='https:'||u.origin!==origin)throw Error('Workload audience refused');
 const compute=fetchIdentity?null:new Compute({transporterOptions:{timeout:5000,retry:false}});
 const fetchToken=fetchIdentity??(()=>compute.fetchIdToken(origin));let cached,inflight;
 async function obtain(){
  if(cached&&cached.until>now())return cached.token;
  const token=await fetchToken();if(typeof token!=='string'||token.length>8192||!/^[-\w]+\.[-\w]+\.[-\w]+$/.test(token))throw Error('Workload identity refused');
  const p=JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString());if(p.aud!==origin||!Number.isSafeInteger(p.exp)||p.exp*1000<=now()+30000)throw Error('Workload identity expired');
  cached={token,until:Math.min(now()+300000,p.exp*1000-30000)};return token;
 }
 return ()=>{if(!inflight)inflight=obtain().finally(()=>{inflight=null;});return inflight;};
}
