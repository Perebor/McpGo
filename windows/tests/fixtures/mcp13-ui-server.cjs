'use strict';
// Local fixture-only HTML server. No user AutoSend endpoints, no privileged IPC.
const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const app=path.resolve(__dirname,'../../app');
const mock=path.join(__dirname,'mcp13-mock-preload.js');
const port=Number(process.env.MCPGO_UI_FIXTURE_PORT||18963);
if(!Number.isInteger(port)||port<1024||port>65535)throw Error('Unsafe fixture port');
const resources=Object.freeze({
 '/style.css':{file:path.join(app,'style.css'),mime:'text/css'},
 '/project-view.js':{file:path.join(app,'project-view.js'),mime:'application/javascript'},
 '/renderer.js':{file:path.join(app,'renderer.js'),mime:'application/javascript'},
 '/mcp13-mock-preload.js':{file:mock,mime:'application/javascript'},
 '/logo.png':{file:path.join(app,'logo.png'),mime:'image/png'}
});
http.createServer((req,res)=>{
 if(req.method!=='GET')return res.writeHead(405).end();
 const url=(req.url||'/').split('?')[0];
 if(url==='/'||url==='/index.html'){
  const html=fs.readFileSync(path.join(app,'index.html'),'utf8').replace(
   '<script defer src="project-view.js"></script>',
   '<script defer src="mcp13-mock-preload.js"></script><script defer src="project-view.js"></script>');
  res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});
  return res.end(html);
 }
 const asset=resources[url];
 if(!asset)return res.writeHead(404).end();
 res.writeHead(200,{'Content-Type':asset.mime,'Cache-Control':'no-store'});
 res.end(fs.readFileSync(asset.file));
}).listen(port,'127.0.0.1',()=>console.log('MCP13_FIXTURE_UI_LISTENING='+port));
