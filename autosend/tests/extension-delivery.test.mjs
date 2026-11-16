import {test} from 'node:test';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {classifyAgent,parsePageResult,extractTabs,pageInspection,deliverViaPlaywright,preClickIssue,classifyPreflightError,confirmsNewUserMessage} from '../delivery.mjs';
import {sameReadySnapshot,classifyChatState} from '../chat-state.mjs';
const url='https://chatgpt.com/c/00000000-0000-4000-8000-000000000001';
const task={url,message:'Test scheduler CDP'};
const page={url,ready:'complete',editorCount:1,editorText:'',editorSelector:'#prompt-textarea',
 sendCount:1,sendSelector:'[data-testid="send-button"]',sendEnabled:false,turnCount:5,genericTitle:false,stop:false,busyText:false,userCount:5,assistantCount:5,
 lastUserText:'Old',mainLength:1250,title:'Previous Chat',login:false};
function fake(initial={}){
 const calls=[];const state={...page,...initial};let committed=false;
 const client={async tool(name,args){
  calls.push({name,args});
  if(name==='browser_tabs' && args.action==='new')return '### Result\n- 9: '+url;
  if(name==='browser_tabs' && args.action==='list')return '- 9: '+url;
  if(name==='browser_tabs' && args.action==='select')return 'selected';
  if(name==='browser_tabs' && args.action==='close')return 'closed';
  if(name==='browser_evaluate' && args.function.includes('function guardedClickInPage')){
   assert.equal(committed,true,'operation must be persisted before the click');
   assert.equal(args.function.includes('send.click()'),true);
   if(state.stop||state.busyText)return '### Result\n'+JSON.stringify({status:'refused',code:'GENERATION_ACTIVE'});
   state.userCount++;state.lastUserText=task.message;
   return '### Result\n'+JSON.stringify({status:'clicked',code:'CLICK_DISPATCHED'});
  }
  if(name==='browser_evaluate')return '### Result\n```json\n'+JSON.stringify(state)+'\n```';
  if(name==='browser_type'){state.editorText=args.text;state.sendEnabled=!!args.text;return 'typed';}
  if(name==='browser_click')throw Error('Standalone browser_click must never be used for AutoSend');
  throw Error('unexpected '+name);
 }};
 return {client,calls,state,commit:()=>{committed=true;return 'autosend:00000000-0000-4000-8000-000000000001';}};
}
test('readiness fails closed for busy agent, draft, wrong conversation and ambiguous page',()=>{
 for (const p of [{stop:true},{busyText:true},{editorText:'human draft'}])assert.equal(classifyAgent({...page,...p},url).kind,'busy');
 for (const p of [{url:'https://chatgpt.com/'},{editorCount:0},{mainLength:5,turnCount:0},{genericTitle:true},{login:true}])assert.equal(classifyAgent({...page,...p},url).kind,'deferred');
 assert.equal(classifyAgent(page,url).kind,'ready');
});
test('CDP browser tab indexes are parsed conservatively',()=>{
 assert.deepEqual(extractTabs('### Result\n- 2: Chat (https://chatgpt.com/c/aaa)\n3: cloud (https://console.cloud.ru/)'),[{index:2,url:'https://chatgpt.com/c/aaa'},{index:3,url:'https://console.cloud.ru'}]);
});
test('Playwright extension tab listing parses Markdown titles and ignores extension connection page',()=>{
 const listed='### Result\n- 0: (current) [Welcome](chrome-extension://extension-id/connect.html)\n- 2: [ChatGPT](https://chatgpt.com/c/aaa)';
 assert.deepEqual(extractTabs(listed),[{index:2,url:'https://chatgpt.com/c/aaa'}]);
});
test('scheduler skips missing conversation without creating tabs or typing',async()=>{
 const f=fake(),original=f.client.tool;
 f.client.tool=async(name,args)=>{
  if(name==='browser_tabs'&&args.action==='list'){
   f.calls.push({name,args});
   return '### Result\n- 0: (current) [Welcome](chrome-extension://extension-id/connect.html)';
  }
  return original(name,args);
 };
 const result=await deliverViaPlaywright(task,()=>{throw Error('no claim')},
  {client:f.client,wait:async()=>{}});
 assert.equal(result.status,'deferred');
 assert.equal(result.evidence.code,'CHAT_TAB_MISSING');
 assert.ok(!f.calls.some(c=>c.name==='browser_tabs'&&c.args.action==='new'));
 assert.ok(!f.calls.some(c=>c.name==='browser_type'||c.name==='browser_evaluate'));
});
test('scheduler refuses ambiguous matching tabs in the same extension group',async()=>{
 const f=fake(),original=f.client.tool;
 f.client.tool=async(name,args)=>{
  if(name==='browser_tabs'&&args.action==='list'){
   f.calls.push({name,args});
   return '### Result\n- 0: [Chat A]('+url+')\n- 1: [Chat B]('+url+')';
  }
  return original(name,args);
 };
 const result=await deliverViaPlaywright(task,()=>{throw Error('no claim')},
  {client:f.client,wait:async()=>{}});
 assert.equal(result.status,'deferred');
 assert.equal(result.evidence.code,'AMBIGUOUS_CHAT_TABS');
 assert.ok(!f.calls.some(c=>c.name==='browser_tabs'&&c.args.action==='new'));
 assert.ok(!f.calls.some(c=>c.name==='browser_type'||c.name==='browser_evaluate'));
});
test('browser_tabs parser reads only the Result, not repeated tab lists',()=>{
 assert.deepEqual(extractTabs('### Result\n- 0: [Chat]('+url+')\n### Open tabs\n- 0: [Chat]('+url+')'),
  [{index:0,url}]);
});
test('MCP results parse fenced and plain JSON',()=>{
 assert.equal(parsePageResult('### Result\n```json\n{"stop":true}\n```').stop,true);
 assert.equal(parsePageResult('### Result\n{"stop":false}').stop,false);
});
test('MCP result parser ignores echoed Playwright JavaScript with braces',()=>{
 const response = [
  '### Result',
  JSON.stringify({stop:false,title:'quoted "brace}"'}),
  '### Ran Playwright code',
  '```js',
  "await page.evaluate('() => { const x = {stop: true}; return x; }');",
  '```',
 ].join('\n');
 const obj=parsePageResult(response);
 assert.equal(obj.stop,false);
 assert.ok(obj.title.includes('brace}'));
});
test('MCP result parser rejects invalid JSON instead of parsing echoed source',()=>{
 const response=['### Result','{stop:false}','### Ran Playwright code','```js','({stop:true})','```'].join('\n');
 assert.throws(()=>parsePageResult(response),/некорректный JSON/);
});
test('extension proxy queue saturation yields recoverable preflight error without sending',async()=>{
 const f=fake();
 f.client.tool=async()=>{throw Error('Playwright MCP HTTP 429: Browser action queue full')};
 const result=await deliverViaPlaywright(task,()=>{throw Error('must not click')},{client:f.client});
 assert.equal(result.status,'deferred');
 assert.equal(result.reason,'transport_busy');
 assert.equal(result.evidence.clickCommitted,false);
 assert.equal(result.evidence.code,'BROWSER_QUEUE_BUSY');
});
test('busy chat never types or clicks and skips current slot',async()=>{
 const f=fake({stop:true});const result=await deliverViaPlaywright(task,()=>{throw Error('must not click')},{client:f.client});
 assert.equal(result.status,'deferred');assert.equal(result.reason,'busy');
 assert.ok(!f.calls.some(c=>c.name==='browser_type'||c.name==='browser_click'));
});
test('wrong destination never types or clicks',async()=>{
 const f=fake({url:'https://chatgpt.com/c/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'});
 const result=await deliverViaPlaywright(task,()=>{throw Error('must not click')},{client:f.client});
 assert.equal(result.status,'deferred');
 assert.ok(!f.calls.some(c=>c.name==='browser_click'));
});
test('successful send persists before click and verifies new user message',async()=>{
 const f=fake();let persisted=false;
 const result=await deliverViaPlaywright(task,async()=>{persisted=true;return f.commit();},{client:f.client});
 assert.equal(result.status,'verified');assert.ok(persisted);
 assert.equal(f.calls.filter(x=>x.name==='browser_evaluate'&&x.args.function.includes('function guardedClickInPage')).length,1);
 assert.equal(f.calls.filter(x=>x.name==='browser_click').length,0);

 assert.equal(f.calls.filter(x=>x.name==='browser_type').length,1);
 assert.ok(!f.calls.some(x=>x.name==='browser_tabs' && x.args.action==='new'),'reuse opened personal Chrome tab');
});
test('failure before click does not send or commit, and clears own draft',async()=>{
 const f=fake();const original=f.client.tool;
 f.client.tool=async(name,args)=>{
  if(name==='browser_evaluate' && f.calls.some(x=>x.name==='browser_type'))f.state.stop=true;
  return original(name,args);
 };
 const result=await deliverViaPlaywright(task,()=>{throw Error('must not click')},{client:f.client});
 assert.equal(result.status,'deferred');assert.ok(!f.calls.some(x=>x.name==='browser_click'));
});

