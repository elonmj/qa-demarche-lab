import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Engine} from '../src/engine.mjs';
import {ScriptedProvider} from '../src/providers.mjs';
import {handleRequest} from '../src/protocol.mjs';
import {startShop,shopConfig} from '../fixtures/sites.mjs';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('any orchestrator protocol: observe -> authored steps -> independent outcome, no accidental replay',async()=>{
  const site=await startShop(),config=shopConfig(site.origin,'basic','rpc'),directory=fs.mkdtempSync(path.join(os.tmpdir(),'qa-lab-rpc-'));
  const engine=new Engine(config,directory,new ScriptedProvider(()=>({action:'finish'})));
  const call=(method,params={})=>handleRequest(engine,{jsonrpc:'2.0',id:1,method,params});
  try{
    await engine.start();const init=await call('initialize');assert.equal(init.protocol,'qa-lab/1');
    const scenario=config.scenarios[0].id;
    await assert.rejects(call('step',{scenario,step:'submit'}),/Preceding/);assert.equal(site.state.requests,0);
    for(const step of ['key','prepare','submit'])await call('step',{scenario,step});
    const status=await call('status');assert.equal(status.intents[0].phase,'confirmed');assert.equal(site.state.requests,1);
    await assert.rejects(call('step',{scenario,step:'submit'}),/attempted/);assert.equal(site.state.requests,1);
    await assert.rejects(call('act',{scenario,decision:{action:'shell'}}),/Invalid/);
    await assert.rejects(call('authorize',{scenario}),/Unknown method/);
    assert.equal((await call('report')).intents[0].phase,'confirmed');
  }finally{await engine.close();await site.close();}
});
test('real stdio child serves JSON-RPC, saves report and closes cleanly',async()=>{
  const site=await startShop(),config=shopConfig(site.origin),directory=fs.mkdtempSync(path.join(os.tmpdir(),'qa-lab-stdio-')),file=path.join(directory,'config.json');fs.writeFileSync(file,JSON.stringify(config));
  let child;
  try{
    const cli=fileURLToPath(new URL('../src/cli.mjs',import.meta.url));child=spawn(process.execPath,[cli,'serve',file,path.join(directory,'run')],{windowsHide:true,stdio:['pipe','pipe','pipe']});
    let output='',diagnostic='';child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>diagnostic+=c);
    child.stdin.end([{jsonrpc:'2.0',id:1,method:'initialize'},{jsonrpc:'2.0',id:2,method:'status'},{jsonrpc:'2.0',id:3,method:'close'}].map(JSON.stringify).join('\n')+'\n');
    const code=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('stdio startup timeout'));},15000);child.once('error',reject);child.once('close',code=>{clearTimeout(timer);resolve(code);});});
    assert.equal(code,0,diagnostic);const rows=output.trim().split('\n').map(JSON.parse);assert.equal(rows.length,3);assert.equal(rows[0].result.protocol,'qa-lab/1');assert.equal(rows[2].result.closed,true);assert.ok(fs.existsSync(path.join(directory,'run','REPORT.md')));assert.equal(site.state.requests,0);
  }finally{if(child?.exitCode===null)child.kill('SIGKILL');await site.close();}
});
