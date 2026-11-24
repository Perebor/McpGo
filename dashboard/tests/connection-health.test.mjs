import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import health from '../connection-health.cjs';
const now=1800000000000;
const good={running:true,mcp:true,tunnel:'ready',checkedAt:now};
test('a live PID and open port cannot create green health without fresh MCP and tunnel proof',()=>{
 assert.equal(health.evaluate({...good,mcp:false},now).state,'degraded');
 assert.equal(health.evaluate({...good,tunnel:'auth'},now).state,'auth');
 assert.equal(health.evaluate({...good,tunnel:'down'},now).state,'degraded');
 assert.equal(health.evaluate({...good,tunnel:'starting'},now).state,'degraded');
 assert.equal(health.evaluate({...good,tunnel:'unmonitored'},now).state,'unknown');
 assert.equal(health.evaluate({...good,checkedAt:now-30001},now).state,'unknown');
 assert.equal(health.evaluate({...good,checkedAt:now+1},now).state,'unknown');
 assert.equal(health.evaluate({...good,running:false},now).state,'stopped');
 assert.equal(health.evaluate(good,now).state,'ready');
 assert.equal(health.evaluate(good,now).chatgpt,'unverified');
});
test('reproduced false-green: extension lost while MCP and tunnel still ready',()=>{
 const lastConnectedAt=new Date(now-1000).toISOString();
 const connected=health.browserEvidence({browser:'connected',transport:'ready',lastConnectedAt},now);
 assert.equal(health.evaluate({...good,browser:connected},now).state,'ready');
 const failed=health.browserEvidence({browser:'degraded',transport:'ready',lastConnectedAt},now);
 assert.equal(health.evaluate({...good,browser:failed},now).state,'degraded');
 assert.equal(health.evaluate({...good,browser:failed},now).reason,'BROWSER_CONNECTION_FAILED');
 assert.equal(health.evaluate({...good,browser:health.browserEvidence(null,now)},now).state,'unknown');
});
test('failed explicit verification overrides older success until a newer successful call',()=>{
 const old={browser:'connected',transport:'ready',lastConnectedAt:new Date(now-100).toISOString()};
 assert.equal(health.browserEvidence(old,now,now-50).state,'failed');
 assert.equal(health.browserEvidence({...old,lastConnectedAt:new Date(now).toISOString()},now,now-50).state,'ready');
});
test('idle browser is unknown rather than broken or indefinitely green',()=>{
 const telemetry={browser:'connected',transport:'ready',lastConnectedAt:new Date(now-301000).toISOString()};
 const b=health.browserEvidence(telemetry,now);
 assert.equal(b.state,'unknown');assert.equal(b.reason,'BROWSER_NOT_RECENTLY_VERIFIED');
 assert.equal(health.evaluate({...good,browser:b},now).state,'unknown');
});
test('health probe does not call tools or wake Chrome; rejects unsafe tool lists',async()=>{
 const methods=[];
 const mock=async(_url,opts)=>{
  const m=JSON.parse(opts.body).method;methods.push(m);
  return {ok:true,text:async()=>JSON.stringify({result:{resultType:'complete',
   supportedVersions:['2026-07-28'],tools:[{name:'browser_tabs'},{name:'browser_snapshot'}]}})};
 };
 assert.equal(await health.probeMcp('http://127.0.0.1:8940/mcp',['browser_tabs'],mock),true);
 assert.deepEqual(methods,['server/discover','tools/list']);
 assert.equal(await health.probeMcp('http://example.com/mcp',['browser_tabs'],()=>{throw Error('forbidden')}),false);
 assert.equal(await health.probeMcp('http://127.0.0.1:8940/mcp',['browser_tabs'],async()=>({ok:true,text:async()=>JSON.stringify({result:{resultType:'complete',supportedVersions:['2026-07-28'],tools:[{name:'browser_tabs'},{name:'browser_run_code_unsafe'}]}})})),false);
});
test('tunnel health distinguishes rate limits, auth, startup and liveness',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mcpgo-typed-health-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const f=path.join(dir,'health.url');fs.writeFileSync(f,'http://127.0.0.1:12345',{mode:0o600});
 for(const [code,expected] of [[200,'ready'],[403,'auth'],[429,'throttled'],[503,'starting']])
  assert.equal(await health.tunnelHealth(f,async url=>({status:url.endsWith('/healthz')?200:code})),expected);
 assert.equal(await health.tunnelHealth(f,async()=>{throw Error('connection lost')}),'down');
 assert.equal(await health.tunnelHealth(f,async()=>({status:403})),'auth');
});
test('history records transitions only and remains after restart',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mcpgo-health-history-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const f=path.join(dir,'history.json'),h=new health.HealthHistory(f);
 h.observe('browser',{state:'ready',reason:null},now);
 h.observe('browser',{state:'ready',reason:null},now+1);
 h.observe('browser',{state:'degraded',reason:'BROWSER_CONNECTION_FAILED'},now+2);
 h.observe('browser',{state:'ready',reason:null},now+3);
 assert.deepEqual(new health.HealthHistory(f).snapshot().map(e=>e.state),['ready','degraded','ready']);
 assert.equal(fs.readFileSync(f,'utf8').includes('token'),false);
});