test('browser evaluation source parses as a real JavaScript function',()=>{
 assert.equal(typeof Function('return ('+pageInspection+')')(),'function');
});

test('current ChatGPT user bubbles are counted without legacy author attributes',()=>{
 const userBubbles=['Earlier message','Test scheduler CDP'].map(innerText=>({innerText}));
 const document={
  readyState:'complete',
  title:'A real conversation',
  querySelectorAll(selector){
   if(selector==='[class~="bg-user-message"]')return userBubbles;
   return [];
  },
  querySelector(selector){
   if(selector==='main')return {innerText:'Long conversation history with multiple messages and an editor on this page.'};
   return null;
  },
 };
 const location={origin:'https://chatgpt.com',pathname:'/c/00000000-0000-4000-8000-000000000001'};
 const result=vm.runInNewContext('('+pageInspection+')()', {document,location});
 assert.equal(result.userCount,2);
 assert.equal(result.lastUserText,'Test scheduler CDP');
 assert.equal(result.turnCount,0,'the modern DOM may have no conversation-turn nodes');
});

test('strict acknowledgement requires a new actual user bubble with exact text',()=>{
 const old={userCount:4,mainOccurrences:3};
 assert.equal(confirmsNewUserMessage(old,{userCount:5,lastUserText:'Test scheduler CDP'},'Test scheduler CDP'),true);
 assert.equal(confirmsNewUserMessage(old,{userCount:4,lastUserText:'Test scheduler CDP',mainOccurrences:4},'Test scheduler CDP'),false,'repeated text in assistant or editor is not evidence');
 assert.equal(confirmsNewUserMessage(old,{userCount:5,lastUserText:'Different message'},'Test scheduler CDP'),false);
 assert.equal(confirmsNewUserMessage(old,{userCount:3,lastUserText:'Test scheduler CDP'},'Test scheduler CDP'),false);
});

