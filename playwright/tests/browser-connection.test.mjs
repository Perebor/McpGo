import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {browserConfig} from '../../launchers/browser.mjs';
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
