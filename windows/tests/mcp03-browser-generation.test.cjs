'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const runtime=require('../app/runtime.cjs');

test('MCP-03: Windows supervisor writes distinct atomic backend generation on restart',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mcpgo-browser-generation-'));
 try{
  const first=runtime.writeBrowserGeneration(dir,1001);
  const file=path.join(dir,'AutoSend','browser-generation.json');
  const v1=JSON.parse(fs.readFileSync(file,'utf8'));
  assert.equal(v1.version,1);assert.equal(v1.pid,1001);
  assert.match(v1.generation,/^[a-f0-9-]{36}$/);
  assert.equal(first,v1.generation);
  const second=runtime.writeBrowserGeneration(dir,1002);
  const v2=JSON.parse(fs.readFileSync(file,'utf8'));
  assert.equal(v2.pid,1002);assert.notEqual(first,second);
  assert.equal(fs.existsSync(file+'.tmp'),false);
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});

test('MCP-03: supervisor generates epoch only for its private AutoSend browser',()=>{
 const source=fs.readFileSync(path.resolve(__dirname,'../app/runtime.cjs'),'utf8');
 assert.match(source,/if\(name==='autosendBrowser'\).*writeBrowserGeneration/s);
});