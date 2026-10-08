import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Engine} from '../src/engine.mjs';
import {CliProvider} from '../src/cli-provider.mjs';
import {startShop,shopConfig} from './sites.mjs';
const root=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
const previousReserved=fs.existsSync(path.join(root,'artifacts'))?fs.readdirSync(path.join(root,'artifacts')).filter(name=>name.startsWith('live-cli-')).reduce((sum,name)=>{const file=path.join(root,'artifacts',name,'report.json');if(!fs.existsSync(file))throw Error('Previous live run unresolved; review it before another experiment');return sum+(JSON.parse(fs.readFileSync(file,'utf8')).calls || 0);},0):0;
if(previousReserved>=12)throw Error('Local live experiment authorization exhausted; no new calls');
const kind=process.argv[2] || 'antigravity',model=process.argv[3] || (kind==='codex'?'gpt-6-luna':'gemini-3.8-flash-low');
if(!['antigravity','codex'].includes(kind))throw Error('This live fixture profile only authorizes explicitly chosen Antigravity or Codex.');
const site=await startShop(),config=shopConfig(site.origin,'basic');
const agent=kind==='codex'?'codex-luna':'low-gemini';
config.id='live-cli-readonly';config.scenarios=[{id:'mobile-reader',agent,goal:'Explore the visible mobile interface. Click the visible link Contrôles once, observe the page, then finish with what was actually covered and limits. Do not fill, submit, upload or change any field. Three or fewer decisions should suffice.',persona:{role:'first-time-reader',constraints:'mobile, read-only'},steps:[],assertions:[{id:'mobile-overflow',path:'overflow',op:'equals',value:false}]}];
config.agents={[agent]:{kind,model,billing:{mode:'subscription'},timeoutMs:40000}};config.defaultAgent=agent;config.budget.maxCalls=Math.min(8,12-previousReserved);config.budget.maxDurationMs=120000;
const provider=new CliProvider({...config.agents[agent],id:agent}),directory=path.join(root,'artifacts',`live-cli-${Date.now()}`),engine=new Engine(config,directory,provider,{agentProviders:{[agent]:provider}});
try{
  await engine.start();const started=Date.now(),verdict=await engine.explore(config.scenarios[0],8);await engine.verifyChecks(config.scenarios[0]);
  if(site.state.requests!==0)throw Error('Blocking failure: readonly fixture mutated');
  const summary={worker:kind,model,verdict,durationMs:Date.now()-started,calls:engine.store.state.calls,workerUsage:engine.store.state.workerUsage,serverMutations:site.state.requests,paths:[...new Set(engine.store.state.observations.map(o=>o.path))],costUSD:null,meaning:'Subscription usage only; no measured monetary invoice',directory};
  fs.writeFileSync(path.join(directory,'LIVE-RESULT.json'),JSON.stringify(summary,null,2));console.log(JSON.stringify(summary,null,2));
}finally{fs.writeFileSync(path.join(directory,'SIDE-EFFECTS.json'),JSON.stringify({serverMutations:site.state.requests,meaning:'Independent synthetic server counter, including interrupted runs'},null,2));engine.report();await engine.close();await site.close();}
