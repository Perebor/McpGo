'use strict';
const $=id=>document.getElementById(id);
const sectionInfo=Object.freeze({
 overview:['CONTROL CENTER','Сервисы MCP','Управление подключениями ChatGPT на этом компьютере'],
 onboarding:['GETTING STARTED','Первое подключение','Мастер настройки и безопасного подключения сервисов'],
 messages:['AGENT MESSAGING','Связь агентов','Локальный обмен сообщениями между агентами'],
 settings:['TUNNEL SETTINGS','Настройки туннелей','Ключи, браузер и автозапуск Windows'],
 skills:['AGENT SKILLS','Навыки инструментов','Готовые инструкции для инструментов и агентов McpGo'],
 autosend:['SCHEDULED MESSAGES','Сообщения по таймеру','Расписания для продолжения работы в ChatGPT'],
 updates:['RELEASES','Обновления','Версии McpGo и проверка новых выпусков']
});
let activeSection='overview';
function navigate(section,focus=false){
 const page=sectionInfo[section];
 if(!page)return;
 activeSection=section;
 document.body.dataset.activeSection=section;
 document.body.dataset.navReady='true';
 $('page-kicker').textContent=page[0];
 $('page-title').textContent=page[1];
 $('page-description').textContent=page[2];
 for(const element of document.querySelectorAll('[data-section]'))
  element.hidden=element.dataset.section!==section;
 for(const button of document.querySelectorAll('[data-nav]')){
  const active=button.dataset.nav===section;
  button.classList.toggle('is-active',active);
  if(active)button.setAttribute('aria-current','page');
  else button.removeAttribute('aria-current');
 }
 $('workspace').scrollTop=0;
 if(section==='skills')void loadSkill(selectedSkill);
 if(focus)$('workspace').focus({preventScroll:true});
}
for(const button of document.querySelectorAll('[data-nav]'))
 button.addEventListener('click',()=>navigate(button.dataset.nav,true));
for(const button of document.querySelectorAll('[data-open]'))
 button.addEventListener('click',()=>window.mcpgo.openLocation(button.dataset.open)
  .catch(error=>message(error.message,true)));
navigate('overview');
// Keep selected skill local; the main process accepts only four fixed resource IDs.
let selectedSkill='terminalhub-operations',skillRequest=0;
async function loadSkill(id){
 const item=document.querySelector('[data-skill="'+id+'"]');
 if(!item)return;
 selectedSkill=id;
 const sequence=++skillRequest;
 $('skill-title').textContent=item.querySelector('strong').textContent;
 $('skill-path').textContent=id+'/SKILL.md';
 $('skill-content').textContent='Читаем инструкцию…';
 $('skills-feedback').textContent='Чтение локального SKILL.md';
 for(const button of document.querySelectorAll('[data-skill]')){
  const selected=button.dataset.skill===id;
  button.classList.toggle('is-selected',selected);
  button.setAttribute('aria-pressed',String(selected));
 }
 try{
  const result=await window.mcpgo.skillRead(id);
  if(sequence!==skillRequest)return;
  $('skill-content').textContent=result.content;
  $('skills-feedback').textContent='Локальный навык · Без автоматического выполнения команд';
 }catch(error){
  if(sequence!==skillRequest)return;
  $('skill-content').textContent='Не удалось прочитать SKILL.md.';
  $('skills-feedback').textContent=error.message;
 }
}
for(const button of document.querySelectorAll('[data-skill]'))
 button.addEventListener('click',()=>void loadSkill(button.dataset.skill));
for(const [id,mode] of [['skill-copy-chat','chat'],['skill-copy-raw','raw']]){
 $(id).addEventListener('click',async()=>{
  const button=$(id);button.disabled=true;
  try{
   await window.mcpgo.skillCopy(selectedSkill,mode);
   $('skills-feedback').textContent=mode==='chat'?
    'Навык скопирован. Вставьте его в нужный чат ChatGPT.':'Содержимое SKILL.md скопировано.';
  }catch(error){$('skills-feedback').textContent=error.message}
  finally{button.disabled=false}
 });
}
$('skill-open').addEventListener('click',()=>window.mcpgo.skillOpen(selectedSkill)
 .catch(error=>{$('skills-feedback').textContent=error.message}));
