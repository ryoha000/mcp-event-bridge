export function createOwnerVerifier({google,config,backend}) {
 return async (credential,nonce)=>{
  if(typeof credential!=='string'||credential.length>16384)throw Error('Invalid login');
  const ticket=await google.verifyIdToken({idToken:credential,audience:config.googleClientId});const p=ticket.getPayload();
  if(!p||!['accounts.google.com','https://accounts.google.com'].includes(p.iss)||p.aud!==config.googleClientId||p.nonce!==nonce||p.email_verified!==true||typeof p.email!=='string'||p.email.toLowerCase()!==config.ownerEmail||typeof p.sub!=='string'||!p.sub)throw Error('Owner login required');
  // Google is authoritative for Gmail and Google Workspace verified addresses.
  if(!p.email.toLowerCase().endsWith('@gmail.com')&&!p.hd)throw Error('Google-authoritative email required');
  return backend.update('google-owner:v1',old=>{if(old&&old.sub!==p.sub)throw Error('Owner subject mismatch');return {value:{sub:p.sub},result:'google:'+p.sub};});
 };
}
