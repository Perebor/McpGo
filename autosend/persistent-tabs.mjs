/**
 * Owner-approved recovery of EXACT task URLs into DEDICATED AutoSend Extension.
 * No ChatGPT text is sent and no existing tab is navigated or closed.
 * A new tab is provisioned at most once per approved task in a backend MCP
 * session. Uncertain creations are not repeated. Every URL must pass a stable
 * read-only inspection after reconnection.
 */
import fs from 'node:fs';
import path from 'node:path';
import {locateChatTab} from './delivery.mjs';
import {chatGPTConversationKey} from '../playwright/chatgpt-url.mjs';

const PROJECT_SLUG=Object.freeze({TD:'td-astra6',Museum:'moi-muzei-istoriia'});
const MAX_CHATS=2;
export const DEFAULT_TAB_CONSENT_FILE=process.env.MCPHUB_AUTOSEND_TAB_APPROVAL_FILE||
 path.join(process.env.APPDATA||'', 'mcpgo-windows','AutoSend','approved-chat-tabs.json');

function validUrl(url,project){
 if(typeof url!=='string'||url.length>500)return false;
 try{
  const parsed=new URL(url);
  return parsed.protocol==='https:'&&parsed.hostname==='chatgpt.com'&&
   parsed.search===''&&parsed.hash===''&&
   /^\/g\/g-p-[a-zA-Z0-9-]+\/c\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(parsed.pathname)&&
   parsed.pathname.includes('-'+PROJECT_SLUG[project]+'/c/')&&
   chatGPTConversationKey(url)!==null;
 }catch{return false}
}
function validConfig(config){
 if(!config||config.version!==1||config.enabled!==true||
    !Array.isArray(config.chats)||config.chats.length<1||config.chats.length>MAX_CHATS)
  return false;
 const ids=new Set(),urls=new Set(),projects=new Set();
 for(const c of config.chats){
  if(typeof c?.task_id!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(c.task_id)||
     !Object.hasOwn(PROJECT_SLUG,c.project)||!validUrl(c.url,c.project))return false;
  if(ids.has(c.task_id)||urls.has(c.url)||projects.has(c.project))return false;
  ids.add(c.task_id);urls.add(c.url);projects.add(c.project);
 }
 return true;
}
function readableTabList(output){
 if(typeof output!=='string'||!output.includes('### Result'))return false;
 const result=output.split('### Result')[1]?.split(/^### /m,1)[0]||'';
 // An error masquerading as an empty list must not authorize tab creation.
 return /^\s*(?:-\s*)?\d+:\s+\S+/m.test(result)&&
  !/(?:^|\n)### Error\b/m.test(output);
}
export function loadTabConsent(file=DEFAULT_TAB_CONSENT_FILE){
 try{
  const data=JSON.parse(fs.readFileSync(file,'utf8'));
  return validConfig(data)?data:null;
 }catch{return null}
}
export function allowedTarget(task,config){
 if(!validConfig(config)||!task||task.enabled!==true||
    task.status!=='scheduled'||task.smart_v2!==true||task.smart_result_gate!==true||
    task.schedule_mode!=='after_response'||task.verification||task.active_slot_id||
    task.smart_v2_pending_action||task.manual_once||
    !Object.hasOwn(PROJECT_SLUG,task.smart_v2_project)||
    !validUrl(task.url,task.smart_v2_project))return false;
 return config.chats.some(c=>c.task_id===task.id&&c.project===task.smart_v2_project&&c.url===task.url);
}
export class PersistentTabRecovery {
 constructor({client,config,approval,verify}){
  if(!client?.tool||!client?.connect||!approval?.update||!approval?.has||typeof verify!=='function')
   throw Error('PersistentTabRecovery requires shared client, process scope and read-only verifier');
  this.client=client;this.config=config;this.approval=approval;this.verify=verify;
  this.created=new Set();this.lastSession='';
 }
 async run(tasks){
  const summary={created:0,approved:0,missing:0,ambiguous:0,skipped:0,errors:0};
  if(!validConfig(this.config)||!Array.isArray(tasks))return summary;
  const allowed=tasks.filter(t=>allowedTarget(t,this.config));
  if(!allowed.length)return summary;
  const duplicates=tasks.some(t=>allowed.some(a=>a.id!==t.id&&a.url===t.url));
  if(duplicates)return summary;
  try{await this.client.connect()}catch{this.approval.reset();summary.errors++;return summary}
  const sid=String(this.client.session||'');
  if(sid!==this.lastSession){this.lastSession=sid;this.created.clear()}
  let tabs;
  try{tabs=await this.client.tool('browser_tabs',{action:'list'})}
  catch{this.approval.reset();summary.errors++;return summary}
  if(!readableTabList(tabs)){
   this.approval.reset();summary.errors++;return summary;
  }
  for(const t of allowed){
   let match=locateChatTab(tabs,t.url);
   if(match.kind==='ambiguous'){
    this.approval.update(t.id,false);summary.ambiguous++;continue;
   }
   if(match.kind==='missing'){
    this.approval.update(t.id,false);summary.missing++;
    const key=t.id+'\0'+t.url;
    if(this.created.has(key))continue;
    this.created.add(key);
    try{
     await this.client.tool('browser_tabs',{action:'new',url:t.url});
     summary.created++;
     tabs=await this.client.tool('browser_tabs',{action:'list'});
     if(!readableTabList(tabs)){this.approval.reset();summary.errors++;return summary;}
     match=locateChatTab(tabs,t.url);
    }catch{summary.errors++;continue}
   }
   if(match.kind!=='found'){
    this.approval.update(t.id,false);if(match.kind==='ambiguous')summary.ambiguous++;continue;
   }
   try{
    const preview=await this.verify(t);
    if(preview?.chatFound===true&&preview?.ready===true){
     this.approval.update(t.id,true);summary.approved++;
    }else{
     this.approval.update(t.id,false);summary.skipped++;
    }
   }catch{this.approval.update(t.id,false);summary.errors++}
  }
  return summary;
 }
}
