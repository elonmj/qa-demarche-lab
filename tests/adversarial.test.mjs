import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { PassThrough } from 'node:stream';
import { Engine } from '../src/engine.mjs';
import { Store } from '../src/store.mjs';
import { Redactor, validateConfig, checkValue, Policy } from '../src/policy.mjs';
import { ScriptedProvider, JsonGatewayProvider, validateDecision } from '../src/providers.mjs';
import { BrowserAdapter } from '../src/browser.mjs';
import { serveStdio, handleRequest } from '../src/protocol.mjs';
import { parseCliReply, runCli } from '../src/cli-provider.mjs';
import { shopConfig, startShop } from '../fixtures/sites.mjs';

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'qa-lab-adversarial-'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const config = () => shopConfig('http://127.0.0.1:1234');
const fake = () => ({start:async()=>{},close:async()=>{},observe:async()=>({id:'s',path:'/',text:'Synthetic',elements:[]}),act:async()=>{},probe:async(p,options)=>({available:true,matched:!options?.preflight,checks:[],correlation:{pass:!options?.preflight}})});
const provider = () => new ScriptedProvider(()=>({action:'finish'}));
function pending(engine, c) {
  engine.store.state.intents.i = {id:'i',scenario:c.scenarios[0].id,phase:'uncertain',endpoints:[],requests:{},evidence:[]};
  engine.store.state.holds.push('i'); engine.store.commit('synthetic-interruption');
}
async function server(fn, callback) {
  const s=http.createServer(fn); await new Promise(resolve=>s.listen(0,'127.0.0.1',resolve));
  try { return await callback(`http://127.0.0.1:${s.address().port}`); }
  finally { s.closeAllConnections(); await new Promise(resolve=>s.close(resolve)); }
}

test('A1 concurrent direct submissions admit exactly one gesture and one durable intent', async()=>{
  const c=config(), b=fake(); c.scenarios[0].steps=[{id:'submit',action:'observe',submit:true}]; c.scenarios[0].settleMs=0;
  let gestures=0; b.act=async()=>{gestures++;await delay(20);};
  const engine=new Engine(c,dir(),provider(),{browser:b});
  try {
    await engine.start(); const s=c.scenarios[0];
    const results=await Promise.allSettled([engine.execute(s,s.steps[0],{action:'observe'}),engine.execute(s,s.steps[0],{action:'observe'})]);
    assert.equal(gestures,1); assert.equal(Object.keys(engine.store.state.intents).length,1);
    assert.equal(results.filter(r=>r.status==='rejected').length,1);
  } finally { await engine.close(); }
});

test('A2 campaign deadline also blocks authored preparation and external API actions', async()=>{
  const c=config(), b=fake(); c.budget.maxDurationMs=1000; let now=Date.now(), gestures=0;
  b.act=async()=>{gestures++;}; const engine=new Engine(c,dir(),provider(),{browser:b,clock:()=>now});
  try { await engine.start(); now+=2000; await assert.rejects(engine.execute(c.scenarios[0],{id:'external',submit:false},{action:'observe'}),/deadline/); assert.equal(gestures,0); }
  finally { await engine.close(); }
});

test('A3 slow custom worker is bounded by the remaining campaign deadline', async()=>{
  const c=config(); c.budget.maxDurationMs=160;
  const p=provider(); p.decide=async()=>{await delay(400);return {action:'finish'};};
  const engine=new Engine(c,dir(),p,{browser:fake()});
  try { await engine.start(); const t=Date.now(); await assert.rejects(engine.decision(c.scenarios[0]),/deadline|timeout/); assert.ok(Date.now()-t<320); assert.equal(engine.store.state.calls,1); assert.ok(engine.store.state.providerFault); }
  finally { await engine.close(); }
});

test('A4 crash after durable worker reservation prevents another call on restart', async()=>{
  const c=config(), directory=dir(), p=provider(); let calls=0; p.decide=async()=>{calls++;return {action:'finish'};};
  const store=new Store(directory,c); store.reserve(p,await p.quota(),c.budget); store.close();
  const engine=new Engine(c,directory,p,{browser:fake()});
  try { await engine.start(); await assert.rejects(engine.decision(c.scenarios[0]),/pending|interrupted|circuit/i); assert.equal(calls,0); assert.equal(engine.store.state.calls,1); }
  finally { await engine.close(); }
});

test('A5 unavailable competing oracle cannot be interpreted as a confirmed outcome', async()=>{
  const c=config(), b=fake(); c.scenarios[0].probeTimeoutMs=1;
  b.probe=async p=>p.verdict==='confirmed'?{available:true,matched:true,checks:[]}:{available:false,matched:false,checks:[]};
  const engine=new Engine(c,dir(),provider(),{browser:b});
  try { await engine.start(); pending(engine,c); assert.equal(await engine.reconcile(c.scenarios[0]),'uncertain'); assert.deepEqual(engine.store.state.holds,['i']); }
  finally { await engine.close(); }
});

