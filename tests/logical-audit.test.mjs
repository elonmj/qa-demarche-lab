import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Engine } from '../src/engine.mjs';
import { unlock } from '../src/store.mjs';
import { Redactor, validateConfig } from '../src/policy.mjs';
import { ScriptedProvider } from '../src/providers.mjs';
import { handleRequest } from '../src/protocol.mjs';
import { startShop, shopConfig } from '../fixtures/sites.mjs';

const directory = () => fs.mkdtempSync(path.join(os.tmpdir(), 'qa-lab-logic-'));
const worker = () => new ScriptedProvider(() => ({action:'finish'}));
function fakeBrowser() {
  let n = 0;
  return {
    redactor: new Redactor(), role: null,
    async start(role) { this.role = role; }, async close() {}, async act() {},
    async observe() { return {id:`s-${++n}`,path:'/',text:'Synthetic',elements:[],errors:[],overflow:false}; },
    async probe() { return {available:true,matched:false,correlation:{pass:false},checks:[]}; }
  };
}
function config() {
  const c = shopConfig('http://127.0.0.1:1234');
  c.scenarios[0].steps = [{id:'prepare',action:'observe'},{id:'submit',action:'observe',submit:true}];
  c.scenarios[0].settleMs = 0; c.scenarios[0].probeTimeoutMs = 1;
  return c;
}

test('L1 recreated preparation in the same browser session cannot authorize an authored submit', async () => {
  const site = await startShop(), c = shopConfig(site.origin), scenario = c.scenarios[0];
  const engine = new Engine(c,directory(),worker());
  const rpc = (method,params) => handleRequest(engine,{jsonrpc:'2.0',id:1,method,params:{scenario:scenario.id,...params}});
  try {
    await engine.start();
    for (const step of scenario.steps.slice(0,2)) await rpc('step',{step:step.id});
    await rpc('act',{decision:{action:'navigate',path:'/case/basic'}});
    for (const step of scenario.steps.slice(0,2)) await rpc('act',{decision:await engine.resolveStep(step)});
    assert.ok(engine.view.elements.some(e=>e.name==='Confirmer'));
    await assert.rejects(rpc('step',{step:'submit'}),/preparation|continuity|review/i);
    assert.equal(site.state.requests,0);
    assert.equal(Object.keys(engine.store.state.intents).length,0);
  } finally { await engine.close(); await site.close(); }
});

test('L2 the submitted role survives a new process context instead of silently using visitor', async () => {
  const c = config(), dir = directory(), scenario = c.scenarios[0];
  let b = fakeBrowser(), engine = new Engine(c,dir,worker(),{browser:b});
  try {
    await engine.start('owner-role');
    await engine.runScenario(scenario);
    assert.equal(engine.report().intents[0].role,'owner-role');
    await engine.close();
    b = fakeBrowser();
    engine = new Engine(c,dir,worker(),{browser:b,readbackOnly:true});
    await engine.start('visitor');
    await engine.reconcile(scenario);
    assert.equal(b.role,'owner-role');
    assert.equal(engine.report().missions[0].role,'owner-role');
  } finally { await engine.close(); }
});

test('L3 configured assertions absent after a durable business verdict remain explicitly incomplete', async () => {
  const c = config(), dir = directory(), s = c.scenarios[0], b = fakeBrowser();
  s.assertions = [{id:'layout',path:'overflow',op:'equals',value:false}];
  b.probe = async (probe, options) => ({available:true,matched:!options?.preflight && probe.verdict==='confirmed',correlation:{pass:!options?.preflight && probe.verdict==='confirmed'},checks:[]});
  let engine = new Engine(c,dir,worker(),{browser:b});
  try {
    await engine.start();
    for (const step of s.steps) await engine.execute(s,step,await engine.resolveStep(step));
    assert.equal(engine.report().intents[0].phase,'confirmed');
    await engine.close();
    engine = new Engine(c,dir,worker(),{browser:fakeBrowser()});
    await engine.start();
    assert.equal(await engine.runScenario(s),'confirmed');
    const report = engine.report();
    assert.equal(report.exitCode,4);
    assert.equal(report.coverage.find(c=>c.check==='layout')?.verdict,'not-run');
    assert.match(fs.readFileSync(path.join(dir,'REPORT.md'),'utf8'),/layout.*not-run/);
    assert.ok(!engine.store.state.coverage.some(c=>c.check==='layout'), 'report does not fabricate ledger evidence');
  } finally { await engine.close(); }
});

