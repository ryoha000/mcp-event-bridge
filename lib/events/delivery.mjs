import { signedPost } from '../probe.mjs';
import { Webhook } from 'standardwebhooks';

// 少なくとも1回のコールバック配送。リトライ間で eventId/webhook-id は安定。
// 受信側プラットフォームはそのIDで重複排除する必要がある。
// 受領確認はエージェント起動を意味しない。
export async function deliverNext({ store, owner, transport, authorizeSubscription,onTiming=()=>{},callbackData }) {
  if(typeof authorizeSubscription!=='function')throw Error('Subscription authorization required');
  const claim = await store.claimDelivery(owner);
  if (!claim) return { attempted: false };
  onTiming('callback_claim_committed',{eventId:claim.eventId});
  let status = null;
  try {
    if(!await authorizeSubscription(owner,claim.subscription)) {
      await store.unsubscribe(owner,claim.subscription.id,claim.subscription.clientId);
      return {attempted:false,eventId:claim.eventId,revoked:true};
    }
    const e = claim.event;
    const rotatingTransport=(url,request)=>{
      if(claim.subscription.oldSecret){const id=request.headers['webhook-id'];const at=new Date(Number(request.headers['webhook-timestamp'])*1000);request.headers['webhook-signature']+=' '+new Webhook(claim.subscription.oldSecret).sign(id,at,request.body);}
      return transport(url,request);
    };
    const began=performance.now();onTiming('callback_post_started',{eventId:e.eventId});
    const data=callbackData?callbackData(e):{event_id:e.eventId,source:e.source,guild_id:e.origin.tenantId};
    const response = await signedPost(claim.subscription, { eventId: e.eventId, name: e.name, timestamp: e.timestamp, data, cursor: null }, rotatingTransport);
    status = response.status;
    onTiming('callback_post_completed',{eventId:e.eventId,httpStatus:status,durationMs:performance.now()-began});
  } catch { /* トランスポートエラー、コールバックURL、認証情報を永続化しない。 */ }
  await store.settleDelivery(owner, claim, status);
  onTiming('callback_receipt_committed',{eventId:claim.eventId,httpStatus:status});
  return { attempted: true, eventId: claim.eventId, acknowledged: status !== null && status >= 200 && status < 300 };
}
