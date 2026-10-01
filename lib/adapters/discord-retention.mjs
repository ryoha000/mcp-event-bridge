// Discord message IDs encode immutable creation time; mutable envelope timestamps
// cannot defeat replay expiry. Other adapters must supply their own identity clock.
export const discordRetention = Object.freeze({
  replayMs:7*86400000, replyMs:86400000, maxRetired:4096,
  identityTime:event=>{
    if(event.source!=='discord'||!/^[0-9]{17,20}$/.test(event.origin.messageId))throw Error('Retention identity refused');
    return Number(BigInt(event.origin.messageId)>>22n)+1420070400000;
  },
});
