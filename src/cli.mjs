import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Engine } from './engine.mjs';
import { Store, unlock } from './store.mjs';
import { validateConfig } from './policy.mjs';
import {createAgents,agentInventory} from './provider-factory.mjs';
import {serveStdio} from './protocol.mjs';
import { startShop, shopConfig } from '../fixtures/sites.mjs';

const root=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
const [command,configPath,outputPath]=process.argv.slice(2);
try{
  if(command==='check'){
    for(const folder of ['src','fixtures','tests'])for(const name of fs.readdirSync(path.join(root,folder)).filter(n=>n.endsWith('.mjs'))){const result=spawnSync(process.execPath,['--check',path.join(root,folder,name)],{encoding:'utf8',windowsHide:true});if(result.status!==0)throw Error(result.stderr);}
    console.log('Syntax OK');
  }else if(command==='agents'){
    const config=validateConfig(JSON.parse(fs.readFileSync(configPath,'utf8')));console.log(JSON.stringify(agentInventory(config),null,2));
  }else if(command==='serve'){
    const config=validateConfig(JSON.parse(fs.readFileSync(configPath,'utf8'))),{provider,agents}=createAgents(config);
    const engine=new Engine(config,outputPath,provider,{agentProviders:agents,privateOptions:{secrets:[process.env.QA_LAB_GATEWAY_TOKEN].filter(Boolean)}});
    try{await engine.start(config.role || 'visitor');await serveStdio(engine);}catch(error){engine.report();await engine.close();throw error;}
  }else if(command==='unlock'){
    if(!configPath)throw Error('Run directory required');unlock(configPath);console.log('Dead process lock removed; intents preserved');
  }else if(command==='report'){
    const config=validateConfig(JSON.parse(fs.readFileSync(configPath,'utf8'))),store=new Store(outputPath,config);
    try{const {writeReport}=await import('./report.mjs');writeReport(store,config);console.log(path.join(store.directory,'REPORT.md'));}finally{store.close();}
  }else if(['run','explore','reconcile','demo'].includes(command)){
    let fixture,engine;
    try{
      const config=command==='demo'?(fixture=await startShop(),shopConfig(fixture.origin,'basic','demo')):validateConfig(JSON.parse(fs.readFileSync(configPath,'utf8')));
      const directory=command==='demo'?path.join(root,'artifacts',`demo-${Date.now()}`):outputPath;
      if(!directory)throw Error('Output directory required');
      const {provider,agents}=createAgents(config);
      if(command==='explore'&&!config.provider&&!config.agents)throw Error('Exploration requires explicit worker configuration');
      const secrets=[process.env.QA_LAB_GATEWAY_TOKEN].filter(Boolean);
      engine=new Engine(config,directory,provider,{agentProviders:agents,privateOptions:{secrets}});await engine.start(config.role || 'visitor');
      for(const scenario of config.scenarios){
        const verdict=command==='explore'?await engine.explore(scenario):command==='reconcile'?await engine.reconcile(scenario):await engine.runScenario(scenario);
        console.log(`${scenario.id}: ${verdict}`);
        await engine.verifyChecks(scenario);
      }
      engine.report();console.log(path.join(engine.store.directory,'REPORT.md'));
      if(engine.store.state.holds.length)process.exitCode=2;
    }finally{if(engine)engine.report();await engine?.close();await fixture?.close();}
  }else throw Error('Usage: node src/cli.mjs demo | check | agents config.json | run|explore|serve|reconcile|report config.json run-directory | unlock run-directory');
}catch(error){console.error(error.message);process.exitCode=1;}
