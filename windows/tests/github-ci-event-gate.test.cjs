'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const root=path.resolve(__dirname,'../..','autosend');
const get=name=>import(pathToFileURL(path.join(root,name)).href);
const SHA='d783a398025179c62b5bf39cb03e85f7fbd33367';
const FP='a'.repeat(64);
const PR={
 number:159,state:'open',draft:true,merged:false,created_at:'2026-11-26T15:45:09Z',
 head:{sha:SHA,ref:'integration/museum-mvp-20261126',repo:{full_name:'Perebor/Museum'}},
 base:{ref:'main',repo:{full_name:'Perebor/Museum'}}
};
const run=(name,id,extras={})=>({
 id,name,head_sha:SHA,event:'pull_request',status:'completed',conclusion:'success',
 pull_requests:[{number:159}],run_number:id,created_at:'2026-11-26T15:46:00Z',...extras
});
const RUNS={workflow_runs:[
 run('Museum starter checks',10),
 run('Fictional museum XSS Chromium guard',12)
]};
const task=()=>({
 id:'1fdf7be0-6362-4a6b-90aa-d3402ac5144f',url:'https://chatgpt.com/g/g-p-moi-muzei-istoriia/c/11111111-1111-4111-8111-111111111111',smart_v2:true,smart_v2_project:'Museum',
 smart_result_gate:true,schedule_mode:'after_response',enabled:true,status:'scheduled',
 last_success_at:'2026-11-26T15:41:20.021Z',
 smart_v2_last_action:'BOOTSTRAP',next_at:null,delivery_count:36,
 message:'Only museum authorized. OWNER_CONSENT_20261126_MUSEUM_BRANCH_PR_CI'
});
const outcome=()=>({
 kind:'report',report:{status:'IN_PROGRESS',action:'CONTINUE_CURRENT',task:'REL-001'},
 fingerprint:FP,githubPrNumber:159,
 workEvidence:{files_changed:0,tests_passed:0,tests_failed:0,commit:'NONE'}
});
const provider=(pr=PR,runs=RUNS)=>{
 const requests=[];
 return {requests,getJson:async(url)=>{requests.push(url);
  if(url==='/pulls/159')return structuredClone(pr);
  if(url.startsWith('/actions/runs?'))return structuredClone(runs);
  throw Error('unexpected remote URL '+url);
 }};
};
test('only one unambiguous owner-report PR number is eligible; do not follow URLs',async()=>{
 const {parseGitHubPrNumber}=await get('github-ci-evidence.mjs');
 assert.equal(parseGitHubPrNumber('PR №159 — интеграция MVP'),159);
 assert.equal(parseGitHubPrNumber('Draft PR #159, проверяем PR №159'),159);
 assert.equal(parseGitHubPrNumber('PR №159 — интеграция MVP\nФайлов в PR\n37\nPR №159'),159);
 assert.equal(parseGitHubPrNumber('PR #159 и PR #160'),null);
 assert.equal(parseGitHubPrNumber('PR 0'),null);
 assert.equal(parseGitHubPrNumber('PR https://evil.example/159'),null);
});
test('private GitHub evidence proves exact open Museum PR head, successful linked CI and creation after last send',async()=>{
 const {verifyGitHubCI}=await get('github-ci-evidence.mjs');
 const fake=provider();
 const proof=await verifyGitHubCI(task(),outcome(),{getJson:fake.getJson});
 assert.equal(proof.verified,true);
 assert.equal(proof.source,'github_ci_verified');
 assert.equal(proof.sha,SHA);
 assert.equal(proof.prNumber,159);
 assert.equal(proof.fingerprint,FP);
 assert.equal(proof.workflows.length,2);
 assert.equal(fake.requests.length,2);
 assert.deepEqual(fake.requests[0],'/pulls/159');
 assert.match(fake.requests[1],/head_sha=d783a398025179c62b5bf39cb03e85f7fbd33367/);
});
test('fail closed for paused/NEED_OWNER/no explicit consent, no GitHub request',async()=>{
 const {verifyGitHubCI}=await get('github-ci-evidence.mjs');
 for(const change of [
  {enabled:false},{status:'paused'},
  {smart_v2_project:'TD'},{message:'no explicit repo permission'},
  {verification:{actionId:'unknown'}},{smart_v2_pending_action:'CONTINUE_CURRENT'}
 ]){
  const fake=provider(),t={...task(),...change};
  const proof=await verifyGitHubCI(t,outcome(),{getJson:fake.getJson});
  assert.equal(proof,null);
  assert.equal(fake.requests.length,0);
 }
 const fake=provider();
 const o={...outcome(),report:{status:'NEED_OWNER',action:'NEED_OWNER',task:'REL-001'}};
 assert.equal(await verifyGitHubCI(task(),o,{getJson:fake.getJson}),null);
 assert.equal(fake.requests.length,0);
});
test('rejects forged repository, foreign branch, stale PR, wrong hash, closed/non-draft PR',async()=>{
 const {verifyGitHubCI}=await get('github-ci-evidence.mjs');
 for(const pr of [
  {...PR,head:{...PR.head,repo:{full_name:'Other/Museum'}}},
  {...PR,head:{...PR.head,ref:'main'}},
  {...PR,created_at:'2026-11-25T10:00:00Z'},
  {...PR,head:{...PR.head,sha:'a'.repeat(40)}},
  {...PR,state:'closed'},
  {...PR,draft:false}
 ]){
  const fake=provider(pr);
  assert.equal(await verifyGitHubCI(task(),outcome(),{getJson:fake.getJson}),null);
 }
});
test('checks latest PR-triggered run for each required workflow: pending, failed, stale and unrelated never count',async()=>{
 const {verifyGitHubCI}=await get('github-ci-evidence.mjs');
 for(const runs of [
  {workflow_runs:[RUNS.workflow_runs[0]]},
  {workflow_runs:[run('Museum starter checks',15,{status:'in_progress',conclusion:null}),...RUNS.workflow_runs]},
  {workflow_runs:[run('Museum starter checks',15,{conclusion:'failure'}),...RUNS.workflow_runs]},
  {workflow_runs:[run('Museum starter checks',15,{head_sha:'b'.repeat(40)}),RUNS.workflow_runs[1]]},
  {workflow_runs:[run('Museum starter checks',15,{pull_requests:[{number:160}]}),RUNS.workflow_runs[1]]},
  {workflow_runs:[run('Museum starter checks',15,{event:'push'}),RUNS.workflow_runs[1]]}
 ]){
  const p=await verifyGitHubCI(task(),outcome(),{getJson:provider(PR,runs).getJson});
  assert.equal(p,null);
 }
});
test('IN_PROGRESS may proceed ONCE only with actual GitHub proof bound to this exact report',async()=>{
 const {assessWorkReadiness,commitWorkReadiness,workEfficiency}=await get('smart-work-ready.mjs');
 const t=task(),o=outcome();
 assert.equal(assessWorkReadiness(t,o).ready,false);
 const {verifyGitHubCI}=await get('github-ci-evidence.mjs');
 const externalEvidence=await verifyGitHubCI(t,o,{getJson:provider().getJson});
 const decision=assessWorkReadiness(t,o,{externalEvidence});
 assert.equal(decision.ready,true);
 assert.equal(decision.action,'CONTINUE_CURRENT');
 assert.equal(decision.evidence.source,'github_ci_verified');
 assert.equal(commitWorkReadiness(t,decision,1000),true);
 assert.equal(workEfficiency(t).externally_verified_runs,1);
 assert.equal(t.work_metrics.reported_files_changed,0);
 assert.equal(t.work_metrics.reported_tests_passed,0);
 assert.equal(assessWorkReadiness(t,o,{externalEvidence}).ready,false);
 assert.equal(assessWorkReadiness(t,o,{forDispatch:true,externalEvidence}).ready,true);
 assert.equal(assessWorkReadiness(t,{...o,fingerprint:'b'.repeat(64)},{forDispatch:true,externalEvidence}).ready,false);
 t.next_at=null;
 assert.equal(assessWorkReadiness(t,o,{externalEvidence}).ready,false);
});
test('already-armed CI event MUST revalidate at dispatch without treating its marker as a replay',async()=>{
 const {verifyGitHubCI}=await get('github-ci-evidence.mjs');
 const {assessWorkReadiness,commitWorkReadiness}=await get('smart-work-ready.mjs');
 const t=task(),o=outcome();
 const a=await verifyGitHubCI(t,o,{getJson:provider().getJson});
 const decision=assessWorkReadiness(t,o,{externalEvidence:a});
 assert.equal(commitWorkReadiness(t,decision,1000),true);
 const b=await verifyGitHubCI(t,o,{getJson:provider().getJson});
 assert.equal(b?.verified,true);
 assert.equal(assessWorkReadiness(t,o,{forDispatch:true,externalEvidence:b}).ready,true);
});
test('a verified but pre-click disarmed CI result can be restored ONCE, never with pending receipt',async()=>{
 const {verifyGitHubCI}=await get('github-ci-evidence.mjs');
 const {assessWorkReadiness,commitWorkReadiness,rearmVerifiedExternalWork}=await get('smart-work-ready.mjs');
 const t=task(),o=outcome();
 const proof=await verifyGitHubCI(t,o,{getJson:provider().getJson});
 assert.equal(commitWorkReadiness(t,assessWorkReadiness(t,o,{externalEvidence:proof}),1000),true);
 t.next_at=null;t.last_error='Нет актуального доказательства результата; новая отправка запрещена.';
 assert.equal(rearmVerifiedExternalWork(t,o,proof,2000),true);
 assert.equal(t.next_at,new Date(2000).toISOString());
 assert.equal(rearmVerifiedExternalWork(t,o,proof,3000),false);
 assert.equal(t.work_metrics.externally_verified_runs,1);
 t.next_at=null;t.verification={actionId:'unknown'};
 assert.equal(rearmVerifiedExternalWork(t,o,proof,4000),false);
});
test('armed external event stays due for safe retry if GitHub is transiently unavailable',async()=>{
 const {shouldRetryExternalVerification}=await get('smart-work-ready.mjs');
 const t=task(),o=outcome();
 t.smart_work_ready_marker=FP;t.smart_work_expected_action='CONTINUE_CURRENT';
 t.smart_work_ready_evidence={source:'github_ci_verified',prNumber:159,sha:SHA};
 t.next_at='2026-11-26T17:00:00.000Z';
 assert.equal(shouldRetryExternalVerification(t,o),true);
 assert.equal(shouldRetryExternalVerification({...t,verification:{some:'receipt'}},o),false);
 assert.equal(shouldRetryExternalVerification({...t,smart_work_ready_marker:'b'.repeat(64)},o),false);
});
test('runtime dispatcher and observer both pass GitHub verified evidence through the safe existing gate',()=>{
 const source=fs.readFileSync(path.join(root,'server.mjs'),'utf8');
 assert.match(source,/GitHubCIObserver/);
 assert.match(source,/externalEvidence/);
 assert.match(source,/assessWorkReadiness\(t,observed,\{forDispatch:true,externalEvidence\}\)/);
 assert.match(source,/assessWorkReadiness\(t,observed,\{externalEvidence\}\)/);
});