test('a repeated phrase in page text cannot falsely confirm a click',async()=>{
 const f=fake({mainOccurrences:2});
 const original=f.client.tool;
 f.client.tool=async(name,args)=>{
  const value=await original(name,args);
  if(name==='browser_evaluate' && args.function.includes('function guardedClickInPage')){
    // New ChatGPT response quoted the same text, but there was no new
    // observed user-authored bubble, so the click outcome is ambiguous.
    f.state.userCount--;
    f.state.mainOccurrences=3;
    f.state.editorText='';
  }
  return value;
 };
 const result=await deliverViaPlaywright(task,async()=>f.commit(),{client:f.client,wait:async()=>{}});
 assert.equal(result.status,'pending');
 assert.equal(f.calls.filter(c=>c.name==='browser_evaluate'&&c.args.function.includes('function guardedClickInPage')).length,1,'never retry an ambiguous click');
});

test('stable preflight rejects changing assistant progress and never types',async()=>{
 const f=fake();
 const original=f.client.tool;
 let reads=0;
 f.client.tool=async(name,args)=>{
  if(name==='browser_evaluate' && ++reads===2)f.state.stop=true;
  return original(name,args);
 };
 const result=await deliverViaPlaywright(task,()=>{throw Error('must not click')},
  {client:f.client,wait:async()=>{}});
 assert.equal(result.status,'deferred');
 assert.ok(!f.calls.some(x=>x.name==='browser_click'||x.name==='browser_type'));
});
test('explicit interruption is not misclassified as normal busy or ready',()=>{
 const state={...page,connectionInterrupted:true,stop:true};
 assert.equal(classifyChatState(state,url).kind,'interrupted');
 assert.equal(classifyChatState({...page,stop:true,lastAssistantMutationAt:1000},url,
  1000+13*60*1000).kind,'stalled');
 assert.equal(classifyChatState({...page,stop:false,busyText:false},url).kind,'ready');
});
test('DOM revision changes invalidate a seemingly stable ready state',()=>{
 const a={...page,assistantRevision:3};
 assert.equal(sameReadySnapshot(a,{...a,assistantRevision:4}),false);
 assert.equal(sameReadySnapshot(a,{...a,assistantRevision:3}),true);
});
test('in-page MutationObserver tracks assistant progress, not user draft text',()=>{
 let cb,observeCount=0;
 const main={innerText:'Conversation contents'};
 const win={};
 class FakeObserver{
  constructor(callback){cb=callback}
  observe(root){assert.equal(root,main);observeCount++}
  disconnect(){}
 }
 const document={readyState:'complete',title:'A real conversation',
  querySelectorAll(){return []},
  querySelector(selector){return selector==='main'?main:null}};
 const location={origin:'https://chatgpt.com',pathname:'/c/00000000-0000-4000-8000-000000000001'};
 const inspect=()=>vm.runInNewContext('('+pageInspection+')()',
  {document,location,window:win,MutationObserver:FakeObserver});
 const before=inspect();
 assert.equal(before.assistantRevision,0);
 const privateText='CONFIDENTIAL_ASSISTANT_TEXT';
 const target={nodeType:1,textContent:privateText,
  closest(selector){return selector.includes('[data-message-author-role="assistant"]')?{}:null}};
 cb([{target,addedNodes:[]}]);
 const after=inspect();
 assert.equal(after.assistantRevision,1);
 assert.equal(observeCount,1,'only one observer is installed per page');
 assert.ok(!JSON.stringify({
  revision:after.assistantRevision,lastChangedAt:after.lastAssistantMutationAt
 }).includes(privateText));
});
test('hidden streaming indicator does not incorrectly mark an idle page busy',()=>{
 const hidden={getClientRects(){return []}};
 const document={readyState:'complete',title:'Conversation',
  querySelectorAll(selector){
   if(selector==='[data-testid="streaming-indicator"],[data-is-streaming="true"]')return [hidden];
   return [];
  },
  querySelector(selector){return selector==='main'?{innerText:'Long conversation content'}:null}};
 const location={origin:'https://chatgpt.com',pathname:'/c/00000000-0000-4000-8000-000000000001'};
 const snapshot=vm.runInNewContext('('+pageInspection+')()',{document,location});
 assert.equal(snapshot.busyText,false);
});


