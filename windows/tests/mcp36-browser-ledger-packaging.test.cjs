'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'../..');
const read=f=>fs.readFileSync(path.join(root,f),'utf8');

test('MCP-36 package carries extension diagnostic and atomic model receipt ledger with Python parity',()=>{
 const pkg=JSON.parse(read('windows/package.json'));
 const autosend=pkg.build.extraResources.find(e=>e.to==='mcpgo-runtime/autosend');
 assert.ok(autosend&&autosend.filter.includes('*.mjs'));
 const verify=read('windows/verify-build.py');
 for(const mod of ['extension-diagnostic.mjs','model-use-ledger.mjs'])
  assert.match(verify,new RegExp(mod.replaceAll('.','\\.')));
 const source=read('autosend/server.mjs');
 assert.match(source,/probe_extension/);
 assert.match(source,/modelUsageEventForAttempt/);
 assert.match(source,/syncModelUsageLedger\(db,usageLedgerPath\)/);
 assert.match(source,/modelUsage:modelUsageStatus\(\)/);
 const python=read('execution/usage_ledger.py');
 assert.match(python,/CREATE TABLE IF NOT EXISTS autosend_observations/);
 assert.match(python,/observed_chat_responses/);
});
test('MCP-36 UI separates extension MCP transport, exact target lease and observed chat replies',()=>{
 const html=read('windows/app/index.html');
 const js=read('windows/app/renderer.js');
 assert.match(html,/id="extension-probe"/);
 assert.match(html,/id="extension-probe-status"/);
 assert.match(html,/id="model-usage-status"/);
 assert.match(js,/extensionTransportConnected/);
 assert.match(js,/chatTabApprovedCount/);
 assert.match(js,/evidence\.rows/);
});