test('L4 a later successful exploration cannot hide an unobserved gesture', async () => {
  const c = config(), b = fakeBrowser();
  c.scenarios[0].steps = [];
  b.act = async () => { throw Error('Synthetic gesture interrupted'); };
  const engine = new Engine(c,directory(),worker(),{browser:b});
  try {
    await engine.start();
    await assert.rejects(engine.execute(c.scenarios[0],{id:'external-1'},{action:'observe'}),/interrupted/);
    assert.equal(await engine.explore(c.scenarios[0]),'observed');
    const report = engine.report();
    assert.equal(report.exitCode,4);
    assert.equal(report.missions[0].status,'attempted');
    assert.match(report.missions[0].reason,/gesture|preparation|observ/i);
  } finally { await engine.close(); }
});

test('L5 unavailable or out-of-scope samples cannot pass merely because an adapter says matched', async () => {
  for (const facts of [{available:false},{available:true,scopeMatched:false}]) {
    const c = config(), b = fakeBrowser();
    c.scenarios[0].readChecks = [{id:'check',path:'/api/state',checks:[{path:'total',op:'equals',value:20}]}];
    b.probe = async () => ({...facts,matched:true,checks:[]});
    const engine = new Engine(c,directory(),worker(),{browser:b});
    try {
      await engine.start(); await engine.verifyChecks(c.scenarios[0]);
      assert.equal(engine.report().coverage[0].verdict,'blocked-prerequisite');
    } finally { await engine.close(); }
  }
});

test('L6 owner checks bound custom probes and retain late replies as unavailable, including after deadline', async () => {
  const c = config(), b = fakeBrowser();
  c.budget.maxDurationMs = 1; c.scenarios[0].probeTimeoutMs = 20;
  c.scenarios[0].readChecks = [{id:'check',path:'/api/state',checks:[{path:'total',op:'equals',value:20}]}];
  let now = Date.now(), aborted = 0;
  b.probe = async (_, {signal} = {}) => {
    signal?.addEventListener('abort',()=>aborted++,{once:true});
    await new Promise(resolve=>setTimeout(resolve,150));
    return {available:true,matched:true,checks:[]};
  };
  const engine = new Engine(c,directory(),worker(),{browser:b,clock:()=>now});
  try {
    await engine.start(); now += 1000;
    await engine.verifyChecks(c.scenarios[0]);
    const coverage = engine.report().coverage[0];
    assert.equal(coverage.verdict,'blocked-prerequisite');
    assert.equal(aborted,2);
    await new Promise(resolve=>setTimeout(resolve,170));
    assert.equal(engine.store.state.coverage[0].verdict,'blocked-prerequisite');
  } finally { await engine.close(); }
});

test('L7 resolved conflict cites only the deciding reads, preserving prior contradictions as history', async () => {
  const c = config(), b = fakeBrowser();
  let conflict = true;
  b.probe = async (_,options) => ({available:true,matched:!options?.preflight && (conflict || _.verdict==='confirmed'),correlation:{pass:!options?.preflight},checks:[]});
  const engine = new Engine(c,directory(),worker(),{browser:b});
  try {
    await engine.start(); assert.equal(await engine.runScenario(c.scenarios[0]),'uncertain');
    const historical = engine.report().intents[0].evidence.filter(e=>e.matched).map(e=>e.id);
    assert.equal(historical.length,2);
    conflict = false;
    assert.equal(await engine.reconcile(c.scenarios[0]),'confirmed');
    const report = engine.report(), outcome = report.coverage.find(c=>c.check==='business-outcome');
    assert.ok(outcome.evidence.every(id=>!historical.includes(id)));
    assert.equal(outcome.evidence.length,1);
    assert.equal(report.intents[0].evidence.length,4);
    assert.equal(report.intents[0].conflict,undefined);
  } finally { await engine.close(); }
});