function updateSummary(status,readiness={}){
 const h=readiness.connectionHealth||{};
 const fresh=c=>Number.isFinite(c?.checkedAt)&&Date.now()>=c.checkedAt&&Date.now()-c.checkedAt<=30000;
 const terminal=fresh(h.terminal)&&h.terminal.state==='ready';
 const browser=fresh(h.browser)&&h.browser.state==='ready'&&Date.now()-h.browser.lastBrowserAt<=300000;
 const count=Number(terminal)+Number(browser);
 $('active-count').textContent=String(count);
 $('summary-count').textContent=count+' / 2';
 $('summary-message').textContent=count===2?'Локальная готовность подтверждена':
  count===1?'Одна система готова':'Нет подтверждённого подключения';
 $('connection-dot').classList.toggle('is-online',count>0);
 for(const [id,ready,parts] of [
  ['terminal-pill',terminal,[status.terminal,status.terminalTunnel]],
  ['browser-pill',browser,[status.browser,status.proxy,status.browserTunnel]]
 ]){
  const pill=$(id),partial=parts.some(value=>value==='running');
  const health=id==='terminal-pill'?h.terminal:h.browser;
  pill.textContent=ready?'Локально готов':health?.state==='auth'?'Авторизация':partial?'Не подтверждено':'Остановлен';
  pill.classList.toggle('is-running',ready);
  pill.classList.toggle('is-partial',!ready&&partial);
 }
}
$('refresh-status').addEventListener('click',async()=>{
 const button=$('refresh-status');button.disabled=true;
 try{render(await window.mcpgo.status());message('Состояние локальных сервисов обновлено.')}
 catch(error){message(error.message,true)}
 finally{button.disabled=false}
});

