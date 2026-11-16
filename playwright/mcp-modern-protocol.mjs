/** External MCP 2026-07-28 wire adapter. Playwright remains a private 2025-era MCP backend.
 * No session IDs are accepted or emitted on the public modern HTTP interface.
 * Every response has a resultType and serverInfo stamp, even when it was
 * originally supplied by the legacy upstream as an SSE data frame.
 */
import {createHash} from 'node:crypto';

export const MODERN_PROTOCOL='2026-07-28';
export const SERVER_INFO={name:'McpGo-Browser',version:'1.0.0'};
export const SERVER_META_KEY='io.modelcontextprotocol/serverInfo';
export const VERSION_META_KEY='io.modelcontextprotocol/protocolVersion';
export const CAPABILITIES_META_KEY='io.modelcontextprotocol/clientCapabilities';
export const CLIENT_INFO_META_KEY='io.modelcontextprotocol/clientInfo';
export const ERROR_HEADER_MISMATCH=-32020;
export const ERROR_MISSING_CAPABILITIES=-32021;
export const ERROR_UNSUPPORTED_VERSION=-32022;
export const modernMeta=(name='McpGo-Client')=>({
 [VERSION_META_KEY]:MODERN_PROTOCOL,
 [CAPABILITIES_META_KEY]:{},
 [CLIENT_INFO_META_KEY]:{name,version:'1.0.0'},
});
export const modernHeaders=(method,params={})=>({
 'content-type':'application/json','accept':'application/json, text/event-stream',
 'mcp-protocol-version':MODERN_PROTOCOL,
 'mcp-method':method,
 ...(method==='tools/call'?{'mcp-name':params.name}:{})
});
export const modernParams=(params={},client='McpGo-Client')=>({
 ...params,_meta:{...modernMeta(client),...(params._meta||{})}
});

export function validateModernRequest(headers,data){
 const bad=(code,message)=>({code,message});
 if(!data||Array.isArray(data)||data.jsonrpc!=='2.0'||typeof data.method!=='string'||
    !('id' in data)||!(typeof data.id==='string'||typeof data.id==='number'))
   return bad(-32600,'Invalid JSON-RPC request');
 if(headers['mcp-protocol-version']!==MODERN_PROTOCOL)
   return bad(ERROR_UNSUPPORTED_VERSION,'Unsupported MCP protocol; only 2026-07-28 is exposed');
 if(headers['mcp-method']!==data.method)
   return bad(ERROR_HEADER_MISMATCH,'Mcp-Method does not match JSON-RPC method');
 const named=data.method==='tools/call';
 if(named){
  if(typeof data.params?.name!=='string'||!data.params.name||headers['mcp-name']!==data.params.name)
   return bad(ERROR_HEADER_MISMATCH,'Mcp-Name does not match tool name');
 }else if(headers['mcp-name']!==undefined)
   return bad(ERROR_HEADER_MISMATCH,'Unexpected Mcp-Name');
 const meta=data.params?._meta;
 if(!meta||typeof meta!=='object'||Array.isArray(meta)||meta[VERSION_META_KEY]!==MODERN_PROTOCOL)
   return bad(ERROR_UNSUPPORTED_VERSION,'Missing or unsupported per-request protocolVersion');
 if(!meta[CAPABILITIES_META_KEY]||typeof meta[CAPABILITIES_META_KEY]!=='object'||
    Array.isArray(meta[CAPABILITIES_META_KEY]))
   return bad(ERROR_MISSING_CAPABILITIES,'Missing clientCapabilities');
 const client=meta[CLIENT_INFO_META_KEY];
 if(client!==undefined && (!client||typeof client.name!=='string'||typeof client.version!=='string'))
   return bad(-32602,'Invalid clientInfo');
 if(!['server/discover','tools/list','tools/call'].includes(data.method))
   return bad(-32601,'Method not supported by McpGo browser proxy');
 if(data.method==='tools/call'&&(!data.params||typeof data.params.arguments!=='object'||
    Array.isArray(data.params.arguments)||data.params.arguments===null))
   return bad(-32602,'Invalid tool arguments');
 return null;
}
export function normalizedConversationHint(headers,meta){
 const explicit=headers['x-mcpgo-agent-id']||headers['x-mcpgo-conversation-id'];
 if(explicit)return explicit;
 // ChatGPT may supply anonymized conversation identity; only treat it as a
 // stable, untrusted locator INSIDE the already authorized local MCP tunnel.
 const openai=meta?.['openai/session'];
 if(typeof openai!=='string'||openai.length<3||openai.length>512)return null;
 return 'openai-session-'+createHash('sha256').update(openai).digest('hex').slice(0,48);
}
export function modernizeMessage(message,{cache=false,serverInfo=SERVER_INFO}={}){
 if(!message||typeof message!=='object'||Array.isArray(message)||!message.result||
    typeof message.result!=='object'||Array.isArray(message.result))return message;
 const result=message.result;
 return {...message,result:{...result,resultType:'complete',
   ...(cache?{ttlMs:0,cacheScope:'private'}:{}),
   _meta:{...(result._meta||{}),[SERVER_META_KEY]:serverInfo}}};
}
export function modernizeResponse(raw,contentType,{cache=false}={}){
 const source=Buffer.isBuffer(raw)?raw.toString('utf8'):String(raw);
 if(String(contentType).includes('text/event-stream')){
  return Buffer.from(source.replace(/^data:\s*(\{[^\r\n]*\})\r?$/gm,(line,s)=>{
    try{return 'data: '+JSON.stringify(modernizeMessage(JSON.parse(s),{cache}));}catch{return line;}
  }));
 }
 return Buffer.from(JSON.stringify(modernizeMessage(JSON.parse(source),{cache})));
}
export function discoverResult({serverInfo=SERVER_INFO,instructions}={}){
 return {resultType:'complete',supportedVersions:[MODERN_PROTOCOL],capabilities:{tools:{}},
   instructions:instructions||'Each browser action belongs to a McpGo workspace. Reuse workspace_id from every tool result; without a ChatGPT conversation identity, call mcpgo_workspace first.',
   ttlMs:0,cacheScope:'private',_meta:{[SERVER_META_KEY]:serverInfo}};
}
export function stripModernParams(data){
 if(!data||!data.params)return data;
 const { _meta:meta, ...params}=data.params;
 return {...data,params};
}
