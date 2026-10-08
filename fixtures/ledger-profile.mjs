import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { Store } from '../src/store.mjs';
import { shopConfig } from './sites.mjs';
const count=Number(process.argv[2] ?? 60);
if(!Number.isSafeInteger(count)||count<1||count>600)throw Error('Synthetic profile count must be 1..600');
const directory=path.resolve('artifacts',`ledger-profile-${Date.now()}`),config=shopConfig('http://127.0.0.1:1234'),store=new Store(directory,config);
const started=performance.now();let peakHeap=process.memoryUsage().heapUsed,error=null;
try {
  for(let n=0;n<count;n++) {
    store.state.observations.push({id:String(n),text:'x'.repeat(10000)});store.commit('synthetic-profile');
    peakHeap=Math.max(peakHeap,process.memoryUsage().heapUsed);
  }
}catch(e){error=e.message;}
const summary={node:process.version,platform:process.platform,requestedObservations:count,appended:store.state.observations.length,elapsedMs:Math.round(performance.now()-started),ledgerBytes:fs.statSync(store.file).size,eventCacheJsonBytes:Buffer.byteLength(JSON.stringify(store.events)),sampledPeakHeapBytes:peakHeap,error,limits:'Direct Store instrumentation with 10k-character synthetic records. No browser, screenshots or LLM; sampled heap depends on GC, not an RSS bound.'};
store.close();fs.writeFileSync(path.join(directory,'PROFILE.json'),JSON.stringify(summary,null,2));console.log(JSON.stringify({directory,...summary},null,2));
