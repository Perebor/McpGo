import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {detectUniqueExtensionProfile,PLAYWRIGHT_EXTENSION_ID} from '../chrome-profile.mjs';
import {browserConfig} from '../../launchers/browser.mjs';

test('autodetect selects only unambiguous official Chrome extension profile',()=>{
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'mcpgo-profile-'));
 try{
  const install=profile=>{
   const dir=path.join(folder,profile,'Extensions',PLAYWRIGHT_EXTENSION_ID,'0.5.0_0');
   fs.mkdirSync(dir,{recursive:true});
  };
  assert.equal(detectUniqueExtensionProfile({chromeRoot:folder}),null);
  install('Default');
  assert.equal(detectUniqueExtensionProfile({chromeRoot:folder}),process.platform==='darwin'?'Default':null,
    'automatic Chrome profile selection must be macOS-only');
  install('Profile 2');
  assert.equal(detectUniqueExtensionProfile({chromeRoot:folder}),null,'must not guess when multiple profiles contain the extension');
  assert.equal(detectUniqueExtensionProfile({chromeRoot:path.join(folder,'missing')}),null);
 } finally {fs.rmSync(folder,{recursive:true,force:true});}
});
test('current Mac Chrome profile resolves without exposing browser cookies',()=>{
 const cfg=browserConfig({env:{MCPGO_BROWSER_MODE:'extension',PLAYWRIGHT_MCP_EXTENSION_TOKEN:'abcdefghijklmnopqrstuvwxyz012345'},settingsDir:'/nonexistent'});
 assert.ok(cfg.args.includes('--extension'));
 assert.ok(cfg.args.includes('--shared-browser-context'));
 const pos=cfg.args.indexOf('--profile-dir-name');
 if(pos!==-1) assert.match(cfg.args[pos+1],/^(Default|Profile \d+)$/);
});
