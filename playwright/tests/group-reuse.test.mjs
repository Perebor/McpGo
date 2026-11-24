import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {patchSource} from '../patch-playwright.mjs';
import {SHARED_CLIENT} from '../browser-session-manager.mjs';
import {browserConfig} from '../../launchers/browser.mjs';

const bundled=fileURLToPath(new URL('../node_modules/playwright-core/lib/coreBundle.js',import.meta.url));
const core=fs.readFileSync(bundled,'utf8');
const proxy=fs.readFileSync(fileURLToPath(new URL('../restricted-proxy.mjs',import.meta.url)),'utf8');

test('upstream group lifecycle unmodified, shared proxy is connection owner',()=>{
 assert.ok(core.includes('const last = !shared || !clientCount;'));
 assert.ok(core.includes('config.tabGroup === false ? void 0 : { title: config.sessionName, color: config.sessionColor }'),
  'v0.0.86 native extension tab-group ownership and named sessions retained');
 assert.ok(core.includes('profileDirName, clientInfo.clientName, tabGroup, config.background'));
 assert.doesNotMatch(core,/PLAYWRIGHT_MCP_SESSION_NAME \|\| clientInfo\.clientName/);
 assert.ok(proxy.includes('clientInfo:{name:SHARED_CLIENT'));
 assert.equal(SHARED_CLIENT,'MCPGO');
 assert.ok(proxy.includes("req.method!=='POST' && !LEGACY_COMPAT"));
 assert.ok(proxy.includes('MCPGO_DISABLE_LEGACY'));
 assert.ok(proxy.includes('Do not tear down the shared browser session on client disconnect'));
});
test('official shared-browser-context keeps extension group common to MCP clients',()=>{
 const cfg=browserConfig({env:{MCPGO_BROWSER_MODE:'extension',PLAYWRIGHT_MCP_EXTENSION_TOKEN:'abcdefghijklmnopqrstuvwxyz012345'},settingsDir:'/nonexistent'});
 assert.ok(cfg.args.includes('--shared-browser-context'));
 assert.ok(cfg.args.includes('--background'));
 assert.ok(!cfg.args.includes('--no-tab-group'));
});
test('only bounded metadata compatibility patch remains, and is idempotent',()=>{
 assert.deepEqual(patchSource(core),{source:core,modified:false});
 const other=core.replace('const last = !shared || !clientCount;','const last = alternativeLifecycle();');
 assert.equal(patchSource(other).modified,false,'no group lifecycle monkey-patching');
});
