/**
 * Owner-invoked read-only Playwright extension handshake.
 * Never calls browser_tabs, navigates, types, clicks or approves a chat.
 * Capability verification ≠ a tab lease ≠ proof of actual ChatGPT delivery.
 */
export async function inspectExtensionConnection(client){
 try {
  if(typeof client?.listTools!=='function')return {connected:false,reason:'PLAYWRIGHT_MCP_CAPABILITIES_MISSING'};
  const capabilities=await client.listTools();
  const names=new Set(Array.isArray(capabilities)?capabilities.map(t=>t?.name):[]);
  if(!names.has('browser_tabs')||!names.has('browser_snapshot'))
   return {connected:false,reason:'PLAYWRIGHT_MCP_CAPABILITIES_MISSING'};
  return {connected:true,reason:'PLAYWRIGHT_MCP_TOOLS_VERIFIED'};
 }catch{
  // Never leak provider URLs, Chrome content, local user paths, or tokens.
  return {connected:false,reason:'PLAYWRIGHT_MCP_PROBE_FAILED'};
 }
}