test('A6 business probes require explicit operation correlation instead of an old status', ()=>{
  const c=config(); delete c.scenarios[0].operationId;
  c.scenarios[0].probes=[{path:'/api/state',verdict:'confirmed',checks:[{path:'status',op:'equals',value:'saved'}]}];
  assert.throws(()=>validateConfig(c),/correlation|operation/i);
});

test('A7 configured scope must be verified before a read becomes a product defect', async()=>{
  const c=config(); c.scenarios[0].readChecks=[{id:'total',path:'/api/state',scope:{account:'owner'},scopeChecks:[{path:'account',op:'equals',value:'owner'}],checks:[{path:'total',op:'equals',value:20}]}];
  await server((req,res)=>res.end(JSON.stringify({account:'someone-else',total:21})),async origin=>{
    c.origin=origin; const engine=new Engine(c,dir(),provider());
    try { await engine.start(); await engine.verifyChecks(c.scenarios[0]); assert.equal(engine.store.state.candidates.length,0); assert.equal(engine.store.state.coverage[0].verdict,'blocked-prerequisite'); }
    finally { await engine.close(); }
  });
});

test('A8 known secrets in failed check expectations, scope and worker input never persist', async()=>{
  const c=config(), secret='synthetic-expectation-canary', b=fake(), directory=dir();
  c.scenarios[0].goal=secret; c.scenarios[0].readChecks=[{id:'secret-check',path:'/api/state',scope:{account:secret},checks:[{path:'value',op:'equals',value:secret}]}];
  b.redactor=new Redactor([secret]); b.probe=async()=>({available:true,matched:false,checks:[{path:'value',expected:'[REDACTED]',observed:'wrong',pass:false}],scope:{account:'[REDACTED]'}});
  const p=new ScriptedProvider(input=>{assert.ok(!JSON.stringify(input).includes(secret));return {action:'finish'};});
  const engine=new Engine(c,directory,p,{browser:b});
  try { await engine.start(); await engine.verifyChecks(c.scenarios[0]); engine.report(); for(const f of ['ledger.jsonl','REPORT.md','report.json']) assert.ok(!fs.readFileSync(path.join(directory,f),'utf8').includes(secret),f); await engine.decision(c.scenarios[0]);await engine.execute(c.scenarios[0],{id:'path',submit:false},{action:'navigate',path:'/'+secret});engine.report();for(const f of ['ledger.jsonl','REPORT.md','report.json'])assert.ok(!fs.readFileSync(path.join(directory,f),'utf8').includes(secret),'action path: '+f); }
  finally { await engine.close(); }
});

test('A9 text and names are redacted before truncation can expose a secret prefix', async()=>{
  const site=await startShop(), c=shopConfig(site.origin), secret='CANARY-TRUNCATION-UNIQUE', directory=dir();
  const engine=new Engine(c,directory,provider(),{privateOptions:{secrets:[secret]}});
  try {
    await engine.start(); await engine.browser.page.evaluate(secret=>{document.body.replaceChildren();const b=document.createElement('button');b.setAttribute('aria-label','x'.repeat(150)+secret);b.textContent='x'.repeat(13990)+secret;document.body.append(b);},secret);
    const view=await engine.observe(); assert.ok(!JSON.stringify(view).includes('CANARY-TRU')); engine.report();
  } finally { await engine.close(); await site.close(); }
});

test('A10 gateway byte cap cancels a response before its deliberately stalled tail', async()=>{
  await server((req,res)=>{res.setHeader('content-type','application/json');res.write(' '.repeat(25000));const timer=setTimeout(()=>res.end('{}'),600);res.on('close',()=>clearTimeout(timer));},async origin=>{
    const p=new JsonGatewayProvider({id:'local',endpoint:origin,quotaEndpoint:origin,maxCostMicros:0,token:'synthetic',model:'fake'});
    const t=Date.now(); await assert.rejects(p.decide({}),/large|cap/i); assert.ok(Date.now()-t<450);
  });
});

test('A11 probe byte cap cancels oversized body before a stalled tail', async()=>{
  await server((req,res)=>{res.write(' '.repeat(110000));const timer=setTimeout(()=>res.end('{}'),600);res.on('close',()=>clearTimeout(timer));},async origin=>{
    const c=config(); c.origin=origin; const store=new Store(dir(),c);
    const b=new BrowserAdapter(c,{request:()=>({allow:true})},store);
    try { const t=Date.now(); await assert.rejects(b.probe(c.scenarios[0].probes[0]),/large|cap/i); assert.ok(Date.now()-t<450); }
    finally { store.close(); }
  });
});

