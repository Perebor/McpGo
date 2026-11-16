import {sameChatGPTConversation} from '../playwright/chatgpt-url.mjs';
import {streamBusy,streamReady} from './stream-monitor.mjs';
/**
 * Conservative chat-state classifier. These are observable DOM states, never
 * proof of server-side ChatGPT execution or a license to replay Send.
 */
export const STALE_GENERATION_MS=12*60_000;
export const STABLE_READY_INTERVAL_MS=650;

export function classifyChatState(page,expectedUrl,now=Date.now()) {
 const detail={
  urlMatched:sameChatGPTConversation(page?.url,expectedUrl),
  stopVisible:!!page?.stop,
  streamingVisible:!!page?.busyText,
  interrupted:!!page?.connectionInterrupted,
  continuationAvailable:!!page?.continuationAvailable,
  editorCount:Number.isInteger(page?.editorCount)?page.editorCount:0,
  sendCount:Number.isInteger(page?.sendCount)?page.sendCount:0,
  observerRevision:Number.isInteger(page?.assistantRevision)?page.assistantRevision:null
 };
 const result=(kind,code,reason)=>({kind,code,reason,signals:detail});
 if(!detail.urlMatched)return result('deferred','WRONG_CONVERSATION','Нужный разговор не открыт или произошла переадресация');
 if(detail.interrupted&&page.streamStatus!=='COMPLETE')
  return result('interrupted','CONNECTION_INTERRUPTED','В интерфейсе явно показан обрыв ответа; требуется восстановление соединения');
 if(page.ready!=='complete'||page.login||detail.editorCount!==1||detail.sendCount>1||
    (page.mainLength<80&&page.turnCount<1)||page.genericTitle)
  return result('deferred','PAGE_NOT_READY','Страница разговора не готова или её состояние неоднозначно');
 // Server status outranks a stale Stop button. Unknown means never click.
 // An actively arriving SSE stream briefly outranks an eventual COMPLETE.
 if(page.streamStatus==='UNKNOWN')
  return result('deferred','STREAM_STATUS_UNKNOWN','Сервер не подтвердил завершение генерации; Send запрещён');
 if(streamBusy(page))
  return result('busy','SERVER_STREAMING','Сервер или свежие сетевые события подтверждают работу агента');
 if(detail.interrupted && !streamReady(page))
  return result('interrupted','CONNECTION_INTERRUPTED','В интерфейсе явно показан обрыв ответа; требуется восстановление соединения');
 if((detail.stopVisible||detail.streamingVisible)&&!streamReady(page)){
  const changedAt=Number(page.lastAssistantMutationAt);
  const stale=Number.isFinite(changedAt)&&changedAt>0&&now-changedAt>=STALE_GENERATION_MS;
  return stale
   ?result('stalled','GENERATION_SUSPECTED_STALLED','Индикатор ответа виден, но нет подтверждённых изменений более 12 минут; отправка запрещена')
   :result('busy','GENERATION_ACTIVE_OR_UNCERTAIN','Ответ ещё активен либо индикатор генерации не исчез; отправка отложена');
 }
 if(String(page.editorText||'').trim())return result('busy','USER_DRAFT_PRESENT','В чате есть пользовательский черновик; его не трогаем');
 if(!page.editorSelector)return result('deferred','EDITOR_NOT_FOUND','Не удалось однозначно определить поле ввода');
 return result('ready','READY_TO_CHECK','Видимые признаки занятости отсутствуют; требуется повторная проверка');
}
export function sameReadySnapshot(a,b) {
 if(!a||!b)return false;
 // React may re-render an already completed answer without actually resuming
 // generation. An assistant DOM revision is only a busy signal when the server
 // has NOT confirmed two idle snapshots with an unchanged stream sequence.
 const serverIdle=streamReady(a)&&streamReady(b);
 return sameChatGPTConversation(a.url,b.url) && a.userCount===b.userCount &&
  String(a.lastUserId||'')===String(b.lastUserId||'') &&
  String(a.lastUserText||'').trim()===String(b.lastUserText||'').trim() &&
  (serverIdle||Number(a.assistantRevision||0)===Number(b.assistantRevision||0)) &&
  (!a.streamStatus&&!b.streamStatus || serverIdle) &&
  (a.streamSequence===undefined||a.streamSequence===b.streamSequence) &&
  !String(a.editorText||'').trim()&&!String(b.editorText||'').trim();
}
/** Structured diagnostics without message text, URL, screenshots or tokens. */
export function safeEvidence(e={}) {
 const boolean=['clickCommitted','editorCleared','urlMatched','lastTextMatched',
  'newUserCount','stableUserAnchor','previousBubbleConfirmed','messageFound',
  'stopVisible','streamingVisible','connectionInterrupted',
  'assistantActivitySeen','virtualizedProof'];
 const integers=['checks','userCountDelta','assistantRevisionDelta','userInsertionDelta'];
 const out={code:typeof e.code==='string'&&/^[A-Z0-9_]{2,64}$/.test(e.code)?e.code:'UNSPECIFIED'};
 for(const key of boolean)if(typeof e[key]==='boolean')out[key]=e[key];
 for(const key of integers)if(Number.isSafeInteger(e[key]))out[key]=Math.max(-100000,Math.min(100000,e[key]));
 return out;
}
export function explainEvidence(e={}) {
 const evidence=safeEvidence(e);
 const title={
  USER_BUBBLE_VERIFIED:'Новая пользовательская реплика подтверждена',
  USER_BUBBLE_VERIFIED_VIRTUALIZED:'Сообщение подтверждено по событиям отправки и ответа (DOM свернул старые реплики)',
  USER_BUBBLE_NOT_FOUND:'Новая пользовательская реплика ещё не найдена',
  USER_TEXT_MISMATCH:'Последняя пользовательская реплика не совпадает с заданием',
  TAB_UNAVAILABLE:'Нужная вкладка недоступна для проверки',
  CHAT_TAB_MISSING:'Вкладка не выбрана в группе AutoSend',
  AMBIGUOUS_CHAT_TABS:'В группе AutoSend несколько одинаковых вкладок',
  WRONG_CONVERSATION:'Проверка открыла другой разговор',
  OBSERVATION_FAILED:'Не удалось прочитать состояние чата',
  TAB_IDENTITY_UNVERIFIED:'Chrome не подтвердил идентичность активной вкладки',
  TAB_INDEX_UNSTABLE:'Вкладки Chrome изменились во время проверки',
  TAB_OWNED_BY_ANOTHER_AGENT:'Вкладка принадлежит другому агенту',
  BROWSER_OBSERVATION_TIMEOUT:'Chrome не успел сообщить состояние страницы',
  BROWSER_OBSERVATION_UNAVAILABLE:'Соединение с браузером временно недоступно',
  PAGE_RESULT_INVALID:'Невозможно разобрать ответ браузера',
  PRECLICK_BUSY:'До нажатия Send появились признаки занятости',
  PRECLICK_NOT_READY:'Страница изменилась до нажатия Send',
  GENERATION_ACTIVE:'Ответ агента ещё генерируется',
  STREAM_PROGRESS:'Обнаружены новые события генерации ответа',
  USER_MESSAGES_CHANGED:'Изменились пользовательские сообщения',
  EDITOR_TEXT_CHANGED:'Черновик изменился до отправки',
  SEND_NOT_READY:'Кнопка отправки не готова',
  EDITOR_NOT_READY:'Поле ввода временно недоступно',
  ASSISTANT_CHANGED:'Ответ изменился без подтверждения завершённой генерации',
  CONNECTION_INTERRUPTED:'Ответ прерван — повторная отправка не выполнена',
  READY_NOT_STABLE:'Страница менялась во время проверки готовности',
  DELIVERY_UNCERTAIN:'Отправка могла произойти, но подтверждения нет',
  UNSPECIFIED:'Недостаточно сведений для подтверждения'
 }[evidence.code]||'Проверка состояния отправки';
 const pieces=[title];
 if(evidence.clickCommitted)pieces.push('Send мог быть нажат — повтор заблокирован');
 if(evidence.virtualizedProof)pieces.push('подтверждено несколькими независимыми признаками');
 if(evidence.userInsertionDelta>0)pieces.push('после Send появился пользовательский элемент');
 if(evidence.assistantActivitySeen)pieces.push('наблюдался новый ответ агента');
 if(evidence.editorCleared===true)pieces.push('поле ввода очищено');
 else if(evidence.editorCleared===false)pieces.push('поле ввода не подтверждено очищенным');
 if(evidence.messageFound===false)pieces.push('подтверждённой новой реплики нет');
 if(Number.isInteger(evidence.checks))pieces.push('проверок: '+evidence.checks);
 return pieces.join(' · ');
}
