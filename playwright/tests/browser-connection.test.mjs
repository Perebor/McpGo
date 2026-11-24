import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {browserConfig,extensionStatus} from '../../launchers/browser.mjs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

function withSettings(run) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mcpgo-browser-test-'));
  try {run(dir);} finally {fs.rmSync(dir,{recursive:true,force:true});}
}

test('default backend requires official extension credentials',()=>{
 withSettings(dir=>{
  assert.throws(()=>browserConfig({env:{},settingsDir:dir,baseDir:'/tmp/playwright'}),/not configured/);
 });
});

test('token enables one persistent Playwright Extension browser shared between HTTP sessions',()=>{
  withSettings(dir=>{
    fs.writeFileSync(path.join(dir,'browser-mode'),'extension\n',{mode:0o600});
    fs.writeFileSync(path.join(dir,'extension-token'),'abcdefghijklmnopqrstuvwxyz012345\n',{mode:0o600});
    const cfg=browserConfig({env:{},settingsDir:dir,baseDir:'/tmp/playwright'});
    assert.equal(cfg.mode,'extension');
    assert.ok(cfg.args.includes('--extension'));
    assert.ok(cfg.args.includes('--background'));
    assert.ok(cfg.args.includes('--shared-browser-context'));
    assert.ok(!cfg.args.includes('--cdp-endpoint'));
    assert.equal(cfg.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN,'abcdefghijklmnopqrstuvwxyz012345');
    assert.equal(cfg.env.PLAYWRIGHT_MCP_SESSION_NAME,'MCPGO');
    assert.equal(cfg.env.PLAYWRIGHT_MCP_SESSION_COLOR,'purple');
    assert.ok(!cfg.args.join(' ').includes('abcdefghijklmnopqrstuvwxyz012345'));
  });
});

test('extension without token fails closed',()=>{
  withSettings(dir=>{
    assert.throws(()=>browserConfig({env:{MCPGO_BROWSER_MODE:'extension'},settingsDir:dir}),/not configured/);
  });
});

test('extension refuses insecure token files and invalid mode',()=>{
  withSettings(dir=>{
    fs.writeFileSync(path.join(dir,'extension-token'),'abcdefghijklmnopqrstuvwxyz012345',{mode:0o644});
    assert.throws(()=>browserConfig({env:{MCPGO_BROWSER_MODE:'extension'},settingsDir:dir}),/private regular file/);
    assert.throws(()=>browserConfig({env:{MCPGO_BROWSER_MODE:'unexpected'},settingsDir:dir}),/Only the official Playwright/);
  });
});

test('CDP is unsupported and Chrome profile remains configurable',()=>{
  withSettings(dir=>{
    fs.writeFileSync(path.join(dir,'chrome-profile'),'Profile 1\n');
    const cfg=browserConfig({env:{MCPGO_BROWSER_MODE:'extension',PLAYWRIGHT_MCP_EXTENSION_TOKEN:'abcdefghijklmnopqrstuvwxyz012345'},settingsDir:dir});
    assert.deepEqual(cfg.args.slice(-2),['--profile-dir-name','Profile 1']);
    assert.throws(()=>browserConfig({env:{MCPGO_BROWSER_MODE:'cdp'},settingsDir:dir}),/CDP has been removed/);
  });
});

test('setup script rejects legacy CDP mode and never writes its config',()=>{
 withSettings(home=>{
  const script=fileURLToPath(new URL('../configure-extension.sh',import.meta.url));
  const res=spawnSync('bash',[script,'--cdp'],{env:{...process.env,HOME:home},encoding:'utf8'});
  assert.equal(res.status,2);
  assert.match(res.stderr,/removed/);
 });
});
test('AutoSend is a dedicated client group and does not have a CDP fallback',()=>{
 const cfg=browserConfig({role:'autosend',
  env:{PLAYWRIGHT_MCP_EXTENSION_TOKEN:'abcdefghijklmnopqrstuvwxyz012345'},
  settingsDir:'/nonexistent'});
 assert.equal(cfg.port,8932);
 assert.equal(cfg.env.PLAYWRIGHT_MCP_SESSION_NAME,'MCPGO AutoSend');
 assert.equal(cfg.env.PLAYWRIGHT_MCP_SESSION_COLOR,'blue');
 assert.ok(cfg.args.includes('--extension'));
 assert.ok(cfg.args.includes('--shared-browser-context'));
 assert.ok(cfg.args.join(' ').includes('artifacts/autosend'));
 assert.ok(!cfg.args.includes('--cdp-endpoint'));
});
test('setup does not accept a token on a non-interactive stdin',()=>{
  withSettings(home=>{
    const script=fileURLToPath(new URL('../configure-extension.sh',import.meta.url));
    const res=spawnSync('bash',[script,'--extension'],{env:{...process.env,HOME:home},encoding:'utf8',input:'fake-token'});
    assert.equal(res.status,2);
    assert.equal(fs.existsSync(path.join(home,'Library/Application Support/McpGo/playwright/extension-token')),false);
  });
});

