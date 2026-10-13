import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {Engine} from '../src/engine.mjs';
import {ScriptedProvider} from '../src/providers.mjs';
import {Redactor} from '../src/policy.mjs';
import {handleRequest} from '../src/protocol.mjs';
import {shopConfig} from '../fixtures/sites.mjs';

const directory=()=>fs.mkdtempSync(path.join(os.tmpdir(),'qa-lab-reliability-'));
function config() {
  const cfg=shopConfig('http://127.0.0.1:1234');
  cfg.scenarios=[{id:'first',role:'first',goal:'Observe first role',steps:[]},{id:'second',role:'second',goal:'Observe second role',steps:[]}];
  return cfg;
}
function fakeBrowser() {
  let n=0;
  return {
    role:null,gestures:[],reads:[],redactor:new Redactor(['private-test-value']),
    async start(role='visitor'){this.role=role;},async close(){},
    async observe(){return {id:`view-${++n}`,role:this.role,path:'/',text:'Stable screen',elements:[{ref:0,name:'Control',tag:'INPUT',type:'text',value:null,disabled:false}],errors:[],overflow:false};},
    async act(decision){this.gestures.push({role:this.role,...decision});},
    async probe(){this.reads.push(this.role);return {available:true,matched:true,checks:[]};}
  };
}

test('cycles are mission/role specific, persist after restart and report stops honestly',async()=>{
  const cfg=config(),dir=directory();cfg.maxRepeatedStates=1;
  let engine=new Engine(cfg,dir,new ScriptedProvider(()=>({action:'observe'})),{browser:fakeBrowser()});
  try {
    await engine.start();
    assert.equal(await engine.explore(cfg.scenarios[0],1),'bounded');
    assert.equal(await engine.explore(cfg.scenarios[1],1),'bounded');
    assert.equal(engine.store.state.calls,2);
    await engine.close();
    engine=new Engine(cfg,dir,new ScriptedProvider(()=>({action:'observe'})),{browser:fakeBrowser()});
    await engine.start();
    await assert.rejects(engine.explore(cfg.scenarios[0],1),/cycle/);
    assert.equal(engine.store.state.calls,2);
    const report=engine.report();
    assert.equal(report.missions[0].status,'blocked');
    assert.match(report.missions[0].reason,/cycle/);
    assert.equal(report.missions[1].status,'bounded');
    assert.match(fs.readFileSync(path.join(dir,'REPORT.md'),'utf8'),/first.*blocked/);
  } finally {await engine.close();}
});

test('worker receives bounded factual action memory after resume without copied fill values',async()=>{
  const cfg=config(),dir=directory();let browser=fakeBrowser();
  let engine=new Engine(cfg,dir,new ScriptedProvider(()=>({action:'finish'})),{browser});
  try {
    await engine.start();await engine.ensureRole(cfg.scenarios[0]);
    for(let n=0;n<10;n++)await engine.execute(cfg.scenarios[0],{id:`draft-${n}`},await engine.resolveStep({action:'fill',target:'Control',text:'private-test-value'}));
    await engine.close();browser=fakeBrowser();
    let seen;
    engine=new Engine(cfg,dir,new ScriptedProvider(input=>{seen=input;return {action:'finish'};}),{browser});
    await engine.start();await engine.explore(cfg.scenarios[0],1);
    assert.equal(seen.execution.role,'first');
    assert.equal(seen.execution.recentActions.length,8);
    assert.equal(seen.execution.recentActions[0].id,'first/draft-2');
    assert.ok(seen.execution.recentActions.every(a=>a.phase==='observed'&&a.before&&a.after&&a.role==='first'));
    assert.ok(!JSON.stringify(seen).includes('private-test-value'));
    assert.equal(engine.report().missions[0].status,'observed');
    assert.equal(engine.report().missions[1].status,'not-run');
  } finally {await engine.close();}
});

test('failed gestures remain attempts and are never presented as observed effects',async()=>{
  const cfg=config(),browser=fakeBrowser();browser.act=async()=>{throw Error('synthetic gesture failure');};
  let seen;
  const engine=new Engine(cfg,directory(),new ScriptedProvider(input=>{seen=input;return {action:'finish'};}),{browser});
  try {
    await engine.start();await engine.ensureRole(cfg.scenarios[0]);
    await assert.rejects(engine.execute(cfg.scenarios[0],{id:'draft'},await engine.resolveStep({action:'click',target:'Control'})),/gesture failure/);
    await engine.decision(cfg.scenarios[0]);
    assert.equal(seen.execution.recentActions[0].phase,'attempted');
    assert.equal(seen.execution.recentActions[0].after,undefined);
    await assert.rejects(engine.execute(cfg.scenarios[0],{id:'draft'},{action:'observe'}),/already attempted/);
  } finally {await engine.close();}
});

test('RPC steps switch before resolution; cross-role external refs are refused before gestures',async()=>{
  const cfg=config(),browser=fakeBrowser();cfg.scenarios[1].steps=[{id:'draft',action:'fill',target:'Control',text:'example'}];
  const engine=new Engine(cfg,directory(),new ScriptedProvider(()=>({action:'finish'})),{browser});
  const call=(method,params)=>handleRequest(engine,{jsonrpc:'2.0',id:1,method,params});
  try {
    await engine.start();await engine.ensureRole(cfg.scenarios[0]);
    const oldRef=await engine.resolveStep({action:'click',target:'Control'});
    await assert.rejects(call('act',{scenario:'second',decision:oldRef}),/role changed/);
    assert.equal(browser.gestures.length,0);assert.equal(Object.keys(engine.store.state.steps).length,0);
    await call('step',{scenario:'second',step:'draft'});
    assert.equal(browser.gestures[0].role,'second');
    assert.equal(engine.store.state.steps['second/draft'].role,'second');
    assert.equal(engine.report().missions[1].status,'observed');
    assert.equal(engine.store.state.calls,0);
  } finally {await engine.close();}
});