const message=(value,failed=false)=>{const m=$('message');m.textContent=value;m.style.color=failed?'#ff8a92':'#a1aaba'};
let initialized=false;
let lastOverview=null;
const healthLabels={ready:'Готов',down:'Недоступен',starting:'Ожидание',auth:'Ошибка авторизации',throttled:'Ограничение запросов',unmonitored:'Не проверяется',unknown:'Не подтверждён',failed:'Ошибка'};
const reasonLabels={SERVICE_STOPPED:'Служба остановлена',HEALTH_STALE:'Данные устарели',LOCAL_MCP_UNAVAILABLE:'MCP не отвечает',TUNNEL_AUTH:'Ошибка авторизации',TUNNEL_DOWN:'Туннель не отвечает',TUNNEL_STARTING:'Туннель не готов',TUNNEL_UNMONITORED:'Нет проверки туннеля',TUNNEL_THROTTLED:'Ограничение запросов',BROWSER_CONNECTION_FAILED:'Нет связи с расширением',BROWSER_NOT_RECENTLY_VERIFIED:'Браузер давно не проверялся',BROWSER_TELEMETRY_UNAVAILABLE:'Нет данных браузера'};
function renderConnection(data){
 const h=data.readiness?.connectionHealth||{};
 for(const [id,c] of [['terminal-health-detail',h.terminal],['browser-health-detail',h.browser]]){
  const el=$(id);if(!el)continue;
  if(!c||!Number.isFinite(c.checkedAt)||Date.now()-c.checkedAt>30000||Date.now()<c.checkedAt){el.textContent='Статус неизвестен: нет актуальной проверки';continue}
  el.textContent=['MCP: '+(c.mcp?'готов':'не готов'),'Туннель: '+(healthLabels[c.tunnel]||'не подтверждён'),
   c.browser?'Расширение: '+(healthLabels[c.browser]||'не подтверждено'):'',
   c.reason?(reasonLabels[c.reason]||c.reason):'Локальная готовность подтверждена',
   'Проверено '+new Date(c.checkedAt).toLocaleTimeString(),
   c.lastCallAt?'Последний успешный MCP-вызов '+new Date(c.lastCallAt).toLocaleString():'',
   c.lastBrowserAt?'Последний успешный браузерный вызов '+new Date(c.lastBrowserAt).toLocaleString():'',
   'Доступность в конкретном чате не проверена'].filter(Boolean).join(' · ');
 }
 const history=$('connection-history');
 if(history)history.textContent=(data.readiness?.history||[]).slice(-8).reverse().map(e=>new Date(e.at).toLocaleString()+' · '+(e.channel==='terminal'?'Terminal':'Playwright')+' · '+(reasonLabels[e.reason]||healthLabels[e.state]||e.state)).join('\n')||'Нет событий';
 for(const [id,field,c] of [['state-terminal','terminal',h.terminal],['state-terminalTunnel','terminalTunnel',h.terminal],['state-browser','browser',h.browser],['state-proxy','proxy',h.browser],['state-browserTunnel','browserTunnel',h.browser]]){
  const el=$(id);if(!el)continue;
  const fresh=c&&Number.isFinite(c.checkedAt)&&Date.now()>=c.checkedAt&&Date.now()-c.checkedAt<=30000;
  const status=!fresh?'Не проверено':field.endsWith('Tunnel')?(healthLabels[c.tunnel]||'Не подтверждён'):field==='browser'?(healthLabels[c.browser]||'Не подтверждён'):c.mcp?'MCP готов':'MCP не готов';
  el.textContent=status;el.className=fresh&&(field.endsWith('Tunnel')?c.tunnel==='ready':field==='browser'?c.browser==='ready'&&Date.now()-c.lastBrowserAt<=300000:c.mcp)?'ok':'warn';
 }
}
setInterval(()=>{if(lastOverview){updateSummary(lastOverview.status||{},lastOverview.readiness||{});renderConnection(lastOverview)}},1000);
function render(data) {
 if(!initialized){
  $('terminal-id').value=data.terminal.id||'';
  $('browser-id').value=data.browserTunnel.id||'';
  $('browser').value=data.browser;
  $('autoStart').checked=data.autoStart;
  initialized=true;
  if(!data.terminal?.id || !data.browserTunnel?.id)navigate('onboarding');
  else if(!data.terminal?.configured||!data.browserTunnel?.configured)navigate('onboarding');
 }
 lastOverview=data;
 updateSummary(data.status||{},data.readiness||{});
 const diagnostic=$('connection-diagnostic'),r=data.readiness||{};
 if(diagnostic)diagnostic.textContent=[
  'Terminal MCP: '+(r.terminalMcp?'готов':'не подтверждён'),
  'Terminal Tunnel: '+(r.terminalTunnel?'готов':'не подтверждён'),
  'Browser MCP: '+(r.browserMcp?'готов':'не подтверждён'),
  'Browser Tunnel: '+(r.browserTunnel?'готов':'не подтверждён'),
  'Chrome/Edge: '+(r.chrome===true?'вкладки доступны':r.chrome===false?'проверка не пройдена':'не проверен'),
  'ChatGPT: выполни тестовый вызов из подключённого чата'
 ].join(' · ');

 const extensionStates=[data.status?.browser,data.status?.autosendBrowser];
 const invalid=extensionStates.some(v=>typeof v==='string'&&/INVALID_ENCRYPTED_EXTENSION_TOKEN|SECURE_STORAGE_UNAVAILABLE|EXTENSION_CONFIG_UNREADABLE/.test(v));
 const missing=!data.playwrightExtension?.configured||extensionStates.includes('unconfigured');
 const hint=$('playwright-token-help');
 if(hint)hint.textContent=invalid?'Не удалось прочитать токен. Проверь доступ к защищённому хранилищу Windows и введи токен заново. Туннели пересоздавать не нужно.':
  missing?'Токен отсутствует. Вставь токен Chrome Extension и сохрани настройки для восстановления Browser MCP и AutoSend.':
  'Токен сохранён в защищённом хранилище Windows. Это не подтверждает соединение с Chrome. Для восстановления введи новый токен и сохрани настройки.';

 for(const [key,value] of Object.entries(data.status||{})){
  const el=$('state-'+key);if(!el)continue;
  const messages={running:'Запущен',stopped:'Остановлен',starting:'Запуск',unconfigured:'Не настроен','error: PORT_OCCUPIED':'Локальный порт занят','error: INVALID_ENCRYPTED_EXTENSION_TOKEN':'Токен повреждён','error: EXTENSION_CONFIG_UNREADABLE':'Не удалось прочитать токен','error: SECURE_STORAGE_UNAVAILABLE':'Защищённое хранилище недоступно'};
  el.textContent=messages[value]||value;
  el.className=value==='running'?'ok':(value==='stopped'||value==='unconfigured'?'':'warn');
 }
 renderConnection(data);
}
window.mcpgo.onStatus(render);
$('copy-connection-test').onclick=async()=>{
 try{await window.mcpgo.copyConnectionTest();message('Вставь скопированный тест в нужный чат ChatGPT.')}catch(e){message(e.message,true)}
};
$('overview-verify').onclick=async()=>{
 try{message('Проверяем соединение с браузером…');render(await window.mcpgo.verifyConnection());message('Проверка завершена. См. состояние компонентов.')}catch(e){message(e.message,true)}
};
for(const [id,name] of [['recover-terminal-tunnel','terminalTunnel'],['recover-browser-tunnel','browserTunnel']])$(id).onclick=async()=>{
 try{if(!window.confirm('Переподключить только туннель? Текущий сетевой вызов может быть прерван.'))return;render(await window.mcpgo.recoverTunnel(name));message('Переподключаем туннель…')}catch(e){message(e.message,true)}
};
window.mcpgo.status().then(data=>{render(data);message('Локальные сервисы запускаются автоматически.')})
  .catch(e=>message(e.message,true));
