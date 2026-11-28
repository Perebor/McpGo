/** MCP-05: unified, side-effect-free WORK_RESULT classification for projects.
 * An assistant report is never independent proof of Git, CI or tests.
 * Only a trusted local verification adapter may return GitHub/CI evidence.
 * This module never triggers Send, changes task readiness, or uses network.
 */
import {createHash} from 'node:crypto';
const SHA=/^[a-f0-9]{40}$/;
const FP=/^[a-f0-9]{64}$/;
const MAX_PROOF_AGE=5*60*1000;
// Application-owned allowlist. TD workflow names are not yet confirmed,
// therefore its CI cannot be marked verified; its reports stay SELF_REPORT.
export const KNOWN_WORK_POLICIES=Object.freeze({
 TD:Object.freeze({project:'TD',repo:'Perebor/teplyedaty',baseBranch:'main',
  branchPrefix:'work/td-',requiredWorkflows:Object.freeze([]),requiredTestJobs:Object.freeze({})}),
 Museum:Object.freeze({project:'Museum',repo:'Perebor/Museum',baseBranch:'main',
  branchPrefix:'integration/museum-',requiredWorkflows:Object.freeze([
   'Museum starter checks','Fictional museum XSS Chromium guard']),
  requiredTestJobs:Object.freeze({
   'Museum starter checks':Object.freeze({job:'test',step:'JavaScript and SQLite tests (no secrets)'}),
   'Fictional museum XSS Chromium guard':Object.freeze({
    job:'browser',step:'Browser XSS negative cases + positive proof on localhost only'})
  })})
});
// Narrow, independently checked GitHub evidence profile for the TD Bencho
// experiment. Not the generic TD release policy: no CI on TD main is known.
// Deliberately NOT chosen by server's generic TD work-result observer.
export const KNOWN_WORK_PROFILES=Object.freeze({
 TD_BENCHO_VARIANTS:Object.freeze({
  project:'TD',repo:'Perebor/teplyedaty',
  baseBranch:'feature/bencho-mit-ui-preview-20261126',
  branchPrefix:'experiment/bencho-design-variants-',
  requiredWorkflows:Object.freeze([
   'Bencho MIT preview checks','Bencho design variants (isolated)'
  ]),
  requiredTestJobs:Object.freeze({
   'Bencho MIT preview checks':Object.freeze({
    job:'test',step:'Run isolated Bencho preview checks'
   }),
   'Bencho design variants (isolated)':Object.freeze({
    job:'test',step:'Verify original preview and three visual variants'
   })
  })
 })
});

const hash=parts=>createHash('sha256').update(JSON.stringify(parts)).digest('hex');

function reportedWork(outcome){
 const w=outcome?.workEvidence;
 if(!w||w.source!=='assistant_self_report')return null;
 const limits={files_changed:10000,tests_passed:100000,tests_failed:100000};
 for(const [key,max] of Object.entries(limits))
  if(!Number.isSafeInteger(w[key])||w[key]<0||w[key]>max)return null;
 return {filesChanged:w.files_changed,testsPassed:w.tests_passed,
  testsFailed:w.tests_failed};
}
function validTrustedProof(proof,task,outcome,policy,now){
 if(!proof||proof.verified!==true||proof.testsVerified!==true||proof.source!=='github_ci_verified'||
    proof.project!==policy.project||proof.repo!==policy.repo||
    proof.fingerprint!==outcome.fingerprint||!SHA.test(proof.sha||'')||
    !Number.isSafeInteger(proof.prNumber)||proof.prNumber<1||proof.prNumber>999999||
    !Array.isArray(proof.workflows)||proof.workflows.length!==policy.requiredWorkflows.length)
  return false;
 const at=Date.parse(proof.provenAt||''),lastSuccess=Date.parse(task.last_success_at||'');
 if(!Number.isFinite(at)||!Number.isFinite(lastSuccess)||at<lastSuccess||
    at>now+1000||now-at>MAX_PROOF_AGE)return false;
 const wanted=new Set(policy.requiredWorkflows);
 if(wanted.size!==policy.requiredWorkflows.length||wanted.size<1||wanted.size>8)return false;
 const seenNames=new Set(),seenIds=new Set();
 for(const run of proof.workflows){
  if(!run||!wanted.has(run.name)||seenNames.has(run.name)||
     !Number.isSafeInteger(run.runId)||run.runId<=0||seenIds.has(run.runId))return false;
  seenNames.add(run.name);seenIds.add(run.runId);
 }
 return seenNames.size===wanted.size;
}

/**
 * `policy` is application-owned configuration, NEVER extracted from ChatGPT.
 * `verify` is an application-owned async adapter; user-provided JSON is ignored.
 * `outcome` contains only the stable ChatGPT report/fingerprint from a read-only
 * paired DOM observation, NOT a provider proof. Fail closed if adapter absent.
 */
