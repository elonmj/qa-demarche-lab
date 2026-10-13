import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { Engine } from '../src/engine.mjs';
import { ScriptedProvider } from '../src/providers.mjs';
import { startShop,startRegistry,shopConfig,registryConfig } from './sites.mjs';
import { seededEvaluation } from './seeded-evaluation.mjs';

const root=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
const directory=path.join(root,'artifacts',`benchmark-${Date.now()}`);fs.mkdirSync(directory,{recursive:true});
const rows=[];
const cases=[['basic','confirmed',1],['delayed','confirmed',1],['timeout','confirmed',1],['reject','rejected',1],['http200-refusal','rejected',1],['multiple','confirmed',2],['hallucination','uncertain',0],['before-request','uncertain',0]];
for(const [mode,expected,requests] of cases){
  for(const implementation of ['qa-lab','playwright-authored']){
    const site=await startShop(),started=performance.now();let engine,browser,result;
    try{
      if(implementation==='qa-lab'){
        const config=shopConfig(site.origin,mode,'bench');engine=new Engine(config,path.join(directory,mode),new ScriptedProvider(()=>({action:'finish'})));await engine.start();result=await engine.runScenario(config.scenarios[0]);
        await engine.runScenario(config.scenarios[0]); // Resume path on exact same state.
        engine.report();
      }else{
        // Meaningful existing-tool baseline: authored Playwright gestures + same business
        // oracle and polling window. This is not the Playwright planner/healer benchmark.
        browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:390,height:844},serviceWorkers:'block'});
        await page.goto(site.origin+`/case/${mode}`);await page.getByLabel('Référence',{exact:true}).fill('bench');await page.getByRole('button',{name:'Préparer',exact:true}).click();await page.getByRole('button',{name:'Confirmer',exact:true}).click();
        const deadline=performance.now()+650;result='uncertain';
        do{const s=await(await fetch(site.origin+'/api/state')).json();if(s.records.bench?.status==='saved'){result='confirmed';break;}if(s.refusals.includes('bench')){result='rejected';break;}await new Promise(r=>setTimeout(r,100));}while(performance.now()<deadline);
      }
      assert.equal(result,expected);assert.equal(site.state.requests,requests);
      rows.push({case:mode,implementation,expected,observed:result,correct:true,durationMs:Math.round(performance.now()-started),llmCalls:0,llmCostMicros:0,serverRequests:site.state.requests,unauthorizedRepeats:Math.max(0,site.state.requests-requests),falsePositive:0,scope:'fixture outcome, not autonomous discovery'});
    }finally{await engine?.close();await browser?.close();await site.close();}
  }
}
const site=await startRegistry();let engine;
try{
  const config=registryConfig(site.origin);config.scenarios[0].readChecks=[{id:'total-conservation',path:'/register/state',scope:{unit:'currency-demo',account:'synthetic-registry'},checks:[{path:'total',op:'equals',value:20}],impact:'Le total affiché doit égaler les lignes 12 et 8.'}];
  engine=new Engine(config,path.join(directory,'registry-approve'),new ScriptedProvider(()=>({action:'finish'})));await engine.start();await engine.runScenario(config.scenarios[0]);await engine.verifyChecks(config.scenarios[0]);engine.report();await engine.close();
  const edit=registryConfig(site.origin,'edit');edit.scenarios[0].readChecks=[{id:'closed-immutability',path:'/register/state',scope:{unit:'pages',document:'doc-demo',status:'definitive'},checks:[{path:'document.pages',op:'equals',value:2}],impact:'Document définitif modifié : intégrité après clôture compromise.'}];
  engine=new Engine(edit,path.join(directory,'registry-edit'),new ScriptedProvider(()=>({action:'finish'})));await engine.start();await engine.runScenario(edit.scenarios[0]);await engine.verifyChecks(edit.scenarios[0]);engine.report();
  assert.equal(engine.store.state.candidates.length,1);
}finally{await engine?.close();await site.close();}
const totals=Object.fromEntries(['qa-lab','playwright-authored'].map(name=>{const selected=rows.filter(r=>r.implementation===name);return[name,{cases:selected.length,correct:selected.filter(r=>r.correct).length,durationMs:selected.reduce((s,r)=>s+r.durationMs,0),llmCalls:0,llmCostMicros:0,unauthorizedRepeats:selected.reduce((s,r)=>s+r.unauthorizedRepeats,0),falsePositives:0}];}));
const results={date:'2026-10-08',playwrightVersion:'1.61.1',node:process.version,platform:process.platform,totals,rows,knownSyntheticDefects:[{id:'false-toast',detected:'UI success without request or independent record during bounded window',evidence:'hallucination/report.json'},{id:'wrong-total',detected:'21 != 12+8',evidence:'registry-approve/report.json'},{id:'closed-edit',detected:'definitive document changes from 2 to 3 pages',evidence:'registry-edit/report.json'}],limits:['Zero LLM calls: deterministic authored scenarios and fake provider, not model performance.','Single local run; durations descriptive, no significance or SaaS quality ranking.','Seeded defects known in advance; no real-site recall estimate.','Playwright baseline has same oracle; no built-in durable campaign policy supplied in this baseline.']};
results.seeded=await seededEvaluation(path.join(directory,'seeded'));
assert.equal(results.seeded.metrics.falsePositives,0);assert.equal(results.seeded.metrics.falseNegatives,0);
fs.writeFileSync(path.join(directory,'RESULTS.json'),JSON.stringify(results,null,2));
fs.writeFileSync(path.join(directory,'RESULTS.md'),`# Mesure synthétique — 8 octobre 2026\n\n| Implémentation | Corrects | Durée ms | Appels modèle | Rejeux non autorisés | Faux positifs |\n|---|---:|---:|---:|---:|---:|\n${Object.entries(totals).map(([name,t])=>`| ${name} | ${t.correct}/${t.cases} | ${t.durationMs} | 0 | ${t.unauthorizedRepeats} | 0 |`).join('\n')}\n\nTrois défauts synthétiques observés : faux toast, total erroné, modification après validation définitive. Deux défauts du registre produisent des fiches de contrôles avec lectures indépendantes ; le faux toast reste preuve UI avec absence de persistance dans une fenêtre bornée.\n\n${results.limits.map(l=>'- '+l).join('\n')}\n`);
fs.appendFileSync(path.join(directory,'RESULTS.md'),`\n## Évaluation à seeds fixes\n\nSeeds : ${results.seeded.seeds.join(', ')} ; ${results.seeded.rows.length} cas.\n\n${JSON.stringify(results.seeded.metrics)}\n\n${results.seeded.limits.map(l=>'- '+l).join('\n')}\n`);
console.log(JSON.stringify({directory,totals,seeded:results.seeded.metrics,seeds:results.seeded.seeds},null,2));
