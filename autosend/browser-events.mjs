import {chatGPTConversationKey} from '../playwright/chatgpt-url.mjs';
/**
 * Event-assisted browser observation on the existing personal Chrome tab.
 * The in-page MutationObserver notifies a SHORT (<=1300 ms) bounded promise.
 *
 * This is NOT a background CDP connection or a permanent shared-browser
 * lock. A timed-out/unsupported waiter falls back to ordinary health polling.
 */
export const MAX_EVENT_WAIT_MS=1300;
export async function waitForChatMutationInPage(cfg){
 const current=location.origin+location.pathname.replace(/\/$/,'');
 const project=current.match(/^https:\/\/chatgpt\.com\/g\/g-p-([0-9a-f]{32})(?:-[a-z0-9-]{1,160})?\/c\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i);
 const direct=current.match(/^https:\/\/chatgpt\.com\/c\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i);
 const currentKey=project?'project:'+project[1].toLowerCase()+':'+project[2].toLowerCase():
   direct?'direct:'+direct[1].toLowerCase():null;
 if(!currentKey||currentKey!==cfg.conversationKey)return {kind:'scope_changed'};
 const record=window.__mcpgoAutoSendObserver;
 if(!record||!(record.listeners instanceof Set))
   return {kind:'unavailable'};
 const result=()=>({kind:'changed',assistantRevision:record.revision,
   userInsertions:record.userInsertions});
 if(record.revision!==cfg.assistantRevision||
    record.userInsertions!==cfg.userInsertions)
   return result();
 const delay=Math.min(Math.max(Number(cfg.timeoutMs)||250,100),1300);
 return await new Promise(resolve=>{
  let finished=false;
  let timer=null;
  function settle(payload){
   if(finished)return;
   finished=true;
   record.listeners.delete(notify);
   clearTimeout(timer);
   resolve(payload);
  }
  function notify(){
   if(record.revision!==cfg.assistantRevision||
      record.userInsertions!==cfg.userInsertions)settle(result());
  }
  record.listeners.add(notify);
  timer=setTimeout(()=>settle({kind:'timeout'}),delay);
  notify();
 });
}
export function buildEventWait({url,assistantRevision,userInsertions,timeoutMs=1000}){
 if(typeof url!=='string'||!url.startsWith('https://chatgpt.com/c/')&&
    !url.startsWith('https://chatgpt.com/g/'))throw Error('INVALID_EVENT_URL');
 if(!Number.isInteger(assistantRevision)||!Number.isInteger(userInsertions))
   return null;
 const conversationKey=chatGPTConversationKey(url);
 if(!conversationKey)throw Error('INVALID_EVENT_URL');
 const cfg={url,conversationKey,assistantRevision,userInsertions,
   timeoutMs:Math.min(MAX_EVENT_WAIT_MS,Math.max(100,timeoutMs))};
 return 'async () => ('+waitForChatMutationInPage.toString()+')('+JSON.stringify(cfg)+')';
}
