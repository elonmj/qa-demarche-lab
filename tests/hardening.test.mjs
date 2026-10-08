import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Redactor, validateConfig, Policy } from '../src/policy.mjs';
import { Store } from '../src/store.mjs';
import { Engine } from '../src/engine.mjs';
import { ScriptedProvider, validateDecision } from '../src/providers.mjs';
import { reportExitCode } from '../src/report.mjs';
import { shopConfig } from '../fixtures/sites.mjs';

const directory = () => fs.mkdtempSync(path.join(os.tmpdir(), 'qa-lab-hardening-'));
const config = () => shopConfig('http://127.0.0.1:1234');
const browser = () => ({ role: 'visitor', start: async function(role) { this.role = role || 'visitor'; }, observe: async () => ({id:'view',path:'/',text:'Synthetic',elements:[]}), close: async () => {} });

test('structured redaction preserves JSON and masks escaped, overlapping and nested secrets', () => {
  const secret = 'synthetic-"secret"\\\n', redactor = new Redactor(['abc', 'abcdef', secret]);
  const input = { nested: [secret, `prefix ${secret} suffix`, 'abcdef'], [secret]: secret, count: 3 };
  const output = redactor.value(input);
  assert.deepEqual(output, {nested:['[REDACTED]', 'prefix [REDACTED] suffix', '[REDACTED]'], '[REDACTED]':'[REDACTED]', count:3});
  assert.ok(!JSON.stringify(output).includes('def'));
});

test('malformed consent bodies are denied without consuming request reservations', () => {
  const c = config(), store = new Store(directory(), c), policy = new Policy(c, store);
  try {
    store.state.intents.i = {phase:'attempted',endpoints:c.scenarios[0].writeConsent.endpoints,requests:{}};
    policy.active = 'i';
    for (const payload of ['null', '[]', '3', '"value"', '{']) {
      assert.doesNotThrow(() => assert.equal(policy.request(c.origin+'/api/save','POST',payload).allow, false));
    }
    assert.deepEqual(store.state.intents.i.requests, {});
  } finally { store.close(); }
});

test('configuration rejects unbounded caps, invalid assertions and contradictory consent', () => {
  const mutations = [
    c => { c.maxExternalActions = Infinity; },
    c => { c.maxRepeatedStates = 0; },
    c => { c.budget.quotaMaxAgeMs = Infinity; },
    c => { c.scenarios[0].settleMs = -1; },
    c => { c.scenarios[0].probeTimeoutMs = 0; },
    c => { c.scenarios[0].probes[0].checks[0].op = 'invented'; },
    c => { c.scenarios[0].writeConsent.endpoints[0].path = '/api/../save'; },
    c => { c.scenarios[0].writeConsent.endpoints = []; },
    c => { c.reads.push({path:'/api/save',methods:['GET']}); c.scenarios[0].writeConsent.endpoints[0].methods = ['GET']; },
    c => { delete c.scenarios[0].writeConsent; },
    c => { delete c.scenarios[0].steps[2].action; },
    c => { c.scenarios[0].steps[2].submit = 'true'; },
  ];
  for (const mutate of mutations) {
    const c = config(); mutate(c);
    assert.throws(() => validateConfig(c), undefined, mutate.toString());
  }
});

test('closed stores cannot write or reserve while another writer owns the run', () => {
  const c = config(), dir = directory(), old = new Store(dir, c); old.close();
  const current = new Store(dir, c);
  try {
    assert.throws(() => old.commit('after-close'), /closed|lock/i);
    assert.throws(() => old.reserve({id:'x',maxCostMicros:0},{available:true,remainingFraction:1,checkedAt:Date.now()},c.budget), /closed|lock/i);
    assert.equal(old.state.calls, 0);
  } finally { current.close(); }
});

test('failed durable append stops further actions even after filesystem recovery', () => {
  const c = config(), store = new Store(directory(), c), ledger = store.file;
  try {
    store.file = store.directory;
    assert.throws(() => store.commit('write-fails'));
    store.file = ledger;
    assert.throws(() => store.commit('must-not-resume'), /journal|ledger/i);
    const policy = new Policy(c, store);
    assert.throws(() => policy.request(c.origin+'/api/state','GET'), /journal|ledger/i);
  } finally { store.file = ledger; store.close(); }
});

test('quota transport failure latches circuit across restart without reserving a model call', async () => {
  const c = config(), dir = directory(); let reads = 0;
  const provider = {id:'broken-quota',maxCostMicros:0,quota:async()=>{reads++;throw Error('synthetic quota failure');},decide:async()=>{throw Error('must never decide');}};
  let engine = new Engine(c, dir, provider, {browser:browser()});
  try { await engine.start(); await assert.rejects(engine.decision(c.scenarios[0]), /quota failure/); }
  finally { await engine.close(); }
  engine = new Engine(c, dir, provider, {browser:browser()});
  try {
    await engine.start(); await assert.rejects(engine.decision(c.scenarios[0]), /circuit/);
    assert.equal(reads, 1); assert.equal(engine.store.state.calls, 0);
  } finally { await engine.close(); }
});

