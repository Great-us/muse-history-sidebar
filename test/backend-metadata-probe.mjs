/** Reproduce leased-root metadata behavior on newly generated isolated synthetic data. */
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createHost,uuidv7,isolatedEnv,createSyntheticSession} from './backend-fixture.mjs';
import {CatalogService} from '../out/src/backend/catalogService.js';
const extension=process.cwd();
const binary=process.env.MUSE_TEST_ENGINE;
if(!binary)throw new Error('Set MUSE_TEST_ENGINE to the native Muse engine executable.');
const box=path.join(extension,'.test-sandbox',`backend-metadata-${Date.now()}`);
const env=isolatedEnv(path.join(box,'muse'));
const workspace=path.join(box,'workspace');
const cwd=path.join(box,'neutral');
await mkdir(workspace,{recursive:true});await mkdir(cwd,{recursive:true});
const seed=await createSyntheticSession({binary,workspace,env});
const report={box,seed:{sessionId:seed.sessionId,workspaceRoot:seed.workspaceRoot},phases:[]};
async function observe(phase){
 const reader=createHost({binary,workspace:cwd,env,extraArgs:['--trust-workspace']});await reader.connect();
 try {
  const list=await reader.request('session/list',{limit:200});
  const root=list.sessions.find(row=>row.sessionId===seed.sessionId);
  const readStarted=performance.now();
  const read=await reader.request('session/read',{sessionId:seed.sessionId,excludeItems:true}).then(r=>({session:r.session})).catch(e=>({error:e.message,code:e.code,kind:e.kind}));
  const readMs=performance.now()-readStarted;
  const catalog=new CatalogService({storagePath:path.join(cwd,'storage'),nativeHelperPath:'unused.exe',enginePath:binary,env,extraServeArgs:['--provider','echo']});
  let catalogRow;try{catalogRow=(await catalog.refresh()).sessions.find(row=>row.session_id===seed.sessionId);}finally{await catalog.dispose();}
  if(catalogRow?.workspace!==seed.workspaceRoot)throw new Error('catalog lost root workspace '+phase);
  report.phases.push({phase,listed:!!root,row:root,read,readMs,catalogRow});
 }finally{await reader.stop();}
}
await observe('before-holder');
const holder=createHost({binary,workspace,env,extraArgs:['--trust-workspace']});await holder.connect();
try{report.resume=await holder.request('session/resume',{sessionId:seed.sessionId,commandId:uuidv7(),excludeItems:true});await observe('during-holder');}
finally{await holder.stop();}
await observe('after-holder');
await mkdir(path.join(extension,'work'),{recursive:true});
await writeFile(path.join(extension,'work','metadata-probe-evidence.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
