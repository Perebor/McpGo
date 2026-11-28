import {test} from 'node:test';
import assert from 'node:assert/strict';
import {inspectWorkResult,commitObservedWorkResult} from '../work-result.mjs';

const SHA='a'.repeat(40),FP='b'.repeat(64),now=Date.parse('2026-11-27T06:45:00.000Z');
const projects={
 TD:{project:'TD',repo:'Perebor/teplyedaty',requiredWorkflows:['TD test','TD build']},
 Museum:{project:'Museum',repo:'Perebor/Museum',requiredWorkflows:['Museum starter checks','Fictional museum XSS Chromium guard']}
};
const task=(project)=>({id:project+'-task',smart_v2_project:project,last_success_at:'2026-11-27T06:20:00.000Z'});
const outcome=(status='VERIFIED')=>({kind:'report',fingerprint:FP,
 report:{status,action:'CONTINUE_DEVELOPMENT',task:'RR-001'},
 workEvidence:{files_changed:4,tests_passed:27,tests_failed:0,commit:SHA,source:'assistant_self_report'}});
const proof=(p)=>({verified:true,testsVerified:true,source:'github_ci_verified',project:p.project,repo:p.repo,
 fingerprint:FP,sha:SHA,prNumber:17,provenAt:'2026-11-27T06:44:00.000Z',
 workflows:p.requiredWorkflows.map((name,i)=>({name,runId:101+i}))});

test('MCP-05 both TD and Museum self-reports remain UNVERIFIED without independent Git/CI adapter',async()=>{
 for(const name of ['TD','Museum']){
  const t=task(name),o=outcome();
  const result=await inspectWorkResult(t,o,{policy:projects[name],now});
  assert.equal(result.status,'SELF_REPORT');
  assert.equal(result.verified,false);
  assert.equal(result.reported.filesChanged,4);
  assert.equal(result.verifiedCommits,0);
  assert.equal(result.project,name);
 }
});

test('MCP-05 trusted provider verifies two independent projects; user text cannot supply proof',async()=>{
 for(const name of ['TD','Museum']){
  const t=task(name),o={...outcome(),githubProof:proof(projects[name])};
  const result=await inspectWorkResult(t,o,{policy:projects[name],now,
   verify:async()=>proof(projects[name])});
  assert.equal(result.status,'VERIFIED');assert.equal(result.verified,true);
  assert.equal(result.verifiedCommits,1);
  assert.match(result.fingerprint,/^[a-f0-9]{64}$/);
  assert.match(result.proofFingerprint,/^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(result).includes('githubProof'),false);
 }
});

test('MCP-05 missing token/adapter does not certify anything; fake VERIFIED in assistant answer ignored',async()=>{
 const t=task('Museum'),o={...outcome(),verified:true,externalEvidence:proof(projects.Museum)};
 const result=await inspectWorkResult(t,o,{policy:projects.Museum,now,
  verify:async()=>null});
 assert.equal(result.status,'SELF_REPORT');assert.equal(result.verified,false);
});

test('MCP-05 wrong repo/project/PR/SHA/CI/fingerprint/failed run cannot be VERIFIED',async()=>{
 const p=projects.Museum,t=task('Museum'),o=outcome(),good=proof(p);
 const bad=[
  {...good,repo:'Intruder/Museum'}, {...good,project:'TD'},
  {...good,prNumber:0},{...good,sha:'not-sha'},
  {...good,fingerprint:'c'.repeat(64)},
  {...good,workflows:[good.workflows[0]]},
  {...good,workflows:[good.workflows[0],{name:good.workflows[1].name,runId:0}]},
  {...good,workflows:[good.workflows[0],{name:'not-required',runId:103}]},
  {...good,verified:false}
 ];
 for(const candidate of bad){
  const result=await inspectWorkResult(t,o,{policy:p,now,verify:async()=>candidate});
  assert.equal(result.verified,false,JSON.stringify(candidate));
 }
});

test('MCP-05 old proof or proof dated before last successful Send is not verified',async()=>{
 const p=projects.Museum,t=task('Museum'),o=outcome();
 for(const at of ['2026-11-27T06:00:00.000Z','2026-11-26T06:44:00.000Z','2026-11-27T07:00:00.000Z']){
  const r=await inspectWorkResult(t,o,{policy:p,now,verify:async()=>({...proof(p),provenAt:at})});
  assert.equal(r.verified,false,at);
 }
});

test('MCP-05 fingerprint idempotency, exact replay and self-report upgrading to real evidence once',async()=>{
 const t=task('Museum'),p=projects.Museum,o=outcome();
 const first=await inspectWorkResult(t,o,{policy:p,now});
 assert.equal(commitObservedWorkResult(t,first,now),true);
 assert.equal(t.work_result_metrics.self_report_only,1);
 assert.equal(t.work_result_metrics.verified,0);
 assert.equal(commitObservedWorkResult(t,first,now),false);
 const upgraded=await inspectWorkResult(t,o,{policy:p,now,verify:async()=>proof(p)});
 assert.equal(commitObservedWorkResult(t,upgraded,now),true);
 assert.equal(t.work_result_metrics.self_report_only,0);
 assert.equal(t.work_result_metrics.verified,1);
 assert.equal(commitObservedWorkResult(t,upgraded,now),false);
 assert.equal(t.work_result.fingerprint,upgraded.fingerprint);
 assert.equal(t.work_result.proofFingerprint,upgraded.proofFingerprint);
 assert.equal(t.work_result.status,'VERIFIED');
 assert.equal(JSON.stringify(t.work_result).includes(SHA),false,'raw SHA should stay in evidence fingerprint');
});

