/**
 * Preserve JSON-RPC and SSE body shape while repeating the browser workspace
 * in every MCP tool result, both as structuredContent and a short text note.
 * Do not modify initializations, notifications, errors, screenshots or pages.
 */
import {validWorkspaceId} from './browser-workspace.mjs';
const intro=id=>`### McpGo browser workspace\nworkspace_id: ${id}\nUse workspace_id with subsequent browser tool calls, especially after reconnecting.`;
export const workspaceParameter={type:'string',description:'Optional McpGo browser workspace ID returned by earlier tool results. Reuse it after a new MCP session to recover the same browser tabs.'};
export const withWorkspaceToolSchema=tool=>{
  if(!tool?.name||!(/^(browser_|mcpgo_)/.test(tool.name)))return tool;
  if(tool.inputSchema?.properties?.workspace_id)return tool;
  const schema=tool.inputSchema||{type:'object',properties:{}};
  return {...tool,
    description:`${tool.description||''} McpGo returns workspace_id in every result; send it back on future calls to keep the same workspace across MCP reconnects.`.trim(),
    inputSchema:{...schema,type:'object',properties:{...(schema.properties||{}),workspace_id:workspaceParameter}},
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
