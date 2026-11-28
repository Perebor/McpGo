import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectExtensionConnection} from '../extension-diagnostic.mjs';

test('MCP-03 owner read-only extension probe checks tool capability, not tab access or Send',async()=>{
 const calls=[];
 const probe=await inspectExtensionConnection({
  listTools:async()=>{calls.push('tools/list');return [
   {name:'browser_tabs'},{name:'browser_snapshot'},{name:'browser_click'}]}
 });
 assert.deepEqual(calls,['tools/list']);
 assert.deepEqual(probe,{connected:true,reason:'PLAYWRIGHT_MCP_TOOLS_VERIFIED'});
 assert.equal(JSON.stringify(probe).includes('http'),false);
});
test('MCP-03 read-only connection probe rejects unhealthy or ambiguous tool catalog',async()=>{
 for(const bad of [[],[{name:'browser_click'}],null,{},'browser_tabs']){
  const probe=await inspectExtensionConnection({listTools:async()=>bad});
  assert.equal(probe.connected,false);
  assert.equal(probe.reason,'PLAYWRIGHT_MCP_CAPABILITIES_MISSING');
 }
 const failed=await inspectExtensionConnection({
  listTools:async()=>{throw Error('credential=very-private-session-secret');}
 });
 assert.equal(failed.connected,false);
 assert.equal(JSON.stringify(failed).includes('private'),false);
 assert.equal(failed.reason,'PLAYWRIGHT_MCP_PROBE_FAILED');
});
test('MCP-03 owner connection probe never approves or selects a Chrome tab',async()=>{
 const client={listTools:async()=>[{name:'browser_tabs'},{name:'browser_snapshot'}],
  tool:async()=>{throw Error('Any browser interaction forbidden')}};
 const result=await inspectExtensionConnection(client);
 assert.equal(result.connected,true);
});
