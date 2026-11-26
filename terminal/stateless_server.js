'use strict';

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const jobs = require('./job_runtime.js');
const platform=require('./platform.js');
const interactive=require('./interactive_runtime.cjs');
const files=process.env.MCPGO_ENABLE_FILES==='1'?require('./files_tools.cjs'):null;
const MCP_VERSION=require('./mcp-version.json').version;
const modernProtocol=import('../playwright/mcp-modern-protocol.mjs');
const SERVER_INFO={name:'McpGo Terminal MCP',version:MCP_VERSION};
// Actual existing ChatGPT Terminal plugin still uses the 2025 envelope. Keep
// transitional compatibility until it negotiates 2026. Strict mode is opt-in.
const LEGACY_COMPAT=process.env.MCPGO_DISABLE_LEGACY!=='1';
// Keep the MCP response short while the detached job continues running.
// Production defaults to 12 seconds; isolated tests can use a shorter wait.
const SYNC_WAIT_MS=Number(process.env.MCPGO_TERMINAL_SYNC_WAIT_MS??12000);
if(!Number.isInteger(SYNC_WAIT_MS)||SYNC_WAIT_MS<100||SYNC_WAIT_MS>15000)
  throw Error('INVALID_TERMINAL_SYNC_WAIT_MS');
const DEFAULT_JOB_TIMEOUT_MS=20*60*1000;
const MAX_JOB_TIMEOUT_MS=4*60*60*1000;
// Wire counters only; never capture command text, auth data or session tokens.
const observedWireCalls={modern:0,legacy:0};
let lastSuccessfulCallAt=null;

const DIR = __dirname;
const CONFIG = process.env.MCPGO_ONESHOT_CONFIG || path.join(platform.dataRoot(),'terminal','stateless-config.json');
fs.mkdirSync(path.dirname(CONFIG),{recursive:true,mode:0o700});
const PORT = Number(process.env.MCPGO_ONESHOT_PORT || 12848);
if(!Number.isInteger(PORT)||PORT<1024||PORT>65535)throw Error('INVALID_ONESHOT_PORT');

if (!fs.existsSync(CONFIG)) {
  fs.writeFileSync(CONFIG, JSON.stringify({
    mcpPath: 'exec/' + crypto.randomBytes(32).toString('hex')
  }), { mode: 0o600, flag: 'wx' });
}

const config = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
if (!/^exec\/[a-f0-9]{64}$/.test(config.mcpPath)) {
  throw new Error('Invalid private MCP path');
}

const tool = {
  name: 'terminal_exec',
  description: 'Run a Windows PowerShell or macOS zsh command as a durable job. Wait up to 12 seconds for a quick result; if still running, return promoted_to_job=true and job_id without cancelling. Use job_status/job_result/job_logs to retrieve completion. Never treat a pending result as PASS or repeat an uncertain command. Default job runtime is 20 minutes (maximum 4 hours; timeout_ms is the command runtime, NOT MCP wait time). On connection loss call mcpgo_recover. Optional request_id deduplicates and resource_key locks conflicting resources.',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string' },
      cwd: { type: 'string' },
      request_id: {type:'string',minLength:8,maxLength:128,description:'Optional client idempotency token. If omitted, the generated job_id can still be recovered by mcpgo_recover after disconnect.'},
      resource_key: {type:'string',description:'Optional exclusive lock for a known conflicting operation, e.g. deploy:gafus-prod, release:mcpgo, git:repo-main. Unrelated operations always execute in parallel.'},
      timeout_ms: {
        type: 'integer',
        minimum: 1000,
        maximum: 14400000,
        description: 'Maximum total command runtime (default 20 minutes; maximum 4 hours). terminal_exec returns a job_id after 12 seconds if still running.'
      }
    },
    required: ['command'],
    additionalProperties: false
  }
};

