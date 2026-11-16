import {chatGPTConversationKey} from '../playwright/chatgpt-url.mjs';
/**
 * Page-scoped guarded Send. The last safety check and one Send click happen
 * synchronously in ONE browser_evaluate invocation, under the proxy's shared
 * Chrome lock. The proxy claims x-mcpgo-action-id before dispatch.
 *
 * The function source is serialized rather than evaluated by McpGo itself.
 */
export const SAFE_EDITORS=new Set([
 '#prompt-textarea','[contenteditable="true"][role="textbox"]'
]);
export const SAFE_SENDS=new Set([
 '[data-testid="send-button"]',
 'button[aria-label="Send prompt"]',
 'button[aria-label="Send message"]',
 'button[aria-label="Send"]',
 'button[aria-label="Отправить"]',
 'button[aria-label="Отправить сообщение"]'
]);

export function guardedClickInPage(cfg) {
 const refuse=code=>({status:'refused',code});
 const normalize=s=>String(s||'').replace(/[\u200b-\u200d\ufeff]/g,'')
   .replace(/\s+/g,' ').trim();
 const visible=e=>!!e&&e.getClientRects().length>0&&
   !e.closest?.('[inert]') &&
   (!e.ownerDocument?.defaultView?.getComputedStyle ||
    (e.ownerDocument.defaultView.getComputedStyle(e).visibility!=='hidden' &&
     e.ownerDocument.defaultView.getComputedStyle(e).display!=='none'));
 const current=location.origin+location.pathname.replace(/\/$/,'');
 const project=current.match(/^https:\/\/chatgpt\.com\/g\/g-p-([0-9a-f]{32})(?:-[a-z0-9-]{1,160})?\/c\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i);
 const direct=current.match(/^https:\/\/chatgpt\.com\/c\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i);
 const currentKey=project?'project:'+project[1].toLowerCase()+':'+project[2].toLowerCase():
   direct?'direct:'+direct[1].toLowerCase():null;
 if(!currentKey||currentKey!==cfg.conversationKey)return refuse('WRONG_CONVERSATION');
 if(document.readyState!=='complete')return refuse('PAGE_NOT_READY');
 const edits=[...document.querySelectorAll(cfg.editorSelector)].filter(visible);
 if(edits.length!==1)return refuse('EDITOR_NOT_UNIQUE');
 if(normalize(edits[0].innerText||edits[0].textContent)!==normalize(cfg.message))
   return refuse('EDITOR_TEXT_CHANGED');
 const stop=[...document.querySelectorAll(
   '[data-testid="stop-button"],button[aria-label="Stop generating"],button[aria-label="Stop streaming"],button[aria-label="Stop response"],button[aria-label="Stop"],button[aria-label="Остановить генерацию"],button[aria-label="Остановить"]'
 )].some(visible);
 const streaming=[...document.querySelectorAll('[data-testid="streaming-indicator"],[data-is-streaming="true"]')].some(visible);
 // A fresh server COMPLETE permits a stale Stop button, but only after the
 // guarded, same-tab, last-moment probe below has succeeded.
 if((stop||streaming)&&!cfg.serverConfirmedComplete)return refuse('GENERATION_ACTIVE');
 if(cfg.streamSequence!==null&&cfg.streamSequence!==undefined&&
    window.__mcpgoAutoSendStream?.sequence!==cfg.streamSequence)
   return refuse('STREAM_PROGRESS');
 const observation=window.__mcpgoAutoSendObserver;
 // DOM re-renders are not proof that the assistant is working. For a live
 // dispatch the fresh, same-tab COMPLETE server probe plus stream sequence
 // take precedence; offline/uncertain dispatches keep the strict DOM guard.
 if(!cfg.serverConfirmedComplete && cfg.assistantRevision!==null &&
    observation?.revision!==cfg.assistantRevision)
   return refuse('ASSISTANT_CHANGED');
 const legacy=[...document.querySelectorAll('[data-message-author-role="user"]')];
 const modern=[...document.querySelectorAll('[class~="bg-user-message"]')];
 const testids=[...document.querySelectorAll('[data-testid="user-message"]')];
 const count=(legacy.length?legacy:modern.length?modern:testids).length;
 if(count!==cfg.baselineUserCount)return refuse('USER_MESSAGES_CHANGED');
 const buttons=[...document.querySelectorAll(
   '[data-testid="send-button"],button[aria-label="Send prompt"],button[aria-label="Send message"],button[aria-label="Send"],button[aria-label="Отправить"],button[aria-label="Отправить сообщение"]'
 )].filter(visible);
 if(buttons.length!==1||!buttons[0].matches?.(cfg.sendSelector))
   return refuse('SEND_NOT_UNIQUE');
 const send=buttons[0];
 if(send.disabled||send.getAttribute?.('aria-disabled')==='true')
   return refuse('SEND_DISABLED');
 const sent=window.__mcpgoAutoSendClickedIds||
   (window.__mcpgoAutoSendClickedIds=new Set());
 if(sent.has(cfg.actionId))return refuse('DUPLICATE_ACTION');
 sent.add(cfg.actionId);
 // The one and only mutating step. A lost response must NOT replay this.
 send.click();
 return {status:'clicked',code:'CLICK_DISPATCHED'};
}

