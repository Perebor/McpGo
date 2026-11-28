import test from 'node:test';
import assert from 'node:assert/strict';
import {checkPreview,diagnosePreview,samePreviewReady} from '../preview-check.mjs';
const base={urlValid:true,pageReady:'complete',editorCount:1,editorText:'',
 streamStatus:'COMPLETE',streamReason:'SERVER',streamActive:false,
 stop:false,busyText:false,connectionInterrupted:false,
 streamSequence:12,userCount:4,lastUserHash:'last-user-hash',lastUserId:'user-4'};
function observer(values){
 let index=0;
 const calls=[];
 const read=async(_,opts)=>{
  calls.push(opts);
  const value=values[Math.min(index++,values.length-1)];
  return value.status?value:{status:'ok',observation:value};
 };
 return {read,calls};
}
test('preview handles a transient 503 without sending, then requires two server COMPLETE checks',async()=>{
 const {read,calls}=observer([
  {...base,streamStatus:'UNKNOWN',streamReason:'HTTP_503'},
  base,{...base}
 ]);
 const result=await checkPreview({url:'chat'},read,async()=>{});
 assert.equal(result.ready,true);
 assert.equal(result.code,'READY_TO_CHECK');
 assert.equal(result.readings,3);
 assert.equal(result.sendBlocked,true);
 assert.deepEqual(calls,[{eventWaitMs:0},{eventWaitMs:0},{eventWaitMs:0}]);
});
test('preview never trusts permanent unknown server status despite an idle DOM',async()=>{
 const {read}=observer([{...base,streamStatus:'UNKNOWN',streamReason:'HTTP_404'}]);
 const result=await checkPreview({},read,async()=>{});
 assert.equal(result.ready,false);
 assert.equal(result.code,'STREAM_STATUS_UNKNOWN');
 assert.match(result.reason,/не предоставил статус генерации/);
 assert.equal(result.readings,3);
});
test('stable composer draft remains private; transient unknown stream cannot authorize Send',async()=>{
 const {read,calls}=observer([{...base,editorText:'Private unsent draft',streamStatus:'UNKNOWN',streamReason:'HTTP_503'}]);
 const result=await checkPreview({},read,async()=>{});
 assert.equal(result.ready,false);
 assert.equal(result.code,'STREAM_STATUS_UNKNOWN');
 assert.equal(result.readings,3);
 assert.equal(calls.length,3);
 assert.equal(result.sendBlocked,true);
 assert.ok(!JSON.stringify(result).includes('Private unsent draft'));
});
test('stream activity blocks preview even if the server reports COMPLETE',()=>{
 const result=diagnosePreview({...base,streamActive:true,streamLastEventAt:Date.now()});
 assert.equal(result.ready,false);
 assert.equal(result.code,'GENERATION_ACTIVE_OR_UNCERTAIN');
});
test('two COMPLETE probes with changed user text or stream sequence are not stable',()=>{
 assert.equal(samePreviewReady(base,{...base,streamSequence:13}),false);
 assert.equal(samePreviewReady(base,{...base,lastUserHash:'changed'}),false);
 assert.equal(samePreviewReady(base,{...base}),true);
});
test('unexpected browser-tab result is not a ready preview',async()=>{
 const result=await checkPreview({},async()=>({status:'unavailable',code:'AMBIGUOUS_CHAT_TABS',
  reason:'More than one chat tab'}),async()=>{throw Error('must not wait')});
 assert.equal(result.chatFound,false);
 assert.equal(result.code,'AMBIGUOUS_CHAT_TABS');
 assert.equal(result.readings,1);
});
test('intermittent COMPLETE without two stable results cannot turn ready',async()=>{
 const {read}=observer([base,{...base,streamStatus:'UNKNOWN',streamReason:'HTTP_429'},base]);
 const result=await checkPreview({},read,async()=>{});
 assert.equal(result.ready,false);
 assert.equal(result.code,'READY_NOT_STABLE');
 assert.equal(result.readings,3);
});
