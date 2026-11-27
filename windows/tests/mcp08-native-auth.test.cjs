'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const http=require('node:http');
const {EventEmitter}=require('node:events');
const {localRequest}=require('../app/local-api.cjs');
const {readOnlyProbe}=require('../app/health-contract.cjs');
const OWNER_TOKEN='d'.repeat(64);
function sandbox(fn){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mcpgo-hub-native-auth-'));
 try{fs.mkdirSync(path.join(dir,'Messaging'));return fn(dir)}
 finally{fs.rmSync(dir,{recursive:true,force:true})}
}
test('MCP-08 Messaging API refuses missing/invalid owner token before network',()=>{
 sandbox(dir=>{
  assert.throws(()=>localRequest('messaging','/api/status',undefined,dir),/MESSAGING_CONTROL_TOKEN/);
  fs.writeFileSync(path.join(dir,'Messaging','control-token'),'native');
  assert.throws(()=>localRequest('messaging','/api/status',undefined,dir),/MESSAGING_CONTROL_TOKEN/);
 });
});
test('MCP-08 native Messaging API attaches only the protected expected token',async()=>{
 await sandbox(async dir=>{
  fs.writeFileSync(path.join(dir,'Messaging','control-token'),OWNER_TOKEN);
  const old=http.request;let captured=null;
  http.request=(options,cb)=>{
   captured=options;
   const req=new EventEmitter();
   req.end=()=>{
    const res=new EventEmitter();res.statusCode=200;cb(res);
    res.emit('data',Buffer.from('{"ok":true}'));res.emit('end');
   };
   req.destroy=err=>req.emit('error',err);
   return req;
  };
  try{
   assert.deepEqual(await localRequest('messaging','/api/status',undefined,dir),{ok:true});
   assert.equal(captured.headers['X-MCPHub-Token'],OWNER_TOKEN);
   assert.equal(captured.headers['X-MCPHub-Client'],'native');
   assert.equal(captured.method,'GET');
   assert.equal(captured.port,8971);
  }finally{http.request=old}
 });
});
test('MCP-08 Hub health check requires owner token, no downgrade to naked native header',async()=>{
 let called=0;
 const mock=async(url,params)=>{called++;assert.equal(params.headers['X-MCPHub-Token'],OWNER_TOKEN);
  return {ok:true,json:async()=>({ok:true,agents:1})}};
 const absent=await readOnlyProbe('hub',{fetchImpl:mock,now:1700000000000});
 assert.equal(absent.ok,false);assert.equal(called,0);
 const present=await readOnlyProbe('hub',{fetchImpl:mock,token:OWNER_TOKEN,now:1700000000000});
 assert.equal(present.ok,true);assert.equal(called,1);
});
test('MCP-08 runtime actually injects Messaging owner credential into health probe',()=>{
 const source=fs.readFileSync(path.join(__dirname,'../app/runtime.cjs'),'utf8');
 assert.match(source,/hubToken/);
 assert.match(source,/readOnlyProbe\('hub',\{token:hubToken\}\)/);
});
