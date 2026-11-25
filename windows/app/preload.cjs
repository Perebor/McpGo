'use strict';
const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('mcpgo',Object.freeze({
 status:()=>ipcRenderer.invoke('mcpgo:status'),
 save:data=>ipcRenderer.invoke('mcpgo:save',data),
 restart:()=>ipcRenderer.invoke('mcpgo:restart'),
 checkUpdates:()=>ipcRenderer.invoke('mcpgo:check-updates'),
 verifyUpdate:()=>ipcRenderer.invoke('mcpgo:verify-update'),
 openUpdate:url=>ipcRenderer.invoke('mcpgo:open-update',url),
 openReleases:()=>ipcRenderer.invoke('mcpgo:open-releases'),
 openLocation:kind=>ipcRenderer.invoke('mcpgo:open-location',kind),
 skillRead:id=>ipcRenderer.invoke('mcpgo:skill-read',id),
 skillCopy:(id,mode)=>ipcRenderer.invoke('mcpgo:skill-copy',id,mode),
 skillOpen:id=>ipcRenderer.invoke('mcpgo:skill-open',id),
 extensionStore:()=>ipcRenderer.invoke('mcpgo:extension-store'),
 browserUpdate:browser=>ipcRenderer.invoke('mcpgo:browser-update',browser),
 serviceRead:(service,route)=>ipcRenderer.invoke('mcpgo:service-read',service,route),
 serviceAction:(service,route,body)=>ipcRenderer.invoke('mcpgo:service-action',service,route,body),
 copyConnectionTest:()=>ipcRenderer.invoke('mcpgo:copy-connection-test'),
 verifyConnection:()=>ipcRenderer.invoke('mcpgo:verify-connection'),
 recoverTunnel:name=>ipcRenderer.invoke('mcpgo:recover-tunnel',name),
 guideLink:kind=>ipcRenderer.invoke('mcpgo:guide-link',kind),
 copyTunnel:name=>ipcRenderer.invoke('mcpgo:copy-tunnel',name),
 onboard:(action,payload)=>ipcRenderer.invoke('mcpgo:onboard',action,payload),
 exportDiagnostics:()=>ipcRenderer.invoke('mcpgo:export-diagnostics'),
 onStatus:callback=>{
  if(typeof callback!=='function')return;
  const listener=(_event,data)=>callback(data);
  ipcRenderer.on('mcpgo:status',listener);
  return ()=>ipcRenderer.removeListener('mcpgo:status',listener);
 }
}));
