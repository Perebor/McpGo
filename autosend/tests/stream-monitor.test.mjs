import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {probeStreamInPage,streamBusy,streamReady} from '../stream-monitor.mjs';
import {classifyChatState,sameReadySnapshot} from '../chat-state.mjs';
import {buildGuardedClick} from '../guarded-send.mjs';
import {SimulatedChat} from '../simulated-browser.mjs';

const chatUrl='https://chatgpt.com/c/00000000-0000-4000-8000-000000000001';
const makeContext=(server='COMPLETE')=>{
 const window={};
 const seen=[];
 const state={server};
 window.fetch=async (url,options={})=>{
  seen.push({url,method:options.method||'GET'});
  if(String(url).endsWith('/stream_status'))
   return {ok:true,json:async()=>({status:state.server})};
  if(String(url).endsWith('/resume') || String(url).endsWith('/conversation')){
   const chunk=state.frame||'data: {"p":"/message/content/parts/0","o":"append","v":"partial"}\n\n';
   return new Response(new ReadableStream({
    start(ctrl){ctrl.enqueue(new TextEncoder().encode(chunk));ctrl.close();}
   }),{headers:{'content-type':'text/event-stream'}});
  }
  return {ok:false,status:404};
 };
 return {window,seen,state,ctx:vm.createContext({
  window,location:new URL(chatUrl),URL,Response,ReadableStream,TextDecoder,
  AbortController,setTimeout,clearTimeout,Date,Promise,TextEncoder,encodeURIComponent
 })};
};
const probe=ctx=>vm.runInContext('('+probeStreamInPage.toString()+')()',ctx);
const next=()=>new Promise(resolve=>setTimeout(resolve,10));

test('server IS_STREAMING beats missing DOM Stop; unknown status blocks Send',()=>{
 const base={url:chatUrl,ready:'complete',editorCount:1,sendCount:1,
  editorSelector:'#prompt-textarea',mainLength:800,turnCount:5,genericTitle:false,
  editorText:'',stop:false,busyText:false};
 assert.equal(classifyChatState({...base,streamStatus:'IS_STREAMING'},chatUrl).kind,'busy');
 assert.equal(classifyChatState({...base,streamStatus:'UNKNOWN'},chatUrl).kind,'deferred');
 assert.equal(classifyChatState({...base,streamStatus:'COMPLETE',stop:true},chatUrl).kind,'ready');
 assert.equal(streamReady({streamStatus:'COMPLETE'}),true);
 assert.equal(streamBusy({streamStatus:'COMPLETE',streamActive:true,streamLastEventAt:Date.now()}),true);
 assert.equal(classifyChatState({...base,streamStatus:'COMPLETE',streamActive:true,streamLastEventAt:Date.now()},chatUrl).kind,'busy');
 assert.equal(sameReadySnapshot({...base,streamStatus:'COMPLETE',streamSequence:3,userCount:1},
  {...base,streamStatus:'COMPLETE',streamSequence:4,userCount:1}),false);
});

test('page monitor sees resume SSE and never treats transport closure as successful turn',async()=>{
 const {window,ctx}=makeContext();
 assert.equal((await probe(ctx)).streamStatus,'COMPLETE');
 const originalHook=window.fetch;
 await window.fetch('/backend-api/f/conversation/resume',{method:'POST'});
 await next();
 const after=await probe(ctx);
 assert.equal(after.streamPhase,'disconnected');
 assert.equal(after.streamActive,false);
 assert.ok(after.streamSequence>0);
 assert.equal(after.streamLastFinishedAt,null);
 assert.equal(window.fetch,originalHook,'hook installed once, not repeatedly');
});

test('explicit assistant end_turn is recognized, including patch array',async()=>{
 const {window,ctx,state}=makeContext('IS_STREAMING');
 await probe(ctx);
 state.frame='data: {"o":"patch","v":[{"p":"/message/end_turn","o":"replace","v":true}]}\n\n';
 await window.fetch('/backend-api/conversation',{method:'POST'});
 await next();
 const after=await probe(ctx);
 assert.equal(after.streamStatus,'IS_STREAMING','server is separate authority');
 assert.equal(after.streamPhase,'finished');
 assert.ok(after.streamLastFinishedAt);
});

test('guarded Send rechecks server status immediately before click',async()=>{
 const config={url:chatUrl,message:'TEST MESSAGE 1',editorSelector:'#prompt-textarea',
  sendSelector:'[data-testid="send-button"]',baselineUserCount:1,assistantRevision:null,
  actionId:'autosend:00000000-0000-4000-8000-000000000001',requireStreamStatus:true};
 const page=new SimulatedChat(chatUrl);
 page.editorText='TEST MESSAGE 1';
 page.send.disabled=false;
 page.context.AbortController=AbortController;
 page.context.window.fetch=async()=>({ok:true,json:async()=>({status:'IS_STREAMING'})});
 page.context.fetch=page.context.window.fetch;
 const source=buildGuardedClick(config);
 assert.match(source,/stream_status/);
 const blocked=await page.evaluate(source);
 assert.equal(blocked.code,'GENERATION_ACTIVE');
 assert.equal(page.clicks,0);
 page.context.window.fetch=async()=>({ok:true,json:async()=>({status:'COMPLETE'})});
 page.context.fetch=page.context.window.fetch;
 const accepted=await page.evaluate(source);
 assert.equal(accepted.code,'CLICK_DISPATCHED');
 assert.equal(page.clicks,1);
});

test('server request failure refuses guarded click without clicking',async()=>{
 const page=new SimulatedChat(chatUrl);
 page.editorText='TEST MESSAGE 1';
 page.send.disabled=false;
 page.context.AbortController=AbortController;
 page.context.window.fetch=async()=>{throw Error('offline');};
 page.context.fetch=page.context.window.fetch;
 const source=buildGuardedClick({url:chatUrl,message:'TEST MESSAGE 1',
  editorSelector:'#prompt-textarea',sendSelector:'[data-testid="send-button"]',
  baselineUserCount:1,assistantRevision:null,requireStreamStatus:true,
  actionId:'autosend:00000000-0000-4000-8000-000000000002'});
 const result=await page.evaluate(source);
 assert.equal(result.code,'STREAM_STATUS_UNAVAILABLE');
 assert.equal(page.clicks,0);
});
