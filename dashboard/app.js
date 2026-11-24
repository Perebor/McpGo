'use strict';
let working=false;
let last=null;
const $=id=>document.getElementById(id);
const mark=(id,on,label,warn=false)=>{const el=$(id); el.className='dotline'+(on?' on':warn?' warn':'');el.textContent=label;};
function render(data){
  last=data;
  const t=data.terminal,p=data.playwright;
  const rec=data.recovery||{};
  const textFor={CONNECTED:'Туннель готов',DEGRADED:'Подключение не готово',
    RECOVERING:'Восстановление соединения',OFFLINE:'Локальный MCP недоступен',
    AUTH_REQUIRED:'Нужна авторизация',NEEDS_ATTENTION:'Нужна проверка',
    STOPPED_BY_USER:'Процесс запускается вручную',
    UNMONITORED:'Мониторинг после следующего запуска',CHECKING:'Проверка подключения'};
  const tunnelLabel=(target,running)=>!running?'Не запущен':
    textFor[rec[target]?.status]||'Процесс запущен';

  const h=data.connectionHealth||{},fresh=c=>Number.isFinite(c?.checkedAt)&&Date.now()>=c.checkedAt&&Date.now()-c.checkedAt<=30000;
  const terminalOn=fresh(h.terminal)&&h.terminal.state==='ready';
  const browserOn=fresh(h.browser)&&h.browser.state==='ready'&&Date.now()-h.browser.lastBrowserAt<=300000;
  for(const [group,on,any] of [['terminal',terminalOn,t.oneshot.running||t.tunnel.running],['playwright',browserOn,p.browser.running||p.proxy.running||p.tunnel.running]]){
    const el=$(group+'-state'); el.textContent=on?'Локально готов':any?'Не подтверждён':'Остановлен';el.className='state'+(on?' on':any?' partial':'');
    const block=document.querySelector('[data-group="'+group+'"]');
    for(const btn of block.querySelectorAll('[data-action]'))btn.disabled=working||data.busy||(btn.dataset.action==='start'&&on)||(btn.dataset.action==='stop'&&!any)||(btn.dataset.action==='restart'&&!any);
  }
  mark('terminal-oneshot',fresh(h.terminal)&&h.terminal.mcp,fresh(h.terminal)&&h.terminal.mcp?'MCP готов':'MCP не подтверждён');
  mark('terminal-tunnel',fresh(h.terminal)&&h.terminal.tunnel==='ready',
    fresh(h.terminal)?(h.terminal.tunnel==='ready'?'Туннель готов':h.terminal.reason||h.terminal.tunnel):'Нет актуальной проверки',t.tunnel.running&&rec.terminal?.status==='NEEDS_ATTENTION');
  mark('playwright-browser',fresh(h.browser)&&h.browser.browser==='ready'&&Date.now()-h.browser.lastBrowserAt<=300000,h.browser?.browser==='failed'?'Нет связи с расширением':browserOn?'Подключено':'Не подтверждено',p.browser.running&&!browserOn);
  const chromeState=p.browserSession?.browser || 'unknown';
  const chromeDetail=chromeState==='connected'?'Chrome подключён':
    chromeState==='degraded'?'Chrome: требуется восстановление':
    chromeState==='connecting'?'Chrome: подключение':
    chromeState==='recovering'?'Chrome: восстановление':'Chrome ещё не проверен';
  mark('playwright-proxy',fresh(h.browser)&&h.browser.mcp,
    p.proxyReady?(fresh(h.browser)&&h.browser.mcp?'MCP готов · '+chromeDetail:'MCP не подтверждён'):'Не запущен',
    p.proxy.running&&(p.mcpReady!==true||chromeState==='degraded'));
  mark('playwright-tunnel',fresh(h.browser)&&h.browser.tunnel==='ready',
    p.configured?(fresh(h.browser)?(h.browser.tunnel==='ready'?'Туннель готов':h.browser.reason||h.browser.tunnel):'Нет актуальной проверки'):'Не настроен',
    !p.configured||rec.playwright?.status==='NEEDS_ATTENTION');
  $('playwright-hint').textContent=p.extension && !p.extension.configured? 'Chrome Extension: '+p.extension.code+' — восстановите подключение в мастере McpGo.':!p.configured?
    'Для туннеля не хватает сохранённой конфигурации. Подробности в README.':
    rec.playwright?.desired?
    'Автовосстановление туннеля включено. Chrome, активные задачи и действия не перезапускаются.':
    'Нажмите «Запустить», чтобы включить автоматический контроль туннеля после успешного запуска.';
  $('updated').textContent='Статус: '+new Date(data.updatedAt).toLocaleTimeString('ru-RU');
}
let refreshing=false;
async function refresh(){
 if(refreshing)return;refreshing=true;
 try{const response=await fetch('/api/status',{cache:'no-store',signal:AbortSignal.timeout(5000)});if(!response.ok)throw Error('Ошибка связи с панелью');render(await response.json());}
 catch(e){last=null;for(const el of document.querySelectorAll('.state,.dotline')){el.className=el.classList.contains('state')?'state partial':'dotline warn';el.textContent='Статус неизвестен'}flash(e.message,true);}
 finally{refreshing=false}
}
let noticeTimeout;
function flash(msg,error=false){const n=$('notice');n.textContent=msg;n.className='notice'+(error?' error':'');n.hidden=false;clearTimeout(noticeTimeout);noticeTimeout=setTimeout(()=>n.hidden=true,error?9000:3500);}
async function act(group,action){if(working)return;working=true;if(last)render(last);
  try{const response=await fetch('/api/action',{method:'POST',headers:{'content-type':'application/json','x-mcp-hub':'dashboard'},body:JSON.stringify({group,action})});const obj=await response.json();if(!response.ok)throw Error(obj.error||'Действие не выполнено');if(obj.status)render(obj.status);flash(action==='start'?'Запуск выполнен':action==='stop'?'Остановлено':action==='restart'?'Перезапущено':'Открыто');}
  catch(e){flash(e.message,true);}finally{working=false;await refresh();}
}
document.querySelectorAll('.service').forEach(el=>el.querySelectorAll('button[data-action]').forEach(btn=>btn.addEventListener('click',()=>act(el.dataset.group,btn.dataset.action))));
$('refresh').addEventListener('click',refresh);$('folder').addEventListener('click',()=>act('system','folder'));$('logs').addEventListener('click',()=>act('system','logs'));
$('verify-connection').onclick=()=>act('system','verify-connection');
refresh();setInterval(()=>{if(last)render(last);},1000);setInterval(()=>{if(!working)refresh();},3500);
