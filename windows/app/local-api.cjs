'use strict';
const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const ROUTES={
 autosend:{port:8972,read:['/api/status'],write:['/api/tasks']},
 messaging:{port:8971,read:['/api/status','/api/agents','/api/history'],
   write:['/api/agents','/api/messages','/api/ack']}
};
function localRequest(service,route,body,userData){
 const target=ROUTES[service];
 if(!target)throw Error('UNKNOWN_LOCAL_SERVICE');
 const method=body===undefined?'GET':'POST';
 const allowed=body===undefined?target.read:target.write;
 if(!allowed.includes(route))throw Error('FORBIDDEN_LOCAL_ENDPOINT');
 const data=body===undefined?null:Buffer.from(JSON.stringify(body));
 let token=null;
 if(service==='autosend'||service==='messaging'){
  const code=service==='autosend'?'AUTOSEND_CONTROL_TOKEN_MISSING':'MESSAGING_CONTROL_TOKEN_MISSING';
  const file=path.join(userData||'',service==='autosend'?'AutoSend':'Messaging','control-token');
  try{
   if(!userData)throw Error(code);
   const stat=fs.lstatSync(file);
   if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==64)throw Error(code);
   token=fs.readFileSync(file,'utf8').trim();
  }catch{throw Error(code)}
  if(!/^[a-f0-9]{64}$/.test(token))throw Error(code);
 }
 if(data?.length>26000)throw Error('REQUEST_TOO_LARGE');
 return new Promise((resolve,reject)=>{
  const req=http.request({host:'127.0.0.1',port:target.port,path:route,
   method,timeout:10000,headers:{
    'Host':'127.0.0.1:'+target.port,'X-MCPHub-Client':'native',
    ...(token?{'X-MCPHub-Token':token}:{}),
    'Accept':'application/json',...(data?{
    'Content-Type':'application/json','Content-Length':data.length}:{}),
    }},res=>{
    let bytes=0,parts=[];
    res.on('data',value=>{bytes+=value.length;
      if(bytes>1024*1024){req.destroy(Error('RESPONSE_TOO_LARGE'));return}
      parts.push(value);
    });
    res.on('end',()=>{try{
      const value=JSON.parse(Buffer.concat(parts).toString('utf8'));
      if(res.statusCode<200||res.statusCode>=300)
        return reject(Error(String(value.error||'LOCAL_API_ERROR').slice(0,180)));
      resolve(value);
    }catch(error){reject(error)}});
   });
  req.on('error',reject);
  req.on('timeout',()=>req.destroy(Error('LOCAL_API_TIMEOUT')));
  req.end(data);
 });
}
module.exports={localRequest};
