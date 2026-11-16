/**
 * Preserve JSON-RPC and SSE body shape while repeating the browser workspace
 * in every MCP tool result, both as structuredContent and a short text note.
 * Do not modify initializations, notifications, errors, screenshots or pages.
 */
import {validWorkspaceId} from './browser-workspace.mjs';
const intro=id=>`### McpGo browser workspace\nworkspace_id: ${id}\nREQUIRED: pass this SAME workspace_id in EVERY subsequent browser call (including snapshots); never reuse another agent workspace_id.`;
export const workspaceParameter={type:'string',description:'REQUIRED for every browser action: use the private workspace_id obtained from mcpgo_workspace or your last browser tool result. Do not copy a workspace_id from another chat or agent.'};
const BOOTSTRAP_TOOL_NAMES=new Set(['mcpgo_workspace','mcpgo_browser_status','mcpgo_action_status']);
export const withWorkspaceToolSchema=(tool,{requireWorkspace=false}={})=>{
  if(!tool?.name||!(/^(browser_|mcpgo_)/.test(tool.name)))return tool;
  const schema=tool.inputSchema||{type:'object',properties:{}};
  const isRequired=requireWorkspace&&!BOOTSTRAP_TOOL_NAMES.has(tool.name);
  const required=[...(schema.required||[])];
  if(isRequired&&!required.includes('workspace_id'))required.push('workspace_id');
  const newSchema={...schema,type:'object',
    properties:{...(schema.properties||{}),workspace_id:schema.properties?.workspace_id||workspaceParameter},
    ...(isRequired?{required}:{})};
  const unchanged=!!schema.properties?.workspace_id&&
    (!isRequired||(schema.required||[]).includes('workspace_id'));
  if(unchanged)return tool;
  return {...tool,
    description:`${tool.description||''} McpGo returns workspace_id in every result; MUST pass it on every subsequent call (including browser_snapshot) to avoid false conflicts when MCP session identifiers rotate.`.trim(),
    inputSchema:newSchema,
    ...(tool.outputSchema&&tool.outputSchema.type==='object' ? {outputSchema:{
      ...tool.outputSchema,properties:{...(tool.outputSchema.properties||{}),workspace_id:{type:'string'}}
    }} : {})};
};
export function attachWorkspace(result,workspaceId){
  if(!validWorkspaceId(workspaceId)||!result||!Array.isArray(result.content))return result;
  const structured=(result.structuredContent&&typeof result.structuredContent==='object'&&!Array.isArray(result.structuredContent))
    ? result.structuredContent:{};
  const notice=intro(workspaceId);
  const content=result.content.filter(c=>!(c?.type==='text'&&c.text?.startsWith('### McpGo browser workspace\n')));
  return {...result,structuredContent:{...structured,workspace_id:workspaceId},
    content:[...content,{type:'text',text:notice}]};
}
function amendMessage(message,workspaceId){
  if(message&&typeof message==='object'&&message.result&&Array.isArray(message.result.content))
    return {...message,result:attachWorkspace(message.result,workspaceId)};
  return message;
}
export function decorateMcpToolResponse(raw,contentType,workspaceId){
  const input=Buffer.isBuffer(raw)?raw.toString('utf8'):String(raw);
  if(!validWorkspaceId(workspaceId))return Buffer.from(input);
  if(input.trimStart().startsWith('{')){
    const message=JSON.parse(input);
    return Buffer.from(JSON.stringify(amendMessage(message,workspaceId)));
  }
  if(String(contentType).includes('text/event-stream')){
    const output=input.replace(/^data: (\{[^\r\n]*\})\r?$/gm,(line,value)=>{
      try{return 'data: '+JSON.stringify(amendMessage(JSON.parse(value),workspaceId));}
      catch{return line;}
    });
    return Buffer.from(output);
  }
  throw Error('Unrecognized MCP response format');
}