test('completed server stream ignores unrelated assistant DOM re-render while idle',async()=>{
 const f=fake({streamStatus:'COMPLETE',streamSequence:5,assistantRevision:7});
 const original=f.client.tool;
 let inspections=0;
 f.client.tool=async(name,args)=>{
  if(name==='browser_type'){
   const result=await original(name,args);
   f.state.assistantRevision++; // React composer updated a wrapper inside <main>
   return result;
  }
  if(name==='browser_evaluate'&&!args.function.includes('function guardedClickInPage')){
   inspections++;
   if(inspections===4)f.state.assistantRevision++; // also re-rendered before final preflight
  }
  return original(name,args);
 };
 const result=await deliverViaPlaywright(task,async()=>f.commit(),{client:f.client,wait:async()=>{}});
 assert.equal(result.status,'verified');
 assert.equal(f.calls.filter(c=>c.name==='browser_type').length,1);
 assert.equal(f.calls.filter(c=>c.name==='browser_evaluate'&&c.args.function.includes('function guardedClickInPage')).length,1);
});

test('idle snapshots accept DOM revisions only when server COMPLETE and sequence unchanged',()=>{
 const a={...page,streamStatus:'COMPLETE',streamSequence:10,assistantRevision:8};
 assert.equal(sameReadySnapshot(a,{...a,assistantRevision:12}),true);
 assert.equal(sameReadySnapshot(a,{...a,assistantRevision:12,streamSequence:11}),false);
 assert.equal(sameReadySnapshot(a,{...a,assistantRevision:12,lastUserText:'A different user message'}),false);
 assert.equal(sameReadySnapshot({...a,streamStatus:'UNKNOWN'},a),false);
 const taskWithUrl={url,message:'Test scheduler CDP'};
 const typed={...a,editorText:task.message,sendEnabled:true};
 assert.equal(preClickIssue(a,{...typed,assistantRevision:15},taskWithUrl,5),null);
 assert.equal(preClickIssue(a,{...typed,streamStatus:'IS_STREAMING'},taskWithUrl,5),'GENERATION_ACTIVE');
 assert.equal(preClickIssue(a,{...typed,streamSequence:12},taskWithUrl,5),'STREAM_PROGRESS');
 assert.equal(preClickIssue(a,{...typed,lastUserText:'New'},taskWithUrl,5),'USER_MESSAGES_CHANGED');
 assert.equal(preClickIssue(a,{...typed,editorText:'Human draft'},taskWithUrl,5),'EDITOR_TEXT_CHANGED');
});