test('independent reads select mission roles and identical check names stay separate',async()=>{
  const cfg=config(),browser=fakeBrowser();
  for(const scenario of cfg.scenarios)scenario.readChecks=[{id:'same-name',path:'/api/state',scope:{account:scenario.role},checks:[{path:'total',op:'equals',value:20}]}];
  cfg.scenarios[0].operationId='role-check';
  cfg.scenarios[0].probes=[{id:'outcome',path:'/api/state',verdict:'confirmed',correlation:{path:'operation',op:'equals',value:'role-check'},checks:[{path:'total',op:'equals',value:20}]}];
  browser.probe=async function(){this.reads.push(this.role);return {available:true,matched:false,checks:[{observed:21,pass:false}]};};
  const engine=new Engine(cfg,directory(),new ScriptedProvider(()=>({action:'finish'})),{browser});
  try {
    await engine.start();
    await engine.verifyChecks(cfg.scenarios[0]);await engine.verifyChecks(cfg.scenarios[1]);await engine.verifyChecks(cfg.scenarios[1]);
    assert.deepEqual(browser.reads,['first','first','second','second','second','second']);
    assert.equal(engine.store.state.candidates.length,2);
    assert.deepEqual(engine.store.state.candidates.map(c=>c.role),['first','second']);
    assert.equal(engine.store.state.coverage.length,3);
    engine.store.state.intents.pending={id:'pending',scenario:'first',phase:'uncertain',evidence:[]};
    browser.probe=async function(){this.reads.push(this.role);return {available:true,matched:true,checks:[]};};
    assert.equal(await engine.reconcile(cfg.scenarios[0]),'confirmed');
    assert.equal(browser.role,'first');
  } finally {await engine.close();}
});

test('quota stop uses no model call; unfinished durable mission is reported interrupted after restart',async()=>{
  const cfg=config(),dir=directory(),worker=new ScriptedProvider(()=>assert.fail('must not call worker'));
  worker.quota=async()=>null;
  let engine=new Engine(cfg,dir,worker,{browser:fakeBrowser()});
  try {
    await engine.start();await assert.rejects(engine.explore(cfg.scenarios[0]),/Quota/);
    assert.equal(engine.report().missions[0].status,'blocked');assert.equal(engine.store.state.calls,0);
    engine.store.state.missions.second={status:'running',role:'second',mode:'explore'};
    engine.store.commit('synthetic-interruption');await engine.close();
    engine=new Engine(cfg,dir,worker,{browser:fakeBrowser()});
    assert.equal(engine.report().missions[1].status,'interrupted');
    assert.equal(engine.store.state.missions.second.status,'running');
  } finally {await engine.close();}
});

test('real browser exploration and probes use intended private sessions; absent named role stops before calls',async()=>{
  const requests=[];
  const server=http.createServer((req,res)=>{
    const role=req.headers['x-qa-role']?.replace('synthetic-session-','') || 'visitor';
    requests.push({path:req.url,role});
    res.setHeader('cache-control','no-store');
    if(req.url==='/api/state'){res.setHeader('content-type','application/json');return res.end(JSON.stringify({role}));}
    if(req.url==='/favicon.ico'){res.writeHead(204);return res.end();}
    res.setHeader('content-type','text/html');res.end('<!doctype html><meta name="viewport" content="width=device-width"><h1>Sessions synthétiques</h1><p>Aucune donnée réelle</p>');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const cfg=config();cfg.origin=`http://127.0.0.1:${server.address().port}`;
  cfg.entry='/';cfg.reads=[{path:'/',methods:['GET']},{path:'/api/state',methods:['GET']},{path:'/favicon.ico',methods:['GET']}];
  cfg.scenarios.push({id:'missing',role:'missing',steps:[]});
  for(const scenario of cfg.scenarios.slice(0,2))scenario.readChecks=[{id:'session-role',path:'/api/state',checks:[{path:'role',op:'equals',value:scenario.role}]}];
  const roles=Object.fromEntries(['first','second'].map(role=>[role,{headers:{'x-qa-role':`synthetic-session-${role}`},probeHeaders:{'x-qa-role':`synthetic-session-${role}`}}]));
  const seen=[];
  const engine=new Engine(cfg,directory(),new ScriptedProvider(input=>{seen.push(input.untrustedSite.role);return {action:'finish'};}),{privateOptions:{roles}});
  try {
    await engine.start();
    for(const scenario of cfg.scenarios.slice(0,2)){await engine.explore(scenario);await engine.verifyChecks(scenario);assert.deepEqual(engine.view.errors,[]);assert.equal(engine.view.overflow,false);}
    assert.deepEqual(seen,['first','second']);
    assert.ok(engine.store.state.coverage.every(c=>c.verdict==='pass'));
    assert.deepEqual(requests.filter(r=>r.path==='/api/state').map(r=>r.role),['first','first','second','second']);
    const count=requests.length;
    await assert.rejects(engine.explore(cfg.scenarios[2]),/session.*unavailable/);
    assert.equal(requests.length,count);assert.equal(engine.store.state.calls,2);
    assert.equal(engine.report().missions[2].status,'blocked');
  } finally {await engine.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
