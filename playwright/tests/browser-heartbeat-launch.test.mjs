import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {browserConfig} from '../../launchers/browser.mjs';

test('macOS Playwright backend disables the HTTP ping heartbeat by default',()=>{
  const config=browserConfig({env:{PLAYWRIGHT_MCP_EXTENSION_TOKEN:'abcdefghijklmnopqrstuvwxyz012345'},settingsDir:'/nonexistent/mcpgo-heartbeat-settings'});
  assert.equal(config.env.PLAYWRIGHT_MCP_PING_TIMEOUT_MS,'0');
  assert.equal(config.args.includes('--shared-browser-context'),true);
});
test('macOS Playwright backend permits an explicit ping timeout override',()=>{
  const config=browserConfig({env:{PLAYWRIGHT_MCP_EXTENSION_TOKEN:'abcdefghijklmnopqrstuvwxyz012345',PLAYWRIGHT_MCP_PING_TIMEOUT_MS:'4500'},
    settingsDir:'/nonexistent/mcpgo-heartbeat-settings'});
  assert.equal(config.env.PLAYWRIGHT_MCP_PING_TIMEOUT_MS,'4500');
});
test('Windows Playwright backend also disables the HTTP ping heartbeat',()=>{
  const source=readFileSync(new URL('../../windows/app/runtime.cjs',import.meta.url),'utf8');
  assert.match(source,/PLAYWRIGHT_MCP_PING_TIMEOUT_MS:process\.env\.PLAYWRIGHT_MCP_PING_TIMEOUT_MS\?\?'0'/);
});
