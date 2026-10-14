import fs from 'node:fs';import path from 'node:path';import http from 'node:http';import {fileURLToPath} from 'node:url';import {createHash} from 'node:crypto';
import {Engine} from '../src/engine.mjs';import {ScriptedProvider} from '../src/providers.mjs';
// Owner-authorized static staging target only; no business corpus, no write server.
const source=process.argv[2];if(!source)throw Error('Usage: node fixtures/recheck-static.mjs owner-authorized-static-directory');
const root=path.resolve(fileURLToPath(new URL('../',import.meta.url))),directory=path.join(root,'artifacts',`static-recheck-${Date.now()}`),target=path.join(directory,'target');fs.mkdirSync(target,{recursive:true});
const manifest=[];function copy(dir,rel=''){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
 const name=path.posix.join(rel,entry.name),src=path.join(dir,entry.name),dest=path.join(target,name);
 if(entry.isDirectory()&&entry.name==='assets'){fs.mkdirSync(dest,{recursive:true});copy(src,name);}else if(entry.isFile()&&/\.(html|js|css|jpg|png|svg)$/i.test(name)){fs.copyFileSync(src,dest);manifest.push({path:name,sha256:createHash('sha256').update(fs.readFileSync(src)).digest('hex')});}
}}copy(source);fs.writeFileSync(path.join(directory,'source-manifest.json'),JSON.stringify(manifest,null,2));
const server=http.createServer((q,r)=>{const url=new URL(q.url,'http://127.0.0.1'),file=decodeURIComponent(url.pathname.slice(1)||'index.html');if(!['GET','HEAD'].includes(q.method)||!manifest.some(x=>x.path===file)){r.writeHead(403);return r.end();}r.setHeader('content-type',file.endsWith('.html')?'text/html; charset=utf-8':file.endsWith('.js')?'text/javascript; charset=utf-8':file.endsWith('.css')?'text/css; charset=utf-8':'image/jpeg');r.end(q.method==='HEAD'?undefined:fs.readFileSync(path.join(target,file)));});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`,rows=[];
try{for(const [id,viewport] of [['desktop',{width:1440,height:1000}],['mobile',{width:390,height:844}]]){
 const c={id:`static-${id}`,origin,entry:'/index.html',viewport,maxDomControls:500,maxArtifactBytes:64000000,maxObservations:50,maxNetworkRequests:200,budget:{maxCalls:0,maxCostMicros:0,reserveFraction:.15,quotaMaxAgeMs:30000,maxDurationMs:120000},reads:manifest.map(x=>({path:'/'+encodeURI(x.path),methods:['GET','HEAD']})),scenarios:manifest.filter(x=>x.path.endsWith('.html')).map((x,n)=>({id:`page-${n}`,goal:'Contrôler la page statique autorisée, sans certificat métier.',steps:[{id:'open',action:'navigate',path:'/'+encodeURI(x.path)}],assertions:[{id:'fits',path:'overflow',op:'equals',value:false,impact:'Contexte et navigation coupés hors viewport.'},{id:'runtime',path:'errors',op:'equals',value:[]},{id:'fictive',path:'text',op:'includes',value:'Données fictives'}]}))};
 fs.writeFileSync(path.join(directory,id+'.config.json'),JSON.stringify(c,null,2));const e=new Engine(c,path.join(directory,id),new ScriptedProvider(()=>({action:'finish'})));
 try{await e.start();for(const s of c.scenarios){try{await e.runScenario(s);}catch(err){rows.push({viewport:id,scenario:s.id,error:err.message});}}
 const r=e.report();rows.push({viewport:id,exitCode:r.exitCode,findings:r.findings.map(x=>({page:x.page,check:x.check,expected:x.expected,observed:x.observed,evidence:x.evidenceIds})),coverage:r.coverage.reduce((a,x)=>(a[x.verdict]=(a[x.verdict]||0)+1,a),{}),observations:r.observations.length});}
 finally{e.report();await e.close();}
}}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
const sourceUnchanged=manifest.every(x=>createHash('sha256').update(fs.readFileSync(path.join(source,x.path))).digest('hex')===x.sha256);
fs.writeFileSync(path.join(directory,'RESULTS.json'),JSON.stringify({target:path.resolve(source),sourceUnchanged,rows},null,2));console.log(JSON.stringify({directory,sourceUnchanged,rows},null,2));