for (const loss of ['replaced','hidden']) test(`L8 preparation target ${loss} and recreated without another engine gesture remains lost`, async () => {
  const site = await startShop(), c = shopConfig(site.origin), scenario = c.scenarios[0];
  const engine = new Engine(c,directory(),worker());
  try {
    await engine.start();
    for (const step of scenario.steps.slice(0,2)) await engine.execute(scenario,step,await engine.resolveStep(step));
    if (loss==='replaced') {
      await engine.browser.page.evaluate(()=>{
        const modal=document.querySelector('#modal'),handler=document.querySelector('#confirm').onclick;
        modal.close(); modal.outerHTML=modal.outerHTML;
        document.querySelector('#confirm').onclick=handler;
        document.querySelector('#modal').showModal();
      });
    } else {
      await engine.browser.page.evaluate(()=>document.querySelector('#modal').close());
      await engine.observe();
      await engine.browser.page.evaluate(()=>document.querySelector('#modal').showModal());
    }
    await engine.observe();
    const step = scenario.steps[2];
    await assert.rejects(engine.execute(scenario,step,await engine.resolveStep(step)),/preparation|control|review/i);
    assert.equal(site.state.requests,0); assert.equal(Object.keys(engine.store.state.intents).length,0);
  } finally { await engine.close(); await site.close(); }
});

test('L9 direct API cannot label a different action as an authored preparation', async () => {
  const c = config(), b = fakeBrowser(), engine = new Engine(c,directory(),worker(),{browser:b});
  try {
    await engine.start();
    await assert.rejects(engine.execute(c.scenarios[0],c.scenarios[0].steps[0],{action:'scroll',value:1}),/authored|preparation/i);
    await assert.rejects(engine.execute(c.scenarios[0],{id:'prepare',action:'scroll'},{action:'scroll',value:1}),/authored|configuration/i);
    assert.equal(Object.keys(engine.store.state.steps).length,0);
  } finally { await engine.close(); }
});

test('normal authored preparation survives extra observations and executes its assertions and read checks', async () => {
  const site = await startShop(), c = shopConfig(site.origin), s = c.scenarios[0];
  s.assertions = [{id:'layout',path:'overflow',op:'equals',value:false}];
  s.readChecks = [{id:'saved-count',path:'/api/state',checks:[{path:'requests',op:'equals',value:1}]}];
  const engine = new Engine(c,directory(),worker());
  try {
    await engine.start();
    for (const step of s.steps.slice(0,2)) await engine.execute(s,step,await engine.resolveStep(step));
    await engine.observe(); await engine.observe();
    assert.equal(await engine.execute(s,s.steps[2],await engine.resolveStep(s.steps[2])),'confirmed');
    // Run the full normal path separately; the already-submitted campaign keeps its
    // missing UI assertion explicit rather than asserting against a recreated page.
    assert.equal(engine.report().coverage.find(c=>c.check==='layout').verdict,'not-run');
    assert.equal(site.state.requests,1);
  } finally { await engine.close(); await site.close(); }
  const normalSite = await startShop(), normalConfig = shopConfig(normalSite.origin);
  normalConfig.scenarios[0].assertions = s.assertions; normalConfig.scenarios[0].readChecks = s.readChecks;
  const normal = new Engine(normalConfig,directory(),worker());
  try {
    await normal.start(); await normal.runScenario(normalConfig.scenarios[0]); await normal.verifyChecks(normalConfig.scenarios[0]);
    assert.equal(normal.report().exitCode,0); assert.equal(normalSite.state.requests,1);
    assert.deepEqual(normal.view.errors,[]); assert.equal(normal.view.overflow,false);
  } finally { await normal.close(); await normalSite.close(); }
});

