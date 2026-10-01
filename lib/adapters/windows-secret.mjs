import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
// Decrypt only the user-approved DPAPI input file. Captured pipe stays in memory;
// no token in arguments, shell expansion, diagnostics, or output logs.
export function readWindowsSecret(path){
  if(process.platform!=='win32'||typeof path!=='string'||!path)throw Error('Windows secret path required');
  const script=fileURLToPath(new URL('../../scripts/read-windows-secret.ps1',import.meta.url));
  const r=spawnSync('pwsh.exe',['-NoProfile','-NonInteractive','-File',script,'-Path',path],{encoding:'utf8',windowsHide:true,timeout:5000,maxBuffer:16384});
  if(r.status!==0||!r.stdout?.trim())throw Error('Approved local secret unavailable');
  return r.stdout.trim();
}
export function writeWindowsSecret(path,value){
  if(process.platform!=='win32'||typeof path!=='string'||!path||typeof value!=='string'||!value)throw Error('Windows secret path required');
  const script=fileURLToPath(new URL('../../scripts/write-windows-secret.ps1',import.meta.url));
  const r=spawnSync('pwsh.exe',['-NoProfile','-NonInteractive','-File',script,'-Path',path],{input:value,encoding:'utf8',windowsHide:true,timeout:5000,maxBuffer:16384});
  if(r.status!==0)throw Error('Encrypted local credential write failed');
}
