import test from 'node:test';
import assert from 'node:assert/strict';
import {modernHeaders,modernParams,modernizeMessage,modernizeResponse,
 validateModernRequest,normalizedConversationHint,discoverResult,MODERN_PROTOCOL,
 SERVER_META_KEY} from '../mcp-modern-protocol.mjs';
test('modern metadata is self-describing and header-name validation is strict',()=>{
 const params=modernParams({name:'browser_tabs',arguments:{action:'list'}},'test');
 const req={jsonrpc:'2.0',id:7,method:'tools/call',params};
 const headers=modernHeaders(req.method,params);
 assert.equal(validateModernRequest(headers,req),null);
 assert.equal(validateModernRequest({...headers,'mcp-name':'browser_close'},req).code,-32020);
 assert.equal(validateModernRequest({...headers,'mcp-method':'tools/list'},req).code,-32020);
 assert.equal(validateModernRequest({...headers,'mcp-protocol-version':'2025-03-26'},req).code,-32022);
 assert.equal(validateModernRequest({...headers}, {...req,params:{...params,_meta:{'io.modelcontextprotocol/protocolVersion':MODERN_PROTOCOL}}}).code,-32021);
 assert.deepEqual(discoverResult().supportedVersions,[MODERN_PROTOCOL]);
});
test('modern response preserves SSE/JSON-RPC payload and stamps complete, private cache and identity',()=>{
 const before={jsonrpc:'2.0',id:3,result:{tools:[{name:'browser_tabs'}],_meta:{other:5}}};
 const after=modernizeMessage(before,{cache:true});
 assert.equal(after.result.resultType,'complete');
 assert.equal(after.result.ttlMs,0);assert.equal(after.result.cacheScope,'private');
 assert.equal(after.result._meta[SERVER_META_KEY].name,'McpGo-Browser');
 assert.equal(after.result._meta.other,5);
 assert.equal(before.result.resultType,undefined);
 const sse='event: message\ndata: '+JSON.stringify(before)+'\n\n';
 const out=modernizeResponse(Buffer.from(sse),'text/event-stream',{cache:true}).toString();
 const payload=JSON.parse(out.split('\n')[1].slice(6));
 assert.equal(payload.result.resultType,'complete');
 assert.equal(payload.result.cacheScope,'private');
 assert.equal(JSON.parse(modernizeResponse(Buffer.from(JSON.stringify(before)),'application/json')).result.resultType,'complete');
});
test('ChatGPT anonymized conversation id is hashed; no client name inferred',()=>{
 const a=normalizedConversationHint({}, {'openai/session':'my-chat-id-001'});
 const b=normalizedConversationHint({}, {'openai/session':'my-chat-id-001'});
 const c=normalizedConversationHint({}, {'openai/session':'my-chat-id-002'});
 assert.equal(a,b);assert.notEqual(a,c);
 assert.match(a,/^openai-session-[a-f0-9]{48}$/);
 assert.doesNotMatch(a,/my-chat/);
 assert.equal(normalizedConversationHint({}, {'io.modelcontextprotocol/clientInfo':{name:'ChatGPT',version:'1'}}),null);
 assert.equal(normalizedConversationHint({}, {'openai/session':'A'}),null);
 assert.equal(normalizedConversationHint({'x-mcpgo-conversation-id':'autosend-123'}, {'openai/session':'something'}),'autosend-123');
});
