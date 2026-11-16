// Manually opted-in, one unique local QA tab. Never exposes page URLs or credentials.
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {setTimeout as pause} from 'node:timers/promises';
if(process.env.MCPGO_INSPECT_TAB_IDS!=='1')throw Error('Explicit opt-in required');
const marker='mcpgo-direct-inspect-'+randomUUID();
const host=http.createServer((req,res)=>{res.writeHead(200,{'content-type':'text/html','cache-control':'no-store'});res.end('<title>McpGo QA</title>')});
host.listen(0,'127.0.0.1');await new Promise(r=>host.once('listening',r));
const qaUrl=`http://127.0.0.1:${host.address().port}/${marker}`;
const endpoint='http://127.0.0.1:8931/mcp';let sid='',id=0,created=false;
async function send(method,params){
 const body={jsonrpc:'2.0',method};if(method!=='notifications/initialized')body.id=++id;if(params)body.params=params;
 const headers={'content-type':'application/json',accept:'application/json, text/event-stream'};
 if(sid)headers['mcp-session-id']=sid;
 const r=await fetch(endpoint,{method:'POST',headers,body:JSON.stringify(body),signal:AbortSignal.timeout(25000)});
 sid=r.headers.get('mcp-session-id')||sid;const raw=await r.text();
 const line=raw.trim().startsWith('{')?raw:raw.split(/\r?\n/).find(x=>x.startsWith('data: '))?.slice(6);
 const parsed=line?JSON.parse(line):null;
 if(!r.ok||parsed?.error||parsed?.result?.isError)throw Error(`${method} HTTP ${r.status} ${String(parsed?.error?.message||'MCP_TOOL_ERROR').slice(0,70)}`);
 return parsed;
}
const tool=(name,args)=>send('tools/call',{name,arguments:args});
function resultText(r){const all=(r?.result?.content||[]).filter(c=>c.type==='text').map(c=>c.text||'').join('\n');return all.match(/### Result\s*\n([\s\S]*?)(?=\n### |$)/)?.[1]?.trim()||all;}
function countByURL(rows,tag){return rows.filter(x=>typeof x.url==='string'&&x.url.includes(tag)).length;}
const getPages=async()=>JSON.parse(resultText(await tool('browser_run_code_unsafe',{code:'(page) => page.context().pages().map((p,i)=>({i,guid:p._guid,url:p.url()}))'})));
try{
 await send('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'McpGo-Tab-ID-ReadOnly-QA',version:'1'}});
 await send('notifications/initialized');
 const before=await getPages();
 const createdResponse=await tool('browser_tabs',{action:'new',url:qaUrl});created=true;
 const tabs=resultText(createdResponse).split(/\r?\n/).filter(x=>/^\s*-\s*\d+:/.test(x));
 const pages=await getPages();
 const matching=pages.filter(p=>p.url===qaUrl);
 const guidTypes=new Set(matching.map(p=>typeof p.guid));
 console.log(JSON.stringify({beforePageCount:before.length,afterPageCount:pages.length,renderedTabCount:tabs.length,matchingPageCount:matching.length,renderedMatches:tabs.filter(x=>x.includes(marker)).length,uniqueGuidCount:new Set(matching.map(p=>p.guid)).size,guidTypes:[...guidTypes]}));
}catch(e){console.error('READ_ONLY_ID_PROBE_FAILED: '+e.message);process.exitCode=1;}
finally{
 if(sid)try{await fetch(endpoint,{method:'DELETE',headers:{'mcp-session-id':sid},signal:AbortSignal.timeout(1500)});}catch{}
 // Exact QA URL only; do not use unstable tab indices.
 const script=`set n to 0\ntell application "Google Chrome"\n repeat with w in windows\n  repeat with t in (tabs of w)\n   try\n    if (URL of t as text) is "${qaUrl}" then\n     close t\n     set n to n + 1\n    end if\n   end try\n  end repeat\n end repeat\nend tell\nreturn n`;
 try {const n=execFileSync('/usr/bin/osascript',['-e',script],{encoding:'utf8',timeout:9000}).trim();console.log('QA_TABS_CLOSED='+n);}catch{console.error('QA_CLEANUP_NOT_CONFIRMED');process.exitCode=1;}
 host.closeAllConnections();host.close();
}
