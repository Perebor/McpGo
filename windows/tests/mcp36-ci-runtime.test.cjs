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
});
