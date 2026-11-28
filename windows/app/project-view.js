'use strict';
// MCP-13: presentation-only, safe default project summary.
// No network, Send, mutable schedule access, or privileged Electron IPC.
(function registerProjectView(root){
 function readableStatus(task){
  if(task.handoff_requires_owner_reconfigure===true)return 'Нужно подтверждение';
  switch(task.status){
   case 'unknown':return 'Доставка не подтверждена';
   case 'sending':case 'checking':case 'verifying':return 'Идёт проверка';
   case 'paused':return 'На паузе';
   case 'scheduled':return task.enabled===true?'Работает':'Остановлено';
   case 'blocked':return 'Заблокировано';
   case 'failed':return 'Ошибка';
   default:return 'Состояние неизвестно';
  }
 }
 function verifiedWork(task){
  const data=task.work_efficiency||{};
  const value=data.verified_work_results;
  const verified=Number.isSafeInteger(value)&&value>=0?value:0;
  if(data.last_work_result_status==='VERIFIED')
   return 'Проверенных изменений кода: '+verified;
  if(data.last_work_result_status==='SELF_REPORT')
   return 'Есть самоотчёт, независимой проверки пока нет';
  return 'Нет подтверждённых изменений кода';
 }
 function presentProject(task={},serviceStatus={}){
  const chat=typeof task.url==='string'?task.url:'';
  // Existing Smart V2 schedules predate project_label and use smart_v2_project.
  // Never render two unrelated legacy project controls with an empty title.
  const label=typeof task.project_label==='string'&&task.project_label.trim()?
    task.project_label.trim():
    typeof task.smart_v2_project==='string'&&task.smart_v2_project.trim()?
      task.smart_v2_project.trim():chat||'Проект без названия';
  const title=label.slice(0,100);
  const state=readableStatus(task);
  let primaryAction=null,primaryLabel='Ожидаем',primaryDisabled=true;
  let next='Сверьте состояние задания',reason='Состояние не подтверждено';
  const receiptPending=!!task.verification||!!task.active_slot_id||!!task.smart_v2_pending_action||
   task.manual_once===true;
  if(task.handoff_requires_owner_reconfigure===true){
   next='Подтвердите перенос чата и его новую вкладку';
   reason='Перенос чата требует подтверждения владельца и браузера';
  }else if(receiptPending){
   next='Дождитесь проверки незавершённого действия. Повторный запуск запрещён';
   reason='Предыдущая отправка или квитанция ещё не завершена';
  }else if(task.status==='unknown'){
   primaryAction='recheck_unknown';primaryLabel='Перепроверить доставку';primaryDisabled=false;
   next='Перепроверьте доставку. Повторная отправка заблокирована';
   reason='Последняя отправка не подтверждена';
  }else if(['sending','checking','verifying'].includes(task.status)){
   next='Дождитесь завершения проверки отправки; повтор запрещён';
   reason='Проверка ещё не завершена';
  }else if(task.status==='scheduled'&&task.enabled===true){
   primaryAction='pause';primaryLabel='Пауза';primaryDisabled=false;
   next='Ожидаем ответ ChatGPT или подтверждённый результат работы';
   reason='Ожидание результата работы';
  }else if(task.status==='paused'&&task.enabled!==true){
   const browserDown=serviceStatus.browserBackendReachable===false;
   const extensionDown=serviceStatus.extensionConnected===false;
   if(browserDown||extensionDown){
    next='Восстановите соединение с браузером и затем выполните проверку вкладки';
    reason=browserDown?'Браузер недоступен, отправка невозможна':
      'Расширение браузера не подключено; отправка невозможна';
   }else{
    primaryAction=task.guided_first_run===true&&!task.first_cycle_started_at?'start_first':'start';
    primaryLabel='Запустить';primaryDisabled=false;
    next='Проверьте вкладку без отправки, затем нажмите «Запустить»';
    reason=task.browserConfirmed===true?'Остановлено владельцем':
      'Вкладка пока не подтверждена';
   }
  }else if(task.status==='blocked'||task.status==='failed'){
   next='Откройте диагностику, устраните блокировку и подтвердите состояние';
   reason='Требуется проверка причины остановки';
  }
  if(typeof task.last_error==='string'&&task.last_error.trim()&&
     ['unknown','blocked','failed'].includes(task.status))
   reason+=': '+task.last_error.trim().slice(0,240);
  return Object.freeze({title,chat,state,result:verifiedWork(task),next,reason,
    primaryAction,primaryLabel,primaryDisabled});
 }
 const api=Object.freeze({presentProject});
 if(typeof module!=='undefined'&&module.exports)module.exports=api;
 if(root)root.McpGoProjectView=api;
})(typeof window==='undefined'?null:window);