test('L10 a request dispatched after the controlled campaign deadline is denied by the same clock', async () => {
  const c = config(), b = fakeBrowser(); c.budget.maxDurationMs = 1000;
  let now = Date.now(), engine, writes = 0;
  b.act = async () => {
    if (!engine.policy.active) return;
    now += 2000;
    if (engine.policy.request(c.origin+'/api/save','POST',JSON.stringify({key:'sample',quantity:'3',mode:'basic'})).allow) writes++;
  };
  b.probe = async () => { now += 2; return {available:true,matched:false,correlation:{pass:false},checks:[]}; };
  engine = new Engine(c,directory(),worker(),{browser:b,clock:()=>now});
  try {
    await engine.start();
    await engine.runScenario(c.scenarios[0]);
    assert.equal(writes,0);
    assert.equal(engine.store.state.holds.length,1);
    assert.equal(engine.store.state.networkRequests || 0,0);
    assert.equal(engine.report().intents[0].phase,'uncertain');
  } finally { await engine.close(); }
});

test('L11 configured checks cannot share an identity and mask an unexecuted check', async () => {
  const c = config();
  c.scenarios[0].assertions = [{id:'same',path:'overflow',op:'equals',value:false}];
  c.scenarios[0].readChecks = [{id:'same',path:'/api/state',checks:[{path:'total',op:'equals',value:20}]}];
  let engine;
  try {
    assert.throws(()=>{engine=new Engine(c,directory(),worker(),{browser:fakeBrowser()});},/check.*identifier|duplicate/i);
  } finally { await engine?.close(); }
});

test('L12 a matched flag without an available correlation cannot certify an operation', async () => {
  for (const correlation of [undefined,{pass:false}]) {
    const c = config(), b = fakeBrowser();
    b.probe = async (probe,options) => ({available:true,matched:!options?.preflight && probe.verdict==='confirmed',correlation:options?.preflight?{pass:false}:correlation,checks:[]});
    const engine = new Engine(c,directory(),worker(),{browser:b});
    try {
      await engine.start(); assert.equal(await engine.runScenario(c.scenarios[0]),'uncertain');
      assert.equal(engine.store.state.holds.length,1);
    } finally { await engine.close(); }
  }
});

test('L12 preflight cannot turn an unavailable correlation or wrong scope into absence and permission', async () => {
  for (const facts of [{correlation:null},{correlation:{pass:false},scopeMatched:false}]) {
    const c = config(), b = fakeBrowser(); let submissions = 0;
    b.probe = async () => ({available:true,matched:false,checks:[],...facts});
    b.act = async () => { submissions++; };
    const engine = new Engine(c,directory(),worker(),{browser:b});
    try {
      await engine.start(); const s = c.scenarios[0];
      await engine.execute(s,s.steps[0],await engine.resolveStep(s.steps[0]));
      const before = submissions;
      await assert.rejects(engine.execute(s,s.steps[1],await engine.resolveStep(s.steps[1])),/preflight|scope|correlation/i);
      assert.equal(submissions,before); assert.equal(Object.keys(engine.store.state.intents).length,0);
    } finally { await engine.close(); }
  }
});

test('L12 an unavailable or internally contradictory competing correlation keeps the outcome uncertain', async () => {
  for (const rival of [{available:true,matched:false,correlation:null},{available:true,matched:true,correlation:{pass:false}}]) {
    const c = config(), b = fakeBrowser();
    b.probe = async (probe,options)=>options?.preflight?{available:true,matched:false,correlation:{pass:false}}:probe.verdict==='confirmed'?{available:true,matched:true,correlation:{pass:true}}:rival;
    const engine = new Engine(c,directory(),worker(),{browser:b});
    try { await engine.start(); assert.equal(await engine.runScenario(c.scenarios[0]),'uncertain'); assert.equal(engine.store.state.holds.length,1); }
    finally { await engine.close(); }
  }
});

