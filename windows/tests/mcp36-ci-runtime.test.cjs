'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const repo=path.resolve(__dirname,'../..');
test('MCP-36 Linux verify CI runs same Node 24 SQLite-capable runtime as Windows release',()=>{
 const yml=fs.readFileSync(path.join(repo,'.github/workflows/verify.yml'),'utf8');
 const windows=fs.readFileSync(path.join(repo,'.github/workflows/windows-preview.yml'),'utf8');
 assert.match(yml,/node-version:\s*["']24["']/);
 assert.match(windows,/node-version:\s*["']24["']/);
 assert.match(yml,/node -e .*node:sqlite/);
 assert.match(yml,/node --test windows\/tests\/\*\.test\.cjs/,'CI must run explicit files, not a directory');
});

test('Windows preview CI triggers for every packaged runtime source directory',()=>{
 const workflow=fs.readFileSync(path.join(repo,'.github/workflows/windows-preview.yml'),'utf8');
 for(const event of ['push','pull_request']){
  const block=workflow.match(new RegExp('^  '+event+':\\r?\\n((?:^    .*\\r?\\n)+)','m'))?.[1];
  assert.ok(block,`${event} trigger missing`);
  for(const dir of ['windows','terminal','playwright','autosend','messaging','execution','dashboard','onboarding','skills','native']){
   assert.ok(block.includes(`'${dir}/**'`),`${event} skips packaged ${dir} source changes`);
  }
 }
});