$('settings').addEventListener('submit',async event=>{
 event.preventDefault();
 const button=event.currentTarget.querySelector('button[type=submit]');button.disabled=true;
 try{
  const terminalId=$('terminal-id').value.trim(),browserId=$('browser-id').value.trim();
  const data={browser:$('browser').value,autoStart:$('autoStart').checked,
    terminal:terminalId?{id:terminalId,key:$('terminal-key').value}:undefined,
    browserTunnel:browserId?{id:browserId,key:$('browser-key').value}:undefined,
    playwrightExtension:$('playwright-token').value?
      {token:$('playwright-token').value}:undefined};
  if(data.playwrightExtension)message('Проверяем токен и доступ к вкладкам браузера…');
  const result=await window.mcpgo.save(data);
  $('terminal-key').value='';$('browser-key').value='';$('playwright-token').value='';
  render(result);message('Настройки сохранены. Проверяй состояние подключения в панели сервисов.');
 }catch(e){
  const detail=String(e.message||'');
  message(detail.includes('EXTENSION_TRIAL')?'Расширение не подтвердило доступ к браузеру. Проверь токен и профиль. Предыдущие настройки сохранены.':detail,true);
 }finally{button.disabled=false}
});
$('restart').addEventListener('click',async()=>{
 try{message('Перезапуск компонентов...');render(await window.mcpgo.restart());message('Запрос на перезапуск выполнен.')}
 catch(e){message(e.message,true)}
});
$('browser-install-extension').addEventListener('click',()=>window.mcpgo.extensionStore().catch(e=>message(e.message,true)));

