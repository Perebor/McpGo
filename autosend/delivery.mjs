import {fingerprint,combinedEvidence} from './reconciliation.mjs';
import {autosendMcp,ExtensionMcpClient} from './browser-client.mjs';
import {classifyChatState,sameReadySnapshot,STABLE_READY_INTERVAL_MS,safeEvidence} from './chat-state.mjs';
import {buildGuardedClick,parseGuardedResult} from './guarded-send.mjs';
import {buildEventWait} from './browser-events.mjs';
import {probeStreamInPage,streamBusy,streamReady} from './stream-monitor.mjs';
import {sameChatGPTConversation} from '../playwright/chatgpt-url.mjs';
// Scheduled ChatGPT delivery through the already-running local Playwright MCP proxy.
// The backend uses the official Playwright Chrome extension in extension mode.
// This module does not create a Chromium profile or use the obsolete native-messaging extension,
// or auto-retry after the Send button could have been clicked.
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export {ExtensionMcpClient as LocalMcp};
export function parsePageResult(text){
 // Playwright includes "### Result" followed by "### Ran Playwright code".
 // Only the first section is data; the subsequent section contains JS source
 // (often with braces), and must NEVER be included in JSON.parse.
 const resultHeader=/^### Result\s*$/m;
 const match=resultHeader.exec(text);
 const section=match?text.slice(match.index+match[0].length).split(/^### /m,1)[0]:text;
 const fenced=section.match(/```(?:json)?\s*([\s\S]*?)```/);
 const candidate=(fenced?.[1]||section).trim();
 // parse the value, not a JavaScript object literal or the echoed source code.
 try { return JSON.parse(candidate); }
 catch { throw Error('Playwright MCP: некорректный JSON в разделе Result'); }
}
export const pageInspection=`() => {
 const vis=e=>!!e && e.getClientRects().length>0 &&
  (!e.ownerDocument?.defaultView?.getComputedStyle ||
   (e.ownerDocument.defaultView.getComputedStyle(e).visibility!=='hidden' &&
    e.ownerDocument.defaultView.getComputedStyle(e).display!=='none'));
 const url=location.origin+location.pathname.replace(/\\/$/,'');
 const conversation=document.querySelector('main');
 // The observer runs within the already-open personal Chrome tab and stores
 // only in-memory counters and timestamps. No text or screenshots are logged.
 let observation=null;
 if(typeof window!=='undefined' && typeof MutationObserver!=='undefined' && conversation){
  const prior=window.__mcpgoAutoSendObserver;
  if(prior?.root!==conversation){
   try{prior?.observer?.disconnect()}catch{}
   const record={root:conversation,revision:0,lastChangedAt:Date.now(),
    userInsertions:0,observer:null,listeners:new Set()};
   const obs=new MutationObserver(mutations=>{
    let changed=false,userChanged=false;
    for(const mutation of mutations){
     const node=mutation.target?.nodeType===1?mutation.target:mutation.target?.parentElement;
     if(node?.closest?.('[contenteditable="true"],[data-message-author-role="user"],[class~="bg-user-message"]'))
      continue;
     const added=[...mutation.addedNodes||[]];
     for(const item of added){
      if(item?.nodeType!==1)continue;
      if(item.matches?.('[data-message-author-role="user"],[class~="bg-user-message"]') ||
         item.querySelector?.('[data-message-author-role="user"],[class~="bg-user-message"]'))
       {record.userInsertions++;userChanged=true;}
     }
     if(node?.closest?.('[data-message-author-role="assistant"],[data-testid="conversation-turn"],article,.markdown,.prose') ||
        added.some(item=>item?.nodeType===1 &&
         (item.matches?.('[data-message-author-role="assistant"],[data-testid="conversation-turn"],article,.markdown,.prose') ||
          item.querySelector?.('[data-message-author-role="assistant"],[data-testid="conversation-turn"],article,.markdown,.prose'))))
      changed=true;
    }
    if(changed){record.revision++;record.lastChangedAt=Date.now();}
    if(changed||userChanged){
     for(const notify of [...record.listeners])try{notify()}catch{}
    }
   });
   obs.observe(conversation,{subtree:true,childList:true,characterData:true});
   record.observer=obs;
   window.__mcpgoAutoSendObserver=record;
  }
  observation=window.__mcpgoAutoSendObserver;
 }
 const prompt=[...document.querySelectorAll('#prompt-textarea,[contenteditable="true"][role="textbox"]')].filter(vis);
 const editor=prompt.length===1?prompt[0]:null;
 const stop=[...document.querySelectorAll('[data-testid="stop-button"],button[aria-label="Stop generating"],button[aria-label="Stop streaming"],button[aria-label="Stop response"],button[aria-label="Stop"],button[aria-label="Остановить генерацию"],button[aria-label="Остановить"]')].some(vis);
 const busyText=[...document.querySelectorAll('[data-testid="streaming-indicator"],[data-is-streaming="true"]')].some(vis);
 // Explicit failure signal is distinct from a legitimate long-running tool.
 // The banner may be outside <main>; read DOM text only in-memory.
 const interruptionPattern=/(?:соединени[ея] прерван[оа]|ожидание полного ответа|ответ прерван|ответ остановлен|connection interrupted|waiting for full response|response interrupted|generation stopped)/i;
 // Detect a short visible status label, NOT phrases quoted by the human in
 // their chat bubble or text editor. Never act on global document.body text.
 const errorNodes=[...document.querySelectorAll('[role="alert"],[role="status"],p,span,div')].filter(el=>{
  // Cheap DOM text check before expensive layout/visibility checks.
  const text=(el.textContent||'').trim();
  if(text.length===0 || text.length>220 || !interruptionPattern.test(text))return false;
  if(!vis(el) || el.closest?.('[data-message-author-role="user"],[class~="bg-user-message"],[data-message-author-role="assistant"],[contenteditable="true"]'))return false;
  return true;
 });
 const continuationButtons=[...document.querySelectorAll('button')].filter(el=>{
  const label=(el.innerText||el.textContent||el.getAttribute('aria-label')||'').trim();
  return /^(?:продолжить генерацию|продолжить ответ|continue generating|continue response)$/i.test(label)&&vis(el)&&!el.disabled&&el.getAttribute?.('aria-disabled')!=='true';
 });
 const connectionInterrupted=errorNodes.some(el=>
  ![...el.children].some(child=>{
   const text=(child.innerText||child.textContent||'').trim();
   return text.length>0 && text.length<=220 && interruptionPattern.test(text);
  })
 );
 const responseText=[...document.querySelectorAll('[data-message-author-role="assistant"],[data-testid="conversation-turn"]')]
  .filter(el=>!el.closest?.('[data-message-author-role="user"],[class~="bg-user-message"]'))
  .at(-1)?.innerText||'';

 // ChatGPT's current UI no longer provides data-message-author-role or
 // conversation-turn for every message. The bg-user-message token identifies
 // the actual user bubble (one per message), unlike nested group/user-message
 // wrappers (two per message). Never count main text or assistant echoes here.
 const legacyUsers=[...document.querySelectorAll('[data-message-author-role="user"]')];
 const modernUsers=[...document.querySelectorAll('[class~="bg-user-message"]')];
 // Extra explicit user-author markers, never count assistant/main text.
 const testidUsers=[...document.querySelectorAll('[data-testid="user-message"]')];
 const users=legacyUsers.length?legacyUsers:modernUsers.length?modernUsers:testidUsers;
 const assistants=[...document.querySelectorAll('[data-message-author-role="assistant"]')];
 const turns=[...document.querySelectorAll('[data-testid="conversation-turn"],[data-message-id],[data-message-author-role],main article')];
 const send=[...document.querySelectorAll('[data-testid="send-button"]')].filter(vis);
 const main=document.querySelector('main');
 const mainText=main?.innerText||main?.textContent||'';
 const genericTitle=/^(chatgpt|new chat|новый чат)(\s*[-|].*)?$/i.test(document.title.trim());
 const sendButtons=[...document.querySelectorAll('[data-testid="send-button"],button[aria-label="Send prompt"],button[aria-label="Send message"],button[aria-label="Send"],button[aria-label="Отправить"],button[aria-label="Отправить сообщение"]')].filter(vis);
 return {url,ready:document.readyState,editorCount:prompt.length,editorText:editor?.innerText||editor?.textContent||'',
  editorSelector:editor?.id==='prompt-textarea'?'#prompt-textarea':'[contenteditable="true"][role="textbox"]',
  sendCount:sendButtons.length,sendEnabled:sendButtons.length===1&&!sendButtons[0].disabled&&sendButtons[0].getAttribute('aria-disabled')!=='true',
  sendSelector:sendButtons.length===1?(sendButtons[0].getAttribute('data-testid')==='send-button'?'[data-testid="send-button"]':'button[aria-label="'+sendButtons[0].getAttribute('aria-label')+'"]'):null,
  turnCount:turns.length,genericTitle,
  stop,busyText,connectionInterrupted,continuationAvailable:continuationButtons.length>0,progressText:responseText.slice(-1500),userCount:users.length,assistantCount:assistants.length,
  lastUserText:users.length?(users.at(-1).innerText||users.at(-1).textContent||'').trim():null,
  lastUserId:users.length?(users.at(-1).getAttribute?.('data-message-id')||users.at(-1).closest?.('[data-message-id]')?.getAttribute?.('data-message-id')||null):null,
  lastUserTexts:users.slice(-2).map(e=>(e.innerText||e.textContent||'').trim()),
  assistantRevision:observation?.revision??null,
  lastAssistantMutationAt:observation?.lastChangedAt??null,
  userInsertionRevision:observation?.userInsertions??null,
  mainLength:mainText.length,mainOccurrences:mainText.split('SCHEDULER_SENTINEL_NOT_PRESENT').length-1,title:document.title,login:!!document.querySelector('input[type="password"]')};
}`;
export function classifyAgent(page,expectedUrl) {
 return classifyChatState(page,expectedUrl);
}
// A post-click acknowledgement must be a NEW user-authored message. Main-page
// text is insufficient: the editor or an assistant quotation may echo the text.
export function normalizedMessage(value) {
 return String(value||'').replace(/[\u200b-\u200d\ufeff]/g,'')
   .replace(/\s+/g,' ').trim();
}
/** Compare a complete user bubble with the original sent text.
 * ChatGPT removes inline-code backticks in its rendered user bubble and may
 * append a UI-only "… Показать ещё" toggle. No prefix/fuzzy matching:
 * the full remaining text MUST match character-for-character. This is used
 * only POST-click; composer/preflight equality stays byte-strict.
 */
export function renderedUserTextMatches(displayed,source) {
 const target=normalizedMessage(source),actual=normalizedMessage(displayed);
 if(!target||!actual)return false;
 if(target===actual)return true;
 const suffix=/\s*…\s*(?:Показать ещё|Show more)$/u;
 // Expanded bubbles have no UI suffix, but still omit Markdown backticks.
 const content=actual.replace(suffix,'').trim();
 return content===target.replace(/`/g,'');
}
export function confirmsNewUserMessage(before,after,message){
 const target=normalizedMessage(message);
 if(!target || !after || !before || !Number.isInteger(after.userCount))return false;
 if(!renderedUserTextMatches(after.lastUserText,target))return false;
 if(after.userCount>before.userCount)return true;
 // A changed DOM ID alone is insufficient when the previous user message
 // had the exact same text: a re-render may have changed a generated ID.
 // In that case prefer a safe unknown over falsely verifying a duplicate.
 if(before.lastUserId && after.lastUserId && before.lastUserId!==after.lastUserId &&
    (before.lastUserHash||fingerprint(before.lastUserText))!==fingerprint(target))
   return true;
 // A virtualized list may keep the visible user-bubble count constant. In that
 // case, verify that the previously observed last user bubble is now the
 // penultimate actual user bubble, and reject repeated identical messages.
 const oldHash=before.lastUserHash||fingerprint(before.lastUserText);
 return Boolean(after.userCount===before.userCount && oldHash &&
   oldHash!==fingerprint(target) && after.userCount>=2 &&
   Array.isArray(after.lastUserTexts) &&
   fingerprint(after.lastUserTexts.at(-2))===oldHash);
}
// Read-only delivery proof based on a user-authored bubble, never on main
// text or an assistant quote. The emitted evidence has no message content.
export function deliveryEvidence(before,after,message,expectedUrl,previousEvidence=null){
 const target=normalizedMessage(message);
 const urlMatched=!!after&&sameChatGPTConversation(after.url,expectedUrl);
 const lastTextMatched=!!target&&renderedUserTextMatches(after?.lastUserText,target);
 const countedProof=urlMatched&&confirmsNewUserMessage(before,after,message);
 const beforeCount=Number.isInteger(before?.userCount)?before.userCount:null;
 const afterCount=Number.isInteger(after?.userCount)?after.userCount:null;
 const insertion=Number.isInteger(before?.userInsertionRevision)&&
   Number.isInteger(after?.userInsertionRevision)?
   Math.max(0,after.userInsertionRevision-before.userInsertionRevision):0;
 const assistantRevisionDelta=Number.isInteger(before?.assistantRevision)&&
   Number.isInteger(after?.assistantRevision)?
   after.assistantRevision-before.assistantRevision:0;
 const assistantTextChanged=typeof before?.assistantHash==='string'&&
   typeof after?.progressText==='string'&&!!after.progressText.trim()&&
   before.assistantHash!==fingerprint(after.progressText);
 // Captured *after* dispatch: an active generation or changed assistant
 // message is corroboration, not proof alone. The preflight guaranteed
 // generation was absent immediately before the guarded Send.
 const responseActivity=!!(after?.stop||after?.busyText||
   assistantRevisionDelta>0||assistantTextChanged);
 const current=safeEvidence({
  code:countedProof?'USER_BUBBLE_VERIFIED':!urlMatched?'WRONG_CONVERSATION':
   lastTextMatched?'USER_BUBBLE_NOT_FOUND':'USER_TEXT_MISMATCH',
  clickCommitted:true,urlMatched,lastTextMatched,messageFound:countedProof,
  newUserCount:beforeCount!==null&&afterCount!==null&&afterCount>beforeCount,
  editorCleared:!!after&&!String(after.editorText||'').trim(),
  userCountDelta:beforeCount!==null&&afterCount!==null?afterCount-beforeCount:0,
  assistantRevisionDelta,userInsertionDelta:insertion,
  assistantActivitySeen:responseActivity,
  stopVisible:!!after?.stop,
  streamingVisible:!!after?.busyText
 });
 const observations=combinedEvidence(previousEvidence||{},current);
 // React virtualizes long chats, so the number of visible user bubbles can
 // shrink after a successful click. Likewise the exact SAME user message
 // may have been sent previously and IDs may be absent. A virtualized proof
 // therefore requires four independent facts from this ONE durable attempt:
 //  1) correct conversation and exact latest user-authored bubble,
 //  2) submitted draft cleared at least once after dispatch,
 //  3) an actual user node insertion observed after the preflight baseline,
 //  4) new assistant activity observed after a previously idle preflight.
 // Mere matching text, rerendered ID or streaming banner is NEVER enough.
 const virtualizedProof=urlMatched&&lastTextMatched&&
   observations.clickCommitted===true&&observations.editorCleared===true&&
   observations.userInsertionDelta>0&&
   observations.assistantActivitySeen===true;
 const verified=countedProof||virtualizedProof;
 const code=verified?
   (virtualizedProof&&!countedProof?'USER_BUBBLE_VERIFIED_VIRTUALIZED':'USER_BUBBLE_VERIFIED'):
   current.code;
 return safeEvidence({...observations,...current,
   code,messageFound:verified,virtualizedProof:virtualizedProof&&!countedProof,
   // Carry positive observations forward; count deltas and current URL still
   // reflect this specific snapshot and are not accepted without live match.
   editorCleared:observations.editorCleared,
   userInsertionDelta:observations.userInsertionDelta,
   assistantActivitySeen:observations.assistantActivitySeen});
}
// Preserve pageInspection as a pure, synchronous DOM snapshot for offline tests.
// Live browser evaluations additionally install the privacy-preserving fetch
// listener and read the server's generation status before any Send decision.
export const pageInspectionWithStream='async () => { const page=('+pageInspection+')(); '+
 'const stream=await ('+probeStreamInPage.toString()+')(); return {...page,...stream}; }';
// Unlike classifyAgent, this check permits our own typed draft in the editor.
function generationIdle(page){
 if(page.streamStatus==='UNKNOWN'||page.streamStatus==='IS_STREAMING')return false;
 if(page.streamStatus==='COMPLETE')return !streamBusy(page);
 return !page.stop&&!page.busyText;
}
// The composer can trigger React mutations in <main> even when an answer is
// complete. Only actual stream progress, a changed conversation, or changed
// user content should invalidate the pre-click snapshot.
export function preClickIssue(before,after,task,baseline){
 if(!sameChatGPTConversation(after.url,task.url))return 'WRONG_CONVERSATION';
 if(after.connectionInterrupted)return 'CONNECTION_INTERRUPTED';
 if(!generationIdle(after))return 'GENERATION_ACTIVE';
 if(after.userCount!==baseline||
    String(before.lastUserId||'')!==String(after.lastUserId||'')||
    normalizedMessage(before.lastUserText)!==normalizedMessage(after.lastUserText))
  return 'USER_MESSAGES_CHANGED';
 if(after.editorCount!==1||!after.editorSelector)return 'EDITOR_NOT_READY';
 if(normalizedMessage(after.editorText)!==normalizedMessage(task.message))
  return 'EDITOR_TEXT_CHANGED';
 if(Number.isInteger(before.streamSequence)&&
    before.streamSequence!==after.streamSequence)return 'STREAM_PROGRESS';
 if(Number.isInteger(before.assistantRevision)&&
    before.assistantRevision!==after.assistantRevision&&
    !(streamReady(before)&&streamReady(after)))return 'ASSISTANT_CHANGED';
 if(!after.sendEnabled||after.sendCount!==1||!after.sendSelector)return 'SEND_NOT_READY';
 return null;
}
function preClickDeferred(issue){
 const notes={
  WRONG_CONVERSATION:'Открыт другой разговор; Send не нажимался',
  CONNECTION_INTERRUPTED:'Ответ прерван; Send не нажимался',
  GENERATION_ACTIVE:'Агент снова работает; Send не нажимался',
  USER_MESSAGES_CHANGED:'В разговоре изменились пользовательские сообщения; Send не нажимался',
  EDITOR_NOT_READY:'Поле ввода не готово; Send не нажимался',
  EDITOR_TEXT_CHANGED:'Черновик изменён; Send не нажимался',
  STREAM_PROGRESS:'Появились новые события генерации; Send не нажимался',
  ASSISTANT_CHANGED:'Изменился ответ без подтверждения простоя; Send не нажимался',
  SEND_NOT_READY:'Кнопка Send не стала активной; Send не нажимался'
 };
 return {status:'deferred',reason:'preclick',error:notes[issue]||'Страница не готова к отправке',
  evidence:safeEvidence({code:issue||'PRECLICK_NOT_READY',clickCommitted:false})};
}
async function inspect(mcp,message='',expectedUrl=null){
 const statement=pageInspectionWithStream.replace("'SCHEDULER_SENTINEL_NOT_PRESENT'",JSON.stringify(message.trim()));
 return parsePageResult(await mcp.tool('browser_evaluate',{function:statement}));
}
/** Only the Result section of the official browser_tabs list is authoritative. */
export function extractTabs(text){
 const section=String(text).includes('### Result')?
  String(text).split('### Result')[1].split('### Ran Playwright code')[0].split('### Open tabs')[0]:
  String(text);
 const rows=[];
 for(const line of section.split(/\r?\n/)){
  const match=line.match(/^\s*(?:-\s*)?(\d+):\s+(.+)$/);
  if(!match)continue;
  const item=match[2].match(/(?:\]\()?(https?:\/\/[^\s)\]<>]+)\)?/);
  if(item)rows.push({index:Number(match[1]),url:item[1].replace(/\/$/,'')});
 }
 return rows;
}
/**
 * A chat owns exactly one already-approved tab in the AutoSend extension
 * group. No new tabs, no arbitrary matching by title/index, no side effects.
 */
export function locateChatTab(output,target){
 const matches=extractTabs(output).filter(t=>sameChatGPTConversation(t.url,target));
 if(!matches.length)return {kind:'missing',code:'CHAT_TAB_MISSING'};
 if(matches.length>1)return {kind:'ambiguous',code:'AMBIGUOUS_CHAT_TABS'};
 return {kind:'found',tab:matches[0]};
}
function tabDeferred(result,clickCommitted=false){
 const details={
  CHAT_TAB_MISSING:'Чат отсутствует в группе MCPGO AutoSend. Откройте его и выберите через Playwright Extension; новая вкладка не создавалась.',
  AMBIGUOUS_CHAT_TABS:'В группе AutoSend несколько вкладок этого разговора. Оставьте одну; Send не нажимался.'
 };
 return {status:'deferred',reason:'tab-scope',error:details[result.code]||'Вкладка недоступна',
  evidence:safeEvidence({code:result.code,clickCommitted})};
}
export function classifyPreflightError(error){
 const value=String(error?.message||'');
 if(/Current tab identity cannot be verified|Agent tab changed during selection/i.test(value))
  return {code:'TAB_IDENTITY_UNVERIFIED',
   message:'Не удалось подтвердить активную вкладку Chrome; Send не нажимался'};
 if(/TAB_HANDLE_STALE_OR_AMBIGUOUS|TAB_INDEX_CHANGED_USE_STABLE_ID|tab index synchronization failed/i.test(value))
  return {code:'TAB_INDEX_UNSTABLE',
   message:'Индексы вкладок Chrome изменились или совпали; Send не нажимался'};
 if(/TAB_OWNED_BY_ANOTHER_AGENT/i.test(value))
  return {code:'TAB_OWNED_BY_ANOTHER_AGENT',
   message:'Эта вкладка занята другим агентом; Send не нажимался'};
 if(/HTTP 429|Browser action queue (?:full|wait timed out)/i.test(value))
  return {code:'BROWSER_QUEUE_BUSY',
   message:'Очередь расширения браузера перегружена; Send не нажимался'};
 if(/TimeoutError|AbortError|timeout|timed out/i.test(value))
  return {code:'BROWSER_OBSERVATION_TIMEOUT',
   message:'Истекло время ответа Chrome; Send не нажимался'};
 if(/некорректный JSON в разделе Result|unreadable response/i.test(value))
  return {code:'PAGE_RESULT_INVALID',
   message:'Браузер вернул состояние страницы в неожиданном формате; Send не нажимался'};
 if(/MCP HTTP 50[0234]|MCP session|Private Playwright|Chrome tabs cannot be inspected/i.test(value))
  return {code:'BROWSER_OBSERVATION_UNAVAILABLE',
   message:'Выделенная сессия Playwright Extension временно недоступна; Send не нажимался'};
 return {code:'OBSERVATION_FAILED',
  message:'Проверка состояния страницы прервана; Send не нажимался'};
}
export async function deliverViaPlaywright(task,aboutToClick=async()=>{},deps={}){
 const mcp=deps.client||autosendMcp();const wait=deps.wait||pause;
 let clicked=false;let typed=false;
 try{
  if(!deps.client)await mcp.connect();
  const located=locateChatTab(await mcp.tool('browser_tabs',{action:'list'}),task.url);
  if(located.kind!=='found')return tabDeferred(located);
  await mcp.tool('browser_tabs',{action:'select',index:located.tab.index});
  let page,steady=null,state,stable=false;
  // Two independent, matching ready snapshots are required before typing.
  for(let i=0;i<9;i++){
   page=await inspect(mcp,task.message,task.url);
   state=classifyAgent(page,task.url);
   if(state.kind==='ready'){
    if(steady&&sameReadySnapshot(steady,page)){stable=true;break;}
    steady=page;
    await wait(STABLE_READY_INTERVAL_MS);
    continue;
   }
   steady=null;
   if(['busy','stalled','interrupted'].includes(state.kind)||!sameChatGPTConversation(page.url,task.url))
    return {status:'deferred',reason:state.kind,error:state.reason,
     evidence:safeEvidence({code:state.code,stopVisible:!!page.stop,
      streamingVisible:!!page.busyText,connectionInterrupted:!!page.connectionInterrupted})};
   await wait(850);
  }
  if(!stable)return {status:'deferred',reason:'unstable',
   evidence:safeEvidence({code:'READY_NOT_STABLE'}),
   error:'Состояние страницы изменялось во время проверки; отправка отложена'};
  const baseline=page.userCount;
  await mcp.tool('browser_type',{target:page.editorSelector,text:task.message,submit:false});
  typed=true;
  // Retry only transient React composer readiness, never an active stream,
  // changed user message or unexpected draft. No extra typing is performed.
  let filled,issue=null;
  for(let attempt=0;attempt<3;attempt++){
   filled=await inspect(mcp,task.message,task.url);
   issue=preClickIssue(page,filled,task,baseline);
   if(!issue||issue!=='SEND_NOT_READY')break;
   if(attempt<2)await wait(300);
  }
  if(issue)return preClickDeferred(issue);
  await wait(300);
  let finalCheck;
  for(let attempt=0;attempt<3;attempt++){
   finalCheck=await inspect(mcp,task.message,task.url);
   issue=preClickIssue(filled,finalCheck,task,baseline);
   if(!issue&&finalCheck.sendSelector!==filled.sendSelector)issue='SEND_NOT_READY';
   if(!issue||issue!=='SEND_NOT_READY')break;
   if(attempt<2)await wait(300);
  }
  if(issue)return preClickDeferred(issue);
  // Write crash-safe "sending" state before clicking. Ambiguous post-click results never retry.
  const baselineProof={
   // The baseline MUST be the last read-only snapshot immediately before
   // reserving the click, not the earlier readiness snapshot: React may
   // have rerendered between them without changing visible user count.
   userCount:baseline,lastUserHash:fingerprint(finalCheck.lastUserText),
   lastUserId:finalCheck.lastUserId||'',
   assistantRevision:Number.isInteger(finalCheck.assistantRevision)?finalCheck.assistantRevision:null,
   userInsertionRevision:Number.isInteger(finalCheck.userInsertionRevision)?finalCheck.userInsertionRevision:null,
   assistantText:finalCheck.progressText||''
  };
  const actionId=await aboutToClick(baselineProof);
  // The server persisted the operation receipt before dispatch. Set possible
  // commit before entering browser_evaluate: a timeout could hide a real click.
  clicked=true;
  const result=parseGuardedResult(
    await mcp.tool('browser_evaluate',{
      function:buildGuardedClick({
        url:task.url,message:task.message,editorSelector:filled.editorSelector,
        sendSelector:filled.sendSelector,baselineUserCount:baseline,
        assistantRevision:Number.isInteger(filled.assistantRevision)?
          filled.assistantRevision:null,actionId,
        requireStreamStatus:finalCheck.streamStatus==='COMPLETE',
        streamSequence:Number.isInteger(finalCheck.streamSequence)?finalCheck.streamSequence:null
      })
    },{}),parsePageResult
  );
  if(result.refused) {
    // A *verified* page-side refusal means button.click was never reached.
    // Do not confuse this with a lost response; only this exact result can
    // reopen future scheduling without eight minutes of read-only checks.
    clicked=false;
    return {status:'refused',reason:'guard-refused',code:result.code,
      evidence:safeEvidence({code:'PRECLICK_NOT_READY',clickCommitted:false}),
      error:'Финальная защита отклонила Send ('+result.code+'); клик не выполнен'};
  }
  let evidence=safeEvidence({code:'USER_BUBBLE_NOT_FOUND',clickCommitted:true,messageFound:false});
  for(let i=0;i<12;i++){
   await wait(i<5?550:1000);
   const after=await inspect(mcp,task.message,task.url);
   evidence=deliveryEvidence({...baselineProof,assistantHash:fingerprint(baselineProof.assistantText)},
    after,task.message,task.url,evidence);
   if(evidence.messageFound)return {status:'verified',evidence};
   if(!sameChatGPTConversation(after.url,task.url))break;
  }
  return {status:'pending',evidence,
   error:'Send мог быть нажат; подтверждённая реплика пока не обнаружена. Повтор заблокирован'};
 }catch(e){
  const diagnostic=classifyPreflightError(e);
  const congestion=!clicked&&diagnostic.code==='BROWSER_QUEUE_BUSY';
  return {status:clicked?'pending':'deferred',reason:congestion?'transport_busy':'error',
   evidence:safeEvidence({code:clicked?'DELIVERY_UNCERTAIN':diagnostic.code,
    clickCommitted:clicked,messageFound:false}),
   error:clicked?'Проверка прервана; Send повторяться не будет':diagnostic.message};
 }
 finally {
  // Never erase an existing draft: only clear our own pre-click text, and only if still exact.
  if(typed&&!clicked){
   try{const p=await inspect(mcp,task.message,task.url);if(sameChatGPTConversation(p.url,task.url) && String(p.editorText||'').trim()===task.message.trim())
    await mcp.tool('browser_type',{target:p.editorSelector,text:'',submit:false});}catch{}
  }
  // Keep the existing or newly opened conversation tab: closing it may interrupt
  // the assistant response, and the next interval should reuse the same tab.
 }
}

/** Read-only reconciliation of a persisted click; never navigates, types or clicks.
 * A response can be delayed, a tab can disappear, or a snapshot can be stale.
 * Only a positively identified new user bubble can change status to verified.
 */
export async function reconcileViaPlaywright(task,receipt,deps={}){
 const mcp=deps.client||autosendMcp();
 if(!Number.isInteger(receipt?.baselineUserCount))
  return {status:'deferred',reason:'Нет исходной квитанции',
   evidence:safeEvidence({code:'OBSERVATION_FAILED',clickCommitted:true,messageFound:false})};
 try{
  if(!deps.client)await mcp.connect();
  const located=locateChatTab(await mcp.tool('browser_tabs',{action:'list'}),task.url);
  const tab=located.kind==='found'?located.tab:null;
  if(!tab)return {status:'deferred',reason:located.code||'TAB_UNAVAILABLE',
   evidence:safeEvidence({code:located.code||'TAB_UNAVAILABLE',clickCommitted:true,messageFound:false})};
  await mcp.tool('browser_tabs',{action:'select',index:tab.index});
  const after=await inspect(mcp,task.message,task.url);
  const before={userCount:receipt.baselineUserCount,lastUserHash:receipt.baselineLastUserHash,
   lastUserId:receipt.baselineLastUserId,assistantRevision:receipt.baselineAssistantRevision,
   userInsertionRevision:receipt.baselineUserInsertionRevision,
   assistantHash:receipt.baselineAssistantHash};
  const evidence=deliveryEvidence(before,after,task.message,task.url,receipt.lastEvidence);
  if(evidence.messageFound)return {status:'verified',evidence};
  return {status:'deferred',reason:'Подтверждённая новая реплика пока не найдена',evidence};
 }catch{
  return {status:'deferred',reason:'Не удалось получить снимок страницы',
   evidence:safeEvidence({code:'OBSERVATION_FAILED',clickCommitted:true,messageFound:false})};
 }
}

/** Read only observation of an EXISTING ChatGPT tab. Never opens a new tab. */
export async function observeExistingChat(task,deps={}){
 const mcp=deps.client||autosendMcp();
 try{
  if(!deps.client)await mcp.connect();
  const located=locateChatTab(await mcp.tool('browser_tabs',{action:'list'}),task.url);
  const tab=located.kind==='found'?located.tab:null;
  if(!tab)return {status:'unavailable',code:located.code,
   reason:tabDeferred(located).error};
  await mcp.tool('browser_tabs',{action:'select',index:tab.index});
  let page=await inspect(mcp,'',task.url);
  if(!sameChatGPTConversation(page.url,task.url))return {status:'unavailable',reason:'Вкладка изменила URL'};
  let eventKind='none';
  if(deps.eventWaitMs>0 && (page.stop||page.busyText||page.connectionInterrupted)){
   const functionSource=buildEventWait({
    url:task.url,assistantRevision:page.assistantRevision,
    userInsertions:page.userInsertionRevision,timeoutMs:deps.eventWaitMs
   });
   if(functionSource) {
    try {
     const evt=parsePageResult(await mcp.tool('browser_evaluate',{function:functionSource}));
     eventKind=evt?.kind==='changed'?'changed':
       evt?.kind==='timeout'?'timeout':'unavailable';
     if(eventKind==='changed'){
      page=await inspect(mcp,'',task.url);
      if(!sameChatGPTConversation(page.url,task.url))return {status:'unavailable',reason:'Вкладка изменилась во время события'};
     }
    }catch {eventKind='unavailable'}
   }
  }
  return {status:'ok',eventKind,observation:{
   urlValid:true,stop:page.stop,busyText:page.busyText,
   streamStatus:page.streamStatus,streamReason:page.streamReason,
   streamPhase:page.streamPhase,streamActive:page.streamActive,
   streamSequence:page.streamSequence,streamLastEventAt:page.streamLastEventAt,
   connectionInterrupted:page.connectionInterrupted,continuationAvailable:page.continuationAvailable,
   progressText:page.progressText,
   assistantRevision:page.assistantRevision,lastAssistantMutationAt:page.lastAssistantMutationAt,
   pageReady:page.ready,
   editorText:page.editorText||'',editorCount:page.editorCount,
   lastUserId:page.lastUserId||'',userCount:page.userCount,
   lastUserHash:fingerprint(page.lastUserText)
  }};
 }catch(e){return {status:'unavailable',reason:String(e.message||e).slice(0,180)};}
}