test('composer send-button hydration gets retried without retyping',async()=>{
 const f=fake({streamStatus:'COMPLETE',streamSequence:2,assistantRevision:1});
 const original=f.client.tool;
 let ready=0;
 f.client.tool=async(name,args)=>{
  if(name==='browser_evaluate'&&!args.function.includes('function guardedClickInPage')&&f.state.editorText){
   ready++;
   if(ready===1)f.state.sendEnabled=false;
   else f.state.sendEnabled=true;
  }
  return original(name,args);
 };
 const result=await deliverViaPlaywright(task,async()=>f.commit(),{client:f.client,wait:async()=>{}});
 assert.equal(result.status,'verified');
 assert.ok(ready>=3);
 assert.equal(f.calls.filter(c=>c.name==='browser_type').length,1);
});


test('real Chrome tab identity 503 reports a precise safe reason without sending',async()=>{
 const f=fake();
 const original=f.client.tool;
 f.client.tool=async(name,args)=>{
  if(name==='browser_evaluate')
   throw Error('Playwright MCP HTTP 503: {"error":{"message":"Current tab identity cannot be verified"}}');
  return original(name,args);
 };
 const result=await deliverViaPlaywright(task,()=>{throw Error('must not commit')},
  {client:f.client,wait:async()=>{}});
 assert.equal(result.status,'deferred');
 assert.equal(result.evidence.code,'TAB_IDENTITY_UNVERIFIED');
 assert.match(result.error,/активную вкладку Chrome/);
 assert.equal(result.evidence.clickCommitted,false);
 assert.equal(f.calls.filter(c=>c.name==='browser_type').length,0);
});
test('transport preflight diagnostics never expose raw MCP body or URLs',()=>{
 const response=classifyPreflightError({message:'MCP HTTP 503: page URL https://private.example/sensitive'});
 assert.equal(response.code,'BROWSER_OBSERVATION_UNAVAILABLE');
 assert.ok(!JSON.stringify(response).includes('private.example'));
 assert.equal(classifyPreflightError({message:'Browser action queue wait timed out'}).code,'BROWSER_QUEUE_BUSY');
 assert.equal(classifyPreflightError({message:'TAB_INDEX_CHANGED_USE_STABLE_ID'}).code,'TAB_INDEX_UNSTABLE');
});


test('scheduler recognizes project canonical URL in readiness and delivery proof',()=>{
 const project='a'.repeat(32),id='00000000-0000-4000-8000-000000000001';
 const short='https://chatgpt.com/g/g-p-'+project+'/c/'+id;
 const canonical='https://chatgpt.com/g/g-p-'+project+'-gafus-refactor/c/'+id;
 const p={...page,url:canonical};
 assert.equal(classifyChatState(p,short).kind,'ready');
 assert.equal(sameReadySnapshot({...p,url:short},p),true);
 assert.equal(preClickIssue({...p,url:short},{...p,editorText:'Test scheduler CDP',sendEnabled:true},
   {url:short,message:'Test scheduler CDP'},p.userCount),null);
});