async function checkBrowserCompatibility(){
 const browser=$('browser').value, indicator=$('browser-version'),update=$('browser-version-update');
 indicator.textContent='Проверяем версию браузера…';
 indicator.classList.remove('warning');update.hidden=true;
 try{
  const result=await window.mcpgo.onboard('browser-check',{browser});
  // The user can change the selection before the async check completes.
  if($('browser').value!==browser)return;
  const label=browser==='chrome'?'Google Chrome':'Microsoft Edge';
  if(result.backgroundReady){
   indicator.textContent=label+' '+result.version+
    ' — версия подходит для фонового Playwright (ориентир '+result.minimumVersion+').'+
    (result.requiresRealBrowserVerification?' Для Edge нужна проверка реальной браузерной сессии.':'');
  }else{
   const detected=result.version?'Найдена версия '+result.version+'. ':'Версию браузера определить не удалось. ';
   indicator.textContent=detected+'Для фонового режима без переключения окон нужен '+
    label+' '+result.minimumVersion+' или новее. McpGo продолжит работать и без обновления.';
   indicator.classList.add('warning');
   update.hidden=false;
   update.textContent='Обновить '+label;
  }
 }catch(e){
  if($('browser').value!==browser)return;
  indicator.textContent='Не удалось проверить версию: '+e.message;
  indicator.classList.add('warning');
 }
}
$('browser-version-check').addEventListener('click',()=>void checkBrowserCompatibility());
$('browser').addEventListener('change',()=>void checkBrowserCompatibility());
$('browser-version-update').addEventListener('click',()=>window.mcpgo.browserUpdate($('browser').value)
 .catch(e=>message(e.message,true)));
void checkBrowserCompatibility();


