import http from 'node:http';
import path from 'node:path';
import { Engine } from '../src/engine.mjs';
import { ScriptedProvider } from '../src/providers.mjs';
import { hash } from '../src/store.mjs';

// Ground truth stays in the fixture controller/evaluator. Neither worker input nor
// configuration contains the fault label. This is a synthetic, deterministic worker,
// not a blinded live-model trial. Vary data, route order, transport and outcome type.
export function makeCases(seed) {
  if(!Number.isSafeInteger(seed) || seed<0 || seed>0xffffffff)throw Error('Seed must be uint32');
  let state=seed;
  const random=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/4294967296;};
  const cases=['clean','wrong-total','wrong-unit','unavailable','unstable','malformed','clean','wrong-total'].map((kind,n)=>{
    const amounts=Array.from({length:2+Math.floor(random()*4)},()=>1+Math.floor(random()*30));
    const account=`account-${Math.floor(random()*10000)}`;
    return {id:`case-${n}`,kind,amounts,expected:amounts.reduce((a,b)=>a+b,0),account,unit:random()>0.5?'items':'packs',delayMs:Math.floor(random()*12)};
  });
  for(let n=cases.length-1;n>0;n--){const k=Math.floor(random()*(n+1));[cases[n],cases[k]]=[cases[k],cases[n]];}
  return cases;
}

export function confusion(rows) {
  let truePositives=0,falsePositives=0,trueNegatives=0,falseNegatives=0,unresolved=0;
  for(const row of rows) {
    const defect=row.truth==='wrong-total',flagged=row.findings>0;
    if(defect){if(flagged)truePositives++;else falseNegatives++;}
    else if(flagged)falsePositives++;else trueNegatives++;
    if(['blocked-prerequisite','inconclusive'].includes(row.verdict))unresolved++;
  }
  const negatives=trueNegatives+falsePositives,positives=truePositives+falseNegatives;
  return {truePositives,falsePositives,trueNegatives,falseNegatives,unresolved,negativeCases:negatives,positiveCases:positives,falsePositiveRate:negatives?falsePositives/negatives:null,recall:positives?truePositives/positives:null};
}

export async function seededEvaluation(directory,seeds=[17,2026,8675309]) {
  const rows=[];
  for(const seed of seeds) {
    const cases=makeCases(seed),byId=new Map(cases.map(c=>[c.id,c])),reads=new Map();
    const server=http.createServer(async(req,res)=>{
      res.setHeader('cache-control','no-store');
      if(req.url==='/'){res.setHeader('content-type','text/html');return res.end('<!doctype html><title>Synthetic evaluation</title><p>Private local fixture</p>');}
      if(req.url==='/favicon.ico'){res.writeHead(204);return res.end();}
      const item=byId.get(req.url.split('/')[2]);if(!item){res.writeHead(404);return res.end();}
      await new Promise(resolve=>setTimeout(resolve,item.delayMs));
      const n=(reads.get(item.id)||0)+1;reads.set(item.id,n);
      if(item.kind==='unavailable'){res.writeHead(503);return res.end('{}');}
      if(item.kind==='malformed')return res.end('{synthetic invalid JSON');
      res.setHeader('content-type','application/json');
      res.end(JSON.stringify({account:item.account,unit:item.kind==='wrong-unit'?'foreign-unit':item.unit,total:item.expected+(item.kind==='wrong-total'?1:item.kind==='unstable'?(n%2):0)}));
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const origin=`http://127.0.0.1:${server.address().port}`;
    try {
      for(const item of cases) {
        const config={id:item.id,origin,entry:'/',reads:[{path:'/',methods:['GET']},{path:'/favicon.ico',methods:['GET']},{path:`/state/${item.id}`,methods:['GET']}],budget:{maxCalls:1,maxCostMicros:0,reserveFraction:0.15,quotaMaxAgeMs:30000},scenarios:[{id:'inspect',goal:'Inspect the supplied local observation; do not claim a business result.',steps:[],readChecks:[{id:'conservation',path:`/state/${item.id}`,scope:{account:item.account,unit:item.unit},scopeChecks:[{path:'account',op:'equals',value:item.account},{path:'unit',op:'equals',value:item.unit}],checks:[{path:'total',op:'equals',value:item.expected}]}]}]};
        let workerInput;
        const worker=new ScriptedProvider(input=>{workerInput=JSON.stringify(input);return {action:'finish'};});
        const engine=new Engine(config,path.join(directory,`seed-${seed}`,item.id),worker);
        try {
          await engine.start();await engine.explore(config.scenarios[0]);await engine.verifyChecks(config.scenarios[0]);
          const report=engine.report();
          if(workerInput.includes(JSON.stringify(item.kind)))throw Error('Fixture ground truth leaked to worker');
          rows.push({seed,id:item.id,caseHash:hash(item),truth:item.kind,verdict:report.coverage[0].verdict,findings:report.hypotheses.filter(h=>h.kind==='deterministic-failure').length,readCount:reads.get(item.id),llmCalls:0,syntheticWorkerCalls:report.calls,evidence:report.coverage[0].evidence,report:path.relative(directory,path.join(engine.store.directory,'report.json'))});
        } finally {await engine.close();}
      }
    } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  }
  return {seeds,rows,metrics:confusion(rows),limits:['Local synthetic cases and scripted worker only; no model recall, autonomy, cognitive injection resistance or real supplier cost measured.','Truth labels hidden from the worker; harness/evaluator authors know the generator.','Unavailable, malformed, scope-mismatched and unstable cases are negative controls for product findings, not proof of absence of a hidden defect.']};
}