test('A12 decisions cap structured output even for non-HTTP adapters', ()=>{
  assert.throws(()=>validateDecision({action:'finish',finding:{text:'x'.repeat(25000)}}),/large|cap|bounded/i);
});

test('A13 JSON-RPC errors never reflect arbitrary invalid ids or secrets', async()=>{
  const c=config(), b=fake(), secret='synthetic-rpc-id-secret'; b.redactor=new Redactor([secret]);
  const engine=new Engine(c,dir(),provider(),{browser:b}), input=new PassThrough(), output=new PassThrough(); let text=''; output.on('data',c=>text+=c);
  await engine.start(); input.end(JSON.stringify({jsonrpc:'2.0',id:{secret},method:'status'})+'\n'); await serveStdio(engine,input,output);
  assert.ok(!text.includes(secret)); assert.equal(JSON.parse(text).id,null);
});

test('A14 oversized unterminated JSON-RPC input is rejected before EOF', async()=>{
  const c=config(), engine=new Engine(c,dir(),provider(),{browser:fake()}), input=new PassThrough(), output=new PassThrough(); let text=''; output.on('data',c=>text+=c);
  await engine.start(); const run=serveStdio(engine,input,output); input.write('x'.repeat(100001));
  try { await delay(80); assert.match(text,/too large/i); }
  finally { input.end(); await run; }
});

test('A15 CLI parser requires one initialized scope and no hidden error events', ()=>{
  const result={type:'result',status:'success'};
  const msg={type:'message',role:'assistant',content:'{"action":"finish"}'};
  assert.throws(()=>parseCliReply('gemini',[msg,result].map(JSON.stringify).join('\n'),'m'),/init|scope/i);
  assert.throws(()=>parseCliReply('gemini',[{type:'init',model:'m'},msg,{type:'error',message:'failure'},result].map(JSON.stringify).join('\n'),'m'),/error|failed/i);
});

test('A16 process output decoding survives UTF-8 characters split across chunks', async()=>{
  const code="const b=Buffer.from(JSON.stringify({action:'finish',claim:'é'}));const i=b.indexOf(195);process.stdout.write(b.subarray(0,i+1));setTimeout(()=>process.stdout.end(b.subarray(i+1)),30);";
  const text=await runCli(process.execPath,['-e',code],{timeoutMs:2000}); assert.equal(JSON.parse(text).claim,'é');
});

test('A17 event cache does not retain a deep full-state copy at every append', ()=>{
  const c=config(), directory=dir(), store=new Store(directory,c);
  try { for(let n=0;n<60;n++){store.state.observations.push({id:String(n),text:'x'.repeat(10000)});store.commit('observed');} assert.ok(JSON.stringify(store.events).length<100000); }
  finally { store.close(); }
  const resumed=new Store(directory,c); try { assert.equal(resumed.state.observations.length,60); assert.ok(JSON.stringify(resumed.events).length<100000); } finally { resumed.close(); }
});

test('A18 engine cannot report or gesture after losing its lock during await', async()=>{
  const c=config(), b=fake(); let gestures=0,engine; b.act=async()=>{gestures++;};
  const p=provider(); p.quota=async()=>{fs.writeFileSync(engine.store.lock,JSON.stringify({pid:process.pid,token:'replacement'}));return {available:true,remainingFraction:1,checkedAt:Date.now()};};
  engine=new Engine(c,dir(),p,{browser:b});
  try { await engine.start(); await assert.rejects(engine.decision(c.scenarios[0]),/lock/i); assert.throws(()=>engine.report(),/lock|ledger/i); assert.equal(gestures,0); }
  finally { await engine.close(); }
});

test('A19 preexisting correlated operation is not credited to a gesture with no request', async()=>{
  const site=await startShop(), c=shopConfig(site.origin,'hallucination','already'), engine=new Engine(c,dir(),provider());
  site.state.records.already={reference:'already',status:'saved',quantity:3,unit:'items',date:'2026-10-08',zone:'Africa/Porto-Novo',account:'synthetic-clerk'};
  try { await engine.start(); await assert.rejects(engine.runScenario(c.scenarios[0]),/operation.*exist|preflight/i); assert.equal(site.state.requests,0); assert.equal(Object.keys(engine.store.state.intents).length,0); }
  finally { await engine.close(); await site.close(); }
});

test('A20 reconciliation timeout bounds a slow probe even when the campaign is readback only', async()=>{
  const c=config(), b=fake(); c.scenarios[0].probeTimeoutMs=80;
  b.probe=async()=>{await delay(400);return {available:true,matched:false,checks:[]};};
  const engine=new Engine(c,dir(),provider(),{browser:b});
  try { await engine.start(); pending(engine,c);const t=Date.now();assert.equal(await engine.reconcile(c.scenarios[0]),'uncertain');assert.ok(Date.now()-t<300); }
  finally { await engine.close(); }
});

