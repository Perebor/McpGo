import {test} from 'node:test';
import assert from 'node:assert/strict';
import {probeMcp} from '../mcp-health.mjs';
import {MODERN_PROTOCOL,SERVER_META_KEY} from '../../playwright/mcp-modern-protocol.mjs';
function fakeFetch({listStatus=200,unsafe=false,expired=false}={}){
 return async (_url,{body,headers,method})=>{
  assert.equal(method,'POST');
  const payload=JSON.parse(body);
  assert.equal(headers['mcp-protocol-version'],MODERN_PROTOCOL);
  assert.equal(headers['mcp-method'],payload.method);
  assert.equal(payload.params._meta['io.modelcontextprotocol/protocolVersion'],MODERN_PROTOCOL);
  if(payload.method==='tools/call')throw Error('Dashboard health may not call browser tools');
  if(payload.method==='server/discover')return new Response(JSON.stringify({jsonrpc:'2.0',id:payload.id,
    result:{resultType:'complete',supportedVersions:[MODERN_PROTOCOL],capabilities:{tools:{}},
      _meta:{[SERVER_META_KEY]:{name:'Fake',version:'1'}}}}),{status:200});
  if(payload.method==='tools/list'){
   if(expired)return new Response('Backend unavailable',{status:502});
   return new Response(JSON.stringify({jsonrpc:'2.0',id:payload.id,
     result:{resultType:'complete',tools:[{name:'browser_tabs'},{name:'browser_snapshot'},
       ...(unsafe?[{name:'browser_run_code_unsafe'}]:[])]}}),{status:listStatus});
  }
  throw Error('Unexpected call: '+payload.method);
 };
}
test('healthy stateless MCP 2026 tools list is accepted',async()=>
 assert.equal(await probeMcp('http://test.local',fakeFetch()),true));
test('repeated health checks never initialize a session or call Chrome',async()=>{
 const seen=[],upstream=fakeFetch();
 const checking=async(url,opts)=>{seen.push(JSON.parse(opts.body).method);return upstream(url,opts);};
 for(let i=0;i<3;i++)assert.equal(await probeMcp('http://test.local',checking),true);
 assert.deepEqual(seen,['server/discover','tools/list','server/discover','tools/list','server/discover','tools/list']);
});
test('unavailable MCP backend must not look healthy',async()=>
 await assert.rejects(probeMcp('http://test.local',fakeFetch({expired:true})),/502/));
test('exposed unsafe browser tool makes status unhealthy',async()=>
 await assert.rejects(probeMcp('http://test.local',fakeFetch({unsafe:true})),/invalid/));
