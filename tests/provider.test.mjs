import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonGatewayProvider } from '../src/providers.mjs';
import { Store } from '../src/store.mjs';
import { shopConfig } from '../fixtures/sites.mjs';

test('real HTTP gateway contract: two explicit provider identities, reservation retained after failure',async()=>{
  let calls=0,available=true;
  const server=http.createServer((request,response)=>{response.setHeader('content-type','application/json');if(request.url==='/quota')return response.end(JSON.stringify({available,remainingFraction:0.9,checkedAt:Date.now()}));calls++;response.statusCode=503;response.end('{}');});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
  const config=shopConfig(origin),directory=fs.mkdtempSync(path.join(os.tmpdir(),'qa-lab-provider-'));let store=new Store(directory,config);
  const options={endpoint:origin+'/decision',quotaEndpoint:origin+'/quota',maxCostMicros:30000,token:'SYNTHETIC-GATEWAY-KEY',model:'test-json'};
  const primary=new JsonGatewayProvider({id:'vendor-a-explicit',...options}),second=new JsonGatewayProvider({id:'vendor-b-explicit',...options});
  try{
    store.reserve(primary,await primary.quota(),config.budget);await assert.rejects(primary.decide({}),/no retry/);assert.equal(calls,1);store.close();store=new Store(directory,config);assert.equal(store.state.reservedMicros,30000);assert.equal(store.state.calls,1);
    assert.throws(()=>store.reserve(second,{available:true,remainingFraction:0.9,checkedAt:Date.now()},config.budget),/fallback/);
    available=false;assert.throws(()=>store.reserve(primary,{available:false},config.budget),/Quota/);assert.equal(calls,1);
  }finally{store.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