const wizard=$('wizard-status');
async function resumeWizard(){
 try{
  const data=await window.mcpgo.onboard('status',{});
  const current=await window.mcpgo.status();
  for(const [field,name] of [['terminal-id','terminal'],['browser-id','browser']]){
   const id=data.tunnels?.[name]?.id;
   if(id&&!$(field).value)$(field).value=id;
  }
  const key=data.runtimeProvision||{},saved=current.terminal?.configured&&current.browserTunnel?.configured;
  if(['key-issuing','key-issued','recovery-key-issuing','key-recovery-rejected'].includes(key.status)&&!saved){
   wizard.textContent='Ключ ранее выпускался, но не подтверждён локально. Проверь созданные ресурсы и восстанови ключ; не создавай новый проект.';
  }else if(data.pending||key.pending){
   wizard.textContent='Найдена незавершённая настройка. Повтори текущий шаг: McpGo сверит существующие ресурсы.';
  }else if(data.tunnels?.terminal?.id&&data.tunnels?.browser?.id&&!saved){
   wizard.textContent='Оба Tunnel ID восстановлены. Продолжи настройку Runtime Key.';
  }
  if(saved&&key.keyExpiresAt&&Date.parse(key.keyExpiresAt)-Date.now()<7*86400000)
   wizard.textContent='Срок Runtime Key подходит к концу или истёк. Проверь ключ в OpenAI Platform и обнови его в настройках.';
 }catch(e){wizard.textContent='Не удалось прочитать сохранённое состояние: '+e.message}
}
void resumeWizard();
$('verify-connection').onclick=async()=>{
 const button=$('verify-connection');button.disabled=true;
 try{
  wizard.textContent='Проверяем сеть, локальное хранилище и подключение браузера…';
  const [preflight,connection]=await Promise.all([
   window.mcpgo.onboard('connection-preflight',{}),window.mcpgo.verifyConnection()]);
  render(connection);
  wizard.textContent=preflight.message+' '+(preflight.secureStorage?'Шифрование Windows доступно.':'Защищённое хранилище Windows недоступно.');
 }
 catch(e){wizard.textContent=e.message}finally{button.disabled=false}
};
$('export-diagnostics').onclick=async()=>{
 try{
  const result=await window.mcpgo.exportDiagnostics();
  if(!result?.canceled)wizard.textContent='Диагностика сохранена: '+result.fileName;
 }catch(e){wizard.textContent='Не удалось экспортировать диагностику: '+e.message}
};
async function runWizard(action,data){
 const buttons=[$('create-tunnels'),$('create-runtime'),$('inspect-runtime'),$('recover-runtime')];
 buttons.forEach(b=>b.disabled=true);
 try{return await window.mcpgo.onboard(action,data)}
 catch(e){wizard.textContent=e.message;throw e}
 finally{buttons.forEach(b=>b.disabled=false)}
}
$('create-tunnels').onclick=async()=>{
 if(!$('admin-key').value)return wizard.textContent='Введите ключ администратора';
 if(!$('organization-id').value.trim()&&!$('workspace-id').value.trim())
  return wizard.textContent='Укажите Organization ID либо Workspace ID';
 wizard.textContent='Создание туннелей...';
 try{
  const r=await runWizard('provision',{adminKey:$('admin-key').value,confirmed:true,
   organizationId:$('organization-id').value.trim(),workspaceId:$('workspace-id').value.trim()});
  $('terminal-id').value=r.tunnels.terminal;
  $('browser-id').value=r.tunnels.browser;
  wizard.textContent='Туннели созданы. Можно выдать Runtime Key.';
 }catch{}
};
$('create-runtime').onclick=async()=>{
 if(!$('admin-key').value)return wizard.textContent='Введите ключ администратора';
 wizard.textContent='Выпуск Runtime Key...';
 try{
  await runWizard('runtime-auto',{adminKey:$('admin-key').value,confirmed:true,createProject:true});
  $('admin-key').value='';
  const r=await window.mcpgo.status();
  $('terminal-id').value=r.terminal.id;$('browser-id').value=r.browserTunnel.id;
  render(r);wizard.textContent='Туннели подключаются. Ключ сохранён.';
 }catch{}
};
$('inspect-runtime').onclick=async()=>{
 if(!$('admin-key').value)return wizard.textContent='Введите ключ администратора';
 try{
  const result=await runWizard('runtime-inspect',{adminKey:$('admin-key').value});
  wizard.textContent=['Проект: '+(result.priorProjectAvailable?'доступен':'не подтверждён'),
   'Роль: '+(result.roleValid?'подтверждена':result.roleFound?'требует проверки':'не найдена'),
   result.priorProjectIsDefault?'Default project не поддерживает Service Account.':'',
   result.pendingKind?'Незавершённый этап: '+result.pendingKind:'',
   'Если ключ был выпущен, но не сохранился, используй восстановление Runtime Key.'].filter(Boolean).join(' · ');
 }catch{}
};
$('recover-runtime').onclick=async()=>{
 if(!$('admin-key').value)return wizard.textContent='Введите ключ администратора';
 if(!window.confirm('Выпустить один новый ключ для существующего Service Account? Прежний ключ может существовать; он не будет удалён.'))return;
 try{
  await runWizard('runtime-recover-key',{adminKey:$('admin-key').value,confirmed:true,acknowledgePossiblePreviousKey:true});
  $('admin-key').value='';
  const r=await window.mcpgo.status();
  $('terminal-id').value=r.terminal.id;$('browser-id').value=r.browserTunnel.id;
  render(r);wizard.textContent='Новый ключ сохранён. Проверяем соединение.';
 }catch{}
};
function element(tag,text){
 const node=document.createElement(tag);node.textContent=String(text);return node;
}
function item(title,lines,buttons=[]){
 const box=element('div','');box.className='item';box.append(element('strong',title));
 for(const line of lines)box.append(element('small',line));
 if(buttons.length){
  const bar=element('div','');bar.className='actions';
  for(const {label,run} of buttons){
   const btn=element('button',label);btn.type='button';btn.className='minor';
   btn.onclick=run;bar.append(btn);
  }box.append(bar);
 }
 return box;
}
async function doTask(action,id){
 try{
  await window.mcpgo.serviceAction('autosend','/api/tasks',{action,id});
  await refreshTasks();
 }catch(e){message(e.message,true)}
}
async function refreshTasks(){
 const list=$('tasks-list');list.replaceChildren();
 try{
  const {tasks=[]}=await window.mcpgo.serviceRead('autosend','/api/status');
  for(const t of tasks){
   const pending=['sending','checking','verifying'].includes(t.status);
   const buttons=pending||t.status==='unknown'?[]:
     t.enabled?[{label:'Пауза',run:()=>doTask('pause',t.id)}]:
     [{label:'Включить',run:()=>doTask('start',t.id)},
      {label:'Удалить',run:()=>{if(confirm('Удалить расписание?'))doTask('remove',t.id)}}];
   list.append(item(t.url,[
    'Статус: '+t.status+'; '+(t.enabled?'Включено':'Выключено'),
    String(t.message||'').slice(0,150),
    'Интервал: '+t.interval_seconds+' сек.; следующий: '+(t.next_at||'нет'),
    t.last_error||''
   ].filter(Boolean),buttons));
  }
  if(!tasks.length)list.append(item('Расписания отсутствуют',[]));
 }catch(e){list.append(item('Планировщик недоступен',[e.message]))}
}
$('refresh-tasks').onclick=refreshTasks;
$('task-create').onsubmit=async event=>{
 event.preventDefault();const btn=event.submitter;btn.disabled=true;
 try{
  await window.mcpgo.serviceAction('autosend','/api/tasks',{
   action:'create',url:$('task-url').value.trim(),message:$('task-message').value,
   interval_seconds:Number($('task-interval').value)*60});
  $('task-create').reset();message('Расписание создано выключенным');await refreshTasks();
 }catch(e){message(e.message,true)}finally{btn.disabled=false}
};
async function refreshAgents(){
 const list=$('agents-list');list.replaceChildren();
 try{
  const {agents=[]}=await window.mcpgo.serviceRead('messaging','/api/agents');
  for(const a of agents)list.append(item(a.label||a.id,
   ['ID: '+a.id+'; '+a.role]));
  if(!agents.length)list.append(item('Нет зарегистрированных агентов',[]));
 }catch(e){list.append(item('Сервис агентов недоступен',[e.message]))}
}
$('refresh-agents').onclick=refreshAgents;
$('agent-create').onsubmit=async event=>{
 event.preventDefault();const btn=event.submitter;btn.disabled=true;
 try{
  await window.mcpgo.serviceAction('messaging','/api/agents',{
   id:$('agent-id').value.trim(),label:$('agent-label').value.trim(),role:'agent'});
  $('agent-create').reset();message('Агент зарегистрирован');await refreshAgents();
 }catch(e){message(e.message,true)}finally{btn.disabled=false}
};
void refreshTasks();void refreshAgents();
setInterval(()=>{if(!document.hidden){void refreshTasks();void refreshAgents()}},15000);


