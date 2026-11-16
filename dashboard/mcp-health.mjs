/** Passive browser proxy readiness over external MCP 2026-07-28.
 * No initialize, sessions, Chrome tools or Chrome extension connections.
 */
import {modernHeaders,modernParams,MODERN_PROTOCOL,SERVER_META_KEY} from '../playwright/mcp-modern-protocol.mjs';
export async function probeMcp(url='http://127.0.0.1:8940/mcp',fetchImpl=fetch){
 let id=0;
 async function send(method,params={}){
  const body={jsonrpc:'2.0',id:++id,method,params:modernParams(params,'McpGo-Dashboard-Health')};
  const response=await fetchImpl(url,{method:'POST',headers:modernHeaders(method,body.params),
    body:JSON.stringify(body),signal:AbortSignal.timeout(5000)});
  const text=await response.text();
  if(!response.ok)throw Error(method+' HTTP '+response.status);
  const json=text.trim().startsWith('{')?text:text.split(/\r?\n/).find(x=>x.startsWith('data: '))?.slice(6);
  if(!json)throw Error('No modern MCP response');
  const reply=JSON.parse(json);
  if(reply.error)throw Error(method+' MCP error: '+reply.error.message);
  if(reply.result?.resultType!=='complete')throw Error('Non-modern MCP response');
  return reply.result;
 }
 const discovered=await send('server/discover');
 if(!discovered?.supportedVersions?.includes(MODERN_PROTOCOL)||
    !discovered?.[ '_meta' ]?.[SERVER_META_KEY])throw Error('MCP 2026 discovery invalid');
 const list=await send('tools/list');
 const names=list?.tools?.map(x=>x.name)||[];
 if(!names.includes('browser_tabs')||!names.includes('browser_snapshot')||
   names.includes('browser_run_code_unsafe'))throw Error('MCP tools/list invalid');
 return true;
}
