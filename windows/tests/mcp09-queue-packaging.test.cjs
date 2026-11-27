const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'../..');
test('MCP-09 owner-local queue ships with Messaging runtime and is independently verified',()=>{
 const pkg=JSON.parse(fs.readFileSync(path.join(root,'windows/package.json'),'utf8'));
 const messaging=pkg.build.extraResources.find(e=>e.from==='../messaging'&&e.to==='mcpgo-runtime/messaging');
 assert.ok(messaging,'Messaging extraResources entry must exist');
 assert.ok(messaging.filter.includes('work_queue.py'),
  'typed queue is missing from installed Messaging runtime');
 const verifier=fs.readFileSync(path.join(root,'windows/verify-build.py'),'utf8');
 assert.match(verifier,/"messaging":\["hub\.py","work_queue\.py"\]/,
  'packaged runtime verifier must detect missing queue');
});
