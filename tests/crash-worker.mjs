import { Engine } from '../src/engine.mjs';
import { ScriptedProvider } from '../src/providers.mjs';
const [configText,directory] = process.argv.slice(2);
const config=JSON.parse(configText),engine=new Engine(config,directory,new ScriptedProvider(()=>({action:'finish'})));
await engine.start();
engine.reconcile=async()=>{process.send({phase:'written-before-readback'});await new Promise(()=>{});};
await engine.runScenario(config.scenarios[0]);