async function refreshHistory(){
 const list=$('agent-history');list.replaceChildren();
 try{
  const {messages=[]}=await window.mcpgo.serviceRead('messaging','/api/history');
  for(const m of messages.slice(-40).reverse())
   list.append(item(m.sender+' → '+m.recipient+' · '+(m.created_at||''),
     [String(m.body||'')]));
  if(!messages.length)list.append(item('Пока нет сообщений',[]));
 }catch(e){list.append(item('История недоступна',[e.message]))}
}
$('refresh-history').onclick=refreshHistory;
$('agent-message').onsubmit=async event=>{
 event.preventDefault();
 const button=event.submitter;button.disabled=true;
 try{
  await window.mcpgo.serviceAction('messaging','/api/messages',{
   sender:'hub',recipient:$('message-target').value.trim(),
   body:$('message-body').value,kind:'message'});
  $('message-body').value='';message('Сообщение сохранено в очереди агента');
  await refreshHistory();
 }catch(e){message(e.message,true)}finally{button.disabled=false}
};
void refreshHistory();

const updatesStatus=$('updates-status');
$('open-releases').onclick=()=>window.mcpgo.openReleases().catch(e=>message(e.message,true));
$('check-updates').onclick=async()=>{
 const button=$('check-updates');button.disabled=true;
 updatesStatus.textContent='Проверяем GitHub Releases...';
 $('open-update').hidden=true;
 try{
  const update=await window.mcpgo.checkUpdates();
  if(update.available){
   updatesStatus.textContent='Доступна версия '+update.version+
    '. Скачайте её с официального GitHub Releases и сравните SHA-256.';
   const open=$('open-update');open.hidden=false;
   open.onclick=()=>window.mcpgo.openUpdate(update.url).catch(e=>message(e.message,true));
  }else updatesStatus.textContent='Новых Windows Preview нет. Установлено: '+update.current;
 }catch(error){updatesStatus.textContent='Не удалось проверить обновления: '+error.message}
 finally{button.disabled=false}
};
