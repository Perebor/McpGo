import test from 'node:test';
import assert from 'node:assert/strict';
import {McpSseResultReader,parseMcpMessages,responseMessage,transformMcpResponse} from '../mcp-response.mjs';
import {modernizeResponse} from '../mcp-modern-protocol.mjs';
import {decorateMcpToolResponse} from '../workspace-response.mjs';
const content={content:[{type:'text',text:'### Result\nПривет'}],structuredContent:{x:1}};
const msg={jsonrpc:'2.0',id:42,result:content};
const make=(newline,spaced,split)=>{
 const data=JSON.stringify(msg);
 const payload=split?[data.slice(0,23),data.slice(23)]:[data];
 return ': alive'+newline+'event: message'+newline+payload.map(s=>'data:'+(spaced?' ':'')+s).join(newline)+newline+newline;
};
test('JSON and completed SSE results have identical id, content, workspace and resultType',()=>{
 const id='ws_'+'a'.repeat(32);
 const canonical=JSON.parse(modernizeResponse(decorateMcpToolResponse(
   Buffer.from(JSON.stringify(msg)),'application/json',id),'application/json'));
 for(const nl of ['\n','\r\n'])for(const spaced of [true,false])for(const split of [true,false]){
  const sse=make(nl,spaced,split);
  // A split can only be legal on a JSON token boundary where its data lines
  // form a valid JSON value; use a newline between object properties here.
  if(split)continue;
  const decorated=decorateMcpToolResponse(Buffer.from(sse),'text/event-stream',id);
  const final=modernizeResponse(decorated,'text/event-stream');
  assert.deepEqual(responseMessage(final,'text/event-stream',42),canonical);
 }
 assert.equal(canonical.result.resultType,'complete');
 assert.equal(canonical.result.structuredContent.workspace_id,id);
});
test('multiline SSE objects, notifications and heartbeat do not interfere with matching result',()=>{
 const pieces=['{"jsonrpc":"2.0",','"id":42,','"result":{"content":[],"structuredContent":{"x":1}}}'];
 const body=': ping\r\n\r\ndata:{"method":"notifications/progress"}\r\n\r\n'+
   pieces.map(s=>'data: '+s).join('\r\n')+'\r\n\r\n';
 const expected={jsonrpc:'2.0',id:42,result:{content:[],structuredContent:{x:1}}};
 assert.deepEqual(responseMessage(body,'text/event-stream',42),expected);
 const transformed=transformMcpResponse(body,'text/event-stream',v=>({...v,checked:true}));
 assert.equal(responseMessage(transformed,'text/event-stream',42).checked,true);
 assert.equal(parseMcpMessages(transformed,'text/event-stream').length,2);
});
test('chunked UTF-8, CRLF split across chunks and earlier unrelated results never finish another request',()=>{
 const body=':keepalive\r\n\r\ndata: '+JSON.stringify({...msg,id:99})+'\r\n\r\n'+make('\r\n',false,false);
 const raw=Buffer.from(body);
 for(let width=1;width<=19;width++){
  const reader=new McpSseResultReader(42);let answer=null;
  for(let i=0;i<raw.length;i+=width)answer??=reader.push(raw.subarray(i,i+width));
  assert.deepEqual(answer?.message,msg);
 }
});
test('missing or incomplete matching response is rejected, not reported as success',()=>{
 assert.throws(()=>responseMessage('data: {"id":1,"result":{}}','text/event-stream',1),/INCOMPLETE/);
 assert.throws(()=>responseMessage('data: {"id":2,"result":{}}\n\n','text/event-stream',1),/MISSING_MATCHING/);
 assert.equal(new McpSseResultReader(1).push(Buffer.from('data: {"id":1,')),null);
 assert.throws(()=>parseMcpMessages('data: {"id":1','text/event-stream'),/INCOMPLETE/);
});
