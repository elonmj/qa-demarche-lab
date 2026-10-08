import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import {CliProvider,parseCliReply,parseOneJson,normalizeQuota,runCli,resolveCommand,createNativeToolGate,readCodexQuota} from '../src/cli-provider.mjs';
import {Store} from '../src/store.mjs';
import {Engine} from '../src/engine.mjs';
import {shopConfig} from '../fixtures/sites.mjs';

test('CLI parser contracts: Antigravity, Gemini, Codex and arbitrary JSON wrapper',()=>{
  const decision={action:'finish',claim:'UI observed, no business certification'};
  const agy=[{event:'init',init:{model:'my-gemini',tools:[]}},{event:'result',result:{status:'SUCCESS',num_turns:1,response:JSON.stringify(decision),usage:{total_tokens:42}}}].map(JSON.stringify).join('\n');
  assert.equal(parseCliReply('antigravity',agy,'my-gemini').usage.total_tokens,42);
  const gemini=[{type:'init',model:'explicit-model'},{type:'message',role:'assistant',content:JSON.stringify(decision)},{type:'result',status:'success',stats:{total_tokens:41}}].map(JSON.stringify).join('\n');
  assert.equal(parseCliReply('gemini',gemini,'explicit-model').decision.action,'finish');
  const codex=[{type:'item.completed',item:{type:'agent_message',text:JSON.stringify(decision)}},{type:'turn.completed',usage:{input_tokens:4,output_tokens:5}}].map(JSON.stringify).join('\n');
  assert.equal(parseCliReply('codex',codex,'chosen').decision.action,'finish');
  assert.equal(parseCliReply('json-cli',JSON.stringify(decision),'chosen').decision.action,'finish');
});
test('tools, substituted model, ambiguous turns and hallucinated arbitrary commands rejected',()=>{
  assert.throws(()=>parseCliReply('antigravity',JSON.stringify({event:'init',init:{tools:['read_file']}}),'m'),/tools/);
  assert.throws(()=>parseCliReply('antigravity',JSON.stringify({event:'init',init:{model:'different'}}),'m'),/substituted/);
  assert.throws(()=>parseCliReply('gemini',JSON.stringify({type:'tool_use',name:'shell'}),'m'),/tool/);
  assert.throws(()=>parseOneJson('{"action":"shell","command":"secret"}'),/Invalid/);
  assert.throws(()=>parseOneJson('{"action":"finish"}\n{"action":"observe"}'),/one JSON/);
  assert.throws(()=>new CliProvider({id:'x',kind:'gemini',model:'x',billing:{mode:'api'}}),/subscription/);
  assert.throws(()=>resolveCommand('gemini','gemini.cmd'),/shell shims/);
});
test('actual process runner: stdin JSON, no secret env, private stderr, timeout and tool event kill',async()=>{
  process.env.QA_TEST_PRIVATE_SECRET='DO-NOT-PASS-SYNTHETIC';
  try{
    const output=await runCli(process.execPath,['-e',"let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>console.log(JSON.stringify({stdin:s,secret:process.env.QA_TEST_PRIVATE_SECRET || null})))"],{input:'trusted',cwd:os.tmpdir(),timeoutMs:2000});
    assert.deepEqual(JSON.parse(output),{stdin:'trusted',secret:null});
    await assert.rejects(runCli(process.execPath,['-e',"console.error('private-session-data');process.exit(1)"],{cwd:os.tmpdir(),timeoutMs:2000}),error=>!error.message.includes('private-session-data'));
    await assert.rejects(runCli(process.execPath,['-e','setInterval(()=>{},1000)'],{cwd:os.tmpdir(),timeoutMs:150}),/timeout/);
    await assert.rejects(runCli(process.execPath,['-e',"console.log(JSON.stringify({type:'tool_use'}));setInterval(()=>{},1000)"],{cwd:os.tmpdir(),timeoutMs:2000,inspect:event=>event.type!=='tool_use'}),/policy/);
  }finally{delete process.env.QA_TEST_PRIVATE_SECRET;}
});
test('quota normalization requires actual typed counters, no assumed availability',()=>{
  assert.equal(normalizeQuota({status:'SUCCESS',command:{data:{groups:[{name:'Gemini Models',buckets:[{remaining_fraction:0.8},{remaining_fraction:0.6}]}]}}},'antigravity').remainingFraction,0.6);
  assert.throws(()=>normalizeQuota({status:'SUCCESS'},'antigravity'),/unavailable/);
  assert.equal(normalizeQuota({rateLimits:{primary:{usedPercent:40}}},'codex').remainingFraction,0.6);
  assert.throws(()=>normalizeQuota({available:true,remainingFraction:0.9},'json-cli'),/unavailable/);
});
test('Codex quota reader uses initialize + read-only limits contract without inference',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'qa-lab-quota-rpc-')),file=path.join(directory,'fake-server.mjs');
  fs.writeFileSync(file,`import readline from 'node:readline';const reader=readline.createInterface({input:process.stdin});for await(const line of reader){const m=JSON.parse(line);if(m.method==='initialize')console.log(JSON.stringify({id:m.id,result:{}}));else if(m.method==='initialized'){}else if(m.method==='account/rateLimits/read')console.log(JSON.stringify({id:m.id,result:{rateLimits:{primary:{usedPercent:20}}}}));else process.exit(2);}`);
  const result=await readCodexQuota({executable:process.execPath,args:[file]});assert.equal(normalizeQuota(result,'codex').remainingFraction,0.8);
});
test('native gate denies every tool payload and requires a fresh invocation attestation',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'qa-lab-native-gate-')),gate=createNativeToolGate(directory);
  assert.equal(gate.attested(),false);
  const reply=await runCli(process.execPath,[gate.handler,'deny'],{cwd:directory,input:JSON.stringify({toolCall:{name:'view_file',args:{AbsolutePath:'forbidden-private-path'}}}),timeoutMs:2000});
  assert.equal(JSON.parse(reply).decision,'deny');assert.equal(gate.attested(),false);
  await runCli(process.execPath,[gate.handler,'attest'],{cwd:directory,timeoutMs:2000});assert.equal(gate.attested(),true);
  const response=[{event:'init',init:{tools:['view_file'],model:'m'}},{event:'result',result:{status:'SUCCESS',num_turns:1,response:'{"action":"finish"}'}}].map(JSON.stringify).join('\n');
  assert.throws(()=>parseCliReply('antigravity',response,'m'),/exposed/);
  assert.equal(parseCliReply('antigravity',response,'m',{nativeGateAttested:gate.attested()}).decision.action,'finish');
});
test('declared workers share persistent call cap; undeclared fallback remains denied',()=>{
  const config=shopConfig('http://127.0.0.1:1234');config.agents={low:{kind:'json-cli'},review:{kind:'json-cli'}};config.defaultAgent='low';config.budget.maxCalls=2;
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'qa-lab-workers-'));let store=new Store(directory,config);
  const quota={available:true,remainingFraction:0.9,checkedAt:Date.now()};
  store.reserve({id:'low',maxCostMicros:0},quota,config.budget);store.close();store=new Store(directory,config);store.reserve({id:'review',maxCostMicros:0},quota,config.budget);
  assert.equal(store.state.calls,2);assert.equal(store.state.workerUsage.low.calls,1);assert.throws(()=>store.reserve({id:'low',maxCostMicros:0},quota,config.budget),/exhausted/);
  assert.throws(()=>store.reserve({id:'unexpected',maxCostMicros:0},quota,config.budget),/Undeclared/);store.close();
});
test('worker failure latches circuit across resume instead of new calls/fallback',async()=>{
  const config=shopConfig('http://127.0.0.1:1234'),directory=fs.mkdtempSync(path.join(os.tmpdir(),'qa-lab-fault-'));
  const fake={id:'broken',maxCostMicros:0,quota:async()=>({available:true,remainingFraction:1,checkedAt:Date.now()}),decide:async()=>{throw Error('failure');}};
  const browser={start:async()=>{},observe:async()=>({id:'s',path:'/',text:'Visible',elements:[]}),close:async()=>{}};
  let engine=new Engine(config,directory,fake,{browser});await engine.start();await assert.rejects(engine.decision(config.scenarios[0]),/failure/);await engine.close();
  engine=new Engine(config,directory,fake,{browser});await engine.start();await assert.rejects(engine.decision(config.scenarios[0]),/circuit/);assert.equal(engine.store.state.calls,1);await engine.close();
});
