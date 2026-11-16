import test from 'node:test';
import assert from 'node:assert/strict';
import {BrowserWorkspaceRegistry,validWorkspaceId} from '../browser-workspace.mjs';
import {AgentScopeRegistry} from '../agent-scope.mjs';
import {attachWorkspace,decorateMcpToolResponse,withWorkspaceToolSchema} from '../workspace-response.mjs';

test('high-entropy, non-derivable and expiring workspace IDs remain stable for an agent',()=>{
 let now=0;
 const registry=new BrowserWorkspaceRegistry({now:()=>now,ttlMs:2000});
 const first=registry.ensure('agent-A'),second=registry.ensure('agent-B');
 assert.ok(validWorkspaceId(first));assert.ok(validWorkspaceId(second));assert.notEqual(first,second);
 assert.equal(registry.ensure('agent-A'),first);
 assert.equal(registry.status().workspaceCount,2);
 assert.equal(registry.lookup('ws_known'),null);
 now=1000;assert.equal(registry.lookup(second)?.agent,'agent-B');
 now=2100;
 assert.equal(registry.lookup(first),null);
 assert.equal(registry.lookup(second)?.agent,'agent-B');
 const replacement=registry.ensure('agent-A');assert.notEqual(first,replacement);
 assert.doesNotMatch(JSON.stringify(registry.status()),/agent-|ws_/);
});
test('workspace recovery is explicit, cannot hijack a stable header or occupied client',()=>{
 const reg=new BrowserWorkspaceRegistry();
 const agent='agent-A', targetId=reg.ensure(agent);
 assert.deepEqual(reg.resolve('agent-A','transport',targetId).resumed,false);
 assert.equal(reg.resolve('agent-B','stable',targetId).error,'WORKSPACE_STABLE_SCOPE_CONFLICT');
 assert.equal(reg.resolve('agent-B','transport',targetId,{hasOwnedTabs:true}).error,'WORKSPACE_CURRENT_AGENT_HAS_TABS');
 assert.equal(reg.resolve(null,'legacy',targetId).error,'WORKSPACE_REQUIRES_MCP_SESSION');
 assert.equal(reg.resolve('agent-B','transport','ws_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA').error,'UNKNOWN_OR_EXPIRED_WORKSPACE');
 const resumed=reg.resolve('agent-B','transport',targetId);
 assert.equal(resumed.resumed,true);
 reg.ensure('agent-B');reg.adopt('agent-B',resumed.agent);
 assert.equal(reg.ensure('agent-A'),targetId);
 assert.equal(reg.status().workspaceCount,1);
});
test('reconnected transport rebinds only its own session, stable identity is immutable',()=>{
 const scopes=new AgentScopeRegistry();
 const a=scopes.create(), b=scopes.create(), fixed=scopes.create({'x-mcpgo-conversation-id':'fixed-chat'});
 assert.equal(scopes.adoptWorkspace({'mcp-session-id':b.sessionId},a.agent).mode,'workspace');
 assert.equal(scopes.resolve({'mcp-session-id':b.sessionId}).agent,a.agent);
 assert.equal(scopes.adoptWorkspace({'mcp-session-id':fixed.sessionId},a.agent).error,'WORKSPACE_STABLE_SCOPE_CONFLICT');
 assert.equal(scopes.resolve({'mcp-session-id':fixed.sessionId}).agent,fixed.agent);
});
test('SSE tool result keeps media, structuredContent, JSON-RPC and short workspace reminder',()=>{
 const ws=new BrowserWorkspaceRegistry().ensure('agent-A');
 const event={jsonrpc:'2.0',id:12,result:{content:[{type:'image',data:'image-content',mimeType:'image/png'},
   {type:'text',text:'### Result\nclicked'}],structuredContent:{tool_value:42}}};
 const raw=Buffer.from('event: message\ndata: '+JSON.stringify(event)+'\n\n');
 const transformed=decorateMcpToolResponse(raw,'text/event-stream',ws).toString();
 const parsed=JSON.parse(transformed.split('\n').find(x=>x.startsWith('data: ')).slice(6));
 assert.equal(parsed.id,12);assert.equal(parsed.result.structuredContent.workspace_id,ws);
 assert.equal(parsed.result.structuredContent.tool_value,42);
 assert.deepEqual(parsed.result.content[0],event.result.content[0]);
 assert.equal(parsed.result.content[1].text,'### Result\nclicked');
 assert.match(parsed.result.content[2].text,new RegExp('workspace_id: '+ws));
 const once=attachWorkspace(parsed.result,ws);
 assert.equal(once.content.filter(c=>c.text?.startsWith('### McpGo browser workspace')).length,1);
});
test('JSON tool result and strict tool schemas support workspace_id without modifying input or error messages',()=>{
 const ws=new BrowserWorkspaceRegistry().ensure('agent-A');
 const incoming={jsonrpc:'2.0',id:1,result:{content:[{type:'text',text:'Snapshot'}]}};
 const out=JSON.parse(decorateMcpToolResponse(Buffer.from(JSON.stringify(incoming)),'application/json',ws));
 assert.equal(out.result.structuredContent.workspace_id,ws);
 const schema=withWorkspaceToolSchema({name:'browser_tabs',description:'Tabs',inputSchema:{type:'object',properties:{action:{type:'string'}},required:['action'],additionalProperties:false}});
 assert.equal(schema.inputSchema.properties.workspace_id.type,'string');
 assert.deepEqual(schema.inputSchema.required,['action']);
 const mandatory=withWorkspaceToolSchema(schema,{requireWorkspace:true});
 assert.deepEqual(mandatory.inputSchema.required,['action','workspace_id']);
 assert.deepEqual(withWorkspaceToolSchema(mandatory,{requireWorkspace:true}),mandatory);
 assert.ok(!withWorkspaceToolSchema({name:'mcpgo_workspace',inputSchema:{type:'object',properties:{}}},{requireWorkspace:true}).inputSchema.required?.includes('workspace_id'));
 assert.equal(schema.inputSchema.additionalProperties,false);
 assert.deepEqual(withWorkspaceToolSchema(schema),schema);
 const schemaWithOutput=withWorkspaceToolSchema({name:'browser_snapshot',
   inputSchema:{type:'object',properties:{}},
   outputSchema:{type:'object',additionalProperties:false,properties:{snapshot:{type:'string'}},required:['snapshot']}});
 assert.equal(schemaWithOutput.outputSchema.properties.workspace_id.type,'string');
 assert.equal(schemaWithOutput.outputSchema.additionalProperties,false);
 assert.deepEqual(schemaWithOutput.outputSchema.required,['snapshot']);
 assert.equal(withWorkspaceToolSchema({name:'browser_run_code_unsafe'}).inputSchema.properties.workspace_id.type,'string');
 assert.equal(decorateMcpToolResponse(Buffer.from(JSON.stringify({jsonrpc:'2.0',id:2,error:{code:-1,message:'Bad'}})),'application/json',ws).toString(),JSON.stringify({jsonrpc:'2.0',id:2,error:{code:-1,message:'Bad'}}));
});