test('trial mode can use a separate localhost port without changing the live backend',()=>{
  withSettings(dir=>{
    const cfg=browserConfig({env:{MCPGO_PLAYWRIGHT_PORT:'8999',PLAYWRIGHT_MCP_EXTENSION_TOKEN:'abcdefghijklmnopqrstuvwxyz012345'},settingsDir:dir});
    const index=cfg.args.indexOf('--port');
    assert.equal(cfg.port,8999);
    assert.equal(cfg.args[index+1],'8999');
    assert.throws(()=>browserConfig({env:{MCPGO_PLAYWRIGHT_PORT:'0',PLAYWRIGHT_MCP_EXTENSION_TOKEN:'abcdefghijklmnopqrstuvwxyz012345'},settingsDir:dir}),/port/);
    assert.throws(()=>browserConfig({env:{MCPGO_PLAYWRIGHT_PORT:'70000',PLAYWRIGHT_MCP_EXTENSION_TOKEN:'abcdefghijklmnopqrstuvwxyz012345'},settingsDir:dir}),/port/);
  });
});

test('browser settle is bounded and AutoSend retains conservative defaults',()=>{
 const env={PLAYWRIGHT_MCP_EXTENSION_TOKEN:'abcdefghijklmnopqrstuvwxyz012345'};
 const browser=browserConfig({role:'browser',env,settingsDir:'/nonexistent'});
 const autosend=browserConfig({role:'autosend',env,settingsDir:'/nonexistent'});
 const settle=args=>args[args.indexOf('--timeout-settle')+1];
 assert.equal(settle(browser.args),'200');
 assert.equal(settle(autosend.args),'500');
 assert.equal(settle(browserConfig({role:'browser',env:{...env,MCPGO_BROWSER_SETTLE_MS:'100'},settingsDir:'/nonexistent'}).args),'100');
 assert.throws(()=>browserConfig({env:{...env,MCPGO_BROWSER_SETTLE_MS:'-1'},settingsDir:'/nonexistent'}),/settle timeout/);
 assert.throws(()=>browserConfig({env:{...env,MCPGO_BROWSER_SETTLE_MS:'99999'},settingsDir:'/nonexistent'}),/settle timeout/);
});

test('snapshot mode is conservative and opt-in for both browser clients',()=>{
 const env={PLAYWRIGHT_MCP_EXTENSION_TOKEN:'abcdefghijklmnopqrstuvwxyz012345'};
 const mode=args=>args[args.indexOf('--snapshot-mode')+1];
 assert.equal(mode(browserConfig({env,settingsDir:'/nonexistent'}).args),'full');
 assert.equal(mode(browserConfig({role:'autosend',env,settingsDir:'/nonexistent'}).args),'full');
 assert.equal(mode(browserConfig({env:{...env,MCPGO_BROWSER_SNAPSHOT_MODE:'none'},settingsDir:'/nonexistent'}).args),'none');
 assert.throws(()=>browserConfig({env:{...env,MCPGO_BROWSER_SNAPSHOT_MODE:'invalid'},settingsDir:'/nonexistent'}),/snapshot mode/);
});

test('extension preflight agrees with launch and does not expose the token',()=>{
 withSettings(dir=>{
  const opts={env:{},settingsDir:dir};
  const tokenFile=path.join(dir,'extension-token');
  assert.deepEqual(extensionStatus(opts),{configured:false,code:'EXTENSION_TOKEN_MISSING'});
  fs.writeFileSync(tokenFile,'bad',{mode:0o600});
  assert.equal(extensionStatus(opts).code,'EXTENSION_TOKEN_INVALID');
  fs.writeFileSync(tokenFile,'abcdefghijklmnopqrstuvwxyz012345');
  fs.chmodSync(tokenFile,0o644);
  assert.equal(extensionStatus(opts).code,'EXTENSION_TOKEN_UNSAFE');
  fs.chmodSync(tokenFile,0o600);
  assert.deepEqual(extensionStatus(opts),{configured:true,code:'EXTENSION_CONFIGURED'});
  for(const role of ['browser','autosend'])assert.equal(browserConfig({...opts,role}).mode,'extension');
 });
});

test('AutoSend launcher does not restart-loop before token configuration',()=>{
 withSettings(home=>{
  const launcher=fileURLToPath(new URL('../../launchers/browser.mjs',import.meta.url));
  const env={...process.env,HOME:home,MCPGO_BROWSER_MODE:'extension'};
  delete env.PLAYWRIGHT_MCP_EXTENSION_TOKEN;
  const result=spawnSync(process.execPath,[launcher,'--autosend'],{env,encoding:'utf8'});
  assert.equal(result.status,0);
  assert.match(result.stderr,/EXTENSION_TOKEN_MISSING/);
  const normal=spawnSync(process.execPath,[launcher],{env,encoding:'utf8'});
  assert.equal(normal.status,2);
 });
});