export function buildGuardedClick({url,message,editorSelector,sendSelector,
                                   baselineUserCount,assistantRevision,actionId,
                                   requireStreamStatus=false,streamSequence=null}) {
 const conversationKey=chatGPTConversationKey(url);
 if(!conversationKey)throw Error('INVALID_GUARDED_CHAT_URL');
 if(typeof message!=='string'||!message.trim()||message.length>8000)
  throw Error('INVALID_GUARDED_MESSAGE');
 if(!SAFE_EDITORS.has(editorSelector)||!SAFE_SENDS.has(sendSelector))
  throw Error('UNTRUSTED_CHAT_SELECTOR');
 if(!Number.isInteger(baselineUserCount)||baselineUserCount<0)
  throw Error('INVALID_GUARDED_BASELINE');
 if(typeof actionId!=='string'||!/^autosend:[a-f0-9-]{36}$/.test(actionId))
  throw Error('INVALID_GUARDED_ACTION_ID');
 const config={url,conversationKey,message:message.trim(),editorSelector,sendSelector,
   baselineUserCount,assistantRevision:Number.isInteger(assistantRevision)?assistantRevision:null,
   actionId,streamSequence:Number.isInteger(streamSequence)?streamSequence:null,
   serverConfirmedComplete:false};
 // Offline simulations do not have the private ChatGPT endpoint. The real
 // delivery path uses this verification and refuses uncertain status.
 if(!requireStreamStatus)
  return '() => ('+guardedClickInPage.toString()+')('+JSON.stringify(config)+')';
 return 'async () => {const cfg='+JSON.stringify(config)+';'+
  'const id=cfg.url.slice(-36);let response;'+
  'try{const ctl=new AbortController();const timer=setTimeout(()=>ctl.abort(),3500);'+
  'try{const res=await fetch("/backend-api/conversation/"+encodeURIComponent(id)+"/stream_status",'+
  '{credentials:"same-origin",cache:"no-store",signal:ctl.signal});'+
  'if(!res.ok)return {status:"refused",code:"STREAM_STATUS_UNAVAILABLE"};'+
  'response=await res.json();}finally{clearTimeout(timer);}}'+
  'catch{return {status:"refused",code:"STREAM_STATUS_UNAVAILABLE"};}'+
  'if(response?.status!=="COMPLETE")return {status:"refused",code:"GENERATION_ACTIVE"};'+
  'const stream=window.__mcpgoAutoSendStream;'+
  'if(stream?.active&&Date.now()-Number(stream.lastEventAt||0)<5000)'+
  'return {status:"refused",code:"STREAM_PROGRESS"};'+
  'cfg.serverConfirmedComplete=true;return ('+guardedClickInPage.toString()+')(cfg); }';

}
export function parseGuardedResult(text,parsePageResult) {
 const result=parsePageResult(text);
 if(result?.status==='clicked'&&result.code==='CLICK_DISPATCHED')
   return {clicked:true,code:result.code};
 if(result?.status==='refused'&&typeof result.code==='string'&&/^[A-Z_]+$/.test(result.code))
   return {clicked:false,refused:true,code:result.code};
 throw Error('GUARDED_CLICK_OUTCOME_UNCERTAIN');
}
