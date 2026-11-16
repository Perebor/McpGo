import test from 'node:test';
import assert from 'node:assert/strict';
import {TabLeaseManager,parseTabIndices,validAgentId} from '../tab-lease-manager.mjs';

test('tab leases are exclusive, expire automatically, never record tab content',()=>{
 let time=100;
 const manager=new TabLeaseManager({now:()=>time,ttlMs:1000});
 assert.equal(manager.claim('agent-A',4).ok,true);
 assert.equal(manager.claim('agent-B',4).reason,'TAB_OWNED_BY_ANOTHER_AGENT');
 assert.equal(manager.check('agent-A',4).ok,true);
 assert.equal(manager.check('agent-B',4).ok,false);
 assert.equal(manager.check(null,4).ok,false);
 assert.equal(manager.status().leasedTabCount,1);
 assert.ok(!JSON.stringify(manager.status()).includes('agent-A'));
 assert.equal(manager.release('agent-B',4).ok,false);
 time=1101;
 assert.equal(manager.owner(4),null);
 assert.equal(manager.claim('agent-B',4).ok,true);
 manager.clear();
 assert.equal(manager.status().leasedTabCount,0);
 assert.equal(manager.status().leaseGeneration,1);
});
test('browser_tabs list parser does not store sensitive tab titles or URLs',()=>{
 const text='### Result\n- 0: [Sensitive tab](https://private.example)\n- 1: (current) [Work](https://example.org)';
 const snap=parseTabIndices(text);
 assert.deepEqual([...snap.indices],[0,1]);
 assert.equal(snap.current,1);
 assert.doesNotMatch(JSON.stringify(snap),/private\.example|Sensitive/);
 assert.ok(validAgentId('agent-A'));
 assert.ok(!validAgentId('../other'));
});
