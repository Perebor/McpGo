import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {newTask,readState,writeState,getOrCreateControlToken} from '../core.mjs';
const url='https://chatgpt.com/c/00000000-0000-4000-8000-000000000001';
test('private JSON store encrypts message content and detects tampering',()=>{
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'autosend-secure-'));
 const file=path.join(folder,'tasks.json');
 try{
  const task=newTask({url,message:'PRIVATE_AUTOSEND_CONTENT_2026',interval_seconds:60});
  writeState({version:1,tasks:[task],attempts:[]},file);
  const raw=fs.readFileSync(file,'utf8');
  assert.ok(!raw.includes('PRIVATE_AUTOSEND_CONTENT_2026'));
  assert.ok(raw.includes('sealed_message'));
  const after=readState(file);
  assert.equal(after.tasks[0].message,task.message);
  const stored=JSON.parse(raw);
  stored.tasks[0].sealed_message.ciphertext='AA==';
  fs.writeFileSync(file,JSON.stringify(stored));
  assert.throws(()=>readState(file));
  assert.equal(fs.statSync(path.join(folder,'message-key')).mode&0o777,0o600);
 }finally{fs.rmSync(folder,{recursive:true,force:true});}
});
test('legacy v1 plaintext tasks migrate to ciphertext on the next write',()=>{
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'autosend-migrate-'));
 const file=path.join(folder,'tasks.json');
 try{
  const old={version:1,tasks:[newTask({url,message:'legacy unsealed',interval_seconds:60})],attempts:[]};
  fs.writeFileSync(file,JSON.stringify(old),{mode:0o600});
  const loaded=readState(file);
  writeState(loaded,file);
  assert.ok(!fs.readFileSync(file,'utf8').includes('legacy unsealed'));
  assert.equal(readState(file).tasks[0].message,'legacy unsealed');
 }finally{fs.rmSync(folder,{recursive:true,force:true});}
});
test('local control token is stable and rejects unsafe symlinks',()=>{
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'autosend-token-'));
 try{
  const filename=path.join(folder,'token');
  const token=getOrCreateControlToken(filename);
  assert.match(token,/^[a-f0-9]{64}$/);
  assert.equal(getOrCreateControlToken(filename),token);
  assert.equal(fs.statSync(filename).mode&0o777,0o600);
  const link=path.join(folder,'symlink');fs.symlinkSync(filename,link);
  assert.throws(()=>getOrCreateControlToken(link));
 }finally{fs.rmSync(folder,{recursive:true,force:true});}
});
