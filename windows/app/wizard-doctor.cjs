'use strict';
const {execFile}=require('node:child_process');
const {assertTunnelId}=require('./runtime.cjs');
async function checkTunnelDoctor({client,credential,url},execute=execFile){
 if(!credential?.key)return {ready:false,reason:'Runtime Key отсутствует.'};
 const id=assertTunnelId(credential.id);
 if(!/^http:\/\/127\.0\.0\.1:(12848|8940)\/(?:mcp|exec\/[a-f0-9]{64})$/.test(url))throw Error('INVALID_LOCAL_MCP_URL');
 // Never put the secret in argv or return unredacted subprocess output.
 const env={...process.env,CONTROL_PLANE_API_KEY:credential.key};
 delete env.OPENAI_ADMIN_KEY;
 const args=['doctor','--control-plane.tunnel-id',id,'--control-plane.api-key','env:CONTROL_PLANE_API_KEY','--mcp.server-url',url,'--explain','--json'];
 return new Promise(resolve=>execute(client,args,{env,timeout:25000,windowsHide:true,maxBuffer:262144},error=>
  resolve(error?{ready:false,reason:'Doctor не подтвердил готовность; проверь ключ, сеть и локальный MCP.'}:{ready:true})));
}
module.exports={checkTunnelDoctor};
