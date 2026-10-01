import {readdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
async function walk(dir) {
  for(const entry of await readdir(dir,{withFileTypes:true})) {
    const path=dir+'/'+entry.name;
    if(entry.isDirectory())await walk(path);
    else if(entry.name.endsWith('.mjs'))check(path);
  }
}
function check(path) { const r=spawnSync(process.execPath,['--check',path],{stdio:'inherit'});if(r.status!==0)process.exit(r.status??1); }
await walk('lib');await walk('scripts');check('server.mjs');check('production.mjs');check('consolidated-runtime.mjs');check('consolidated-server.mjs');check('gce-server.mjs');
