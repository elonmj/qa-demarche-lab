import readline from 'node:readline';
import {validateDecision} from './providers.mjs';

export async function handleRequest(engine,request){
  if(request?.jsonrpc!=='2.0'||!['string','number'].includes(typeof request.id)||typeof request.method!=='string')throw Error('JSON-RPC 2.0 id and method required');
  const p=request.params || {};
  const scenario=engine.config.scenarios.find(s=>s.id===p.scenario);
  switch(request.method){
    case 'initialize': return {protocol:'qa-lab/1',label:'Agents simulating a human QA approach',methods:['observe','status','mission','step','act','reconcile','report','close'],agents:Object.keys(engine.config.agents || {}),missions:engine.config.scenarios.map(s=>({id:s.id,agent:s.agent || engine.config.defaultAgent || null,writeConsent:!!s.writeConsent?.confirmed}))};
    case 'observe': return engine.observe();
    case 'status': return {calls:engine.store.state.calls,reservedMicros:engine.store.state.reservedMicros,workers:engine.store.state.workerUsage || {},holds:engine.store.state.holds,intents:Object.values(engine.store.state.intents).map(i=>({id:i.id,scenario:i.scenario,phase:i.phase})),providerFault:engine.store.state.providerFault || null};
    case 'mission': {
      if(!scenario)throw Error('Unknown authored mission');
      const mode=p.mode || 'authored';
      if(!['authored','explore'].includes(mode))throw Error('Unknown mission mode');
      const verdict=mode==='explore'?await engine.explore(scenario,Math.min(12,Number.isInteger(p.limit)&&p.limit>0?p.limit:8)):await engine.runScenario(scenario);
      await engine.verifyChecks(scenario);engine.report();return {verdict,observation:engine.view};
    }
    case 'step': {
      if(!scenario)throw Error('Unknown authored mission');
      const index=scenario.steps?.findIndex(s=>s.id===p.step);
      if(index===undefined||index<0)throw Error('Unknown authored step');
      if(engine.store.state.steps[`${scenario.id}/${p.step}`])throw Error('Step already attempted; reconcile only, no replay');
      for(const previous of scenario.steps.slice(0,index))if(engine.store.state.steps[`${scenario.id}/${previous.id}`]?.phase!=='observed')throw Error('Preceding preparation not observed; no submission');
      const step=scenario.steps[index];const verdict=await engine.execute(scenario,step,await engine.resolveStep(step));engine.report();return {verdict,observation:engine.view};
    }
    case 'act': {
      if(!scenario)throw Error('Unknown authored mission');
      const decision=validateDecision(p.decision);
      if(decision.intent||decision.action==='finish')throw Error('External act is read-only; submit uses authored step');
      if((engine.store.state.externalActions || 0)>=(engine.config.maxExternalActions || 40))throw Error('External action cap reached');
      engine.store.state.externalActions=(engine.store.state.externalActions || 0)+1;
      engine.store.commit('external-action-reserved');
      await engine.execute(scenario,{id:`external-${engine.store.state.externalActions}`,submit:false},decision);return engine.view;
    }
    case 'reconcile': if(!scenario)throw Error('Unknown authored mission');return {verdict:await engine.reconcile(scenario)};
    case 'report': return engine.report();
    case 'close': engine.report();return {closed:true};
    default:throw Error('Unknown method; no mutation executed');
  }
}
export async function serveStdio(engine,input=process.stdin,output=process.stdout){
  const reader=readline.createInterface({input,crlfDelay:Infinity});
  try{
    for await(const line of reader){
      let request;
      try{
        if(Buffer.byteLength(line)>100000)throw Error('Request too large');
        request=JSON.parse(line);const result=await handleRequest(engine,request);output.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\n');
        if(request.method==='close'){reader.close();break;}
      }catch(error){const message=engine.browser.redactor?.text(error.message) || 'Protocol request failed';engine.report();output.write(JSON.stringify({jsonrpc:'2.0',id:request?.id ?? null,error:{code:-32000,message}})+'\n');}
    }
  }finally{reader.close();await engine.close();}
}