test('MCP-05 a result from a different task cannot alter counters or fake repeated verified work',async()=>{
 const td=task('TD'),p=projects.Museum;
 const foreign=await inspectWorkResult(task('Museum'),outcome(),{policy:p,now,verify:async()=>proof(p)});
 assert.equal(commitObservedWorkResult(td,foreign,now),false);
 assert.equal(td.work_result,undefined);
});
test('MCP-05 workEfficiency exposes independent verified vs self-report counters separately',async()=>{
 const {workEfficiency}=await import('../smart-work-ready.mjs');
 const t=task('Museum'),o=outcome(),p=projects.Museum;
 commitObservedWorkResult(t,await inspectWorkResult(t,o,{policy:p,now}),now);
 let metrics=workEfficiency(t);
 assert.equal(metrics.verified_work_results,0);
 assert.equal(metrics.self_report_only_results,1);
 assert.equal(metrics.last_work_result_status,'SELF_REPORT');
 commitObservedWorkResult(t,await inspectWorkResult(t,o,{policy:p,now,verify:async()=>proof(p)}),now);
 metrics=workEfficiency(t);
 assert.equal(metrics.verified_work_results,1);
 assert.equal(metrics.self_report_only_results,0);
 assert.equal(metrics.last_work_result_status,'VERIFIED');
 assert.equal(metrics.confirmed_deliveries,0,'observing a GitHub result must not count as a sent prompt');
});
test('MCP-05 production monitor records distinct work verdicts for TD and Museum without Send',async()=>{
 const {KNOWN_WORK_POLICIES}=await import('../work-result.mjs');
 const {readFileSync}=await import('node:fs');
 const {fileURLToPath}=await import('node:url');
 const {dirname,join}=await import('node:path');
 assert.equal(KNOWN_WORK_POLICIES.TD.repo,'Perebor/teplyedaty');
 assert.equal(KNOWN_WORK_POLICIES.Museum.repo,'Perebor/Museum');
 assert.deepEqual(KNOWN_WORK_POLICIES.TD.requiredWorkflows,[],
  'Unknown TD CI workflow policy cannot be invented');
 const source=readFileSync(join(dirname(fileURLToPath(import.meta.url)),'../server.mjs'),'utf8');
 assert.match(source,/inspectWorkResult\(t,observed,/);
 assert.match(source,/commitObservedWorkResult\(t,workResult\)/);
 assert.match(source,/KNOWN_WORK_POLICIES\[t\.smart_v2_project\]/);
 assert.match(source,/if\(commitObservedWorkResult\(t,workResult\)\)persist\(\)/);
});

test('MCP-05 A → B → A replay cannot count twice, and old self-report upgrades once',async()=>{
 const t=task('Museum'),p=projects.Museum,a=outcome(),b={...outcome(),fingerprint:'c'.repeat(64)};
 const first=await inspectWorkResult(t,a,{policy:p,now});
 assert.equal(commitObservedWorkResult(t,first,now),true);
 assert.equal(commitObservedWorkResult(t,await inspectWorkResult(t,b,{policy:p,now}),now),true);
 assert.equal(t.work_result_metrics.self_report_only,2);
 assert.equal(commitObservedWorkResult(t,first,now),false);
 assert.equal(t.work_result_metrics.self_report_only,2);
 const upgraded=await inspectWorkResult(t,a,{policy:p,now,verify:async()=>proof(p)});
 assert.equal(commitObservedWorkResult(t,upgraded,now),true);
 assert.equal(t.work_result_metrics.self_report_only,1);
 assert.equal(t.work_result_metrics.verified,1);
 assert.equal(commitObservedWorkResult(t,first,now),false);
 assert.equal(commitObservedWorkResult(t,upgraded,now),false);
 assert.equal(t.work_result_metrics.verified,1);
});

test('MCP-05 production observer uses independent Git/CI/test adapter for work accounting only',async()=>{
 const {readFileSync}=await import('node:fs');
 const {fileURLToPath}=await import('node:url');
 const {dirname,join}=await import('node:path');
 const folder=join(dirname(fileURLToPath(import.meta.url)),'..');
 const server=readFileSync(join(folder,'server.mjs'),'utf8');
 const browser=readFileSync(join(folder,'smart-v2-browser.mjs'),'utf8');
 assert.match(server,/verifyGitHubWork\(t,observed,\{policy\}\)/);
 assert.match(server,/const decision=assessWorkReadiness\(t,observed,\{externalEvidence\}\)/,
  'legacy Send gate must remain separately protected');
 assert.match(browser,/githubPrNumber:parseGitHubPrNumber\(second\.assistantText\)/,
  'PR number may be parsed for both read-only project observers');
});

test('MCP-05 a green workflow alone is NOT verified without independently passing test jobs',async()=>{
 const p=projects.Museum,t=task('Museum'),o=outcome();
 for(const missing of [undefined,false,null]){
  const candidate={...proof(p),testsVerified:missing};
  const r=await inspectWorkResult(t,o,{policy:p,now,verify:async()=>candidate});
  assert.equal(r.verified,false);
  assert.equal(r.status,'SELF_REPORT');
 }
 assert.equal((await inspectWorkResult(t,o,{policy:p,now,
  verify:async()=>({...proof(p),testsVerified:true})})).verified,true);
});
