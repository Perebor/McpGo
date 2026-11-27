import {test} from 'node:test';
import assert from 'node:assert/strict';
import {verifyGitHubWork,createGitHubReadOnlyGetter} from '../github-work-adapter.mjs';
import {KNOWN_WORK_POLICIES} from '../work-result.mjs';

const now=Date.parse('2026-11-27T07:00:00Z');
const sha='a'.repeat(40),fp='b'.repeat(64);
const museum=KNOWN_WORK_POLICIES.Museum;
const td={project:'TD',repo:'Perebor/teplyedaty',baseBranch:'main',
 branchPrefix:'work/td-',requiredWorkflows:['Synthetic TD unit CI'],
 requiredTestJobs:{'Synthetic TD unit CI':{job:'test',step:'Synthetic TD unit tests'}}};
const task=project=>({id:project+'-task',smart_v2_project:project,last_success_at:'2026-11-27T06:00:00Z'});
const outcome=()=>({kind:'report',fingerprint:fp,githubPrNumber:159,
 report:{status:'VERIFIED',task:'RR-001'},
 workEvidence:{source:'assistant_self_report',files_changed:2,tests_passed:3,tests_failed:0,commit:sha}});
function fixtures(policy){
 const branch=policy.project==='Museum'?'integration/museum-mvp-20261127':policy.branchPrefix+'fixture';
 const pr={number:159,state:'open',draft:true,merged:false,
  created_at:'2026-11-27T06:10:00Z',updated_at:'2026-11-27T06:40:00Z',
  base:{ref:policy.baseBranch,repo:{full_name:policy.repo}},
  head:{ref:branch,sha,repo:{full_name:policy.repo}}};
 const commit={sha,commit:{committer:{date:'2026-11-27T06:20:00Z'}},
  files:[{filename:'src/app.js',status:'modified',changes:12}]};
 const runs={workflow_runs:policy.requiredWorkflows.map((name,i)=>({
  name,id:101+i,head_sha:sha,event:'pull_request',status:'completed',conclusion:'success',
  created_at:'2026-11-27T06:25:00Z',updated_at:'2026-11-27T06:35:00Z',
  pull_requests:[{number:159}]
 }))};
 const jobs=Object.fromEntries(policy.requiredWorkflows.map((name,i)=>[
  101+i,{jobs:[{id:1001+i,name:policy.requiredTestJobs[name].job,
   status:'completed',conclusion:'success',
   steps:[{name:policy.requiredTestJobs[name].step,status:'completed',conclusion:'success'}]}]}
 ]));
 return {pr,commit,runs,jobs};
}
function provider(policy,changes={}){
 const f={...fixtures(policy),...changes},seen=[];
 const getJson=async route=>{
  seen.push(route);
  if(route==='/pulls/159')return f.pr;
  if(route==='/commits/'+sha)return f.commit;
  if(route==='/actions/runs?head_sha='+sha+'&per_page=100')return f.runs;
  const m=route.match(/^\/actions\/runs\/(\d+)\/jobs\?per_page=100$/);
  return m?f.jobs[Number(m[1])]??null:null;
 };
 return {getJson,seen,fixtures:f};
}
test('MCP-05 verified Museum PR requires commit diff, two CI runs and successful test jobs',async()=>{
 const p=provider(museum);
 const result=await verifyGitHubWork(task('Museum'),outcome(),{policy:museum,getJson:p.getJson,now});
 assert.equal(result?.verified,true);
 assert.equal(result?.source,'github_ci_verified');
 assert.equal(result?.project,'Museum');
 assert.equal(result?.repo,'Perebor/Museum');
 assert.equal(result?.sha,sha);
 assert.equal(result?.prNumber,159);
 assert.equal(result?.workflows.length,2);
 assert.equal(result?.testsVerified,true);
 assert.equal(p.seen.length,5);
 assert.equal(JSON.stringify(result).includes('src/app.js'),false);
});
test('MCP-05 same adapters support fixture TD policy; live TD without CI policy fails closed',async()=>{
 const p=provider(td);
 const proof=await verifyGitHubWork(task('TD'),outcome(),{policy:td,getJson:p.getJson,now});
 assert.equal(proof?.verified,true);
 assert.equal(proof?.project,'TD');
 const q=provider(td);
 assert.equal(await verifyGitHubWork(task('TD'),outcome(),{policy:KNOWN_WORK_POLICIES.TD,getJson:q.getJson,now}),null);
 assert.equal(q.seen.length,0);
});
test('MCP-05 forged PR repo, base, branch, SHA, timestamp or report commit fail',async()=>{
 const original=fixtures(museum).pr;
 const cases=[
  {...original,head:{...original.head,repo:{full_name:'Other/Museum'}}},
  {...original,head:{...original.head,ref:'unapproved/branch'}},
  {...original,base:{...original.base,ref:'unsafe'}},
  {...original,head:{...original.head,sha:'f'.repeat(40)}},
  {...original,number:160},{...original,state:'closed'},{...original,draft:false},
  {...original,created_at:'2026-11-27T05:30:00Z'}
 ];
 for(const pr of cases)assert.equal(await verifyGitHubWork(task('Museum'),outcome(),
  {policy:museum,getJson:provider(museum,{pr}).getJson,now}),null);
 const changed={...outcome(),workEvidence:{...outcome().workEvidence,commit:'f'.repeat(40)}};
 assert.equal(await verifyGitHubWork(task('Museum'),changed,{policy:museum,getJson:provider(museum).getJson,now}),null);
});
test('MCP-05 commit must be same SHA, non-empty actual diff and newer than last Send',async()=>{
 const good=fixtures(museum).commit;
 for(const commit of [
  {...good,sha:'f'.repeat(40)}, {...good,files:[]},
  {...good,files:[{filename:'src/app.js',status:'modified',changes:0}]},
  {...good,files:[{filename:'src/app.js',status:'removed',changes:12}]},
  {...good,commit:{committer:{date:'2026-11-27T05:30:00Z'}}},
  {...good,commit:{committer:{date:'2026-11-27T08:30:00Z'}}}
 ])assert.equal(await verifyGitHubWork(task('Museum'),outcome(),
  {policy:museum,getJson:provider(museum,{commit}).getJson,now}),null);
});
test('MCP-05 newer pending or failed CI overrides older green, foreign runs cannot substitute',async()=>{
 const runs=fixtures(museum).runs.workflow_runs;
 for(const newer of [
  {...runs[0],id:105,status:'in_progress',conclusion:null},
  {...runs[0],id:105,conclusion:'failure'},
  {...runs[0],id:105,head_sha:'f'.repeat(40)},
  {...runs[0],id:105,pull_requests:[{number:160}]},
  {...runs[0],id:105,event:'push'}
 ])assert.equal(await verifyGitHubWork(task('Museum'),outcome(),
  {policy:museum,getJson:provider(museum,{runs:{workflow_runs:[newer,...runs]}}).getJson,now}),null);
});
test('MCP-05 test job and exact test step must really finish successfully',async()=>{
 const f=fixtures(museum),job=f.jobs[101].jobs[0];
 for(const changes of [
  {conclusion:'failure'}, {status:'in_progress'},
  {steps:[{...job.steps[0],conclusion:'skipped'}]},
  {steps:[{...job.steps[0],name:'Not the test step'}]}
 ]){
  const jobs={...f.jobs,101:{jobs:[{...job,...changes}]}};
  assert.equal(await verifyGitHubWork(task('Museum'),outcome(),
   {policy:museum,getJson:provider(museum,{jobs}).getJson,now}),null);
 }
});
test('MCP-05 missing token or mismatched task/project never queries GitHub',async()=>{
 assert.equal(await verifyGitHubWork(task('Museum'),outcome(),
  {policy:museum,makeClient:async()=>null,now}),null);
 const p=provider(museum);
 assert.equal(await verifyGitHubWork(task('TD'),outcome(),{policy:museum,getJson:p.getJson,now}),null);
 assert.equal(p.seen.length,0);
});
test('MCP-05 HTTP GitHub client refuses URLs and unapproved paths before fetch',async()=>{
 const calls=[];
 const get=await createGitHubReadOnlyGetter({repo:'Perebor/Museum',token:'fixture-token',
  fetchImpl:async url=>{calls.push(url);return {ok:true,headers:{get:()=>null},text:async()=>'{ "ok": true }'}}});
 assert.deepEqual(await get('/pulls/159'),{ok:true});
 for(const route of ['/pulls/159/../../other','/actions/runs/0/jobs?per_page=100','https://evil.example/'])
  assert.equal(await get(route),null);
 assert.deepEqual(calls,['https://api.github.com/repos/Perebor/Museum/pulls/159']);
});

