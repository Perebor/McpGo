/**
 * Read ONLY the assistant answer following the last USER bubble
 * in the selected ChatGPT conversation; never click Send or type.
 */
import {autosendMcp} from './browser-client.mjs';
import {observeExistingChat,locateChatTab,parsePageResult} from './delivery.mjs';
import {readAutoReport,reportBelongsToLastSmartMessage} from './smart-v2.mjs';
import {parseWorkEvidence} from './smart-work-ready.mjs';
import {createHash} from 'node:crypto';
import {streamReady} from './stream-monitor.mjs';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export const smartReportInspection=[
 '() => {',
 ' const url=location.origin+location.pathname.replace(/\\/$/,"");',
 ' const legacy=[...document.querySelectorAll("[data-message-author-role=\\"user\\"]")];',
 ' const modern=[...document.querySelectorAll("[class~=\\"bg-user-message\\"]")];',
 ' const users=legacy.length?legacy:modern.length?modern:[...document.querySelectorAll("[data-testid=\\"user-message\\"]")];',
 ' const last=users.at(-1);',
 ' if(!last)return {url,kind:"no_user"};',
 ' let n=last,reply=null;',
 ' for(let i=0;i<8 && n;i++,n=n.parentElement){',
 '  if(i<3)continue;',
 '  let sibling=n.nextElementSibling,latest=null,count=0;',
 '  while(sibling&&count++<20){',
 '   if(!sibling.querySelector?.("[class~=\\"bg-user-message\\"]") && String(sibling.innerText||sibling.textContent||"").trim())latest=sibling;',
 '   sibling=sibling.nextElementSibling;',
 '  }',
 '  if(latest){reply=latest;break;}',
 ' }',
 ' const answer=String(reply?.innerText||reply?.textContent||"");',
 ' const buttons=[...(reply?.querySelectorAll?.("button")||[])];',
 ' const skip=buttons.some(b=>/^(?:Пропустить|Skip)$/i.test(String(b.innerText||b.textContent||"").trim()));',
 ' const durationOnly=/^(?:Обработка заняла\\s*\\d+\\s*[sс]|Processing took\\s*\\d+\\s*s)$/i.test(answer.trim());',
 ' const activity=skip||durationOnly;',
 ' return {url,kind:reply?(activity?"activity":"paired"):"no_assistant",',
 '  lastUserText:String(last.innerText||last.textContent||"").slice(0,12000),',
 '  assistantText:answer.slice(-12000),assistantLength:answer.length};',
 '}'
].join('\n');
function stableAndReady(result) {
 const p=result?.observation;
 return result?.status==='ok'&&
  p?.pageReady==='complete'&&!p.stop&&!p.busyText&&!p.connectionInterrupted&&
  p.editorCount===1&&streamReady(p);
}
export async function readSmartBrowserOutcome(task,deps={}) {
 const mcp=deps.client||autosendMcp(),wait=deps.wait||sleep;
 try {
  const before=await observeExistingChat(task,{client:mcp,eventWaitMs:0});
  if(!stableAndReady(before))return {kind:before.status==='ok'?'busy':'unavailable'};
  const loc=locateChatTab(await mcp.tool('browser_tabs',{action:'list'}),task.url);
  if(loc.kind!=='found')return {kind:'unavailable'};
  await mcp.tool('browser_tabs',{action:'select',index:loc.tab.index});
  const first=parsePageResult(await mcp.tool('browser_evaluate',{function:smartReportInspection}));
  await wait(400);
  const second=parsePageResult(await mcp.tool('browser_evaluate',{function:smartReportInspection}));
  const after=await observeExistingChat(task,{client:mcp,eventWaitMs:0});
  if(!stableAndReady(after))return {kind:'busy'};
  if(first?.kind==='activity'||second?.kind==='activity')return {kind:'busy'};
  if(!first||!second||first.kind!=='paired'||second.kind!=='paired'||
     first.url!==task.url||second.url!==task.url)return {kind:'unavailable'};
  if(first.lastUserText!==second.lastUserText||
     first.assistantText!==second.assistantText||
     first.assistantLength!==second.assistantLength||
     before.observation.userCount!==after.observation.userCount)
   return {kind:'unstable'};
  if(!reportBelongsToLastSmartMessage(task,second.lastUserText))
   return {kind:'foreign_user'};
  const report=readAutoReport(second.assistantText,task.smart_v2_project);
  if(!report)return {kind:'no_report'};
  // Same reply observed twice, bound to the actual last user bubble.
  // The user-message count prevents identical repeated answers colliding.
  const fingerprint=createHash('sha256').update([
    task.id,second.url,after.observation.userCount,
    second.lastUserText,second.assistantText
  ].join('\0')).digest('hex');
  return {kind:'report',report,fingerprint,
    workEvidence:parseWorkEvidence(second.assistantText)};
 }catch{return {kind:'unavailable'};}
}