let active = 0;
// Preserve the familiar terminal_exec API, but run commands through the SAME
// durable job engine as job_start. This creates recoverable IDs automatically.
// An HTTP/MCP disconnect never kills or replays an existing command.
async function execute(args) {
  active++;
  try {
    const job_timeout_ms=args.timeout_ms??DEFAULT_JOB_TIMEOUT_MS;
    if(!Number.isInteger(job_timeout_ms)||job_timeout_ms<1000||job_timeout_ms>MAX_JOB_TIMEOUT_MS)
      throw Error('INVALID_TIMEOUT');
    // The durable detached worker exists BEFORE we wait for its completion.
    // An HTTP disconnect cannot cancel the job on macOS or Windows.
    const started=jobs.startJob({...args,timeout_ms:job_timeout_ms});
    const job_id=started.job_id;
    const deadline=Date.now()+Math.min(SYNC_WAIT_MS,job_timeout_ms);
    // Never wait again for a duplicate request_id: simply report its state.
    if(!started.deduplicated){
      let status;
      do {
        status=jobs.getStatus({job_id});
        if(['exited','cancelled','launch_error','unknown','stalled'].includes(status.state))break;
        const remaining=deadline-Date.now();
        if(remaining<=0)break;
        await jobs.watch({job_id,wait_ms:Math.min(1000,remaining)});
      } while(Date.now()<deadline);
    }
    const result=jobs.result({job_id});
    const promoted_to_job=!result.result_ready &&
      ['queued','starting','running','cancelling'].includes(result.state);
    return {
      operation_id:job_id,job_id,deduplicated:!!started.deduplicated,
      promoted_to_job,wait_limit_ms:SYNC_WAIT_MS,job_timeout_ms,
      state:result.state,exit_code:result.exit_code??null,
      signal:result.signal??null,timed_out:!!result.timed_out,
      spawn_error:result.spawn_error??null,duration_ms:result.duration_ms??null,
      stdout:result.stdout||'',stderr:result.stderr||'',
      stdout_bytes:result.stdout_bytes??0,stderr_bytes:result.stderr_bytes??0,
      stdout_truncated:!!result.stdout_truncated,
      stderr_truncated:!!result.stderr_truncated,
      result_ready:result.result_ready===true,
      note:result.result_ready?'Durable result confirmed.':
        promoted_to_job
          ? 'PROMOTED TO BACKGROUND JOB (not PASS). Command was NOT cancelled. Check job_status/job_result/job_logs with this job_id; on lost response call mcpgo_recover. NEVER re-execute an uncertain command.'
          : 'JOB STATE UNCERTAIN (not PASS). Inspect job_status/logs and effects; never retry blindly.'
    };
  } finally {active--}
}

