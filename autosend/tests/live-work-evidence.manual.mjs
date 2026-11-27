// Manual MCP-05 read-only two-repository integration exercise.
// No ChatGPT messages, no modifications to GitHub or user task state.
// Run explicitly: node autosend/tests/live-work-evidence.manual.mjs
import assert from 'node:assert/strict';
import {createGitHubReadOnlyGetter,verifyGitHubWork} from '../github-work-adapter.mjs';
import {KNOWN_WORK_PROFILES,KNOWN_WORK_POLICIES,inspectWorkResult,
  commitObservedWorkResult} from '../work-result.mjs';
import {workEfficiency} from '../smart-work-ready.mjs';

const targets=[
 {name:'TD_BENCHO_VARIANTS',project:'TD',prNumber:14,
  policy:KNOWN_WORK_PROFILES.TD_BENCHO_VARIANTS,
  before:'2026-11-26T06:00:00.000Z'},
 {name:'MUSEUM_MVP',project:'Museum',prNumber:159,
  policy:KNOWN_WORK_POLICIES.Museum,
  before:'2026-11-26T06:00:00.000Z'}
];
for(const item of targets){
 const getJson=await createGitHubReadOnlyGetter({repo:item.policy.repo});
 assert.equal(typeof getJson,'function',
  item.name+': missing noninteractive GitHub read-only credential');
 const pr=await getJson('/pulls/'+item.prNumber);
 assert.ok(pr?.head?.sha,item.name+': PR is not readable');
 const task={id:'isolated-mcp05-'+item.name,smart_v2_project:item.project,
  last_success_at:item.before};
 const outcome={kind:'report',fingerprint:'b'.repeat(64),
  githubPrNumber:item.prNumber,report:{status:'VERIFIED',task:item.name},
  workEvidence:{source:'assistant_self_report',files_changed:1,
   tests_passed:1,tests_failed:0,commit:pr.head.sha}};
 const proof=await verifyGitHubWork(task,outcome,{policy:item.policy,getJson});
 assert.equal(proof?.verified,true,item.name+': Git/CI/steps not verified');
 assert.equal(proof.testsVerified,true);
 assert.equal(proof.workflows.length,item.policy.requiredWorkflows.length);
 const verified=await inspectWorkResult(task,outcome,{policy:item.policy,
  verify:async()=>proof});
 assert.equal(verified?.verified,true,item.name+': WORK_RESULT rejected proof');
 assert.equal(commitObservedWorkResult(task,verified),true);
 assert.equal(workEfficiency(task).verified_work_results,1);
 assert.equal(commitObservedWorkResult(task,verified),false,'duplicate must be idempotent');
 console.log('READONLY_PROJECT='+item.project+' PROFILE='+item.name+
  ' PR='+item.prNumber+' CI='+proof.workflows.length+
  ' TEST_JOBS=PASS WORK_RESULT=VERIFIED DUPLICATE=BLOCKED');
}
console.log('MCP05_EXTERNAL_TWO_REPOS_READONLY=PASS USER_TASK_WRITES=0 SEND=0');
