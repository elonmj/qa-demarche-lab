import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {Engine} from '../src/engine.mjs';
import {ScriptedProvider} from '../src/providers.mjs';
import {validateConfig} from '../src/policy.mjs';
import {tokenCount} from '../src/usage.mjs';
import {handleRequest} from '../src/protocol.mjs';

const dir=()=>fs.mkdtempSync(path.join(os.tmpdir(),'qa-corrections-'));
function config(origin){return {id:'corrections',origin,entry:'/',browserActionTimeoutMs:5000,browserNavigationTimeoutMs:10000,reads:['/','/next','/bad','/clean','/state','/missing.css'].map(p=>({path:p,methods:['GET']})),budget:{maxCalls:4,maxCostMicros:0,reserveFraction:.15,quotaMaxAgeMs:30000},scenarios:[{id:'inspect',goal:'Inspect synthetic UI',steps:[],assertions:[]}]};}
async function withSite(handler,fn){const s=http.createServer(handler);await new Promise(r=>s.listen(0,'127.0.0.1',r));try{await fn(`http://127.0.0.1:${s.address().port}`);}finally{s.closeAllConnections();await new Promise(r=>s.close(r));}}
const html=(res,text)=>{res.setHeader('content-type','text/html; charset=utf-8');res.end('<!doctype html>'+text);};

test('authored resolution uses full unique names even when worker prefixes collide',()=>withSite((req,res)=>html(res,req.url==='/'?['A','B'].map(end=>`<a href="/next">${'long label '.repeat(17)+end}</a>`).join(''):'<p>Destination</p>'),async origin=>{
 const c=config(origin),target='long label '.repeat(17)+'B';c.scenarios[0].steps=[{id:'open',action:'click',target}];
 const e=new Engine(c,dir(),new ScriptedProvider(()=>({action:'finish'})));
 try{await e.start();assert.equal(e.view.elements[0].name.length,160);assert.equal(e.view.elements[0].name,e.view.elements[1].name);await e.runScenario(c.scenarios[0]);assert.equal(e.view.path,'/next');await e.browser.act({action:'navigate',path:'/'});await e.observe();await e.browser.page.evaluate(()=>document.querySelectorAll('a')[0].textContent=document.querySelectorAll('a')[1].textContent);await e.observe();await assert.rejects(e.resolveStep(c.scenarios[0].steps[0]),/ambiguous/);}finally{await e.close();}
}));

test('control budget is explicit, bounded and reports count without removing the default guard',()=>withSite((q,r)=>html(r,Array.from({length:216},(_,n)=>`<button hidden>control ${n}</button>`).join('')),async origin=>{
 const c=config(origin);let e=new Engine(c,dir(),new ScriptedProvider(()=>({action:'finish'})));
 try{await assert.rejects(e.start(),/216 controls, limit 200/);}finally{await e.close();}
 c.maxDomControls=300;e=new Engine(c,dir(),new ScriptedProvider(()=>({action:'finish'})));
 try{await e.start();assert.equal(e.view.elements.length,0);}finally{await e.close();}
 for(const value of [0,2001,Infinity,1.5])assert.throws(()=>validateConfig({...c,maxDomControls:value}),/maxDomControls/);
 for(const key of ['browserActionTimeoutMs','browserNavigationTimeoutMs'])for(const value of [0,20001,Infinity])assert.throws(()=>validateConfig({...c,[key]:value}),/TimeoutMs/);
}));

test('final exploration assertions execute for finish and bounded stops, preserving scope and UI defects',()=>withSite((q,r)=>html(r,'<div style="width:900px">wide</div>'),async origin=>{
 for(const action of ['finish','observe']){const c=config(origin);c.scenarios[0].assertions=[{id:'fits',path:'overflow',op:'equals',value:false,impact:'Work context is clipped.'}];const directory=dir(),e=new Engine(c,directory,new ScriptedProvider(()=>({action})));
 try{await e.start();assert.equal(await e.explore(c.scenarios[0],1),action==='finish'?'observed':'bounded');const report=e.report();assert.equal(report.coverage[0].verdict,'fail');assert.equal(report.coverage[0].expected,false);assert.equal(report.coverage[0].observed,true);assert.equal(report.coverage[0].role,'visitor');assert.equal(report.findings[0].kind,'ui-assertion-failure');assert.equal(report.exitCode,3);const md=fs.readFileSync(path.join(directory,'REPORT.md'),'utf8');assert.match(md,/attendu false ; observé true/);assert.match(md,/Reproduction/);assert.match(md,/Work context is clipped/);assert.equal(report.intents.length,0);}finally{await e.close();}}
}));

test('each-observation catches a transient defect, deduplicates it and preserves passing later evidence',()=>withSite((q,r)=>html(r,q.url==='/bad'?'<div style="width:900px">wide</div>':'<p>Normal</p>'),async origin=>{
 const c=config(origin);c.scenarios[0].assertions=[{id:'fits',path:'overflow',op:'equals',value:false,timing:'each-observation'}];let n=0;const worker=new ScriptedProvider(()=>({action:'navigate',path:++n<3?'/bad':'/clean'}));const directory=dir();let e=new Engine(c,directory,worker);
 try{await e.start();await e.explore(c.scenarios[0],3);let r=e.report();assert.equal(r.findings.length,1);assert.equal(r.findings[0].evidenceIds.length,2);assert.equal(r.coverage.at(-1).verdict,'pass');assert.equal(r.exitCode,3);await e.close();e=new Engine(c,directory,worker);await e.start();assert.equal(e.report().findings.length,1);}finally{await e.close();}
}));

