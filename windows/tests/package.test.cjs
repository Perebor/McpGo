'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const app=require('../package.json');
const repo=path.resolve(__dirname,'../..');
test('unsigned Windows NSIS preview is per-user and has no auto-publish',()=>{
 const cfg=app.build;
 assert.equal(cfg.nsis.perMachine,false);
 assert.equal(cfg.nsis.oneClick,false);
 assert.equal(cfg.win.requestedExecutionLevel,'asInvoker');
 assert.equal(cfg.publish,undefined);
 assert.equal(cfg.win.target[0].target,'nsis');
});
test('Windows reinstall keeps the stable app identity and userData outside package',()=>{
 assert.equal(app.build.appId,'ru.mcpgo.desktop');
 assert.equal(app.build.productName,'McpGo');
 assert.equal(app.build.nsis.perMachine,false);
 const source=fs.readFileSync(path.join(repo,'windows/app/main.cjs'),'utf8');
 const settings=fs.readFileSync(path.join(repo,'windows/app/settings.cjs'),'utf8');
 assert.match(source,/app\.getPath\('userData'\)/);
 assert.match(settings,/path\.join\(this\.userData\(\),'settings\.json'\)/);
 assert.doesNotMatch(source,/rmSync|rmdirSync/);
 assert.doesNotMatch(settings,/rmSync|rmdirSync/);
});
test('bundle allowlists exact runtime files and not private local configuration',()=>{
 const resources=app.build.extraResources;
 const terminal=resources.find(x=>x.to==='mcpgo-runtime/terminal');
 const playwright=resources.find(x=>x.to==='mcpgo-runtime/playwright');
 assert.ok(terminal&&playwright);
 const expected=['stateless_server.js','job_runtime.js','job_worker.js','platform.js',
  'resource_locks.js','resource_policy.js','mcp-version.json','interactive_runtime.cjs','pty_worker_win.js','files_tools.cjs','dashboard.html','dashboard.js','dashboard.css'];
 for(const file of expected){
  assert.ok(terminal.filter.includes(file),file+' missing');
  assert.ok(fs.existsSync(path.join(repo,'terminal',file)),file+' absent');
 }
 assert.ok(resources.some(x=>x.from==='../playwright/node_modules'&&x.to==='mcpgo-runtime/playwright/node_modules'&&x.filter.includes('**/*')));
 for(const file of ['restricted-proxy.mjs','action-guard.mjs','browser-session-manager.mjs',
  'tab-lease-manager.mjs','agent-scope.mjs','portable-tab-identity.mjs','portable-agent-tabs.mjs','browser-workspace.mjs','workspace-response.mjs','mcp-modern-protocol.mjs'])
  assert.ok(playwright.filter.includes(file));
 const autosend=resources.find(x=>x.to==='mcpgo-runtime/autosend');
 assert.ok(autosend&&autosend.filter.includes('*.mjs'));
 assert.ok(fs.existsSync(path.join(repo,'autosend','browser-client.mjs')));
 assert.ok(fs.existsSync(path.join(repo,'autosend','delivery.mjs')));
 assert.ok(fs.existsSync(path.join(repo,'autosend','preview-check.mjs')));
 assert.equal(fs.existsSync(path.join(repo,'autosend','cdp-delivery.mjs')),false);
 assert.equal(fs.existsSync(path.join(repo,'autosend','stall-watchdog.mjs')),false);
 for(const name of ['config.json','stateless-config.json','.env','tunnel.key','settings.json'])
  assert.equal(terminal.filter.includes(name)||playwright.filter.includes(name),false);
 assert.ok(app.build.files.every(x=>!x.includes('**/*')));
});
test('native verifier checks the exact built version and fails if installer is missing',()=>{
 const source=fs.readFileSync(path.join(repo,'windows/verify-build.py'),'utf8');
 assert.match(source,/windows\/package\.json/);
 assert.match(source,/Expected Windows NSIS installer missing/);
 assert.doesNotMatch(source,/McpGo Setup 2\.1\.0-preview\.1\.exe/);
});
test('Windows Electron window denies untrusted code execution and remote navigation',()=>{
 const main=fs.readFileSync(path.join(repo,'windows/app/main.cjs'),'utf8');
 const html=fs.readFileSync(path.join(repo,'windows/app/index.html'),'utf8');
 assert.match(main,/sandbox:true/);
 assert.match(main,/contextIsolation:true/);
 assert.match(main,/nodeIntegration:false/);
 assert.match(main,/setWindowOpenHandler/);
 assert.match(html,/Content-Security-Policy/);
 assert.doesNotMatch(html,/<script[^>]+src="https?:/);
});

test('Windows first-run wizard links to the official Playwright Extension install page',()=>{
 const html=fs.readFileSync(path.join(repo,'windows/app/index.html'),'utf8');
 const renderer=fs.readFileSync(path.join(repo,'windows/app/renderer.js'),'utf8');
 const preload=fs.readFileSync(path.join(repo,'windows/app/preload.cjs'),'utf8');
 const main=fs.readFileSync(path.join(repo,'windows/app/main.cjs'),'utf8');
 assert.match(html,/id="browser-install-extension"/);
 assert.match(html,/Manage clients/);
 assert.match(html,/PLAYWRIGHT_MCP_EXTENSION_TOKEN/);
 assert.match(renderer,/window\.mcpgo\.extensionStore\(\)/);
 assert.match(preload,/mcpgo:extension-store/);
 assert.match(main,/chromewebstore\.google\.com\/detail\/playwright-extension\/mmlmfjhmonkocbjadbfplnigmagldckm/);
 assert.doesNotMatch(main,/chrome-extension:\/\//);
});
