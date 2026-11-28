const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'../..');
test('MCP-11 encrypted owner-approved chat handoff is a verified Windows runtime dependency',()=>{
 const pkg=JSON.parse(fs.readFileSync(path.join(root,'windows/package.json'),'utf8'));
 const packed=pkg.build.extraResources.find(entry=>entry.from==='../autosend');
 assert.ok(packed);
 assert.ok(packed.filter.includes('*.mjs'),'handoff source must ship with AutoSend');
 const verify=fs.readFileSync(path.join(root,'windows/verify-build.py'),'utf8');
 assert.match(verify,/"chat-handoff.mjs"/,'packaged runtime verifier must require handoff code');
 assert.match(verify,/"handoff-coordinator.mjs"/,'runtime must package the durable Hub+AutoSend coordinator');
 const server=fs.readFileSync(path.join(root,'autosend/server.mjs'),'utf8');
 assert.match(server,/case 'handoff_chat':/);
 assert.match(server,/const oldTasks=db\.tasks;db\.tasks=next\.tasks;/);
});
