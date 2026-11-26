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
 if(history)history.textContent=(data.readiness?.history||[]).slice(-8).reverse().map(e=>new Date(e.at).toLocaleString()+' · '+(e.channel==='terminal'?'Terminal':'Playwright')+' · '+(reasonLabels[e.reason]||healthLabels[e.state]||e.state)).join('\r\n')||'Нет событий';
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
 syncWizardIds(data);
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
let wizardStep=0,wizardTouched=false,wizardBusy=false;
function showWizardStep(step,manual=true){
 if(manual&&wizardBusy)return;
 wizardStep=Math.max(0,Math.min(6,step));
 if(manual)wizardTouched=true;
 for(const page of document.querySelectorAll('[data-wizard-page]'))page.hidden=Number(page.dataset.wizardPage)!==wizardStep;
 for(const button of document.querySelectorAll('[data-wizard-step]')){
  if(Number(button.dataset.wizardStep)===wizardStep)button.setAttribute('aria-current','step');
  else button.removeAttribute('aria-current');
 }
 $('wizard-progress').textContent='Шаг '+(wizardStep+1)+' из 7';
 $('wizard-back').disabled=wizardStep===0;
 $('wizard-next').hidden=wizardStep===6;
 $('wizard-confirm-plugins').disabled=!(lastOverview?.terminal?.configured&&lastOverview?.browserTunnel?.configured);
}
function wizardMode(importing){
 $('wizard-create-mode').setAttribute('aria-pressed',String(!importing));
 $('wizard-import-mode').setAttribute('aria-pressed',String(importing));
 $('wizard-account-create').hidden=importing;$('wizard-account-import').hidden=!importing;
 $('wizard-tunnel-create').hidden=importing;
 if(importing)$('admin-key').value='';
}
function syncWizardIds(data){
 for(const [name,field] of [['terminal','terminal'],['browser','browserTunnel']]){
  const id=data?.[field]?.id||'';
  const input=$('wizard-'+name+'-id');
  if(id&&(!input.value||document.activeElement!==input&&input.value===input.dataset.savedId))input.value=id;
  input.dataset.savedId=id;
  $('wizard-plugin-'+name).textContent=id||'—';
  $('wizard-copy-'+name).disabled=!id;
 }
 $('wizard-confirm-plugins').disabled=!(data?.terminal?.configured&&data?.browserTunnel?.configured);
}
for(const button of document.querySelectorAll('[data-wizard-step]'))button.onclick=()=>showWizardStep(Number(button.dataset.wizardStep));
for(const button of document.querySelectorAll('[data-guide-link]'))button.onclick=()=>window.mcpgo.guideLink(button.dataset.guideLink).catch(e=>wizard.textContent=e.message);
$('wizard-back').onclick=()=>showWizardStep(wizardStep-1);
$('wizard-next').onclick=()=>showWizardStep(wizardStep+1);
$('wizard-create-mode').onclick=()=>wizardMode(false);
$('wizard-import-mode').onclick=()=>wizardMode(true);
showWizardStep(0,false);
async function wizardAction(fn){
 if(wizardBusy)return;
 wizardBusy=true;
 const controls=[...document.querySelectorAll('[data-wizard-page] button')];
 const prior=controls.map(button=>button.disabled);
 controls.forEach(button=>button.disabled=true);
 try{await fn()}catch(e){wizard.textContent=e.message}
 finally{wizardBusy=false;controls.forEach((button,i)=>button.disabled=prior[i]);if(lastOverview)syncWizardIds(lastOverview)}
}
$('wizard-import-tunnels').onclick=()=>wizardAction(async()=>{
 const terminalId=$('wizard-terminal-id').value.trim(),browserId=$('wizard-browser-id').value.trim();
 if(!window.confirm('Подключить два указанных Tunnel ID?'))return;
 await window.mcpgo.onboard('import',{terminalId,browserId,confirmed:true});
 $('terminal-id').value=terminalId;$('browser-id').value=browserId;
 wizard.textContent='Tunnel ID сохранены в мастере. Введи Runtime API Key.';
});
$('wizard-save-runtime').onclick=()=>wizardAction(async()=>{
 const terminalId=$('wizard-terminal-id').value.trim(),browserId=$('wizard-browser-id').value.trim();
 const key=$('wizard-runtime-key').value.trim();
 if(!key.startsWith('sk-'))throw Error('Введи действительный Runtime API Key.');
 if(terminalId===browserId)throw Error('Нужны два разных Tunnel ID.');
 if(!window.confirm('Сохранить указанные туннели и Runtime API Key?'))return;
 const current=await window.mcpgo.onboard('status',{});
 if(current.tunnels?.terminal?.id!==terminalId||current.tunnels?.browser?.id!==browserId)
  await window.mcpgo.onboard('import',{terminalId,browserId,confirmed:true});
 await window.mcpgo.onboard('verify-remote',{runtimeKey:key});
 const result=await window.mcpgo.save({terminal:{id:terminalId,key},browserTunnel:{id:browserId,key}});
 $('wizard-runtime-key').value='';$('admin-key').value='';
 $('terminal-id').value=terminalId;$('browser-id').value=browserId;
 render(result);wizard.textContent='Ключ сохранён.';showWizardStep(3,false);
});
$('wizard-start-services').onclick=()=>wizardAction(async()=>{
 const result=await window.mcpgo.restart();render(result);
 $('wizard-services-status').textContent='Запуск запрошен. Готовность проверяется отдельно.';
 showWizardStep(4,false);
});
$('wizard-install-extension').onclick=()=>window.mcpgo.extensionStore().catch(e=>wizard.textContent=e.message);
$('wizard-activate-extension').onclick=()=>wizardAction(async()=>{
 const token=$('wizard-extension-token').value.trim();
 if(!token&&!lastOverview?.playwrightExtension?.configured)throw Error('Вставь токен расширения.');
 if(token){const result=await window.mcpgo.save({browser:$('browser').value,playwrightExtension:{token}});$('wizard-extension-token').value='';render(result)}
 const result=await window.mcpgo.verifyConnection();render(result);
 $('wizard-browser-status').textContent=result.readiness?.chrome===true?'Доступ к вкладкам подтверждён.':'Доступ к вкладкам пока не подтверждён.';
 if(result.readiness?.chrome===true)showWizardStep(5,false);
});
async function wizardVerify(){
 const result=await window.mcpgo.verifyConnection();render(result);
 $('wizard-browser-status').textContent=result.readiness?.chrome===true?'Вкладки доступны.':'Доступ к вкладкам не подтверждён.';
 wizard.textContent='Проверка локального соединения выполнена. ChatGPT проверяется отдельно.';
}
$('wizard-verify-local').onclick=()=>wizardAction(wizardVerify);
$('wizard-final-local').onclick=()=>wizardAction(wizardVerify);
$('wizard-copy-terminal').onclick=()=>window.mcpgo.copyTunnel('terminal').then(()=>wizard.textContent='Tunnel ID скопирован.').catch(e=>wizard.textContent=e.message);
$('wizard-copy-browser').onclick=()=>window.mcpgo.copyTunnel('browser').then(()=>wizard.textContent='Tunnel ID скопирован.').catch(e=>wizard.textContent=e.message);
$('wizard-confirm-plugins').onclick=()=>wizardAction(async()=>{
 await window.mcpgo.onboard('chatgpt-instructions',{confirmed:true});
 wizard.textContent='Инструкция подтверждена. Выполни реальный тест из ChatGPT.';
 showWizardStep(6,false);
});
$('wizard-doctor').onclick=()=>wizardAction(async()=>{
 const result=await window.mcpgo.onboard('doctor',{});
 wizard.textContent=['Terminal: '+(result.checks?.terminal?.ready?'готов':result.checks?.terminal?.reason||'не подтверждён'),'Browser: '+(result.checks?.browser?.ready?'готов':result.checks?.browser?.reason||'не подтверждён'),result.note].join(' · ');
});
$('wizard-copy-test').onclick=()=>window.mcpgo.copyConnectionTest().then(()=>wizard.textContent='Вставь скопированный тест в нужный чат ChatGPT.').catch(e=>wizard.textContent=e.message);
$('wizard-dismiss').onclick=()=>wizardAction(async()=>{
 await window.mcpgo.onboard('dismiss',{confirmed:true});navigate('overview');
});
async function resumeWizard(){
 try{
  const data=await window.mcpgo.onboard('status',{});
  const current=await window.mcpgo.status();
  for(const [field,name] of [['terminal-id','terminal'],['browser-id','browser']]){
   const id=data.tunnels?.[name]?.id;
   if(id&&!$(field).value)$(field).value=id;
  }
  const key=data.runtimeProvision||{},saved=current.terminal?.configured&&current.browserTunnel?.configured;
  syncWizardIds(current);
  for(const name of ['terminal','browser']){
   const field=$('wizard-'+name+'-id');
   if(!field.value&&data.tunnels?.[name]?.id)field.value=data.tunnels[name].id;
  }
  if(!wizardTouched&&!data.wizardDismissed){
   if(saved){navigate('onboarding');showWizardStep(data.chatgptInstructionsViewed?6:current.playwrightExtension?.configured?5:4,false)}
   else if(data.tunnels?.terminal?.id&&data.tunnels?.browser?.id)showWizardStep(2,false);
  }
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
  const [preflight,connection,browser]=await Promise.all([
   window.mcpgo.onboard('connection-preflight',{}),window.mcpgo.verifyConnection(),window.mcpgo.onboard('browser-check',{browser:$('browser').value})]);
  $('wizard-browser-check').textContent=browser.message||browser.detail||'Проверка версии браузера выполнена.';
  render(connection);
  $('wizard-preflight').textContent=preflight.message+' '+(preflight.secureStorage?'Шифрование Windows доступно.':'Защищённое хранилище Windows недоступно.');
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
 if(wizardBusy)throw Error('Дождись завершения текущей операции.');
 wizardBusy=true;
 const buttons=[...document.querySelectorAll('[data-wizard-page] button')];
 const prior=buttons.map(b=>b.disabled);buttons.forEach(b=>b.disabled=true);
 try{return await window.mcpgo.onboard(action,data)}
 catch(e){wizard.textContent=e.message;throw e}
 finally{wizardBusy=false;buttons.forEach((b,i)=>b.disabled=prior[i]);if(lastOverview)syncWizardIds(lastOverview)}
}
$('wizard-discover').onclick=async()=>{
 if(!$('admin-key').value)return wizard.textContent='Введите ключ администратора';
 try{
  const result=await runWizard('discover',{adminKey:$('admin-key').value,organizationId:$('organization-id').value.trim(),workspaceId:$('workspace-id').value.trim()});
  const box=$('wizard-discovered');box.replaceChildren();box.hidden=false;
  if(!result.tunnels?.length){box.textContent='Туннели не найдены.';return}
  for(const tunnel of result.tunnels){
   const row=document.createElement('div');row.className='actions';
   const label=document.createElement('span');label.textContent=tunnel.name+' · '+tunnel.id;row.append(label);
   for(const service of ['terminal','browser']){
    const button=document.createElement('button');button.className='minor';button.type='button';button.textContent=service==='terminal'?'Для Terminal':'Для Browser';
    button.onclick=()=>{$('wizard-'+service+'-id').value=tunnel.id;wizard.textContent='Tunnel ID выбран. Подтверди импорт.'};row.append(button);
   }box.append(row);
  }
 }catch{}
};
$('wizard-load-projects').onclick=async()=>{
 if(!$('admin-key').value)return wizard.textContent='Введите ключ администратора';
 try{
  const result=await runWizard('runtime-projects',{adminKey:$('admin-key').value});
  const select=$('wizard-project');select.replaceChildren(new Option('Создать проект McpGo',''));
  for(const project of result.projects||[])select.append(new Option(project.name,project.id));
  wizard.textContent=result.projects?.length?'Выбери существующий проект или создай новый.':'Подходящих проектов не найдено.';
 }catch{}
};
$('create-tunnels').onclick=async()=>{
 if(!$('admin-key').value)return wizard.textContent='Введите ключ администратора';
 if(!$('organization-id').value.trim()&&!$('workspace-id').value.trim())
  return wizard.textContent='Укажите Organization ID либо Workspace ID';
 wizard.textContent='Создание туннелей...';
 try{
  if(!window.confirm('Создать два туннеля в указанной организации или workspace?'))return;
  const r=await runWizard('provision',{adminKey:$('admin-key').value,confirmed:true,
   organizationId:$('organization-id').value.trim(),workspaceId:$('workspace-id').value.trim()});
  $('terminal-id').value=r.tunnels.terminal;
  $('browser-id').value=r.tunnels.browser;
  $('wizard-terminal-id').value=r.tunnels.terminal;$('wizard-browser-id').value=r.tunnels.browser;
  wizard.textContent='Туннели созданы. Можно выдать Runtime Key.';
 }catch{}
};
$('create-runtime').onclick=async()=>{
 if(!$('admin-key').value)return wizard.textContent='Введите ключ администратора';
 wizard.textContent='Выпуск Runtime Key...';
 try{
  const projectId=$('wizard-project').value;
  if(!window.confirm(projectId?'Выпустить Runtime Key в выбранном проекте?':'Создать отдельный проект McpGo и выпустить Runtime Key?'))return;
  const outcome=await runWizard('runtime-auto',{adminKey:$('admin-key').value,confirmed:true,createProject:!projectId,projectId});
  $('admin-key').value='';
  const r=await window.mcpgo.status();
  $('terminal-id').value=r.terminal.id;$('browser-id').value=r.browserTunnel.id;
  render(r);wizard.textContent=outcome.remoteVerified?'Tunnel ID проверены. Ключ сохранён.':'Ключ сохранён. OpenAI пока не подтвердил Tunnel ID; проверь соединение.';showWizardStep(3,false);
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
  render(r);wizard.textContent='Новый ключ сохранён. Проверяем соединение.';showWizardStep(3,false);
 }catch{}
};
function element(tag,text){
 const node=document.createElement(tag);node.textContent=String(text);return node;
}
function item(title,lines,buttons=[],offsetEditor=null){
 const box=element('div','');box.className='item';box.append(element('strong',title));
 for(const line of lines)box.append(element('small',line));
 if(buttons.length){
  const bar=element('div','');bar.className='actions';
  for(const {label,run,danger=false} of buttons){
    const btn=element('button',label);btn.type='button';btn.className='minor';
    if(danger){btn.style.color='#ffb8bf';btn.style.borderColor='#a74c58';btn.style.background='rgba(130,42,54,.14)';}
   btn.onclick=run;bar.append(btn);
  }box.append(bar);
 }
 if(offsetEditor){
  const group=element('div','');group.className='group';group.dataset.offsetEditor='true';
  const label=element('label','Смещение, мин. (пусто — обычный интервал)');
  const input=element('input','');input.type='number';input.min='0';input.step='1';
  input.max=String(Math.floor((offsetEditor.interval-1)/60));input.value=offsetEditor.value;
  label.append(input);group.append(label);
  const save=element('button','Сохранить смещение');save.type='button';save.className='minor';
  save.onclick=()=>{if(input.checkValidity())offsetEditor.save(input.value===''?null:Number(input.value)*60);else input.reportValidity()};
  group.append(save);box.append(group);
 }
 return box;
}
const previewResults=new Map();
let taskRefreshRevision=0;
async function doTask(action,id,extra={}){
 if(action==='preview'){
  const pending={pending:true,targetUrl:extra.targetUrl};
  if(previewResults.get(id)?.pending)return;
  previewResults.set(id,pending);void refreshTasks();
  try{
   const result=await window.mcpgo.serviceAction('autosend','/api/tasks',{action,id});
   if(previewResults.get(id)===pending)previewResults.set(id,{...result,targetUrl:pending.targetUrl,checkedAt:result.checkedAt||new Date().toISOString()});
  }catch(e){
   if(previewResults.get(id)===pending)previewResults.set(id,{ready:false,reason:e.message,targetUrl:pending.targetUrl,checkedAt:new Date().toISOString()});
  }finally{await refreshTasks()}
  return;
 }
 previewResults.delete(id);
 try{
   const result=await window.mcpgo.serviceAction('autosend','/api/tasks',{...extra,action,id});
   await refreshTasks();
  $('autosend-feedback').textContent=
    action==='force_remove'?(result.pending?'Задание скрыто; удаление завершится после текущей проверки. Возможная отправка не отменяется.':'Расписание принудительно удалено. Диагностика сохранена. Возможная отправка не отменяется.'): 
    action==='confirm_received'?'Получение подтверждено. Расписание на паузе.':
   action==='set_interval_offset'?'Смещение сохранено; расписание осталось на паузе.':'';
 }catch(e){$('autosend-feedback').textContent=e.message;message(e.message,true)}
}
function autosendTabHealth(status,task){
 // A listening local MCP endpoint is not proof of an approved Chrome tab.
 if(status.browserBackendReachable===false)
  return 'AutoSend: локальный Playwright backend недоступен. Отправка без проверки вкладки запрещена.';
 if(status.browserBackendReachable!==true)
  return 'AutoSend: статус транспорта не подтверждён. Доступность Chrome не установлена.';
 if(task.browserConfirmed===true)
  return 'AutoSend: вкладка подтверждена в текущей сессии. Готовность ответа проверяется отдельно.';
 return 'AutoSend: локальный backend доступен; вкладка не подтверждена. Используйте «Проверить без отправки» для нужного чата.';
}
async function refreshTasks(){
 const list=$('tasks-list'),revision=++taskRefreshRevision;
 try{
  const status=await window.mcpgo.serviceRead('autosend','/api/status');
  const {tasks=[]}=status;
  if(revision!==taskRefreshRevision)return;
  list.replaceChildren();
  const ids=new Set(tasks.map(t=>t.id));
  for(const id of previewResults.keys())if(!ids.has(id))previewResults.delete(id);
  for(const t of tasks){
   const evidence=previewResults.get(t.id);
   const checked=evidence&&evidence.targetUrl===t.url?evidence:null;
   const pending=['sending','checking','verifying'].includes(t.status);
   const buttons=pending?[]:t.status==='unknown'?
     [{label:'Перепроверить доставку',run:()=>doTask('recheck_unknown',t.id)},
      {label:'Подтвердить получение',run:()=>{
       if(confirm('Вы лично проверили этот чат и увидели сообщение именно из последней попытки? Подтверждение не отправит сообщение и оставит расписание на паузе.'))doTask('confirm_received',t.id);
      }}]:
     t.enabled?[{label:'Пауза',run:()=>doTask('pause',t.id)}]:
     [{label:'Включить',run:()=>doTask('start',t.id)},
      {label:'Удалить',run:()=>{if(confirm('Удалить расписание?'))doTask('remove',t.id)}}];
    if(!pending&&!checked?.pending)buttons.push({label:'Проверить без отправки',run:()=>doTask('preview',t.id,{targetUrl:t.url})});
    // A first event-gated task cannot have a result before the first prompt.
    // The user must explicitly click; merely enabling the task never sends.
    if(t.enabled&&t.status==='scheduled'&&t.smart_v2===true&&t.smart_result_gate===true&&
       t.schedule_mode==='after_response'&&!t.smart_v2_last_action&&!t.smart_v2_pending_action&&
       !t.manual_once&&!t.verification&&!t.active_slot_id&&!t.next_at)
      buttons.push({label:'Запустить первый цикл',run:()=>doTask('send_once',t.id)});
    // Emergency removal is always visible, even for unknown/checking/sending/verifying.
    buttons.push({label:'Удалить принудительно',danger:true,run:()=>{
     if(confirm('Принудительно удалить это расписание AutoSend?\r\n\r\nУдаление не отменяет уже начатую возможную отправку. Данные о неопределённой доставке останутся в диагностическом журнале.\r\n\r\nУдалить расписание?'))
      void doTask('force_remove',t.id,{confirmed:true});
    }});
   const offsetEditor=t.status==='paused'&&!t.enabled&&!t.manual_once&&!t.verification&&!t.active_slot_id&&(t.schedule_mode||'interval')==='interval'?
    {interval:t.interval_seconds,value:t.interval_offset_seconds==null?'':String(t.interval_offset_seconds/60),
     save:value=>doTask('set_interval_offset',t.id,{interval_offset_seconds:value})}:null;
   list.append(item(t.url,[
    'Статус: '+t.status+'; '+(t.enabled?'Включено':'Выключено'),
    autosendTabHealth(status,t),
    String(t.message||'').slice(0,150),
    (t.schedule_mode==='after_response'?
     'Режим: по результату; '+(t.manual_once?'начальный запуск поставлен в очередь':
      !t.smart_v2_last_action?'ожидается первый запуск':'ожидается подтверждённый результат')+
      '; следующий запуск: '+(t.next_at?new Date(t.next_at).toLocaleString('ru-RU'):'после результата'):
     'Интервал: '+t.interval_seconds+' сек.; следующий: '+(t.next_at?new Date(t.next_at).toLocaleString('ru-RU'):'нет')),
    (t.schedule_mode==='after_response'?'':
     'Смещение: '+(t.interval_offset_seconds==null?'нет':t.interval_offset_seconds+' сек.')),
    'Последняя успешная доставка: '+(t.last_success_at?new Date(t.last_success_at).toLocaleString('ru-RU')+' (время подтверждения)':'нет'),
    t.last_error?'Причина остановки / последнее событие: '+t.last_error:'',
    checked?.pending?'Проверяем этот чат без отправки…':checked?
     'Последняя проверка ('+new Date(checked.checkedAt).toLocaleString('ru-RU')+'): '+
     (checked.ready?'готовность наблюдалась; ':'готовность не подтверждена; ')+String(checked.reason||'нет результата')+
     ' Это не разрешение на Send.':'',
    t.status==='unknown'?'Повторная отправка заблокирована. Подтвердите получение только после личной проверки чата.':'',
   ].filter(Boolean),buttons,offsetEditor));
  }
  if(!tasks.length)list.append(item('Расписания отсутствуют',[]));
 }catch(e){if(revision===taskRefreshRevision){list.replaceChildren();list.append(item('Планировщик недоступен',[e.message]))}}
}
$('refresh-tasks').onclick=refreshTasks;
$('task-create').onsubmit=async event=>{
 event.preventDefault();const btn=event.submitter;btn.disabled=true;
 try{
  await window.mcpgo.serviceAction('autosend','/api/tasks',{
   action:'create',url:$('task-url').value.trim(),message:$('task-message').value,
   interval_seconds:Number($('task-interval').value)*60,
   interval_offset_seconds:$('task-offset').value===''?null:Number($('task-offset').value)*60});
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
setInterval(()=>{if(!document.hidden){if(!document.activeElement?.closest('[data-offset-editor]'))void refreshTasks();void refreshAgents()}},15000);


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
 $('open-update').hidden=true;$('verify-update').hidden=true;
 try{
  const update=await window.mcpgo.checkUpdates();
  if(update.available){
   updatesStatus.textContent='Доступна версия '+update.version+
    '. Скачайте из Perebor/McpGo, затем проверьте SHA-256 файла по метаданным релиза.';
   const open=$('open-update');open.hidden=false;$('verify-update').hidden=false;
   open.onclick=()=>window.mcpgo.openUpdate(update.url).catch(e=>message(e.message,true));
  }else updatesStatus.textContent=(update.reason==='NO_RELEASES'?
   'В Perebor/McpGo ещё нет опубликованных Releases. CI-сборка не является релизом. ':
   'Новых проверяемых Windows Preview нет. ')+'Установлено: '+update.current;
 }catch(error){updatesStatus.textContent='Не удалось проверить обновления: '+error.message}
 finally{button.disabled=false}
};

$('verify-update').onclick=async()=>{
 const button=$('verify-update');button.disabled=true;
 try{
  const result=await window.mcpgo.verifyUpdate();
  updatesStatus.textContent=result.cancelled?'Проверка отменена.':
   'SHA-256 совпадает: '+result.sha256+'. Файл проверен на момент чтения. Установщик не подписан; установка только вручную.';
 }catch(error){updatesStatus.textContent='Проверка не пройдена. Не запускайте установщик: '+error.message}
 finally{button.disabled=false}
};
