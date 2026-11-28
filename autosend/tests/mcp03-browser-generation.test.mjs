import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {TabApproval} from '../tab-approval.mjs';

test('MCP-03: backend generation change revokes old tab approval without browser tools',async()=>{
 const {BrowserGenerationGuard}=await import('../browser-generation.mjs');
 let epoch='11111111-1111-4111-8111-111111111111',reads=0;
 const guard=new BrowserGenerationGuard(()=>{reads++;return epoch});
 const approval=new TabApproval();approval.update('fixture',true);
 assert.equal(guard.sync(approval),false);
 assert.equal(approval.has('fixture'),true);
 epoch='22222222-2222-4222-8222-222222222222';
 assert.equal(guard.sync(approval),true);
 assert.equal(approval.has('fixture'),false);
 assert.equal(reads,3);
});

test('MCP-03: missing or invalid backend generation revokes stale approval',async()=>{
 const {readBrowserGeneration,BrowserGenerationGuard}=await import('../browser-generation.mjs');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mcpgo-mcp03-gen-'));
 try{
  const file=path.join(dir,'backend.json');
  fs.writeFileSync(file,JSON.stringify({version:1,generation:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'}));
  const guard=new BrowserGenerationGuard(()=>readBrowserGeneration(file));
  const approval=new TabApproval();approval.update('fixture',true);
  fs.rmSync(file);
  assert.equal(guard.sync(approval),true);
  assert.equal(approval.has('fixture'),false);
  fs.writeFileSync(file,'{"version":1,"generation":"evil"}');
  assert.equal(readBrowserGeneration(file),null);
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});

test('MCP-03: unchanged generation never resets approved user tab',async()=>{
 const {BrowserGenerationGuard}=await import('../browser-generation.mjs');
 const value='11111111-1111-4111-8111-111111111111';
 const guard=new BrowserGenerationGuard(()=>value);
 const approval=new TabApproval();approval.update('fixture',true);
 for(let i=0;i<5;i++)assert.equal(guard.sync(approval),false);
 assert.equal(approval.has('fixture'),true);
});

test('MCP-03: native scheduler checks generation without touching browser backend',async()=>{
 const source=fs.readFileSync(new URL('../server.mjs',import.meta.url),'utf8');
 assert.match(source,/invalidateForBrowserGeneration\(/);
 assert.match(source,/function view\(\).*invalidateForBrowserGeneration/s);
});