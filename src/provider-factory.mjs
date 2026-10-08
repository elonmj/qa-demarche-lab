import { CliProvider,resolveCommand } from './cli-provider.mjs';
import { ScriptedProvider,JsonGatewayProvider } from './providers.mjs';

export function createProvider(config){
  if(!config)return new ScriptedProvider(()=>({action:'finish'}));
  if(['antigravity','gemini','codex','json-cli'].includes(config.kind))return new CliProvider(config);
  if(config.kind==='json-gateway'){
    const token=process.env.QA_LAB_GATEWAY_TOKEN;
    if(!token)throw Error('Explicit QA_LAB_GATEWAY_TOKEN required; no fallback');
    return new JsonGatewayProvider({...config,token});
  }
  if(config.kind==='scripted'&&config.testOnly===true)return new ScriptedProvider(()=>({action:'finish'}));
  throw Error('Unknown provider; no fallback');
}
export function createAgents(config){
  const definitions=config.agents || {};
  const agents=Object.fromEntries(Object.entries(definitions).map(([id,definition])=>[id,createProvider({...definition,id})]));
  if(Object.keys(agents).length){
    if(!config.defaultAgent||!agents[config.defaultAgent])throw Error('Explicit defaultAgent required');
    return {provider:agents[config.defaultAgent],agents};
  }
  return {provider:createProvider(config.provider),agents:{}};
}
export function agentInventory(config){
  return Object.entries(config.agents || (config.provider?{default:config.provider}:{})).map(([id,definition])=>{
    let installed=true,diagnostic=null;
    if(['antigravity','gemini','codex','json-cli'].includes(definition.kind)){try{resolveCommand(definition.kind,definition.executable);}catch(e){installed=false;diagnostic=e.message;}}
    return {id,kind:definition.kind,model:definition.model || null,installed,diagnostic,runtimeValidation:'not-checked-by-inventory',quota:definition.kind==='antigravity'?'vendor-usage':definition.kind==='codex'?'vendor-rate-limits':definition.quotaCommand?'configured-command':'required-for-live-CLI'};
  });
}
