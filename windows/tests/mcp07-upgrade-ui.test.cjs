'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const renderer=fs.readFileSync(path.join(__dirname,'../app/renderer.js'),'utf8');
const html=fs.readFileSync(path.join(__dirname,'../app/index.html'),'utf8');
test('MCP-07 GUI preflight is read-only and shows readiness without offering auto-install',async()=>{
 assert.match(html,/id="upgrade-preflight"/);
 assert.match(html,/id="upgrade-preflight-result"/);
 const begin=renderer.indexOf("const updatesStatus=$('updates-status');");
 assert.ok(begin>=0);
 const elements=new Map(),calls=[];
 const context={
  $:id=>{
   if(!elements.has(id))elements.set(id,{textContent:'',disabled:false,hidden:false,onclick:null});
   return elements.get(id);
  },
  message:()=>{},
  window:{mcpgo:{
   upgradePreflight:async()=>{
    calls.push('preflight');
    return {status:'READY_FOR_BACKUP',reason:'QUIESCENT',nextSafeAction:'CREATE_VERIFIED_BACKUP',canInstall:false};
   },
   openReleases:async()=>{},checkUpdates:async()=>({available:false}),verifyUpdate:async()=>({cancelled:true})
  }}
 };
 vm.runInNewContext(renderer.slice(begin),context);
 assert.equal(typeof elements.get('upgrade-preflight')?.onclick,'function');
 await elements.get('upgrade-preflight').onclick();
 assert.deepEqual(calls,['preflight']);
 const text=elements.get('upgrade-preflight-result').textContent;
 assert.match(text,/резервн/i);
 assert.match(text,/не запускается автоматически/i);
 assert.equal(elements.get('upgrade-preflight').disabled,false);
 context.window.mcpgo.upgradePreflight=async()=>({status:'UNKNOWN',reason:'QUIESCENCE_NOT_PROVEN',nextSafeAction:'RECHECK',canInstall:false});
 await elements.get('upgrade-preflight').onclick();
 assert.match(elements.get('upgrade-preflight-result').textContent,/не подтвержд|неполная/i);
 context.window.mcpgo.upgradePreflight=async()=>({status:'BLOCKED',reason:'AUTOSEND_NOT_QUIESCENT',nextSafeAction:'NEED_OWNER',canInstall:false});
 await elements.get('upgrade-preflight').onclick();
 assert.match(elements.get('upgrade-preflight-result').textContent,/отправк|владел|квитанц/i);
});
test('MCP-07 native bridge exposes only trusted no-argument preflight action',()=>{
 const main=fs.readFileSync(path.join(__dirname,'../app/main.cjs'),'utf8');
 const preload=fs.readFileSync(path.join(__dirname,'../app/preload.cjs'),'utf8');
 assert.match(main,/ipcMain\.handle\('mcpgo:upgrade-preflight'/);
 assert.match(main,/assessUpgradeSafety\(/);
 assert.match(preload,/upgradePreflight:\(\)=>ipcRenderer\.invoke\('mcpgo:upgrade-preflight'\)/);
});