function respond(res, status, obj) {
  const data = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': data.length,
    'Cache-Control': 'no-store'
  });
  res.end(data);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1:' + PORT);

  if (req.method === 'GET' && url.pathname === '/health') {
    return respond(res, 200, {
      ok: true,
      mode: 'unified-terminal-mcp',
      active,
      interactive_sessions:interactive.sessionCount(),
      observedWireCalls:{...observedWireCalls},lastSuccessfulCallAt
    });
  }

  if (interactive.isLocalRoute(url.pathname)) return interactive.handleLocal(req,res,url);

  if (url.pathname !== '/' + config.mcpPath) {
    return respond(res, 404, { error: 'NOT_FOUND' });
  }

  if (req.method !== 'POST') {
    return respond(res, 405, { error: 'METHOD_NOT_ALLOWED' });
  }

  try {
    const chunks = [];
    let size = 0;

    for await (const chunk of req) {
      size += chunk.length;
      if (size > 70000) throw new Error('REQUEST_TOO_LARGE');
      chunks.push(chunk);
    }

    const request = JSON.parse(Buffer.concat(chunks).toString());
    const { id, method, params } = request;
    const modern=await modernProtocol;
    const modernEnvelope=req.headers['mcp-method']!==undefined ||
      req.headers['mcp-protocol-version']===modern.MODERN_PROTOCOL ||
      request?.params?._meta?.['io.modelcontextprotocol/protocolVersion']!==undefined ||
      method==='server/discover';
    if(method==='tools/call')observedWireCalls[modernEnvelope?'modern':'legacy']++;
    if(!modernEnvelope&&!LEGACY_COMPAT)
      return respond(res,400,{jsonrpc:'2.0',id:id??null,
        error:{code:-32022,message:'Unsupported MCP protocol; only 2026-07-28 is exposed'}});
    if(modernEnvelope){
      if(req.headers['mcp-session-id']!==undefined)
        return respond(res,400,{jsonrpc:'2.0',id:id??null,
          error:{code:-32600,message:'Mcp-Session-Id is not used by stateless MCP'}});
      const problem=modern.validateModernRequest(req.headers,request);
      if(problem)return respond(res,400,{jsonrpc:'2.0',id:id??null,
        error:{code:problem.code,message:problem.message}});
    }
    if(method==='server/discover'&&modernEnvelope){
      return respond(res,200,{jsonrpc:'2.0',id,
        result:modern.discoverResult({serverInfo:SERVER_INFO,instructions:
          'terminal_exec returns in up to 12 seconds, promoting still-running commands to durable jobs. Pending is NOT completion. Poll job_status and fetch job_result; on lost response call mcpgo_recover. Never replay uncertain operations.'})});
    }

    let result;
    if (!modernEnvelope&&method==='initialize') {
      result={protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:SERVER_INFO,
        instructions:'terminal_exec promotes calls longer than 12 seconds to durable jobs; poll job_status and job_result. On lost response call mcpgo_recover; never automatically replay an uncertain command.'};
    } else if(!modernEnvelope&&method==='notifications/initialized'){
      res.writeHead(202);return res.end();
    } else if(!modernEnvelope&&method==='ping'){
      result={};
    } else if (method === 'tools/list') {
      result = { tools: [tool, ...jobs.tools, ...interactive.toolSchemas(), ...(files?files.schemas:[])] };
    } else if (method === 'tools/call' && files?.schemas.some(t=>t.name===params?.name)) {
      try {const value=files.call(params.name,params.arguments||{});
        result={content:[{type:'text',text:JSON.stringify(value)}]};}
      catch(error){result={isError:true,content:[{type:'text',text:error.message}]};}
    } else if (method === 'tools/call' && interactive.toolSchemas().some(t=>t.name===params?.name)) {
      try { result = {content:[{type:'text',text:JSON.stringify(await interactive.performTool(params.name,params.arguments||{}))}]}; }
      catch(error){result={isError:true,content:[{type:'text',text:error.message}]};}
    } else if (method === 'tools/call' &&
               params?.name === 'terminal_exec') {
      try {
        const value = await execute(params.arguments || {});
        result = {
          content: [{
            type: 'text',
            text: JSON.stringify(value)
          }]
        };
      } catch (error) {
        result = {
          isError: true,
          content: [{
            type: 'text',
            text: error.message
          }]
        };
      }
    } else if (method === 'tools/call' &&
               ['job_start', 'job_status', 'job_logs', 'job_recent','job_cancel','job_result','job_watch','job_output','mcpgo_recover','resource_lock_status'].includes(params?.name)) {
      try {
        const args = params.arguments || {};
        const value = params.name === 'job_start' ? jobs.startJob(args)
                    : params.name === 'job_status' ? jobs.getStatus(args)
                    : params.name === 'job_recent' ? jobs.recent(args)
                    : params.name === 'job_cancel' ? jobs.cancel(args)
                    : params.name === 'job_result' ? jobs.result(args)
                    : params.name === 'job_watch' ? await jobs.watch(args)
                    : params.name === 'job_output' ? jobs.output(args)
                    : params.name === 'mcpgo_recover' ? jobs.recover(args)
                    : params.name === 'resource_lock_status' ? jobs.lockStatus(args)
                    : jobs.logs(args);
        result = { content: [{ type: 'text', text: JSON.stringify(value) }] };
      } catch (error) {
        result = { isError: true, content: [{ type: 'text', text: error.message }] };
      }
    } else {
      return respond(res, 200, {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: 'Method not found' }
      });
    }

    if(method==='tools/call'&&result&&!result.isError)lastSuccessfulCallAt=Date.now();
    return respond(res, 200, modernEnvelope
      ? modern.modernizeMessage({jsonrpc:'2.0',id,result},
          {cache:method==='tools/list',serverInfo:SERVER_INFO})
      : {jsonrpc:'2.0',id,result});
  } catch (error) {
    return respond(res, 400, { error: error.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('ChatTerminalHub OneShot listening on 127.0.0.1:12848');
});

function stopServer(){
  interactive.shutdown();
  server.close(()=>process.exit(0));
  setTimeout(()=>process.exit(0),3000).unref();
}
process.on('SIGTERM',stopServer);
process.on('SIGINT',stopServer);
