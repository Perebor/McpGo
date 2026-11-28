const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'../..');
test('MCP-08/09 delegated HTTP and read-only AutoSend bridge are installed and audited',()=>{
 const pkg=JSON.parse(fs.readFileSync(path.join(root,'windows/package.json'),'utf8'));
 const messaging=pkg.build.extraResources.find(e=>e.from==='../messaging'&&e.to==='mcpgo-runtime/messaging');
 assert.ok(messaging);
 for(const name of ['hub.py','work_queue.py','delegated_auth.py','autosend_bridge.py'])
  assert.ok(messaging.filter.includes(name),'Missing packaged module: '+name);
 const verify=fs.readFileSync(path.join(root,'windows/verify-build.py'),'utf8');
 for(const name of ['hub.py','work_queue.py','delegated_auth.py','autosend_bridge.py'])
  assert.ok(verify.includes('"'+name+'"'),'Runtime SHA verifier missing: '+name);
});
