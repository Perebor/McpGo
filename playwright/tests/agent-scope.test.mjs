import test from 'node:test';
import assert from 'node:assert/strict';
import {AgentScopeRegistry,normalizeHint} from '../agent-scope.mjs';

test('each concurrent MCP session automatically gets its own scope',()=>{
 const reg=new AgentScopeRegistry();
 const a=reg.create(),b=reg.create(),c=reg.create();
 assert.equal(new Set([a.agent,b.agent,c.agent]).size,3);
 for(const item of [a,b,c])assert.equal(reg.resolve({'mcp-session-id':item.sessionId}).agent,item.agent);
 assert.equal(reg.status().activeMcpSessions,3);
 assert.equal(reg.resolve({}).agent,null);
 reg.remove({'mcp-session-id':a.sessionId});
 assert.equal(reg.resolve({'mcp-session-id':a.sessionId}).error,'MCPGO_SESSION_EXPIRED');
});
test('external stable conversation ID survives MCP transport reconnect',()=>{
 const reg=new AgentScopeRegistry();
 const a=reg.create({'x-mcpgo-conversation-id':'conversation-A'});
 const b=reg.create({'x-mcpgo-conversation-id':'conversation-A'});
 const c=reg.create({'x-mcpgo-conversation-id':'conversation-B'});
 assert.equal(a.agent,b.agent);
 assert.notEqual(a.agent,c.agent);
 assert.equal(reg.resolve({'mcp-session-id':a.sessionId,'x-mcpgo-conversation-id':'conversation-B'}).error,'AGENT_IDENTITY_CONFLICT');
 assert.equal(reg.resolve({'x-mcpgo-agent-id':'conversation-A'}).agent,a.agent);
 assert.ok(!JSON.stringify(reg.status()).includes('conversation'));
});
test('cannot guess user chat identity from shared ChatGPT client name',()=>{
 const reg=new AgentScopeRegistry();
 const a=reg.create({'x-test-client-info-name':'ChatGPT'});
 const b=reg.create({'x-test-client-info-name':'ChatGPT'});
 assert.notEqual(a.agent,b.agent);
 assert.equal(normalizeHint({'x-mcpgo-conversation-id':'../escape'}),null);
});
test('expired sessions are not reattached or confused with other agents',()=>{
 let now=0;
 const reg=new AgentScopeRegistry({now:()=>now,ttlMs:500,maxSessions:3});
 const one=reg.create();now=1000;
 assert.equal(reg.resolve({'mcp-session-id':one.sessionId}).error,'MCPGO_SESSION_EXPIRED');
 const two=reg.create();
 assert.equal(reg.resolve({'mcp-session-id':one.sessionId}).error,'MCPGO_SESSION_EXPIRED');
 assert.equal(reg.resolve({'mcp-session-id':two.sessionId}).agent,two.agent);
});
