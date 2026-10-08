import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.mjs';
import { Policy, Redactor, validateConfig } from '../src/policy.mjs';
import { validateDecision, ScriptedProvider, JsonGatewayProvider } from '../src/providers.mjs';
import { shopConfig } from '../fixtures/sites.mjs';

const directory = () => fs.mkdtempSync(path.join(os.tmpdir(),'qa-lab-unit-'));
test('durable call reservation survives restart; lock prevents parallel overspend',()=>{
  const config=shopConfig('http://127.0.0.1:1234'),dir=directory(),store=new Store(dir,config);
  assert.throws(()=>new Store(dir,config),/EEXIST/);
  const provider={id:'explicit',maxCostMicros:60000},quota={available:true,remainingFraction:0.8,checkedAt:Date.now()};
  store.reserve(provider,quota,config.budget);store.close();
  const resumed=new Store(dir,config);
  assert.equal(resumed.state.calls,1);assert.equal(resumed.state.reservedMicros,60000);
  assert.throws(()=>resumed.reserve(provider,quota,config.budget),/Budget/);resumed.close();
});
test('quota missing, exhausted, stale or malformed prevents calls',()=>{
  const config=shopConfig('http://127.0.0.1:1234'),store=new Store(directory(),config);
  for(const quota of [null,{available:false},{available:true,remainingFraction:0.15,checkedAt:Date.now()},{available:true,remainingFraction:1,checkedAt:Date.now()-60000},{available:true,remainingFraction:NaN,checkedAt:Date.now()}]) assert.throws(()=>store.reserve({id:'x',maxCostMicros:0},quota,config.budget),/Quota/);
  assert.equal(store.state.calls,0);store.close();
});
test('tampering, partial ledger and config drift fail closed',()=>{
  const config=shopConfig('http://127.0.0.1:1234'),dir=directory(),store=new Store(dir,config);store.close();
  assert.throws(()=>new Store(dir,{...config,id:'changed'}),/Configuration/);
  fs.appendFileSync(path.join(dir,'ledger.jsonl'),'{');assert.throws(()=>new Store(dir,config),/Truncated/);
});
test('exact read allowlist, no unsafe GET/queries/off-origin, one consent with multiple requests',()=>{
  const config=shopConfig('http://127.0.0.1:1234','multiple'),store=new Store(directory(),config),policy=new Policy(config,store);
  for(const [url,method] of [['/api/save','POST'],['/danger-get','GET'],['/api/state?token=x','GET'],['http://evil.test/api/state','GET']]) assert.equal(policy.request(new URL(url,config.origin).href,method).allow,false);
  assert.equal(policy.request(config.origin+'/api/state','GET').allow,true);
  store.state.intents.i={phase:'attempted',endpoints:config.scenarios[0].writeConsent.endpoints,requests:{}};policy.active='i';
  const payload=JSON.stringify({key:'sample',quantity:'3',mode:'multiple'});
  assert.equal(policy.request(config.origin+'/api/save','POST',JSON.stringify({key:'other',quantity:'3',mode:'multiple'})).allow,false);
  assert.equal(policy.request(config.origin+'/api/save','POST',payload).allow,true);assert.equal(policy.request(config.origin+'/api/save','POST',payload).allow,false);
  assert.equal(policy.request(config.origin+'/api/audit','POST',payload).allow,true);policy.active=null;assert.equal(policy.request(config.origin+'/api/audit','POST',payload).allow,false);store.close();
});
test('schemas reject arbitrary tools, secret paths and forged consent',()=>{
  assert.throws(()=>validateDecision({action:'shell',command:'cat secret'}),/Invalid/);
  assert.throws(()=>validateDecision({action:'navigate',path:'//evil.test'}),/Local/);
  assert.throws(()=>validateConfig({...shopConfig('http://127.0.0.1:1234'),origin:'https://user:pass@example.com'}),/origin/);
  assert.throws(()=>new JsonGatewayProvider({endpoint:'http://evil.test',quotaEndpoint:'https://example.com'}),/Secure/);
});
test('redaction of raw and URL-encoded secrets, bearer tokens',()=>{
  const redactor=new Redactor(['synthetic+secret']);
  assert.equal(redactor.text('synthetic+secret synthetic%2Bsecret Bearer ABC123'),'[REDACTED] [REDACTED] Bearer [REDACTED]');
  assert.equal(new ScriptedProvider(()=>({action:'finish'})).capabilities.live,false);
});