test('passed owner checks preserve both independent values and scope in the report', async () => {
  const c = config(), dir = directory();
  c.scenarios[0].readChecks = [{id:'count',path:'/api/state',scope:{unit:'items'},checks:[{path:'count',op:'equals',value:3}]}];
  const b = browser(); b.probe = async () => ({available:true,matched:true,scope:{unit:'items'},checks:[{path:'count',expected:3,observed:3,pass:true}]});
  const engine = new Engine(c, dir, new ScriptedProvider(()=>({action:'finish'})), {browser:b});
  try {
    await engine.start(); await engine.verifyChecks(c.scenarios[0]);
    const report = engine.report(), check = report.coverage[0];
    assert.equal(check.verdict, 'pass'); assert.equal(check.samples.length, 2);
    assert.deepEqual(check.samples.map(s=>s.checks[0].observed), [3,3]);
    assert.deepEqual(check.samples.map(s=>s.id), check.evidence);
    assert.equal(check.samples[0].scope.unit, 'items');
  } finally { await engine.close(); }
});

test('same failed check in different missions remains two scoped findings', async () => {
  const c = config(); c.scenarios = ['first','second'].map(id=>({id,steps:[],readChecks:[{id:'same',path:'/api/state',checks:[{path:'count',op:'equals',value:3}]}]}));
  const b = browser(); b.probe = async () => ({available:true,matched:false,checks:[{path:'count',expected:3,observed:4,pass:false}]});
  const engine = new Engine(c, directory(), new ScriptedProvider(()=>({action:'finish'})), {browser:b});
  try {
    await engine.start(); for (const s of c.scenarios) await engine.verifyChecks(s);
    assert.equal(engine.store.state.candidates.length, 2);
  } finally { await engine.close(); }
});

test('partial writes are completed before advancing the durable ledger', () => {
  const c = config(), dir = directory(), store = new Store(dir,c), original = fs.writeSync;
  try {
    fs.writeSync = (fd, buffer, offset, length) => original(fd, buffer, offset, Math.min(length, 17));
    store.commit('partial-write');
  } finally { fs.writeSync = original; store.close(); }
  const resumed = new Store(dir,c);
  try { assert.equal(resumed.events.at(-1).type,'partial-write'); }
  finally { resumed.close(); }
});

test('deadline expiring during quota read prevents the model call', async () => {
  const c = config(); c.budget.maxDurationMs = 1000;
  let calls = 0, now = Date.now();
  const provider = new ScriptedProvider(()=>{calls++;return {action:'finish'};});
  provider.quota = async()=>{now+=2000;return {available:true,remainingFraction:1,checkedAt:Date.now()};};
  const engine = new Engine(c,directory(),provider,{browser:browser(),clock:()=>now});
  try {
    await engine.start(); await assert.rejects(engine.decision(c.scenarios[0]),/deadline/);
    assert.equal(calls,0); assert.equal(engine.store.state.calls,0);
  } finally { await engine.close(); }
});

test('malformed actions fail validation before touching a browser', () => {
  for (const decision of [[], {action:'click',ref:-1,snapshotId:'s'}, {action:'click',ref:0,snapshotId:''}, {action:'slider',ref:0,snapshotId:'s',value:2}, {action:'select',ref:0,snapshotId:'s',value:5}, {action:'scroll',value:Infinity}]) assert.throws(()=>validateDecision(decision));
});

test('machine verdict distinguishes unresolved intentions, defects and missing prerequisites', () => {
  const report = {holds:0,coverage:[],providerFault:null};
  assert.equal(reportExitCode(report),0);
  assert.equal(reportExitCode({...report,coverage:[{verdict:'fail'}]}),3);
  assert.equal(reportExitCode({...report,holds:1,coverage:[{verdict:'fail'}]}),2);
  assert.equal(reportExitCode({...report,coverage:[{verdict:'blocked-prerequisite'}]}),4);
  assert.equal(reportExitCode({...report,coverage:[{verdict:'inconclusive'}]}),4);
  assert.equal(reportExitCode({...report,providerFault:{stage:'quota'}}),4);
});

test('missions without an explicit role retain the owner-selected bootstrap role', async () => {
  const c = config(), b = browser(), engine = new Engine(c,directory(),new ScriptedProvider(()=>({action:'finish'})),{browser:b});
  try {
    await engine.start('owner-role'); await engine.explore(c.scenarios[0]);
    assert.equal(engine.role,'owner-role');
  } finally { await engine.close(); }
});

test('known escaped session secrets stay absent from the durable evidence and report', async () => {
  const c=config(), dir=directory(), secret='synthetic-"session"\\\n', redactor=new Redactor([secret]);
  const b=browser(); b.redactor=redactor;
  b.observe=async()=>redactor.value({id:'s',path:'/',text:secret,elements:[{name:'Synthetic',value:secret,disabled:false}]});
  const engine=new Engine(c,dir,new ScriptedProvider(()=>({action:'finish',claim:secret})),{browser:b});
  try {
    await engine.start(); await engine.explore(c.scenarios[0]); engine.report();
    for(const name of ['ledger.jsonl','report.json','REPORT.md']) {
      const content=fs.readFileSync(path.join(dir,name),'utf8');
      assert.ok(!content.includes(JSON.stringify(secret).slice(1,-1)),name);
      assert.ok(content.includes('[REDACTED]'),name);
    }
  } finally { await engine.close(); }
});

test('all published site profiles remain valid with stricter configuration checks', () => {
  for(const file of fs.readdirSync(new URL('../examples/',import.meta.url)).filter(f=>f.endsWith('.json') && f!=='gateway-contract.json')) {
    const value=JSON.parse(fs.readFileSync(new URL(`../examples/${file}`,import.meta.url)));
    assert.doesNotThrow(()=>validateConfig(value),file);
  }
});