test('external read-only RPC actions run declared observation checks without certifying a model claim',()=>withSite((q,r)=>html(r,q.url==='/bad'?'<div style="width:900px">wide</div>':'<p>Normal</p>'),async origin=>{
 const c=config(origin);c.scenarios[0].assertions=[{id:'fits',path:'overflow',op:'equals',value:false,timing:'each-observation'}];const e=new Engine(c,dir(),new ScriptedProvider(()=>({action:'finish'})));
 try{await e.start();await handleRequest(e,{jsonrpc:'2.0',id:1,method:'act',params:{scenario:'inspect',decision:{action:'navigate',path:'/bad'}}});const r=e.report();assert.equal(r.findings.length,1);assert.equal(r.coverage[0].verdict,'fail');assert.equal(r.calls,0);assert.equal(r.holds,0);assert.equal(r.actions[0].phase,'observed');}finally{await e.close();}
}));

test('a blocked stylesheet or unavailable observation field is a prerequisite, not a product finding',()=>withSite((q,r)=>{if(q.url==='/missing.css'){r.writeHead(403);return r.end('Denied');}html(r,'<link rel="stylesheet" href="/missing.css"><p>Normal</p>');},async origin=>{
 const c=config(origin);c.scenarios[0].assertions=[{id:'fits',path:'overflow',op:'equals',value:false}];const e=new Engine(c,dir(),new ScriptedProvider(()=>({action:'finish'})));
 try{await e.start();await e.observe();assert.equal(e.view.resourceFailures[0].httpStatus,403);await e.explore(c.scenarios[0],1);assert.equal(e.report().coverage[0].verdict,'blocked-prerequisite');assert.equal(e.report().findings.length,0);}finally{await e.close();}
}));

test('unknown metrics and failed workers never fabricate completed final checks',()=>withSite((q,r)=>html(r,'<p>Normal</p>'),async origin=>{
 for(const fail of [false,true]){const c=config(origin);c.scenarios[0].assertions=[{id:'metric',path:fail?'overflow':'unsupportedMetric',op:'equals',value:false}];const worker=new ScriptedProvider(()=>{if(fail)throw Error('Synthetic worker failure');return {action:'finish'};});const e=new Engine(c,dir(),worker);
 try{await e.start();if(fail)await assert.rejects(e.explore(c.scenarios[0]),/worker failure/);else await e.explore(c.scenarios[0],1);assert.equal(e.report().coverage[0].verdict,fail?'not-run':'blocked-prerequisite');assert.equal(e.report().findings.length,0);}finally{await e.close();}}
}));

test('supplier input/output usage survives new reservations and resume; cached tokens are not doubled',()=>withSite((q,r)=>html(r,'<p>Normal</p>'),async origin=>{
 const c=config(origin),directory=dir(),worker=new ScriptedProvider(()=>({action:'observe'}));worker.lastUsage={input_tokens:13878,output_tokens:70,cached_input_tokens:2000};let e=new Engine(c,directory,worker);
 try{await e.start();await e.explore(c.scenarios[0],1);await e.close();worker.lastUsage={input_tokens:14507,output_tokens:60};e=new Engine(c,directory,worker);await e.start();await e.explore(c.scenarios[0],1);assert.equal(e.report().workers[worker.id].reportedTokens,28515);assert.equal(e.report().workers[worker.id].usageReportedCalls,2);}finally{await e.close();}
 assert.equal(tokenCount({total_tokens:0,input_tokens:7,output_tokens:2}),0);assert.equal(tokenCount({input_tokens:4,output_tokens:3,reasoning_output_tokens:2}),7);assert.equal(tokenCount({}),null);assert.equal(tokenCount({input_tokens:4}),null);
}));

test('unknown usage is unavailable and assertion secrets stay out of artifacts',()=>withSite((q,r)=>html(r,'<p>Normal</p>'),async origin=>{
 const c=config(origin),secret='synthetic-expectation-private';c.scenarios[0].assertions=[{id:'content',path:'text',op:'equals',value:secret}];const directory=dir(),e=new Engine(c,directory,new ScriptedProvider(()=>({action:'finish'})),{privateOptions:{secrets:[secret]}});
 try{await e.start();await e.explore(c.scenarios[0],1);assert.equal(e.report().workers['scripted-fixture'].reportedTokens,null);assert.match(fs.readFileSync(path.join(directory,'REPORT.md'),'utf8'),/tokens indisponibles/);for(const f of fs.readdirSync(directory).filter(f=>/json|md/.test(f)))assert.ok(!fs.readFileSync(path.join(directory,f),'utf8').includes(secret),f);}finally{await e.close();}
}));
