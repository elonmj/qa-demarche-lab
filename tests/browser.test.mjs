import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { unlock } from '../src/store.mjs';
import { Engine } from '../src/engine.mjs';
import { ScriptedProvider } from '../src/providers.mjs';
import { startShop, startRegistry, shopConfig, registryConfig } from '../fixtures/sites.mjs';

const dir=()=>fs.mkdtempSync(path.join(os.tmpdir(),'qa-lab-browser-'));
const provider=()=>new ScriptedProvider(()=>({action:'finish'}));
async function usingShop(mode,fn,configure=()=>{}){const site=await startShop(),config=shopConfig(site.origin,mode,'testkey');configure(config);const engine=new Engine(config,dir(),provider());try{await engine.start();await fn(engine,site,config);}finally{await engine.close();await site.close();}}
for(const [mode,outcome,count] of [['basic','confirmed',1],['delayed','confirmed',1],['timeout','confirmed',1],['reject','rejected',1],['http200-refusal','rejected',1],['multiple','confirmed',2],['hallucination','uncertain',0],['before-request','uncertain',0]]){
  test(`business oracle: ${mode} => ${outcome}, no replay`,()=>usingShop(mode,async(engine,site,config)=>{
    const result=await engine.runScenario(config.scenarios[0]);assert.equal(result,outcome);assert.equal(site.state.requests,count);
    const intent=Object.values(engine.store.state.intents)[0];assert.equal(intent.phase,outcome);
    await engine.runScenario(config.scenarios[0]);assert.equal(site.state.requests,count);
    if(mode==='multiple')assert.equal(site.state.audit.length,1);
    if(mode==='basic')assert.ok(engine.view.elements.some(e=>e.name==='Confirmer')===false,'closed dialog controls excluded');
    if(mode==='basic'){assert.equal(await engine.browser.page.locator('#confirm').isDisabled(),true);assert.equal(await engine.browser.page.locator('#key').inputValue(),'');assert.equal(engine.view.busy,false);}
    if(mode==='before-request')assert.match(engine.view.text,/Refus métier/);
  }));
}
test('local preparation is never a server submission',()=>usingShop('basic',async(engine,site,config)=>{
  for(const step of config.scenarios[0].steps.slice(0,2))await engine.execute(config.scenarios[0],step,await engine.resolveStep(step));
  assert.equal(Object.keys(engine.store.state.intents).length,0);assert.equal(site.state.requests,0);
  await assert.rejects(engine.reconcile(config.scenarios[0]),/No submitted/);
}));
test('resume after injected interruption before readback keeps intent and prevents re-submit',async()=>{
  const site=await startShop(),config=shopConfig(site.origin,'timeout','restart'),directory=dir();let engine=new Engine(config,directory,provider());
  try{
    await engine.start();const scenario=config.scenarios[0];
    for(const step of scenario.steps.slice(0,2))await engine.execute(scenario,step,await engine.resolveStep(step));
    const original=engine.reconcile.bind(engine);engine.reconcile=async()=>{throw Error('simulated interruption');};
    await assert.rejects(engine.execute(scenario,scenario.steps[2],await engine.resolveStep(scenario.steps[2])),/interruption/);
    assert.equal(site.state.requests,1);await engine.close();
    engine=new Engine(config,directory,provider());await engine.start();
    assert.equal(await engine.runScenario(scenario),'confirmed');assert.equal(site.state.requests,1);assert.equal(engine.store.state.holds.length,0);
    assert.equal(typeof original,'function');
  }finally{await engine.close();await site.close();}
});
test('real process kill after mutation: surviving lock reviewed, no replay and budget preserved',async()=>{
  const site=await startShop(),config=shopConfig(site.origin,'timeout','crashkey'),directory=dir();let engine,child;
  try{
    child=fork(fileURLToPath(new URL('./crash-worker.mjs',import.meta.url)),[JSON.stringify(config),directory],{stdio:['ignore','ignore','pipe','ipc']});
    let diagnostic='';child.stderr.on('data',chunk=>diagnostic+=chunk);
    await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Child did not reach commit: '+diagnostic)),15000);child.once('message',()=>{clearTimeout(timer);resolve();});child.once('exit',code=>{clearTimeout(timer);reject(Error('Unexpected exit '+code+': '+diagnostic));});});
    assert.equal(site.state.requests,1);await new Promise(resolve=>{child.once('exit',resolve);child.kill('SIGKILL');});
    assert.throws(()=>new Engine(config,directory,provider()),/EEXIST/);unlock(directory);
    engine=new Engine(config,directory,provider());await engine.start();assert.equal(await engine.runScenario(config.scenarios[0]),'confirmed');assert.equal(site.state.requests,1);
  }finally{if(child?.exitCode===null&&child?.signalCode===null)child.kill('SIGKILL');await engine?.close();await site.close();}
});
test('hidden/occluded controls excluded; stale and replaced refs fail; slider/upload/navigation work',()=>usingShop('controls',async(engine,site,config)=>{
  assert.ok(!engine.view.elements.some(e=>['Commande cachée','Commande occluse'].includes(e.name)));
  const stale=await engine.resolveStep({action:'fill',target:'Quantité en articles',text:'7'});
  await engine.observe();await assert.rejects(engine.browser.act(stale),/Stale/);
  const replaced=await engine.resolveStep({action:'fill',target:'Quantité en articles',text:'7'});
  await engine.browser.act(await engine.resolveStep({action:'click',target:'Remplacer le contrôle'}));
  await assert.rejects(engine.browser.act(replaced),/Control changed/);await engine.observe();
  await engine.browser.act(await engine.resolveStep({action:'slider',target:'Intensité',value:0.8}));
  assert.ok(Number(await engine.browser.page.locator('#range').inputValue())>60);
  await engine.observe();await engine.browser.act(await engine.resolveStep({action:'upload',target:'Pièce synthétique',value:'note'}));
  assert.equal(await engine.browser.page.locator('#upload').evaluate(e=>e.files[0].name),'note.txt');
  await engine.observe();await engine.browser.act({action:'navigate',path:'/case/basic'});assert.equal(new URL(engine.browser.page.url()).pathname,'/case/basic');
}));
test('readonly action blocks submission and unsafe GET at the actual server',()=>usingShop('basic',async(engine,site,config)=>{
  for(const step of config.scenarios[0].steps.slice(0,2))await engine.execute(config.scenarios[0],step,await engine.resolveStep(step));
  await engine.browser.act(await engine.resolveStep({action:'click',target:'Confirmer'}));await new Promise(r=>setTimeout(r,100));
  await engine.browser.page.evaluate(()=>fetch('/danger-get').catch(()=>{}));assert.equal(site.state.requests,0);
}));
test('model hallucinations remain hypotheses; malicious site cannot change mission, access secrets or grant writes',()=>usingShop('injection',async(engine,site,config)=>{
  engine.provider=new ScriptedProvider(input=>{assert.match(input.instruction,/UNTRUSTED/);return {action:'finish',claim:'Sauvegarde réussie et facture certifiée'};});
  await engine.explore(config.scenarios[0]);assert.equal(Object.keys(engine.store.state.intents).length,0);assert.equal(engine.store.state.coverage.length,0);assert.equal(engine.store.state.candidates[0].kind,'model-hypothesis');
  await assert.rejects(engine.browser.act({action:'navigate',path:'/danger-get'}),/undeclared/);assert.equal(site.state.requests,0);
}));
test('navigation cycles consume bounded calls and survive resume',()=>usingShop('basic',async(engine,site,config)=>{
  engine.provider=new ScriptedProvider(()=>({action:'observe'}));
  await assert.rejects(engine.explore(config.scenarios[0],10),/cycle/);assert.ok(engine.store.state.calls<=4);
}));
test('secret never enters model, textual evidence or report; screenshot region masked',async()=>{
  const site=await startShop(),config=shopConfig(site.origin,'secrets'),directory=dir(),secret='synthetic-secret-9YxZ';
  const engine=new Engine(config,directory,new ScriptedProvider(input=>{assert.ok(!JSON.stringify(input).includes(secret));return {action:'finish',claim:secret};}),{privateOptions:{secrets:[secret]}});
  try{await engine.start();await engine.explore(config.scenarios[0]);engine.report();for(const filename of fs.readdirSync(directory).filter(f=>/json|md/.test(f)))assert.ok(!fs.readFileSync(path.join(directory,filename),'utf8').includes(secret),filename);assert.ok(fs.readdirSync(directory).some(f=>f.endsWith('.png')));}finally{await engine.close();await site.close();}
});
test('second independent site: provisional => definitive, deliberate closed-edit defect reproduced by server read',async()=>{
  const site=await startRegistry();let engine;
  try{
    const config=registryConfig(site.origin);engine=new Engine(config,dir(),provider());await engine.start();assert.equal(site.state.document.status,'provisional');assert.equal(await engine.runScenario(config.scenarios[0]),'confirmed');await engine.close();
    const edit=registryConfig(site.origin,'edit');engine=new Engine(edit,dir(),provider());await engine.start();assert.equal(await engine.runScenario(edit.scenarios[0]),'confirmed');assert.equal(site.state.document.pages,3);assert.equal(site.state.revisions,1);
  }finally{await engine?.close();await site.close();}
});
for(const [field,value] of [['unit','packs'],['date','2026-10-07'],['zone','UTC'],['account','other-account'],['quantity',999]])test(`wrong scope ${field} not promoted to success even with HTTP 200 and record`,()=>usingShop('basic',async(engine,site,config)=>{
  assert.equal(await engine.runScenario(config.scenarios[0]),'uncertain');assert.equal(site.state.requests,1);
},config=>{config.scenarios[0].probes[0].checks.find(c=>c.path.endsWith('.'+field)).value=value;}));
test('roles use separate contexts, secrets stay out of observations, campaign budget shared',async()=>{
  const site=await startShop(),config=shopConfig(site.origin,'basic'),directory=dir(),secret='synthetic-session-cookie';
  config.scenarios.push({id:'second-role',role:'second',steps:[],probes:[]});
  const privateOptions={roles:{first:{storageState:{cookies:[],origins:[{origin:site.origin,localStorage:[{name:'session-private',value:secret}]}]}},second:{storageState:{cookies:[],origins:[]}}}};
  const engine=new Engine(config,directory,new ScriptedProvider(()=>({action:'finish'})),{privateOptions});
  try{
    await engine.start('first');assert.equal(await engine.browser.page.evaluate(()=>localStorage.getItem('session-private')),secret);await engine.decision(config.scenarios[0]);assert.equal(engine.store.state.calls,1);
    await engine.runScenario(config.scenarios[1]);assert.equal(await engine.browser.page.evaluate(()=>localStorage.getItem('session-private')),null);assert.equal(engine.store.state.calls,1);
    assert.ok(!fs.readFileSync(path.join(directory,'ledger.jsonl'),'utf8').includes(secret));
  }finally{await engine.close();await site.close();}
});
test('positive and negative owner checks are independently read and deduplicated',async()=>{
  const site=await startRegistry(),config=registryConfig(site.origin),scenario=config.scenarios[0];
  scenario.readChecks=[{id:'arithmetic',path:'/register/state',checks:[{path:'total',op:'equals',value:20}]},{id:'known-lines',path:'/register/state',checks:[{path:'amounts',op:'sum',value:20}]}];
  const engine=new Engine(config,dir(),provider());
  try{await engine.start();await engine.verifyChecks(scenario);await engine.verifyChecks(scenario);assert.equal(engine.store.state.candidates.length,1);assert.equal(engine.store.state.candidates[0].observed.length,2);assert.equal(engine.store.state.coverage.find(c=>c.check==='known-lines').verdict,'pass');engine.report();}finally{await engine.close();await site.close();}
});
test('unavailable independent read is a prerequisite, never a product bug',()=>usingShop('basic',async(engine,site,config)=>{
  engine.browser.probe=async()=>({available:false,matched:false,httpStatus:403,checks:[]});
  await engine.verifyChecks(config.scenarios[0]);assert.equal(engine.store.state.candidates.length,0);assert.equal(engine.store.state.coverage[0].verdict,'blocked-prerequisite');
},config=>{config.scenarios[0].readChecks=[{id:'access-precondition',path:'/api/state',checks:[{path:'requests',op:'equals',value:0}]}];}));
