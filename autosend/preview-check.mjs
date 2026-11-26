import {streamBusy,streamReady} from './stream-monitor.mjs';

/**
 * Pure classification of one READ-ONLY AutoSend observation.
 *
 * A 404/5xx/timeout from ChatGPT's undocumented stream_status endpoint is an
 * unknown result, not evidence of a working assistant. Never authorize Send
 * from the DOM alone. This function is only for preview diagnostics; delivery
 * has an independent guarded pre-click check.
 */
const streamFailure={
 NETWORK_ERROR:'Не удалось получить ответ от ChatGPT при проверке генерации.',
 UNKNOWN_SERVER_STATUS:'ChatGPT вернул неизвестный статус генерации.',
 NO_CONVERSATION:'Не найден идентификатор разговора.',
 UNAVAILABLE:'Сетевой статус ответа недоступен.',
 HTTP_404:'ChatGPT не предоставил статус генерации для этого разговора.',
 HTTP_403:'ChatGPT запретил доступ к статусу генерации.',
 HTTP_401:'ChatGPT не разрешил проверить статус генерации.',
 HTTP_429:'ChatGPT временно ограничил запросы проверки.'
};
export function diagnosePreview(page){
 const p=page||{};
 const result=(code,reason,{ready=false,retryable=false}={})=>({code,reason,ready,retryable});
 if(!p.urlValid)return result('WRONG_CONVERSATION','Не подтверждено совпадение нужного разговора.');
 if(p.pageReady!=='complete')return result('PAGE_NOT_READY','Страница разговора ещё загружается.');
 if(p.editorCount!==1)return result('EDITOR_NOT_READY','Поле ввода не обнаружено однозначно.');
 // Stable drafts are allowed: preview does not edit the field.
 if(p.connectionInterrupted)return result('CONNECTION_INTERRUPTED',
  'Разговор сообщает об обрыве соединения.');
 if(streamBusy(p)||p.stop||p.busyText)return result('GENERATION_ACTIVE_OR_UNCERTAIN',
  'Ответ ещё активен или виден индикатор генерации.');
 if(!streamReady(p)){
  const reason=typeof p.streamReason==='string'&&/^(?:HTTP_[1-5][0-9]{2}|[A-Z_]{2,40})$/.test(p.streamReason)
   ?p.streamReason:'UNAVAILABLE';
  const hint=streamFailure[reason]||
   (/^HTTP_5[0-9]{2}$/.test(reason)?'ChatGPT временно не отвечает на проверку статуса.':
    'ChatGPT не подтвердил завершение генерации.');
  return result('STREAM_STATUS_UNKNOWN',hint+' Отправка запрещена.',
   {retryable:p.streamStatus==='UNKNOWN'||p.streamStatus===undefined});
 }
 return result('READY_TO_CHECK','Чат найден; ответ завершён. Стабильный черновик разрешён для AutoSend.',{ready:true});
}
/** Two separate COMPLETE observations with unchanged conversation/stream state. */
export function samePreviewReady(a,b){
 if(!a||!b||!diagnosePreview(a).ready||!diagnosePreview(b).ready)return false;
 const sameStream=a.streamSequence===b.streamSequence||
  (!Number.isInteger(a.streamSequence)&&!Number.isInteger(b.streamSequence));
 return sameStream&&String(a.editorText||'')===String(b.editorText||'')&&a.userCount===b.userCount&&
  String(a.lastUserHash||'')===String(b.lastUserHash||'')&&
  String(a.lastUserId||'')===String(b.lastUserId||'');
}
export async function checkPreview(task,readOnlyObserve,wait=ms=>new Promise(resolve=>setTimeout(resolve,ms))){
 let previous=null,last=null,readings=0;
 for(let attempt=0;attempt<3;attempt++){
  const inspected=await readOnlyObserve(task,{eventWaitMs:0});
  readings++;
  if(inspected.status!=='ok')return {ready:false,chatFound:false,
   code:inspected.code||'CHAT_TAB_MISSING',
   reason:inspected.reason||'Не удалось прочитать состояние вкладки.',
   sendBlocked:true,readings};
  const page=inspected.observation;
  last=diagnosePreview(page);
  if(last.ready){
   if(previous&&samePreviewReady(previous,page))
    return {ready:true,chatFound:true,code:last.code,
     reason:'Готовность подтверждена двумя последовательными проверками. Send не нажимался.',
     sendBlocked:true,readings};
   previous=page;
  }else{
   previous=null;
   if(!last.retryable)return {ready:false,chatFound:true,...last,sendBlocked:true,readings};
  }
  if(attempt<2)await wait(400);
 }
 return {ready:false,chatFound:true,
  code:last?.ready?'READY_NOT_STABLE':last?.code||'OBSERVATION_FAILED',
  reason:last?.ready?'ChatGPT ответил, но двух устойчивых проверок ещё нет. Повторите проверку без отправки.':
   (last?.reason||'Не удалось подтвердить готовность.'),
  sendBlocked:true,readings};
}
