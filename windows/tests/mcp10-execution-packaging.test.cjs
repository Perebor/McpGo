const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'../..');
test('MCP-10 offline worktree roles and HMAC Hub adapter ship in verified runtime',()=>{
 const pkg=JSON.parse(fs.readFileSync(path.join(root,'windows/package.json'),'utf8'));
 const item=pkg.build.extraResources.find(e=>e.from==='../execution'&&e.to==='mcpgo-runtime/execution');
 assert.ok(item,'MCP-10 execution runtime absent');
 const verifier=fs.readFileSync(path.join(root,'windows/verify-build.py'),'utf8');
 for(const file of ['role_engine.py','role_worker.py','hub_role_adapter.py']){
  assert.ok(item.filter.includes(file),file+' absent from packaging');
  assert.ok(verifier.includes('"'+file+'"'),file+' absent from integrity verifier');
 }
 const ci=fs.readFileSync(path.join(root,'.github/workflows/verify.yml'),'utf8');
 assert.match(ci,/unittest discover -s execution\/tests -v/);
});
