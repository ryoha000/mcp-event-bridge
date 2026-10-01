// Fixed Discord API destination, bounded response, no redirects or hidden retries.
export function createDiscordRest({ token, fetchImpl = fetch,onTiming=()=>{} } = {}) {
  if (typeof token !== 'string' || !token.trim() || /\s/.test(token)) throw Error('Discord credential required');
  const timing=(phase,details)=>{try{onTiming(phase,details);}catch{}};
  return async (channelId, body,metadata={}) => {
    if (!/^[0-9]{17,20}$/.test(channelId)) throw Error('Discord channel refused');
    const eventId=metadata.eventId,began=performance.now();timing('discord_post_started',{eventId});
    const res = await fetchImpl('https://discord.com/api/v10/channels/'+channelId+'/messages', {
      method:'POST',redirect:'error',signal:AbortSignal.timeout(8000),
      headers:{authorization:'Bot '+token,'content-type':'application/json'},body:JSON.stringify(body),
    });
    timing('discord_post_headers',{eventId,httpStatus:res.status,durationMs:performance.now()-began});
    let size = 0; const chunks = [];
    for await (const chunk of res.body ?? []) { size += chunk.length; if (size > 65536) { await res.body?.cancel?.().catch(()=>{}); throw Error('Discord response refused'); } chunks.push(Buffer.from(chunk)); }
    if (!res.ok){timing('discord_post_completed',{eventId,httpStatus:res.status,durationMs:performance.now()-began,success:false});return {ok:res.status>=500?null:false,status:res.status};}
    const data = JSON.parse(Buffer.concat(chunks).toString());
    if (!/^[0-9]{17,20}$/.test(data.id ?? '') || data.channel_id !== channelId) throw Error('Discord response refused');
    timing('discord_post_completed',{eventId,httpStatus:res.status,durationMs:performance.now()-began,success:true});return {ok:true,status:res.status,messageId:data.id};
  };
}
