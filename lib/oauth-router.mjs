const pathFor=req=>new URL(req.url,'https://routing.invalid').pathname;

function matchesSource(name,path){
 return path===`/mcp/${name}`||
   path.startsWith(`/${name}/`)||
   path===`/.well-known/oauth-protected-resource/mcp/${name}`||
   path===`/.well-known/oauth-authorization-server/${name}`||
   path===`/.well-known/openid-configuration/${name}`;
}

export function routeSourceOAuth(fallback,consumers={}){
 const entries=Object.entries(consumers).filter(([,auth])=>auth);
 if(!fallback&&entries.length===0)throw Error('OAuth router requires at least one adapter');
 const selected=req=>{
  const path=pathFor(req);
  for(const [name,auth] of entries)if(matchesSource(name,path))return auth;
  return fallback??entries[0][1];
 };
 return {
  productionReady:true,
  consumerPaths:entries.map(([name])=>`/mcp/${name}`),
  discordConsumerEnabled:entries.some(([name])=>name==='discord'),
  challenge:(fallback??entries[0][1]).challenge,
  challengeForRequest:req=>selected(req).challenge,
  authenticate:req=>selected(req).authenticate(req),
  handleHttp:(req,res)=>selected(req).handleHttp(req,res)
 };
}

export function routeConsumerOAuth(main,consumer){
 return routeSourceOAuth(main,{discord:consumer});
}
