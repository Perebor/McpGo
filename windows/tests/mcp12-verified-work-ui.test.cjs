'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const src=fs.readFileSync(path.join(__dirname,'../app/renderer.js'),'utf8');
test('MCP-12 UI shows linked independently verified Git results separately from chat replies',()=>{
 assert.match(src,/verified_git_work_links/);
 assert.match(src,/Git\/CI/);
 assert.match(src,/по времени|временн/i);
 assert.match(src,/точные вызовы моделей, токены и стоимость: UNKNOWN/);
});
test('MCP-12 work result label cannot imply causality or provider-billed tokens',()=>{
 assert.doesNotMatch(src,/экономия.*\d+\s*(руб|₽|%)/i);
 assert.match(src,/не.*причинн|не.*доказыва/i);
});
