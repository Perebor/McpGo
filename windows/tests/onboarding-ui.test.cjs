'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const enabled=Boolean(process.env.MCPGO_WIZARD_CHROME);
test('seven-stage wizard UI with fake IPC, no account or real tunnel mutations',{skip:!enabled,timeout:45000},async()=>{
 const {chromium}=require('../../playwright/node_modules/playwright');
 const browser=await chromium.launch({executablePath:process.env.MCPGO_WIZARD_CHROME,headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1100,height:770}});
  page.setDefaultTimeout(5000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
  await page.addInitScript(()=>{
   const status={terminal:{id:'',configured:false},browserTunnel:{id:'',configured:false},playwrightExtension:{configured:false},browser:'chrome',autoStart:false,status:{},readiness:{}};
   const wizard={tunnels:{},runtimeProvision:{}};
   window.calls=[];
   window.mcpgo=new Proxy({
    status:async()=>structuredClone(status),onStatus:()=>()=>{},serviceRead:async()=>({}),
    onboard:async(action,data)=>{
     window.calls.push(action);
     if(action==='status')return structuredClone(wizard);
     if(action==='connection-preflight')return {message:'Доступно',secureStorage:true};
     if(action==='browser-check')return {message:'Chrome доступен',supported:true};
     if(action==='import'){wizard.tunnels={terminal:{id:data.terminalId},browser:{id:data.browserId}};return {}}
     if(action==='verify-remote')return {verified:{terminal:true,browser:true}};
     if(action==='chatgpt-instructions'){wizard.chatgptInstructionsViewed=true;return {chatgptVerified:false}}
     if(action==='doctor')return {checks:{terminal:{ready:true},browser:{ready:true}},note:'Transport only'};
     if(action==='dismiss'){wizard.wizardDismissed=true;return {}}
     return {};
    },
    save:async(data)=>{
     window.calls.push('save');
     if(data.terminal){status.terminal={id:data.terminal.id,configured:true};status.browserTunnel={id:data.browserTunnel.id,configured:true}}
     if(data.playwrightExtension){status.playwrightExtension.configured=true;status.readiness.chrome=true}
     return structuredClone(status);
    },
    restart:async()=>structuredClone(status),verifyConnection:async()=>structuredClone(status),
    guideLink:async k=>window.calls.push('link:'+k),copyTunnel:async k=>window.calls.push('copy:'+k),
    copyConnectionTest:async()=>window.calls.push('copy-test')
   },{get:(o,k)=>o[k]||(async()=>({}))});
  });
  await page.goto(pathToFileURL(path.resolve(__dirname,'../app/index.html')).href);
  await page.locator('[data-section=onboarding]').waitFor({state:'visible'});
  await page.locator('#verify-connection').click();
  await page.waitForFunction(()=>document.querySelector('#wizard-preflight').textContent.includes('Доступно'));
  await page.locator('#wizard-next').click();
  await page.locator('[data-wizard-page="1"] details summary').click();
  assert.ok(await page.locator('[data-wizard-page="1"] img').evaluateAll(xs=>xs.every(x=>x.complete&&x.naturalWidth>0)));
  await page.locator('#wizard-import-mode').click();
  await page.locator('#wizard-next').click();
  await page.locator('#wizard-terminal-id').fill('tunnel_test_terminal');
  await page.locator('#wizard-browser-id').fill('tunnel_test_browser');
  await page.locator('#wizard-runtime-key').fill('sk-test-fake-key');
  await page.locator('#wizard-save-runtime').click();
  await page.locator('[data-wizard-page="3"]').waitFor({state:'visible'});
  await page.locator('#wizard-start-services').click();
  await page.locator('[data-wizard-page="4"]').waitFor({state:'visible'});
  await page.locator('#wizard-extension-token').fill('fake-test-extension-token');
  await page.locator('#wizard-activate-extension').click();
  await page.locator('[data-wizard-page="5"]').waitFor({state:'visible'});
  for(const summary of await page.locator('[data-wizard-page="5"] details summary').all())await summary.click();
  assert.ok(await page.locator('[data-wizard-page="5"] img').evaluateAll(xs=>xs.every(x=>x.complete&&x.naturalWidth>0)));
  assert.equal(await page.locator('#wizard-plugin-terminal').textContent(),'tunnel_test_terminal');
  await page.locator('#wizard-copy-terminal').click();
  await page.locator('[data-guide-link=plugins]').click();
  await page.locator('#wizard-confirm-plugins').click();
  await page.locator('[data-wizard-page="6"]').waitFor({state:'visible'});
  await page.locator('#wizard-doctor').click();
  await page.locator('#wizard-copy-test').click();
  await page.locator('#wizard-dismiss').click();
  await page.locator('section[data-section=overview]').waitFor({state:'visible'});
  assert.deepEqual(errors,[]);
  const calls=await page.evaluate(()=>window.calls);
  for(const action of ['import','verify-remote','save','copy:terminal','link:plugins','chatgpt-instructions','doctor','copy-test','dismiss'])assert.ok(calls.includes(action),action);
 }finally{await browser.close()}
});
