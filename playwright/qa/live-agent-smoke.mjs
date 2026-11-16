/** Opt-in read/create/close QA. Only closes tabs created by this exact run. */
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as pause} from 'node:timers/promises';
import {modernHeaders,modernParams,MODERN_PROTOCOL} from '../mcp-modern-protocol.mjs';
if(process.env.MCPGO_LIVE_BROWSER_SMOKE!=='1')throw Error('Opt in with MCPGO_LIVE_BROWSER_SMOKE=1');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'mcpgo-live-agent-'));
const port=8941;
let processInfo=null;
const owned=[];
let errors=[];
let current=0;
function client(name,{conversation=true,workspaceId=null}={}){
 let id=0;
 const send=async(method,params={})=>{
  const body={jsonrpc:'2.0',id:++id,method,params:modernParams(params,'McpGo-Live-Smoke')};
  if(conversation)body.params._meta['openai/session']='mcpgo-qa-conversation-'+name;
  const headers=modernHeaders(method,body.params);
  const response=await fetch(`http://127.0.0.1:${port}/mcp`,{
    method:'POST',headers,body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
  if(response.headers.get('mcp-session-id'))throw Error('Modern proxy leaked MCP session');
  const raw=await response.text();
  const line=raw.trim().startsWith('{')?raw:raw.split(/\r?\n/).find(l=>l.startsWith('data: '))?.slice(6);
  const reply=line?JSON.parse(line):null;
  if(!response.ok||reply?.error||reply?.result?.isError)
    throw Error([method,params?.name||'',params?.arguments?.action||''].filter(Boolean).join('/')+
      ' failed: HTTP '+response.status+', reason='+(reply?.error?.message||'TOOL_ERROR'));
  if(reply?.result?.resultType!=='complete')throw Error('Missing 2026 complete result');
  return reply;
 };
 return {name,send,tool:(tool,args={})=>send('tools/call',{name:tool,arguments:{...args,...(workspaceId?{workspace_id:workspaceId}:{})}}),init:async()=>{
  const discovery=await send('server/discover');
  if(!discovery.result?.supportedVersions?.includes(MODERN_PROTOCOL))throw Error('Modern discovery rejected');
 },close:async()=>{}};
}
const value=reply=>JSON.parse(reply.result.content.find(x=>x.type==='text').text);
const clients=[client('1'),client('2'),client('3')];
try{
 processInfo=spawn(process.execPath,[path.join(root,'restricted-proxy.mjs'),'shared'],{
  env:{...process.env,MCPGO_PROXY_PORT:String(port),MCPGO_BACKEND_PORT:'8931',MCPGO_ACTION_ROOT:path.join(temp,'actions')},
  stdio:['ignore','ignore','ignore']});
 let started=false;
 for(let i=0;i<50;i++){
  if(processInfo.exitCode!==null)throw Error('Test proxy did not start');
  try{await fetch(`http://127.0.0.1:${port}/healthz`,{signal:AbortSignal.timeout(400)});started=true;break;}
  catch{await pause(120);}
 }
 if(!started)throw Error('Test proxy not listening');
 for(const client of clients)await client.init();
 if(process.env.MCPGO_DIAGNOSTIC_ONLY==='1'){
  for(const client of clients){
   await client.tool('browser_tabs',{action:'list'});
   const status=await fetch(`http://127.0.0.1:${port}/healthz`).then(x=>x.json());
   console.log('READ_ONLY_AGENT_'+client.name+': attempts='+status.attempts+', generation='+status.generation+', visible='+status.visibleTabHandles);
  }
 }else for(const client of clients){
  const opened=await client.tool('browser_tabs',{action:'new'});
  const workspaceId=opened?.result?.structuredContent?.workspace_id;
  if(process.env.MCPGO_VERIFY_WORKSPACE==='1' &&
    (!/^ws_[A-Za-z0-9_-]{32}$/.test(workspaceId||'') ||
      !opened?.result?.content?.some(c=>c?.type==='text'&&c.text.includes('workspace_id: '+workspaceId))))
    throw Error('Workspace ID is absent from Chrome tool response');
  const handles=value(await client.tool('mcpgo_tab_handle',{action:'list'}));
  if(handles.owned.length!==1)throw Error('Unique managed tab handle not established');
  owned.push({client,id:handles.owned[0],workspaceId});
  if(process.env.MCPGO_LIVE_VERBOSE==='1'){
    const all=await client.tool('browser_tabs',{action:'list'});
    const raw=all?.result?.content?.find(x=>x.type==='text')?.text||'';
    const rows=raw.split(/\r?\n/).filter(x=>/^\s*-\s*\d+:/.test(x));
    const state=value(await client.tool('mcpgo_browser_status',{}));
    console.log('AFTER_NEW_'+client.name+': listed='+rows.length+', blank='+rows.filter(x=>x.endsWith('](about:blank)')).length+
      ', marked='+rows.filter(x=>/\]\(about:blank#mcpgo-/.test(x)).length+
      ', managed='+state.visibleTabHandles+', ambiguous='+state.ambiguousTabs+', generation='+state.generation+', attempts='+state.attempts);
  }
 }
 if(process.env.MCPGO_LIVE_VERBOSE==='1' && owned.length===3){
  for(const item of owned){
    const current=value(await item.client.tool('mcpgo_tab_handle',{action:'list'}));
    console.log('BEFORE_SELECT_'+item.client.name+': owned='+current.owned.length+', visible='+current.tabs.length+', ambiguous='+current.ambiguous);
  }
 }
 if(process.env.MCPGO_VERIFY_WORKSPACE==='1' && owned.length===3){
  if(new Set(owned.map(x=>x.workspaceId)).size!==3)throw Error('Workspace identities collided');
  const item=owned[0];
  await item.client.close();
  const resumed=client('resumed',{conversation:false,workspaceId:item.workspaceId});
  await resumed.init();clients.push(resumed);
  const result=await resumed.tool('mcpgo_workspace',{workspace_id:item.workspaceId});
  if(value(result).workspace_id!==item.workspaceId||value(result).ownedTabs!==1)
    throw Error('New MCP session could not resume existing Chrome workspace');
  item.client=resumed;
  console.log('LIVE_WORKSPACE_RECONNECT=PASS; same_workspace=true; tab_lease_restored=true');
 }
 if(process.env.MCPGO_DIAGNOSTIC_ONLY!=='1')for(const entry of owned){
  await entry.client.tool('mcpgo_tab_action',{action:'select',tab_id:entry.id});
  await entry.client.tool('browser_snapshot',{});
 }
 const status=await fetch(`http://127.0.0.1:${port}/healthz`).then(x=>x.json());
 if(process.env.MCPGO_DIAGNOSTIC_ONLY!=='1'){
  if(status.attempts!==1||status.failures!==0||status.leasedTabCount!==3)
   throw Error('Shared session / lease counters unexpected');
  console.log('LIVE_THREE_AGENT_BROWSER=PASS; shared_connections='+status.attempts+'; owned_tabs=3; failures=0');
 }
}catch(e){errors.push(e.message);}
finally{
 for(const entry of owned.reverse()){
  try{await entry.client.tool('mcpgo_tab_action',{action:'close',tab_id:entry.id});current++;}
  catch{errors.push('Safe cleanup of one created tab could not be confirmed');}
 }
 // Fallback cleanup is limited to the one-off QA proxy port and our
 // generated inert paths. Never use transient Playwright indexes to clean.
 if(current<owned.length){
  const {execFileSync}=await import('node:child_process');
  const apple=`set n to 0\ntell application "Google Chrome"\n repeat with w in windows\n  repeat with t in (tabs of w)\n   try\n    set u to URL of t as text\n    if u starts with "http://127.0.0.1:${port}/mcpgo-blank/" then\n     close t\n     set n to n + 1\n    end if\n   end try\n  end repeat\n end repeat\nend tell\nreturn n`;
  try{const removed=execFileSync('/usr/bin/osascript',['-e',apple],{encoding:'utf8',timeout:12000}).trim();
    console.log('QA_FALLBACK_CLEANED_EXACT_LOCAL_TABS='+removed);
  }catch{errors.push('Could not verify fallback cleanup of QA tabs');}
 }
 for(const client of clients)await client.close();
 if(processInfo){processInfo.kill('SIGTERM');await pause(150);if(processInfo.exitCode===null)processInfo.kill('SIGKILL');}
 fs.rmSync(temp,{recursive:true,force:true});
 console.log('LIVE_TEST_TABS_CLOSED_CONFIRMED='+current+'/'+owned.length);
}
if(errors.length){console.error(errors.join(' | '));process.exitCode=1;}
