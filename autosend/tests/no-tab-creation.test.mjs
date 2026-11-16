import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const source=readFileSync(new URL('../delivery.mjs',import.meta.url),'utf8');
const server=readFileSync(new URL('../server.mjs',import.meta.url),'utf8');

test('AutoSend executor cannot create, close or navigate Chrome tabs',()=>{
 assert.doesNotMatch(source,/browser_tabs'\s*,\s*\{action:\s*'new'/);
 assert.doesNotMatch(source,/browser_tabs'\s*,\s*\{action:\s*'close'/);
 assert.doesNotMatch(source,/browser_navigate/);
 assert.doesNotMatch(server,/browser_tabs'\s*,\s*\{action:\s*'new'/);
 assert.doesNotMatch(server,/browser_navigate/);
});
test('scheduler does not reintroduce legacy auto-reload or CDP executors',()=>{
 assert.doesNotMatch(server,/reloadStalledChat|monitorStalledChats|stall-watchdog|cdp-delivery/);
 assert.doesNotMatch(source,/cdp-delivery|\b--cdp-endpoint\b/);
});
