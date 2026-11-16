import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const server=readFileSync(new URL('../server.mjs',import.meta.url),'utf8');
const app=readFileSync(new URL('../app.js',import.meta.url),'utf8');
const page=readFileSync(new URL('../index.html',import.meta.url),'utf8');
test('dashboard exposes exactly the unified terminal and its tunnel',()=>{
 assert.match(server,/terminal:\s*\['com\.chatterminalhub\.oneshot','com\.chatterminalhub\.tunnel'\]/);
 assert.match(server,/terminal:\{oneshot:terminal\[0\],tunnel:terminal\[1\]\}/);
 assert.doesNotMatch(app,/t\.server\./);
 assert.doesNotMatch(page,/terminal-server|Command server/);
 assert.match(page,/terminal-oneshot/);
});
test('terminal restart waits for launchd unload and the port to close',()=>{
 assert.match(server,/groups\[group\]\.every\(label=>!job\(label\)\.loaded\)/);
 assert.match(server,/group==='terminal' && !await waitFor\(async\(\)=>!\(await alive\(12848\)\)/);
 assert.match(server,/job\(groups\.terminal\[0\]\)\.running && await alive\(12848\)/);
});
