'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'../..');
const read=relative=>fs.readFileSync(path.join(root,relative),'utf8');
const html=read('windows/app/index.html');
const css=read('windows/app/style.css');
const renderer=read('windows/app/renderer.js');

test('Windows desktop shell has macOS-style navigation with matching visible sections',()=>{
 const nav=[...html.matchAll(/data-nav="([^"]+)"/g)].map(x=>x[1]);
 assert.deepEqual(nav,['overview','onboarding','messages','settings','skills','autosend','updates']);
 for(const section of nav){
  assert.match(html,new RegExp('data-section="'+section+'"'));
  assert.match(renderer,new RegExp(' '+section+':\\['));
 }
 assert.match(html,/class="sidebar"/);
 assert.match(html,/id="active-count"/);
 assert.match(html,/id="summary-count"/);
 assert.match(renderer,/element\.hidden=element\.dataset\.section!==section/);
 assert.match(renderer,/setAttribute\('aria-current','page'\)/);
 assert.match(renderer,/if\(!data\.terminal\?\.id \|\| !data\.browserTunnel\?\.id\)navigate\('onboarding'\)/);
});
test('Windows color palette follows macOS and logo is bundled locally',()=>{
 const mac=read('native/main.swift');
 for(const hex of ['0D1016','11151D','191E28','131822','303747','8795FF','56D4C5']){
  assert.match(mac,new RegExp('0x'+hex));
  assert.ok(css.toLowerCase().includes('#'+hex.toLowerCase()),hex+' missing in Windows palette');
 }
 assert.match(html,/src="logo\.png"/);
 assert.ok(require('../package.json').build.files.includes('app/logo.png'));
 assert.ok(fs.statSync(path.join(root,'windows/app/logo.png')).size>1024);
 assert.match(html,/Content-Security-Policy/);
 assert.doesNotMatch(html,/<script[^>]+src="https?:/);
});
test('Windows UI still declares all renderer control IDs and two system status cards',()=>{
 const ids=new Set([...html.matchAll(/id="([^"]+)"/g)].map(x=>x[1]));
 for(const match of renderer.matchAll(/\$\('([a-z][a-z0-9-]*)'\)/g))
  assert.ok(ids.has(match[1]),'Missing element: '+match[1]);
 for(const name of ['terminal','terminalTunnel','browser','proxy','browserTunnel','autosendBrowser','autosend','messaging'])
  assert.ok(ids.has('state-'+name),'Missing status: '+name);
 assert.ok(ids.has('terminal-pill') && ids.has('browser-pill'));
 assert.match(renderer,/fresh\(h\.terminal\)&&h\.terminal\.state==='ready'/);
 assert.match(renderer,/fresh\(h\.browser\)&&h\.browser\.state==='ready'/);
});
test('sidebar tools use fixed allowlisted Electron handlers, not renderer filesystem access',()=>{
 const main=read('windows/app/main.cjs');
 const preload=read('windows/app/preload.cjs');
 const toolIds=[...html.matchAll(/data-open="([^"]+)"/g)].map(x=>x[1]);
 assert.deepEqual(toolIds,['folder','logs','docs']);
 assert.match(renderer,/window\.mcpgo\.openLocation\(button\.dataset\.open\)/);
 assert.match(preload,/openLocation:kind=>ipcRenderer\.invoke\('mcpgo:open-location',kind\)/);
 assert.match(main,/kind!=='folder'&&kind!=='logs'/);
 assert.match(main,/INVALID_LOCATION/);
 assert.match(main,/mcpgo:skill-read/);
 assert.match(main,/mcpgo:skill-copy/);
 assert.match(main,/mcpgo:skill-open/);
 assert.match(main,/shell\.openPath\(target\)/);
 assert.doesNotMatch(renderer,/require\(|eval\(/);
});