export async function inspectWorkResult(task,outcome,{policy,verify=null,now=Date.now()}={}){
 if(!task||typeof task.id!=='string'||!task.id||
    !policy||typeof policy.project!=='string'||policy.project!==task.smart_v2_project||
    typeof policy.repo!=='string'||!Array.isArray(policy.requiredWorkflows)||
    outcome?.kind!=='report'||!FP.test(outcome.fingerprint||'')||!outcome.report||
    !Number.isFinite(now))return null;
 const project=policy.project,reported=reportedWork(outcome);
 const fingerprint=hash(['WORK_RESULT_V1',project,task.id,outcome.fingerprint]);
 let proof=null;
 // Never inspect or accept outcome.githubProof/outcome.externalEvidence as proof.
 if(typeof verify==='function'){
  try{proof=await verify({task,outcome,policy})}catch{proof=null}
 }
 const verified=validTrustedProof(proof,task,outcome,policy,now);
 const proofFingerprint=verified?hash(['GITHUB_CI_V1',project,task.id,
  fingerprint,proof.repo,proof.prNumber,proof.sha,
  [...proof.workflows].sort((a,b)=>a.name.localeCompare(b.name)).map(r=>[r.name,r.runId])]):null;
 return Object.freeze({version:1,taskId:task.id,project,
  status:verified?'VERIFIED':reported?'SELF_REPORT':'UNVERIFIED',
  verified,fingerprint,proofFingerprint,
  // This is independently checked Git/CI adapter data, never from chat.
  // Keep the legacy UI work_result fingerprint-only; persist Git separately.
  verifiedGit:verified?Object.freeze({
   repo:proof.repo,sha:proof.sha,prNumber:proof.prNumber,
   provenAt:proof.provenAt,proofFingerprint,
   resultFingerprint:fingerprint}):null,
  reported:Object.freeze(reported||{filesChanged:0,testsPassed:0,testsFailed:0}),
  verifiedCommits:verified?1:0});
}

/** Persist verified and self-report counters separately, with idempotent
 * same-report promotion from self-report to independently verified only.
 * Caller performs one existing durable tasks.json persist; no Send/rearm.
 */
export function commitObservedWorkResult(task,result,now=Date.now()){
 if(!task||!result||result.version!==1||result.taskId!==task.id||
    result.project!==task.smart_v2_project||!FP.test(result.fingerprint||'')||
    !['VERIFIED','SELF_REPORT','UNVERIFIED'].includes(result.status)||
    !Number.isFinite(now))return false;
 const previous=task.work_result;
 // A last-fingerprint comparison is insufficient: A -> B -> A replays must
 // not inflate work. Persist a bounded history (no prompts, repo or SHA).
 const seen=Array.isArray(task.work_result_seen)?task.work_result_seen
  .filter(x=>x&&FP.test(x.fingerprint||'')&&
    ['VERIFIED','SELF_REPORT','UNVERIFIED'].includes(x.status)).slice(-255):[];
 if(previous&&FP.test(previous.fingerprint||'')&&
    !seen.some(x=>x.fingerprint===previous.fingerprint))
  seen.push({fingerprint:previous.fingerprint,status:previous.status});
 const found=seen.find(x=>x.fingerprint===result.fingerprint);
 if(found){
  if(found.status==='VERIFIED'||result.status==='UNVERIFIED'||
     found.status===result.status)return false;
  if(found.status==='SELF_REPORT'&&result.status!=='VERIFIED')return false;
  if(found.status==='UNVERIFIED'&&!['SELF_REPORT','VERIFIED'].includes(result.status))
   return false;
 }
 const current=task.work_result_metrics||{};
 let selfReportOnly=current.self_report_only||0;
 let verified=current.verified||0;
 if(found?.status==='SELF_REPORT')selfReportOnly=Math.max(0,selfReportOnly-1);
 if(result.status==='SELF_REPORT'&&found?.status!=='SELF_REPORT')selfReportOnly++;
 if(result.status==='VERIFIED')verified++;
 const entry={fingerprint:result.fingerprint,status:result.status};
 const updated=found?seen.map(x=>x.fingerprint===result.fingerprint?entry:x)
  :[...seen,entry];
 task.work_result_seen=updated.slice(-256);
 task.work_result={version:1,taskId:result.taskId,project:result.project,
  status:result.status,fingerprint:result.fingerprint,
  proofFingerprint:result.proofFingerprint,updatedAt:new Date(now).toISOString()};
 task.work_result_metrics={self_report_only:selfReportOnly,verified,
  lastUpdatedAt:new Date(now).toISOString()};
 // Persist the trusted Git identity in the same durable tasks.json update as
 // the work verdict; SQLite can recover after interrupted optional mirroring.
 if(result.status==='VERIFIED'&&result.verified===true&&
    result.verifiedGit&&SHA.test(result.verifiedGit.sha||'')&&
    FP.test(result.verifiedGit.proofFingerprint||'')&&
    result.verifiedGit.resultFingerprint===result.fingerprint){
  task.work_result_git={...result.verifiedGit};
 }else delete task.work_result_git;
 return true;
}
