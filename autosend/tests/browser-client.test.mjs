import test from 'node:test';
import assert from 'node:assert/strict';
import {ExtensionMcpClient} from '../browser-client.mjs';

const result=(id,value)=>new Response(JSON.stringify({jsonrpc:'2.0',id,result:value}),{
 headers:{'content-type':'application/json','mcp-session-id':'private-12345678'}});
test('only one private extension connection is initialized across many reads',async()=>{
 const calls=[];
 const fetcher=async(url,options)=>{
  const req=JSON.parse(options.body);calls.push({url,method:req.method,
   protocol:options.headers['mcp-protocol-version'],session:options.headers['mcp-session-id']});
  if(req.method==='initialize')return result(req.id,{serverInfo:{name:'Playwright MCP'},capabilities:{}});
  if(req.method==='notifications/initialized')return new Response('',{status:202});
  if(req.method==='tools/call')return result(req.id,{content:[{type:'text',text:'### Result\nOK'}]});
  throw Error(req.method);
 };
 const client=new ExtensionMcpClient('http://127.0.0.1:8932/mcp',fetcher);
 assert.match(await client.tool('browser_tabs',{action:'list'}),/OK/);
 assert.match(await client.tool('browser_tabs',{action:'list'}),/OK/);
 assert.deepEqual(calls.map(c=>c.method),
  ['initialize','notifications/initialized','tools/call','tools/call']);
 assert.ok(calls.every(c=>c.protocol==='2025-03-26'));
 assert.equal(calls[2].session,'private-12345678');
 assert.ok(calls.every(c=>c.url==='http://127.0.0.1:8932/mcp'));
 assert.ok(calls.every(c=>c.session===undefined || !c.session.includes('chatgpt')));
});
test('private client never forwards durable action headers or ChatGPT URLs to arbitrary MCP servers',()=>{
 assert.throws(()=>new ExtensionMcpClient('https://example.com/mcp'),/loopback/);
 assert.throws(()=>new ExtensionMcpClient('http://127.0.0.1:8940/mcp?proxy=1'),/loopback/);
});
test('expired session invalidates connection; mutating tool is not retried implicitly',async()=>{
 let calls=0;
 const fetcher=async(_url,{body})=>{
  const req=JSON.parse(body);calls++;
  if(req.method==='initialize')return result(req.id,{serverInfo:{name:'MCP'}});
  if(req.method==='notifications/initialized')return new Response('',{status:202});
  return new Response('gone',{status:404});
 };
 const client=new ExtensionMcpClient('http://127.0.0.1:8932/mcp',fetcher);
 await assert.rejects(client.tool('browser_evaluate',{function:'() => true'}),/session expired/);
 assert.equal(calls,3,'no second browser action after an ambiguous request');
});


test('failed initialized notification cannot make an uninitialized connection look ready',async()=>{
 let initializeCount=0,notifications=0;
 const fetcher=async(_url,{body})=>{
  const request=JSON.parse(body);
  if(request.method==='initialize'){
   initializeCount++;
   return result(request.id,{serverInfo:{name:'Playwright MCP'}});
  }
  if(request.method==='notifications/initialized'){
   notifications++;
   return new Response('',{status:notifications===1?503:202});
  }
  return result(request.id,{content:[{type:'text',text:'OK'}]});
 };
 const client=new ExtensionMcpClient('http://127.0.0.1:8932/mcp',fetcher);
 await assert.rejects(client.tool('browser_tabs',{action:'list'}),/503/);
 assert.equal(client.initialized,false);
 assert.equal(client.session,'');
 assert.equal(await client.tool('browser_tabs',{action:'list'}),'OK');
 assert.equal(initializeCount,2);
 assert.equal(notifications,2);
});
