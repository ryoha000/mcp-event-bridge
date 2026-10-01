import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { createTransport, validateUrl, publicAddress, pinnedOptions } from '../lib/transport.mjs';
const options = {method:'POST',headers:{'content-type':'application/json'},body:'{}'};
function fakeSend({status=200, body='{}', complete=true, headers={}, error=false, hang=false}={}) {
  const calls=[];
  const send=(opts, callback)=> {
    const req=new EventEmitter(); req.destroy=()=>{req.destroyed=true;};
    req.end=data=>{calls.push({opts,data,req});queueMicrotask(()=>{
      if(error){req.emit('error',new Error('Secret details'));return;}
      if(hang)return;
      const res=Readable.from([Buffer.from(body)]);res.statusCode=status;res.headers=headers;res.complete=complete; callback(res);
    });}; return req;
  }; return {send,calls};
}
test('URL/アドレスポリシーは認証情報・プライベート・メタデータ・mapped・特殊レンジを拒否する',()=>{
  for(const url of ['http://example.com','https://user:pass@example.com','https://127.0.0.1','https://[::1]','https://localhost','https://example.com:8443','https://example.com/#x','https://example.com./'])assert.throws(()=>validateUrl(url));
  for(const ip of ['127.0.0.1','10.1.2.3','169.254.169.254','100.64.0.1','192.168.1.1','0.0.0.0','224.0.0.1','203.0.113.1','198.18.0.1','::ffff:8.8.8.8','::1'])assert.equal(publicAddress(ip),false,ip);
  assert.equal(publicAddress('1.1.1.1'),true);
});
test('公開DNSスナップショットを固定。元のホスト名・SNI・証明書検証を維持',async()=>{
  let dns=0;const f=fakeSend();const transport=createTransport({resolve:async host=>{assert.equal(host,'receiver.example.com');dns++;return ['1.1.1.1'];},send:f.send});
  assert.deepEqual(await (await transport('https://receiver.example.com/callback?q=1',options)).json(),{});
  const o=f.calls[0].opts;assert.equal(dns,1);assert.equal(o.hostname,'receiver.example.com');assert.equal(o.servername,o.hostname);assert.equal(o.rejectUnauthorized,true);assert.equal(o.agent,false);assert.equal(o.path,'/callback?q=1');assert.equal(o.headers.host,o.hostname);
  o.lookup(o.hostname,{},(err,ip,family)=>{assert.equal(err,null);assert.equal(ip,'1.1.1.1');assert.equal(family,4);});
  o.lookup(o.hostname,{all:true},(err,ips)=>assert.deepEqual(ips,[{address:'1.1.1.1',family:4}]));
  assert.equal(o.checkServerIdentity('ignored',{subjectaltname:'DNS:receiver.example.com'}),undefined);
  assert.equal(o.checkServerIdentity('attacker.example',{subjectaltname:'DNS:attacker.example'}).code,'ERR_TLS_CERT_ALTNAME_INVALID');
});
test('プライベート混在・空・不正なDNS応答ではリクエストしない',async()=>{
  for(const answers of [[],['1.1.1.1','127.0.0.1'],['alias.example.com.'],['2606:4700:4700::1111'],[null]]){
    const f=fakeSend();await assert.rejects(createTransport({resolve:async()=>answers,send:f.send})('https://example.com',options));assert.equal(f.calls.length,0);
  }
});
test('リダイレクトは後続リクエストなしに失敗する',async()=>{
  const f=fakeSend({status:302,headers:{location:'http://169.254.169.254'}});
  await assert.rejects(createTransport({resolve:async()=>['1.1.1.1'],send:f.send})('https://example.com',options));assert.equal(f.calls.length,1);
});
test('上限付きネイティブIncomingMessage応答・不完全フレーミング・エラーはフェイルクローズ',async()=>{
  for(const config of [{body:'x'.repeat(33)},{complete:false},{headers:{'content-encoding':'gzip'}},{error:true}]){
    const f=fakeSend(config);await assert.rejects(createTransport({resolve:async()=>['1.1.1.1'],send:f.send,maxBytes:32})('https://example.com',options));
  }
});
test('ネイティブ応答は204受領を受理し、4xxは拒否',async()=>{
  for(const status of [204,205,400,500]) { const f=fakeSend({status,body:''});const r=await createTransport({resolve:async()=>['1.1.1.1'],send:f.send})('https://example.com',options);assert.equal(r.ok,status<300); }
});
test('DNSと操作全体のデッドラインは上限付き',async()=>{
  await assert.rejects(createTransport({resolve:()=>new Promise(()=>{}),timeoutMs:10})('https://example.com',options));
  const f=fakeSend({hang:true});await assert.rejects(createTransport({resolve:async()=>['1.1.1.1'],send:f.send,timeoutMs:10})('https://example.com',options));assert.equal(f.calls[0].req.destroyed,true);
});