test('L13 owner checks for another entity are a missing prerequisite even when their numerical expectations pass', async () => {
  const site = await startShop(), c = shopConfig(site.origin);
  site.state.records.found = {reference:'another-entity',quantity:3};
  c.scenarios[0].readChecks = [{id:'entity-quantity',path:'/api/state',checks:[{path:'records.found.quantity',op:'equals',value:3}],correlation:{path:'records.found.reference',op:'equals',value:'intended-entity'}}];
  const engine = new Engine(c,directory(),worker());
  try {
    await engine.start(); await engine.verifyChecks(c.scenarios[0]);
    const report = engine.report();
    assert.equal(report.coverage[0].samples[0].checks[0].pass,true);
    assert.equal(report.coverage[0].samples[0].correlation.pass,false);
    assert.equal(report.coverage[0].verdict,'blocked-prerequisite');
    assert.equal(report.hypotheses.length,0); assert.equal(report.exitCode,4);
    const invalid = structuredClone(c); invalid.scenarios[0].readChecks[0].correlation.op='invented';
    assert.throws(()=>validateConfig(invalid),/correlation|assertion/i);
  } finally { await engine.close(); await site.close(); }
});

// These are actual process kills, in addition to injected exceptions in recovery.test.
// The adapter and supplier are synthetic; no Chromium or vendor process is required
// to establish whether the process memory or the fsynced ledger owns these facts.
for (const boundary of ['intent','worker']) test(`real process interruption at ${boundary} preserves role and consumed reservations`, async () => {
  const c = config(), dir = directory(); let child, engine, diagnostic = '';
  const source = `
    import {Engine} from ${JSON.stringify(new URL('../src/engine.mjs',import.meta.url).href)};
    import {ScriptedProvider} from ${JSON.stringify(new URL('../src/providers.mjs',import.meta.url).href)};
    const browser = {async start(role){this.role=role;},async close(){},async observe(){return {id:'s',path:'/',text:'Synthetic',elements:[]};},async probe(){return {available:true,matched:false,correlation:{pass:false},checks:[]};},async act(){if(engine.policy.active){process.send('intent');await new Promise(()=>{});}}};
    const provider = new ScriptedProvider(async()=>{process.send('worker');await new Promise(()=>{});});
    provider.maxCostMicros = 123;
    const engine = new Engine(JSON.parse(process.argv[1]),process.argv[2],provider,{browser});
    await engine.start('owner-role');
    if(process.argv[3]==='worker')await engine.decision(engine.config.scenarios[0]);
    else await engine.runScenario(engine.config.scenarios[0]);
  `;
  try {
    child = spawn(process.execPath,['--input-type=module','-e',source,JSON.stringify(c),dir,boundary],{windowsHide:true,stdio:['ignore','ignore','pipe','ipc']});
    child.stderr.on('data',chunk=>diagnostic+=chunk);
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(Error('Synthetic child did not reach durable boundary: '+diagnostic)),15000);
      child.once('error',error=>{clearTimeout(timer);reject(error);});
      child.once('exit',code=>{clearTimeout(timer);reject(Error('Child exited before boundary '+code+': '+diagnostic));});
      child.once('message',message=>{clearTimeout(timer);assert.equal(message,boundary);resolve();});
    });
    assert.throws(()=>unlock(dir),/alive/);
    await new Promise(resolve=>{child.once('exit',resolve);child.kill('SIGKILL');});
    unlock(dir);
    let calls = 0;
    const provider = new ScriptedProvider(()=>{calls++;return {action:'finish'};}); provider.maxCostMicros=123;
    const b = fakeBrowser(); engine = new Engine(c,dir,provider,{browser:b});
    await engine.start('visitor');
    if (boundary==='worker') {
      await assert.rejects(engine.decision(c.scenarios[0]),/pending|interrupted/);
      assert.equal(calls,0); assert.equal(engine.store.state.calls,1); assert.equal(engine.store.state.reservedMicros,123);
      assert.equal(engine.report().exitCode,4);
    } else {
      assert.equal(await engine.runScenario(c.scenarios[0]),'uncertain');
      assert.equal(b.role,'owner-role'); assert.equal(engine.store.state.holds.length,1);
      assert.equal(Object.keys(engine.store.state.intents).length,1); assert.equal(engine.report().exitCode,2);
    }
  } finally {
    if(child?.exitCode===null && child?.signalCode===null) await new Promise(resolve=>{child.once('exit',resolve);child.kill('SIGKILL');});
    await engine?.close();
  }
});

