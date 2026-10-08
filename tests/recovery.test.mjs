import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../src/engine.mjs';
import { Store, hash } from '../src/store.mjs';
import { ScriptedProvider } from '../src/providers.mjs';
import { shopConfig } from '../fixtures/sites.mjs';

const dir=()=>fs.mkdtempSync(path.join(os.tmpdir(),'qa-lab-recovery-'));
const config=()=>shopConfig('http://127.0.0.1:1234');
const worker=()=>new ScriptedProvider(()=>({action:'finish'}));

// Fault injection at durable boundaries, distinct from the existing real child SIGKILL
// test. Server state survives engine restart. No data reset to manufacture readback.
for(const boundary of ['step-before-gesture','step-observed','operation-preflight','intent-before-gesture','network-dispatched','reconciliation-required','independent-read','intent-reconciled']) {
  test(`durable interruption at ${boundary}: no automatic second gesture`,async()=>{
    const c=config(),directory=dir();c.scenarios[0].steps=[{id:'prepare',action:'observe'},{id:'submit',action:'observe',submit:true}];c.scenarios[0].probeTimeoutMs=1;c.scenarios[0].settleMs=0;
    let engine,gestures=0,writes=0,snapshot=0;
    const browser={start:async()=>{},close:async()=>{},observe:async()=>({id:String(++snapshot),path:'/',text:'Synthetic',elements:[]}),act:async()=>{
      gestures++;
      if(engine.policy.active && engine.policy.request(c.origin+'/api/save','POST',JSON.stringify({key:'sample',quantity:'3',mode:'basic'})).allow)writes++;
    },probe:async probe=>({available:true,matched:probe.verdict==='confirmed' && writes===1,correlation:{pass:probe.verdict==='confirmed' && writes===1},checks:[]})};
    engine=new Engine(c,directory,worker(),{browser});
    try {
      await engine.start();const commit=engine.store.commit.bind(engine.store);let interrupted=false;
      engine.store.commit=(type,facts)=>{commit(type,facts);if(!interrupted && type===boundary){interrupted=true;throw Error('Synthetic interruption');}};
      await engine.runScenario(c.scenarios[0]).catch(error=>assert.match(error.message,/interruption/));assert.ok(interrupted);
      const beforeGestures=gestures,beforeWrites=writes;
      await engine.close();engine=new Engine(c,directory,worker(),{browser});await engine.start();
      await engine.runScenario(c.scenarios[0]).catch(error=>assert.match(error.message,/preparation|review/i));
      assert.equal(gestures,beforeGestures);assert.equal(writes,beforeWrites);assert.ok(writes<=1);
    } finally {await engine.close();}
  });
}

test('legacy full-state ledger resumes, new deltas preserve budgets and block an old reader',()=>{
  const c=config(),directory=dir(),s=new Store(directory,c);const state=structuredClone(s.state);s.close();
  state.calls=2;state.reservedMicros=30000;state.holds=['legacy-intent'];
  const entry={sequence:1,previous:'genesis',time:new Date().toISOString(),type:'legacy-snapshot',facts:{},state};
  fs.writeFileSync(path.join(directory,'ledger.jsonl'),JSON.stringify({...entry,digest:hash(entry)})+'\n');
  let store=new Store(directory,c);
  try {assert.equal(store.state.calls,2);store.state.calls++;store.commit('new-reservation');}
  finally {store.close();}
  const rows=fs.readFileSync(path.join(directory,'ledger.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.at(-1).format,2);assert.notEqual(rows.at(-1).state.configHash,hash(c),'original reader configuration check must fail instead of reset');
  store=new Store(directory,c);try{assert.equal(store.state.calls,3);assert.equal(store.state.reservedMicros,30000);assert.deepEqual(store.state.holds,['legacy-intent']);}finally{store.close();}
});

test('legacy uncorrelated intent remains readable and uncertain with no worker or gesture',async()=>{
  const c=config(),directory=dir();delete c.scenarios[0].operationId;for(const p of c.scenarios[0].probes)delete p.correlation;c.scenarios[0].probeTimeoutMs=1;
  const s=new Store(directory,c);s.state.intents.i={id:'i',scenario:c.scenarios[0].id,phase:'attempted',evidence:[],requests:{},endpoints:[]};s.state.holds=['i'];s.commit('legacy-intent');s.close();
  let gestures=0,calls=0;
  const p=worker();p.decide=async()=>{calls++;return {action:'finish'};};
  const browser={start:async()=>{},close:async()=>{},act:async()=>{gestures++;},probe:async()=>({available:true,matched:true,checks:[]})};
  const engine=new Engine(c,directory,p,{browser,readbackOnly:true});
  try{await engine.start();assert.equal(await engine.reconcile(c.scenarios[0]),'uncertain');await assert.rejects(engine.decision(c.scenarios[0]),/Readback/);await assert.rejects(engine.execute(c.scenarios[0],c.scenarios[0].steps[0],{action:'observe'}),/Readback/);assert.equal(engine.report().exitCode,2);assert.equal(gestures+calls,0);}
  finally{await engine.close();}
});

test('a partial append failure never advances or permits another reservation',()=>{
  const c=config(),directory=dir(),s=new Store(directory,c),write=fs.writeSync;const initial=s.sequence;let partial=false;
  try {
    fs.writeSync=(fd,buffer,offset,length)=>{if(partial)throw Error('Injected disk full');partial=true;return write(fd,buffer,offset,Math.min(length,11));};
    assert.throws(()=>s.commit('partial-error'),/disk full/);fs.writeSync=write;
    assert.equal(s.sequence,initial);assert.throws(()=>s.reserve({id:'x',maxCostMicros:0},{available:true,remainingFraction:1,checkedAt:Date.now()},c.budget),/Ledger failure/);
  }finally{fs.writeSync=write;s.close();}
  assert.throws(()=>new Store(directory,c),/Truncated/);
});

test('failed role initialization clears the old session and closes the partial browser',async()=>{
  const c=config();let failure=false,closed=0;
  const browser={start:async()=>{if(failure)throw Error('Synthetic role failure');},close:async()=>{closed++;},observe:async()=>({id:'s',path:'/',text:'Synthetic',elements:[]})};
  const engine=new Engine(c,dir(),worker(),{browser});
  try{await engine.start('first');const old=engine.sessionId;failure=true;await assert.rejects(engine.start('second'),/role failure/);assert.equal(engine.sessionId,null);assert.equal(engine.role,null);assert.equal(engine.view,null);assert.ok(old);assert.equal(closed,2);}
  finally{await engine.close();}
});

test('readback-only owner checks preserve independent proof without requiring a new screenshot',async()=>{
  const c=config();c.scenarios[0].readChecks=[{id:'total',path:'/api/state',checks:[{path:'total',op:'equals',value:20}]}];
  const browser={start:async()=>{},close:async()=>{},probe:async()=>({available:true,matched:false,checks:[{path:'total',expected:20,observed:21,pass:false}]})};
  const engine=new Engine(c,dir(),worker(),{browser,readbackOnly:true});
  try{await engine.start();await engine.verifyChecks(c.scenarios[0]);const report=engine.report();assert.equal(report.exitCode,3);assert.equal(report.hypotheses[0].evidence,null);assert.equal(report.coverage[0].samples.length,2);assert.equal(report.observations.length,0);}
  finally{await engine.close();}
});
