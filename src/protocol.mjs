import {validateDecision} from './providers.mjs';

const validId = id => (typeof id==='string' && Buffer.byteLength(id)<=256) || (typeof id==='number' && Number.isSafeInteger(id));
async function* boundedLines(input) {
  let parts=[],bytes=0;
  for await(const chunk of input) {
    const data=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);
    let start=0;
    while(start<data.length) {
      const newline=data.indexOf(10,start),end=newline<0?data.length:newline;
      bytes+=end-start;
      if(bytes>100000)throw Error('Request too large; stream closed');
      parts.push(data.subarray(start,end));
      if(newline<0)break;
      yield new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(parts,bytes));
      parts=[];bytes=0;start=newline+1;
    }
  }
  if(bytes)yield new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(parts,bytes));
}
const send = (output,reply) => new Promise((resolve,reject)=>output.write(JSON.stringify(reply)+'\n',error=>error?reject(error):resolve()));

export async function handleRequest(engine,request){
  if(!request || typeof request!=='object' || Array.isArray(request) || request.jsonrpc!=='2.0'||!validId(request.id)||typeof request.method!=='string' || Object.keys(request).some(k=>!['jsonrpc','id','method','params'].includes(k)))throw Error('JSON-RPC 2.0 id and method required');
  if(request.params!==undefined && (!request.params || typeof request.params!=='object' || Array.isArray(request.params)))throw Error('JSON-RPC params object required');
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
      if(p.limit!==undefined && (!Number.isSafeInteger(p.limit)||p.limit<1||p.limit>12))throw Error('Exploration limit must be 1..12');
      const verdict=mode==='explore'?await engine.explore(scenario,p.limit ?? 8):await engine.runScenario(scenario);
      await engine.verifyChecks(scenario);engine.report();return {verdict,observation:engine.view};
    }
    case 'step': {
      if(!scenario)throw Error('Unknown authored mission');
      const index=scenario.steps?.findIndex(s=>s.id===p.step);
      if(index===undefined||index<0)throw Error('Unknown authored step');
      if(engine.store.state.steps[`${scenario.id}/${p.step}`])throw Error('Step already attempted; reconcile only, no replay');
      for(const previous of scenario.steps.slice(0,index))if(engine.store.state.steps[`${scenario.id}/${previous.id}`]?.phase!=='observed')throw Error('Preceding preparation not observed; no submission');
      await engine.ensureRole(scenario);
      const step=scenario.steps[index];const verdict=await engine.execute(scenario,step,await engine.resolveStep(step));engine.report();return {verdict,observation:engine.view};
    }
    case 'act': {
      if(!scenario)throw Error('Unknown authored mission');
      const decision=validateDecision(p.decision);
      if(decision.intent||decision.action==='finish')throw Error('External act is read-only; submit uses authored step');
      engine.store.assertOpen();engine.checkDeadline();
      if((engine.store.state.externalActions || 0)>=(engine.config.maxExternalActions || 40))throw Error('External action cap reached');
      engine.store.state.externalActions=(engine.store.state.externalActions || 0)+1;
      engine.store.commit('external-action-reserved');
      await engine.execute(scenario,{id:`external-${engine.store.state.externalActions}`,submit:false},decision);return engine.view;
    }
    case 'reconcile': if(!scenario)throw Error('Unknown authored mission');return {verdict:await engine.reconcile(scenario)};
    case 'report': return engine.report();
    case 'close': engine.report();await engine.close();return {closed:true};
    default:throw Error('Unknown method; no mutation executed');
  }
}
export async function serveStdio(engine,input=process.stdin,output=process.stdout){
  const errorReply = async(error,request) => {
    const message=engine.browser.redactor?.text(error.message) || 'Protocol request failed';
    const id=validId(request?.id)?request.id:null;
    await send(output,{jsonrpc:'2.0',id:typeof id==='string' && engine.browser.redactor && engine.browser.redactor.text(id)!==id?null:id,error:{code:-32000,message}});
  };
  try{
    for await(const line of boundedLines(input)){
      let request;
      try{
        try { request=JSON.parse(line); } catch { throw Error('Invalid JSON request'); }
        const result=await handleRequest(engine,request);
        const reply={jsonrpc:'2.0',id:request.id,result};
        await send(output,engine.browser.redactor?engine.browser.redactor.value(reply):reply);
        if(request.method==='close')break;
      }catch(error){await errorReply(error,request);}
    }
  }catch(error){await errorReply(error);}
  finally{try{if(!engine.store.closed)engine.report();}finally{await engine.close();}}
}