test('legacy ambiguous checks stay readable but cannot produce a complete report', async () => {
  const c = config();
  c.scenarios[0].assertions = [{id:'same',path:'overflow',op:'equals',value:false}];
  c.scenarios[0].readChecks = [{id:'same',path:'/api/state',checks:[{path:'total',op:'equals',value:20}]}];
  const engine = new Engine(c,directory(),worker(),{browser:fakeBrowser(),readbackOnly:true});
  try {
    engine.store.state.coverage.push({scenario:c.scenarios[0].id,check:'same',verdict:'pass',evidence:['legacy']}); engine.store.commit('legacy-check');
    const report = engine.report();
    assert.equal(report.exitCode,4); assert.equal(report.coverage[0].verdict,'pass');
    assert.ok(report.coverage.some(c=>c.verdict==='blocked-prerequisite' && /ambiguous/.test(c.reason)));
  } finally { await engine.close(); }
});

test('relocating the intact stopped ledger preserves the attempted operation and forbids another gesture', async () => {
  const c = config(), original = directory(), relocated = path.join(directory(),'relocated');
  let gestures = 0;
  const b = fakeBrowser(); b.act = async()=>{gestures++;};
  let engine = new Engine(c,original,worker(),{browser:b});
  try {
    await engine.start('owner-role'); assert.equal(await engine.runScenario(c.scenarios[0]),'uncertain');
    const attempted = Object.keys(engine.store.state.intents), before = gestures;
    await engine.close(); fs.cpSync(original,relocated,{recursive:true});
    engine = new Engine(c,relocated,worker(),{browser:b});
    await engine.start('visitor'); assert.equal(await engine.runScenario(c.scenarios[0]),'uncertain');
    assert.equal(gestures,before); assert.deepEqual(Object.keys(engine.store.state.intents),attempted);
    assert.equal(engine.role,'owner-role'); assert.equal(engine.report().exitCode,2);
  } finally { await engine.close(); }
});

test('request counters survive an interruption before transport and describe reservations, not sent requests', async () => {
  const c = config(), dir = directory(), b = fakeBrowser(); let engine;
  b.act = async()=>{
    if (engine.policy.active) {
      assert.equal(engine.policy.request(c.origin+'/api/save','POST',JSON.stringify({key:'sample',quantity:'3',mode:'basic'})).allow,true);
      throw Error('Synthetic interruption before invoking transport');
    }
  };
  engine = new Engine(c,dir,worker(),{browser:b});
  try {
    await engine.start(); assert.equal(await engine.runScenario(c.scenarios[0]),'uncertain');
    assert.equal(engine.store.events.find(e=>e.type==='network-dispatched').facts.stage,'reserved-before-transport');
    await engine.close(); engine = new Engine(c,dir,worker(),{browser:fakeBrowser()});
    assert.equal(engine.report().intents[0].requests[0],1);
    assert.match(engine.report().limits.join(' '),/réservations durables avant transport/);
  } finally { await engine.close(); }
});