test('MCP-05 TD verified experimental Bencho policy has exact real branch, workflows and passing test steps',async()=>{
 const {KNOWN_WORK_PROFILES}=await import('../work-result.mjs');
 const p=KNOWN_WORK_PROFILES.TD_BENCHO_VARIANTS;
 assert.equal(p.project,'TD');
 assert.equal(p.repo,'Perebor/teplyedaty');
 assert.equal(p.baseBranch,'feature/bencho-mit-ui-preview-20261126');
 assert.equal(p.branchPrefix,'experiment/bencho-design-variants-');
 assert.deepEqual(p.requiredWorkflows,['Bencho MIT preview checks','Bencho design variants (isolated)']);
 assert.deepEqual(p.requiredTestJobs['Bencho MIT preview checks'],
  {job:'test',step:'Run isolated Bencho preview checks'});
 assert.deepEqual(p.requiredTestJobs['Bencho design variants (isolated)'],
  {job:'test',step:'Verify original preview and three visual variants'});
 assert.deepEqual(KNOWN_WORK_POLICIES.TD.requiredWorkflows,[],
  'generic TD still fails closed, experiment is not the whole TD product');
});

test('MCP-05 scoped trusted TD subbranch base verifies, untrusted base fails before network',async()=>{
 const {KNOWN_WORK_PROFILES}=await import('../work-result.mjs');
 const policy=KNOWN_WORK_PROFILES.TD_BENCHO_VARIANTS;
 const o=outcome(),p=provider(policy);
 const ok=await verifyGitHubWork(task('TD'),o,{policy,getJson:p.getJson,now});
 assert.equal(ok?.verified,true,'trusted exact non-main base must be supported');
 assert.equal(ok?.workflows.length,2);
 const unsafePolicy={...policy,baseBranch:'../../untrusted'};
 const bad=provider(unsafePolicy);
 assert.equal(await verifyGitHubWork(task('TD'),o,{
  policy:unsafePolicy,getJson:bad.getJson,now}),null);
 assert.equal(bad.seen.length,0);
});