test('A21 uncertain worker reservation produces an incomplete report exit code', async()=>{
  const c=config(), engine=new Engine(c,dir(),provider(),{browser:fake()});
  try { engine.store.reserve(engine.provider,await engine.provider.quota(),c.budget);assert.equal(engine.report().exitCode,4); }
  finally { await engine.close(); }
});

test('A22 concurrent role switch cannot close the context of a running action', async()=>{
  const c=config(), b=fake();let closed=0;b.close=async()=>{closed++;};b.act=async()=>delay(80);
  const engine=new Engine(c,dir(),provider(),{browser:b});let action;
  try { await engine.start(); action=engine.execute(c.scenarios[0],{id:'draft',submit:false},{action:'observe'});await assert.rejects(engine.start('another-role'),/Concurrent/);await action;assert.equal(engine.role,'visitor');assert.equal(closed,0); }
  finally { await action?.catch(()=>{});await engine.close(); }
});

test('A23 ledger growth stays proportional to appended observations and preserves replay state', ()=>{
  const c=config(), directory=dir(), store=new Store(directory,c);
  try { for(let n=0;n<60;n++){store.state.observations.push({id:String(n),text:'x'.repeat(10000)});store.commit('observed');} assert.ok(fs.statSync(store.file).size<800000); }
  finally { store.close(); }
  const resumed=new Store(directory,c); try { assert.equal(resumed.state.observations.length,60);assert.equal(resumed.state.observations[59].text.length,10000); } finally { resumed.close(); }
});

test('A24 persistent observation cap prevents unbounded screenshots across restart', async()=>{
  const c=config();c.maxObservations=2;const directory=dir();let captures=0;
  const b=fake();b.observe=async()=>{captures++;return {id:String(captures),path:'/',text:'Synthetic',elements:[]};};
  let engine=new Engine(c,directory,provider(),{browser:b});
  try {await engine.start();await engine.observe();await assert.rejects(engine.observe(),/observation.*cap/i);assert.equal(captures,2);await engine.close();engine=new Engine(c,directory,provider(),{browser:b});await assert.rejects(engine.start(),/observation.*cap/i);assert.equal(captures,2);}
  finally {await engine.close();}
});

test('A25 excessive DOM controls are rejected before materializing observation handles', async()=>{
  const site=await startShop(),c=shopConfig(site.origin),engine=new Engine(c,dir(),provider());
  try {await engine.start();await engine.browser.page.evaluate(()=>{document.body.replaceChildren();for(let n=0;n<201;n++)document.body.append(document.createElement('button'));});await assert.rejects(engine.observe(),/control.*cap/i);}
  finally {await engine.close();await site.close();}
});

test('A26 artifact byte budget is reserved before writing a screenshot', async()=>{
  const site=await startShop(),c=shopConfig(site.origin);c.maxArtifactBytes=1;const directory=dir(),engine=new Engine(c,directory,provider());
  try {await assert.rejects(engine.start(),/artifact.*cap/i);assert.equal(fs.readdirSync(directory).filter(f=>f.endsWith('.png')).length,0);}
  finally {await engine.close();await site.close();}
});

test('A27 object assertions ignore JSON object key order but retain array order and types',()=>{
  assert.equal(checkValue({b:2,a:1},{op:'equals',value:{a:1,b:2}}),true);
  assert.equal(checkValue([2,1],{op:'equals',value:[1,2]}),false);
  assert.equal(checkValue({a:'1'},{op:'equals',value:{a:1}}),false);
});

test('A28 assertion expectations reject non-JSON values before cloning changes their meaning',()=>{
  const c=config();c.scenarios[0].assertions=[{id:'invalid',path:'overflow',op:'equals',value:NaN}];
  assert.throws(()=>validateConfig(c),/JSON|finite|expectation/i);
});

test('A29 a delayed write request is denied once the persistent campaign deadline expires',()=>{
  const c=config();c.budget.maxDurationMs=1;const store=new Store(dir(),c),policy=new Policy(c,store);
  try{store.state.createdAt=new Date(Date.now()-1000).toISOString();store.state.intents.i={phase:'attempted',endpoints:c.scenarios[0].writeConsent.endpoints,requests:{}};policy.active='i';assert.equal(policy.request(c.origin+'/api/save','POST',JSON.stringify({key:'sample',quantity:'3',mode:'basic'})).allow,false);assert.deepEqual(store.state.intents.i.requests,{});}
  finally{store.close();}
});
