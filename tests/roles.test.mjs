import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Engine } from '../src/engine.mjs';
import { ScriptedProvider } from '../src/providers.mjs';
import { handleRequest } from '../src/protocol.mjs';
import { startShop, shopConfig, startRegistry, registryConfig } from '../fixtures/sites.mjs';

const directory = () => fs.mkdtempSync(path.join(os.tmpdir(),'qa-lab-role-'));
async function setup(fn) {
  const site = await startShop(), config = shopConfig(site.origin); config.scenarios[0].role = 'clerk';
  const privateOptions = {roles:{clerk:{storageState:{cookies:[],origins:[{origin:site.origin,localStorage:[{name:'role-test',value:'synthetic-clerk'}]}]}}}};
  const engine = new Engine(config,directory(),new ScriptedProvider(()=>({action:'finish'})),{privateOptions});
  try { await engine.start(); await fn(engine,config,site); }
  finally { await engine.close(); await site.close(); }
}

test('authored RPC steps switch to the mission role before resolving controls', () => setup(async(engine,config,site)=>{
  const scenario = config.scenarios[0].id;
  for (const step of ['key','prepare','submit']) await handleRequest(engine,{jsonrpc:'2.0',id:1,method:'step',params:{scenario,step}});
  assert.equal(engine.role,'clerk');
  assert.equal(await engine.browser.page.evaluate(()=>localStorage.getItem('role-test')),'synthetic-clerk');
  assert.equal(site.state.requests,1);
  assert.equal(Object.values(engine.store.state.intents)[0].phase,'confirmed');
}));

test('exploration, read checks and reconciliation use the declared role', () => setup(async(engine,config)=>{
  const scenario = config.scenarios[0];
  engine.provider = new ScriptedProvider(input=>{assert.equal(input.untrustedSite.role,'clerk');return {action:'finish'};});
  await engine.explore(scenario); assert.equal(engine.role,'clerk');
  await engine.start('visitor'); await engine.verifyChecks(scenario); assert.equal(engine.role,'clerk');
  await engine.runScenario(scenario);
  const intent = Object.values(engine.store.state.intents)[0]; intent.phase='uncertain';
  await engine.start('visitor'); assert.equal(await engine.reconcile(scenario),'confirmed'); assert.equal(engine.role,'clerk');
}));

test('direct API cannot submit before preparation or substitute a different gesture', () => setup(async(engine,config,site)=>{
  const scenario = config.scenarios[0]; await engine.ensureRole(scenario);
  await assert.rejects(engine.execute(scenario,scenario.steps[2],{action:'observe'}),/Preceding/);
  for (const step of scenario.steps.slice(0,2)) await engine.execute(scenario,step,await engine.resolveStep(step));
  await assert.rejects(engine.execute(scenario,scenario.steps[2],{action:'observe'}),/authored action/);
  assert.equal(site.state.requests,0); assert.equal(Object.keys(engine.store.state.intents).length,0);
}));

test('a browser restart invalidates local preparation and cannot create a new intent', () => setup(async(engine,config,site)=>{
  const scenario = config.scenarios[0]; await engine.ensureRole(scenario);
  for (const step of scenario.steps.slice(0,2)) await engine.execute(scenario,step,await engine.resolveStep(step));
  await engine.start('visitor'); await engine.ensureRole(scenario);
  // Even manually recreating the modal cannot restore the durable preparations.
  await engine.browser.act(await engine.resolveStep({action:'click',target:'Préparer'})); await engine.observe();
  const call = handleRequest(engine,{jsonrpc:'2.0',id:1,method:'step',params:{scenario:scenario.id,step:'submit'}});
  await assert.rejects(call,/preparation.*current browser session/i);
  assert.equal(site.state.requests,0); assert.equal(Object.keys(engine.store.state.intents).length,0);
}));

for (const brokenReport of [false,true]) test(`real CLI releases the lock with ${brokenReport?'a report write failure':'a failing control exit code'}`, async()=>{
  const site = await startRegistry(), config = registryConfig(site.origin), dir = directory();
  config.scenarios[0].steps=[]; delete config.scenarios[0].writeConsent;
  config.scenarios[0].readChecks=[{id:'arithmetic',path:'/register/state',checks:[{path:'total',op:'equals',value:20}]}];
  const file = path.join(dir,'config.json'), run = path.join(dir,'run'); fs.writeFileSync(file,JSON.stringify(config));
  if (brokenReport) fs.mkdirSync(path.join(run,'REPORT.md'),{recursive:true});
  let child;
  try {
    child=spawn(process.execPath,[fileURLToPath(new URL('../src/cli.mjs',import.meta.url)),'run',file,run],{windowsHide:true,stdio:['ignore','pipe','pipe']});
    let diagnostic=''; child.stderr.on('data',c=>diagnostic+=c); child.stdout.resume();
    const code = await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('CLI timeout'));},15000);
      child.once('error',error=>{clearTimeout(timer);reject(error);}); child.once('close',code=>{clearTimeout(timer);resolve(code);});
    });
    assert.equal(code,brokenReport?1:3,diagnostic);
    assert.equal(JSON.parse(fs.readFileSync(path.join(run,'report.json'))).coverage[0].samples[0].checks[0].observed,21);
    assert.equal(fs.existsSync(path.join(run,'run.lock')),false);
  } finally { if(child?.exitCode===null && child?.signalCode===null)child.kill('SIGKILL'); await site.close(); }
});
