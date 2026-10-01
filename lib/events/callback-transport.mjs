import {resolve4} from 'node:dns/promises';
import {request} from 'node:https';
import {createTransport} from '../transport.mjs';
import {eventDiagnostic} from './diagnostics.mjs';

// 既存のピン留め済み・公開限定HTTPSトランスポートを再利用する。ラッパーは
// フェーズのみ観測し、DNSレコード、宛先、ソケットアドレス、オプションは
// 診断に入れない。このトランスポートはDiscord検証にのみ使う。
export function createDiscordCallbackTransport({resolve=resolve4,send=request,diagnosticSink=console.info,...limits}={}){
  const trace=(phase,details={})=>eventDiagnostic('callback','events/subscribe',phase,details,diagnosticSink);
  return createTransport({...limits,
    resolve:async hostname=>{
      trace('callback_dns_start');
      try{const addresses=await resolve(hostname);trace('callback_dns_complete');return addresses;}
      catch(error){trace('callback_dns_failed',{error});throw error;}
    },
    send:(options,listener)=>{
      trace('callback_connect_start');
      try{
        const req=send(options,response=>{trace('callback_response',{status:response.statusCode});listener(response);});
        req.once('socket',socket=>socket.once('secureConnect',()=>trace('callback_tls_connected')));
        req.once('error',error=>trace('callback_connection_failed',{error}));
        return req;
      }catch(error){trace('callback_connection_failed',{error});throw error;}
    },
  });
}
