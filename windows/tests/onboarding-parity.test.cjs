'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const html=read('windows/app/index.html'),renderer=read('windows/app/renderer.js');
const main=read('windows/app/main.cjs'),preload=read('windows/app/preload.cjs');
const cli=read('windows/onboarding_cli.py'),bridge=read('windows/app/onboarding.cjs');
const native=read('native/OnboardingView.swift');
test('all seven native onboarding stages are exposed in Windows',()=>{
 assert.deepEqual([...html.matchAll(/data-wizard-page="(\d+)"/g)].map(m=>Number(m[1])),[0,1,2,3,4,5,6]);
 assert.deepEqual([...html.matchAll(/data-wizard-step="(\d+)"/g)].map(m=>Number(m[1])),[0,1,2,3,4,5,6]);
 for(const title of ['2. Подключаем OpenAI','3. Подключаем туннели','5. Личный Chrome','6. Подключение в ChatGPT','7. Проверка готовности']){
  assert.ok(native.includes(title));assert.ok(html.includes(title));
 }
 assert.match(html,/1\. Проверяем Windows/);assert.match(html,/4\. Службы Windows/);
 for(const control of ['wizard-create-mode','wizard-import-mode','wizard-discover','wizard-load-projects','wizard-save-runtime','wizard-start-services','wizard-activate-extension','wizard-confirm-plugins','wizard-final-local','wizard-doctor','wizard-dismiss']){
  assert.ok(html.includes('id="'+control+'"'),control);assert.ok(renderer.includes("$('"+control+"').onclick"),control);
 }
});
test('all original onboarding images are packaged byte for byte',()=>{
 const original=path.join(root,'assets/onboarding'),bundled=path.join(root,'windows/app/onboarding-images');
 const images=fs.readdirSync(original).filter(n=>n.endsWith('.png')).sort();
 assert.deepEqual(images,fs.readdirSync(bundled).sort());
 assert.equal(images.length,5);
 for(const image of images){
  assert.ok(fs.readFileSync(path.join(original,image)).equals(fs.readFileSync(path.join(bundled,image))),image);
  assert.ok(html.includes('src="onboarding-images/'+image+'"'),image);
 }
 assert.ok(require('../package.json').build.files.includes('app/onboarding-images/*.png'));
});
test('plugin confirmation is not ChatGPT verification, and links/copy are allowlisted',()=>{
 for(const action of ['chatgpt-instructions','dismiss','import','verify-remote']){
  for(const source of [main,bridge,cli])assert.ok(source.includes(action),action);
 }
 assert.match(main,/Object\.hasOwn\(guideLinks,kind\)/);
 assert.match(main,/plugins:'https:\/\/chatgpt\.com\/plugins'/);
 assert.match(main,/clipboard\.writeText\(assertTunnelId\(/);
 assert.match(preload,/guideLink:kind=>ipcRenderer\.invoke/);
 assert.match(cli,/engine\.note_chatgpt/);assert.match(cli,/engine\.dismiss/);
 assert.match(renderer,/data\.chatgptInstructionsViewed\?6/);
 assert.match(renderer,/!data\.wizardDismissed/);
 assert.match(renderer,/onboard\('chatgpt-instructions',\{confirmed:true\}\)/);
 assert.match(html,/Доступность ChatGPT остаётся неподтверждённой/);
});
test('Windows doctor uses env credentials and never exposes subprocess output',async()=>{
 const {checkTunnelDoctor}=require('../app/wizard-doctor.cjs');
 const key='sk-test-secret';
 const input={client:'tunnel-client.exe',credential:{id:'tunnel_test123',key},url:'http://127.0.0.1:8940/mcp'};
 let called=false;
 const ok=await checkTunnelDoctor(input,(file,args,options,cb)=>{
  called=true;assert.equal(file,input.client);assert.equal(args[0],'doctor');
  assert.ok(args.includes('env:CONTROL_PLANE_API_KEY'));assert.ok(!args.join(' ').includes(key));
  assert.equal(options.env.CONTROL_PLANE_API_KEY,key);assert.equal(options.windowsHide,true);
  cb(null,key,key);
 });
 assert.equal(called,true);assert.deepEqual(ok,{ready:true});
 const fail=await checkTunnelDoctor(input,(_file,_args,_opts,cb)=>cb(Error(key),key,key));
 assert.equal(fail.ready,false);assert.ok(!JSON.stringify(fail).includes(key));
 await assert.rejects(checkTunnelDoctor({...input,url:'https://example.com'},()=>{}),/INVALID_LOCAL_MCP_URL/);
});
