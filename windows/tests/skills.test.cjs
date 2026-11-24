'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {SKILL_IDS,readSkill,textForChat}=require('../app/skills.cjs');
const repo=path.resolve(__dirname,'../..');

test('Windows exposes four bundled, portable skills with fixed identifiers',()=>{
 assert.deepEqual(SKILL_IDS,['terminalhub-operations','playwrighthub-qa','agent-coordination','tunnel-diagnostics']);
 for(const id of SKILL_IDS){
  const skill=readSkill(repo,id);
  assert.equal(skill.id,id);
  assert.match(skill.file,new RegExp(id+'[/\\\\]SKILL\\.md$'));
  assert.ok(skill.content.length>100);
  assert.match(textForChat(skill.content),/не предоставляет дополнительные права/);
  assert.ok(textForChat(skill.content).endsWith(skill.content));
 }
 const packageData=require('../package.json');
 const resource=packageData.build.extraResources.find(x=>x.to==='mcpgo-runtime/skills');
 assert.deepEqual(resource,{from:'../skills',to:'mcpgo-runtime/skills',filter:['*/SKILL.md']});
});

test('skill reader rejects path traversal and arbitrary renderer-provided identifiers',()=>{
 for(const id of ['../settings.json','../../secret','',null,{},'terminalhub-operations/SKILL.md'])
  assert.throws(()=>readSkill(repo,id),/INVALID_SKILL/);
});

test('skill reader refuses non-files and oversized instructions',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'mcpgo-skill-test-'));
 try{
  const dir=path.join(root,'skills','terminalhub-operations');
  fs.mkdirSync(dir,{recursive:true});
  fs.mkdirSync(path.join(dir,'SKILL.md'));
  assert.throws(()=>readSkill(root,'terminalhub-operations'),/INVALID_SKILL_FILE/);
  fs.rmSync(path.join(dir,'SKILL.md'),{recursive:true});
  fs.writeFileSync(path.join(dir,'SKILL.md'),'x'.repeat(256*1024+1));
  assert.throws(()=>readSkill(root,'terminalhub-operations'),/INVALID_SKILL_FILE/);
 }finally{fs.rmSync(root,{recursive:true,force:true})}
});
