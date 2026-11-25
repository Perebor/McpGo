'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {latestWindowsPreview,checkUpdates,safeReleaseUrl}=require('../app/updates.cjs');
const item=(version,extra={})=>({
 tag_name:'v'+version,prerelease:true,draft:false,
 assets:[{name:'McpGo.Setup.'+version+'.exe',size:160000000,digest:'sha256:'+'a'.repeat(64)}],...extra
});
test('picks only newer, actual Windows prerelease with installer',()=>{
 const r=latestWindowsPreview([
  item('2.1.0-preview.2'),item('2.1.0-preview.6',{draft:true}),
  item('2.1.0-preview.3',{prerelease:false}),
  item('2.2.0-preview.1',{assets:[]}),
  item('2.1.0-preview.1')
 ],'2.1.0-preview.1');
 assert.equal(r.version,'2.1.0-preview.2');
 assert.equal(r.url,'https://github.com/Perebor/McpGo/releases/tag/v2.1.0-preview.2');
 assert.equal(latestWindowsPreview([item('2.1.0-preview.1')],'2.1.0-preview.1').available,false);
 assert.equal(latestWindowsPreview([item('2.1.0-preview.2',{assets:[{name:'McpGo Setup 2.1.0-preview.2.exe',size:160000000}]})],'2.1.0-preview.1').available,false);
});
test('rejects alien websites and incorrect tags',()=>{
 assert.throws(()=>safeReleaseUrl('https://evil.example/next.exe'),/UNTRUSTED/);
 assert.throws(()=>safeReleaseUrl('https://github.com/Perebor/McpGo/releases/tag/v2.1.0-preview.2?test=true'),/UNTRUSTED/);
 assert.throws(()=>safeReleaseUrl('https://github.com/Perebor/McpGo/releases/tag/v2.1.0-preview.2.exe'),/UNTRUSTED/);
 assert.equal(safeReleaseUrl('https://github.com/Perebor/McpGo/releases/tag/v2.1.0-preview.2'),
 'https://github.com/Perebor/McpGo/releases/tag/v2.1.0-preview.2');
});
test('verifies response boundary and never auto-installs anything',async()=>{
 const r=await checkUpdates('2.1.0-preview.1',{fetcher:async()=>({
  ok:true,text:async()=>JSON.stringify([item('2.1.0-preview.4')])
 })});
 assert.equal(r.version,'2.1.0-preview.4');
 await assert.rejects(checkUpdates('2.1.0-preview.1',{fetcher:async()=>({
  ok:false,status:500
 })}),/RELEASE_CHECK_HTTP_500/);
});


test('installer integrity is checked against exact release metadata without running installer',async()=>{
 const {verifyInstaller}=require('../app/updates.cjs');
 const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mcpgo-integrity-fixture-'));
 try{
  const name='McpGo.Setup.2.1.0-preview.10.exe',file=path.join(dir,name),bytes=Buffer.from('fixture only');
  await fs.writeFile(file,bytes);
  const asset={name,size:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')};
  assert.equal((await verifyInstaller(file,asset)).verified,true);
  await assert.rejects(verifyInstaller(file,{...asset,sha256:'0'.repeat(64)}),/INTEGRITY/);
  await assert.rejects(verifyInstaller(file,{...asset,size:bytes.length+1}),/INTEGRITY/);
 }finally{await fs.rm(dir,{recursive:true,force:true})}
});


test('release without a valid digest is excluded; upstream is not trusted',()=>{
 assert.equal(latestWindowsPreview([item('2.1.0-preview.2',{assets:[{name:'McpGo.Setup.2.1.0-preview.2.exe',size:160000000}]})],'2.1.0-preview.1').available,false);
 assert.throws(()=>safeReleaseUrl('https://github.com/mcpgo1/McpGo/releases/tag/v2.1.0-preview.2'),/UNTRUSTED/);
 const result=latestWindowsPreview([item('2.1.0-preview.2')],'2.1.0-preview.1');
 assert.equal(result.asset.sha256,'a'.repeat(64));assert.equal(result.asset.size,160000000);
});
