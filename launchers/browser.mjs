import {spawn} from 'node:child_process';
import {readFileSync, lstatSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {detectUniqueExtensionProfile} from '../playwright/chrome-profile.mjs';

// The browser backend must always use the Playwright installation bundled with McpGo.
const mcp=fileURLToPath(new URL('../playwright/',import.meta.url)).replace(/\/$/,'');
const defaultSettingsDir=join(homedir(),'Library','Application Support','McpGo','playwright');

function optionalSetting(settingsDir,name) {
  try { return readFileSync(join(settingsDir,name),'utf8').trim(); }
  catch(e) { if (e?.code==='ENOENT') return ''; throw e; }
}

function tokenFromFile(settingsDir) {
  const file=join(settingsDir,'extension-token');
  let stat;
  try { stat=lstatSync(file); }
  catch(e) { if (e?.code==='ENOENT') return ''; throw e; }
  if (!stat.isFile() || (stat.mode & 0o077) !== 0 ||
      (typeof process.getuid==='function' && stat.uid!==process.getuid()))
    throw Error('EXTENSION_TOKEN_UNSAFE: Playwright extension token file must be a private regular file (chmod 600), owned by the current user');
  return readFileSync(file,'utf8').trim();
}

function validateToken(token) {
  if (!/^[^\s\x00-\x1f]{16,2048}$/.test(token))
    throw Error('EXTENSION_TOKEN_INVALID: Invalid Playwright extension token. Copy the token from the Playwright Extension, without whitespace.');
}

function extensionToken(env,settingsDir) {
  const token=env.PLAYWRIGHT_MCP_EXTENSION_TOKEN || tokenFromFile(settingsDir);
  if(!token)throw Error('EXTENSION_TOKEN_MISSING: Playwright extension token not configured. Откройте McpGo → Настройка → Chrome Extension.');
  validateToken(token);
  return token;
}

export function extensionStatus({env=process.env,settingsDir=defaultSettingsDir}={}) {
  try {
    const mode=(env.MCPGO_BROWSER_MODE || optionalSetting(settingsDir,'browser-mode') || 'extension').trim();
    if(mode!=='extension')return {configured:false,code:'EXTENSION_MODE_INVALID'};
    extensionToken(env,settingsDir);
    return {configured:true,code:'EXTENSION_CONFIGURED'};
  } catch(e) {
    const code=String(e.message).split(':')[0];
    return {configured:false,code:['EXTENSION_TOKEN_MISSING','EXTENSION_TOKEN_UNSAFE','EXTENSION_TOKEN_INVALID'].includes(code)?code:'EXTENSION_CONFIG_UNREADABLE'};
  }
}

export function browserConfig({env=process.env,settingsDir=defaultSettingsDir,baseDir=mcp,role='browser'}={}) {
  if(!['browser','autosend'].includes(role))throw Error('Unknown browser client role');
  const mode=(env.MCPGO_BROWSER_MODE || optionalSetting(settingsDir,'browser-mode') || 'extension').trim();
  if(mode!=='extension')throw Error('Only the official Playwright Chrome Extension is supported; CDP has been removed');
  const port=Number(role==='autosend'?env.MCPGO_AUTOSEND_PLAYWRIGHT_PORT||8932:
    env.MCPGO_PLAYWRIGHT_PORT||8931);
  if(!Number.isInteger(port) || port<1024 || port>65535)
    throw Error('Invalid Playwright backend port');
  // Separate settle profiles: browser reads favor speed, AutoSend form submits
  // retain the upstream conservative 500ms default unless explicitly tuned.
  const settleKey=role==='autosend'?'MCPGO_AUTOSEND_SETTLE_MS':'MCPGO_BROWSER_SETTLE_MS';
  const settle=Number(env[settleKey]??(role==='autosend'?500:200));
  if(!Number.isInteger(settle)||settle<0||settle>2000)
    throw Error('Invalid Playwright settle timeout');
  // Opt-in: explicit snapshots via mcpgo_inspect_page remain available with none.
  const snapshotMode=role==='autosend'?(env.MCPGO_AUTOSEND_SNAPSHOT_MODE??'full'):
    (env.MCPGO_BROWSER_SNAPSHOT_MODE??'full');
  if(!['full','none'].includes(snapshotMode))
    throw Error('Invalid Playwright snapshot mode');
  const args=[join(baseDir,'node_modules/@playwright/mcp/cli.js'),
    '--host','127.0.0.1','--port',String(port),
    '--caps','vision,devtools','--block-service-workers','--no-webmcp',
    '--output-dir',join(baseDir,role==='autosend'?'artifacts/autosend':'artifacts/shared'),
    '--timeout-navigation','45000','--timeout-settle',String(settle),
    '--snapshot-mode',snapshotMode];
  // Disable Playwright MCP's server-to-client HTTP heartbeat; a missed ping must not
  // destroy the shared MCP backend session. A user override remains possible.
  const childEnv={...env,TMPDIR:join(baseDir,'.cache/tmp/')+'/',PWTEST_SOCKETS_DIR:join(baseDir,'.s'),
    PLAYWRIGHT_MCP_PING_TIMEOUT_MS:env.PLAYWRIGHT_MCP_PING_TIMEOUT_MS??'0'};
  {
    const token=extensionToken(env,settingsDir);
    childEnv.PLAYWRIGHT_MCP_EXTENSION_TOKEN=token;
    childEnv.PLAYWRIGHT_MCP_SESSION_NAME=role==='autosend'?'MCPGO AutoSend':'MCPGO';
    childEnv.PLAYWRIGHT_MCP_SESSION_COLOR=role==='autosend'?'blue':'purple';
    // One backend process per extension client/group. AutoSend never uses the
    // MCPGo Browser agent's shared tab group or its tab-index registry.
    args.push('--extension','--background','--shared-browser-context');
    const profile=(env.MCPGO_CHROME_PROFILE_DIR || optionalSetting(settingsDir,'chrome-profile') ||
      detectUniqueExtensionProfile() || '').trim();
    if(profile) {
      if (!/^[A-Za-z0-9 _.-]{1,100}$/.test(profile) || profile==='.' || profile==='..')
        throw Error('Invalid Chrome profile directory name');
      args.push('--profile-dir-name',profile);
    }
  }
  return {mode,port,args,env:childEnv,role};
}

function main() {
  let cfg;
  const role=process.argv.includes('--autosend')?'autosend':'browser';
  try { cfg=browserConfig({role}); }
  catch(e) {
    console.error('McpGo browser setup:',e.message);
    // AutoSend uses launchd KeepAlive on failure; missing credentials are not a crash.
    const status=extensionStatus();
    process.exitCode=role==='autosend'&&!status.configured?0:2;
    return;
  }
  console.log('Playwright '+cfg.mode+' connecting to existing Chrome on 127.0.0.1:'+cfg.port+' (shared safe proxy)');
  const child=spawn(process.execPath,[...cfg.args,...process.argv.slice(2).filter(a=>a!=='--autosend')],{cwd:mcp,env:cfg.env,stdio:'inherit'});
  for(const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>child.kill(signal));
  child.on('error',e=>{console.error('Browser launch failed:',e.code);process.exitCode=1;});
  child.on('exit',(code,signal)=>{process.exitCode=code??(signal?1:0);});
}

if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) main();
