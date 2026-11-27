const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'../..');
test('MCP-12 source ledger and local-first adapter are required in installed Windows runtime',()=>{
 const pkg=JSON.parse(fs.readFileSync(path.join(root,'windows/package.json'),'utf8'));
 const execution=pkg.build.extraResources.find(entry=>entry.from==='../execution');
 assert.ok(execution,'execution runtime absent');
 assert.ok(execution.filter.includes('usage_ledger.py'),'ledger source must ship');
 assert.ok(execution.filter.includes('usage_adapter.py'),'local-first integration must ship');
 assert.ok(execution.filter.includes('usage_cli.py'),'owner-inspectable usage CLI must ship');
 const verify=fs.readFileSync(path.join(root,'windows/verify-build.py'),'utf8');
 assert.match(verify,/"usage_ledger.py"/);
 assert.match(verify,/"usage_adapter.py"/);
});
