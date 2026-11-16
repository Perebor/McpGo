/**
 * Page-local ChatGPT stream monitor. Serialized by browser_evaluate.
 * No prompts, response text, cookies or SSE payloads are persisted.
 * The undocumented stream_status endpoint is only a best-effort server signal.
 */
export async function probeStreamInPage(){
 const conversationId=location.pathname.match(/\/c\/([0-9a-f-]{36})(?:\/|$)/i)?.[1];
 if(!conversationId)return {streamStatus:'UNKNOWN',streamReason:'NO_CONVERSATION'};
 // Test harnesses and unsupported embedded pages retain conservative DOM logic.
 if(typeof window==='undefined'||typeof window.fetch!=='function')return {};
 let mon=window.__mcpgoAutoSendStream;
 if(!mon){
  mon={active:false,phase:'unseen',sequence:0,lastEventAt:null,lastStartAt:null,
   lastFinishedAt:null,lastDisconnectAt:null,streamsSeen:0};
  window.__mcpgoAutoSendStream=mon;
 }
 if(!mon.hook||window.fetch!==mon.hook){
  const original=window.fetch;
  const monitored=function(...args){
   const url=typeof args[0]==='string'?args[0]:args[0]?.url;
   const method=String(args[1]?.method||args[0]?.method||'GET').toUpperCase();
   let shouldWatch=false;
   try{
    const parsed=new URL(url,location.href);
    shouldWatch=parsed.origin===location.origin&&method==='POST'&&
     /^\/backend-api\/(?:f\/)?conversation(?:\/resume)?\/?$/.test(parsed.pathname);
   }catch{}
   const pending=original.apply(this,args);
   if(shouldWatch){
    Promise.resolve(pending).then(async response=>{
     if(!response?.body||!String(response.headers?.get('content-type')||'').includes('text/event-stream'))return;
     const number=++mon.streamsSeen;
     mon.active=true;mon.phase='streaming';mon.lastStartAt=Date.now();mon.sequence++;
     mon.lastEventAt=Date.now();
     let terminal=false;
     const terminalOp=function(node){
      if(!node||typeof node!=='object')return false;
      if(Array.isArray(node))return node.some(terminalOp);
      if(node.message?.end_turn===true||node.end_turn===true)return true;
      if(node.o==='patch'&&Array.isArray(node.v))return node.v.some(terminalOp);
      if(typeof node.p==='string'){
       if(/\/end_turn$/.test(node.p)&&node.v===true)return true;
       if(/\/finish_details(?:\/|$)/.test(node.p)&&node.v!=null)return true;
      }
      return false;
     };
     function event(raw){
      const data=raw.split(/\r?\n/).filter(x=>x.startsWith('data:'))
       .map(x=>x.slice(5).trimStart()).join('\n');
      if(!data)return;
      mon.sequence++;mon.lastEventAt=Date.now();
      if(data==='[DONE]')return;
      if(data.length>1000000||!/(?:end_turn|finish_details)/.test(data))return;
      try{if(terminalOp(JSON.parse(data)))terminal=true;}catch{}
     }
     let reader=null;
     try{
      reader=response.clone().body.getReader();
      const decoder=new TextDecoder();
      let buffer='';
      while(true){
       const {value,done}=await reader.read();
       if(done)break;
       buffer+=decoder.decode(value,{stream:true});
       const frames=buffer.split(/\r?\n\r?\n/);
       buffer=frames.pop()||'';
       if(buffer.length>2000000)buffer='';
       for(const frame of frames)event(frame);
      }
      if(buffer.trim())event(buffer);
     }catch{}
     finally{
      try{reader?.releaseLock();}catch{}
      if(mon.streamsSeen===number){
       mon.active=false;
       mon.phase=terminal?'finished':'disconnected';
       if(terminal)mon.lastFinishedAt=Date.now();
       else mon.lastDisconnectAt=Date.now();
       mon.sequence++;
      }
     }
    }).catch(()=>{mon.lastDisconnectAt=Date.now();mon.phase='disconnected';mon.active=false;mon.sequence++;});
   }
   return pending;
  };
  mon.hook=monitored;
  window.fetch=monitored;
 }
 let streamStatus='UNKNOWN',streamReason='UNAVAILABLE';
 try{
  const ctl=new AbortController();
  const timer=setTimeout(()=>ctl.abort(),3500);
  try{
   const response=await window.fetch(
    '/backend-api/conversation/'+encodeURIComponent(conversationId)+'/stream_status',
    {method:'GET',credentials:'same-origin',cache:'no-store',signal:ctl.signal});
   if(response.ok){
    const value=await response.json();
    if(value?.status==='IS_STREAMING'||value?.status==='COMPLETE'){
     streamStatus=value.status;streamReason='SERVER';
    }else streamReason='UNKNOWN_SERVER_STATUS';
   }else streamReason='HTTP_'+response.status;
  }finally{clearTimeout(timer);}
 }catch{streamReason='NETWORK_ERROR';}
 return {streamStatus,streamReason,streamPhase:mon.phase,streamActive:mon.active,
  streamSequence:mon.sequence,streamLastEventAt:mon.lastEventAt,
  streamLastFinishedAt:mon.lastFinishedAt,streamLastDisconnectAt:mon.lastDisconnectAt};
}
export function streamBusy(page,now=Date.now()){
 return page?.streamStatus==='IS_STREAMING'||
  (page?.streamStatus==='COMPLETE'&&page?.streamActive===true&&
   Number.isFinite(page.streamLastEventAt)&&now-page.streamLastEventAt<5000);
}
export function streamReady(page,now=Date.now()){
 return page?.streamStatus==='COMPLETE'&&!streamBusy(page,now);
}
