import net from 'node:net';

/**
 * Passive local port probe: NEVER asks Playwright to list tools/tabs, which
 * would attach the Chrome Extension and create connect.html prompts/groups.
 * Connected means that the dedicated backend accepts TCP, NOT that a tab
 * has been approved. The real read-only preview checks the tab independently.
 */
export async function probeBrowserHealth({host='127.0.0.1',port=Number(process.env.MCPHUB_AUTOSEND_BROWSER_PORT||8932),
 timeoutMs=1500}={}){
 if(host!=='127.0.0.1'||!Number.isInteger(port)||port<1024||port>65535)
  throw Error('AutoSend health check must be loopback only');
 return new Promise(resolve=>{
  let settled=false;
  const socket=net.connect({host,port});
  const done=(connected)=>{
   if(settled)return;
   settled=true;socket.destroy();
   resolve({connected,reason:connected?'':'Отдельный Playwright Extension backend AutoSend не запущен'});
  };
  socket.on('connect',()=>done(true));
  socket.on('error',()=>done(false));
  socket.setTimeout(timeoutMs,()=>done(false));
 });
}
