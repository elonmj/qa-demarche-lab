import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Engine } from '../src/engine.mjs';
import { ScriptedProvider } from '../src/providers.mjs';
import { startShop,startRegistry,shopConfig,registryConfig } from './sites.mjs';
const root=path.resolve(fileURLToPath(new URL('..',import.meta.url))),directory=path.join(root,'artifacts',`visual-${Date.now()}`),views=[];
for(const type of ['shop','registry']){
  const site=type==='shop'?await startShop():await startRegistry();
  try{for(const width of [390,1280]){
    const config=type==='shop'?shopConfig(site.origin):registryConfig(site.origin);config.viewport={width,height:844};
    const engine=new Engine(config,path.join(directory,`${type}-${width}`),new ScriptedProvider(()=>({action:'finish'})));
    try{const view=await engine.start();if(view.errors.length||view.overflow)throw Error('Unexpected visual/console failure');views.push({type,width,screenshot:path.join(engine.store.directory,view.screenshot),dom:path.join(engine.store.directory,`observation-${view.id}.json`),errors:view.errors,overflow:view.overflow});}finally{await engine.close();}
  }}finally{await site.close();}
}
fs.writeFileSync(path.join(directory,'VIEWS.json'),JSON.stringify(views,null,2));console.log(JSON.stringify({directory,views},null,2));
