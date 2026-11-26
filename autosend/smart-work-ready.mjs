/**
 * ChatGPT-result-driven AutoSend gate.
 * Work counts are SELF-REPORTED by the ChatGPT answer, not independently
 * verified Git/CI evidence. Never treat them as proven commits or test results.
 * Polling is read-only and never produces a prompt or Send by itself.
 */
const EVIDENCE=/(?:^|\n)WORK_FILES_CHANGED: (0|[1-9]\d{0,4})\nWORK_TESTS_PASSED: (0|[1-9]\d{0,5})\nWORK_TESTS_FAILED: (0|[1-9]\d{0,5})\nWORK_COMMIT: ([a-f0-9]{40}|NONE)\nAUTO_PROJECT:/;
export function parseWorkEvidence(text){
 if(typeof text!=='string'||text.length>100000)return null;
 const s=text.replace(/\r/g,'');
 const matches=[...s.matchAll(/(?:^|\n)WORK_FILES_CHANGED:/g)];
 if(matches.length!==1)return null;
 const m=s.match(EVIDENCE);
 if(!m)return null;
 const [files,passed,failed]=m.slice(1,4).map(Number);
 if(files>10000||passed>100000||failed>100000)return null;
 return {files_changed:files,tests_passed:passed,tests_failed:failed,
  commit:m[4],source:'assistant_self_report'};
}
export function assessWorkReadiness(task,outcome,{forDispatch=false,externalEvidence=null}={}){
 if(!task?.smart_v2||!task?.smart_result_gate||task.schedule_mode!=='after_response')
  return {ready:false,pause:false,reason:'NOT_RESULT_GATED'};
 if(!task.enabled||task.status!=='scheduled')
  return {ready:false,pause:false,reason:'TASK_INACTIVE'};
 if(!task.smart_v2_last_action)
  return {ready:false,pause:false,reason:'NO_PREVIOUS_SMART_MESSAGE'};
 if(!outcome||outcome.kind!=='report'||!outcome.report)
  return {ready:false,pause:false,reason:'NO_STABLE_REPORT'};
 if(outcome.report.status==='NEED_OWNER'||outcome.report.status==='BLOCKED')
  return {ready:false,pause:true,reason:outcome.report.status};
 const marker=outcome.fingerprint;
 const remote=externalEvidence?.verified===true&&
  externalEvidence.source==='github_ci_verified'&&
  externalEvidence.repo==='Perebor/Museum'&&
  externalEvidence.prNumber===outcome.githubPrNumber&&
  externalEvidence.fingerprint===marker&&
  task.smart_v2_project==='Museum'&&
  outcome.report.status==='IN_PROGRESS'&&
  outcome.report.action==='CONTINUE_CURRENT'&&
  /^[a-f0-9]{40}$/.test(externalEvidence.sha||'')&&
  Array.isArray(externalEvidence.workflows)&&externalEvidence.workflows.length===2;
 if(outcome.report.status==='IN_PROGRESS'&&!remote)
  return {ready:false,pause:false,reason:'WORK_STILL_IN_PROGRESS'};
 const evidence=remote?{
  files_changed:0,tests_passed:0,tests_failed:0,commit:'NONE',
  source:'github_ci_verified',prNumber:externalEvidence.prNumber,
  sha:externalEvidence.sha,workflows:externalEvidence.workflows
 }:outcome.workEvidence;
 if(!evidence||typeof marker!=='string'||!/^[a-f0-9]{64}$/.test(marker))
  return {ready:false,pause:false,reason:'NO_MEASURABLE_WORK_EVIDENCE'};
 if(forDispatch){
  if(marker!==task.smart_work_ready_marker||outcome.report.action!==task.smart_work_expected_action||!task.next_at)
   return {ready:false,pause:false,reason:'FINGERPRINT_OR_ACTION_CHANGED'};
 }else if(marker===task.smart_work_ready_marker)
  return {ready:false,pause:false,reason:'ALREADY_USED_RESULT'};
 const verified=outcome.report.status==='VERIFIED'&&
  outcome.report.action==='CONTINUE_DEVELOPMENT'&&
  evidence.files_changed>0&&evidence.tests_passed>0&&
  evidence.tests_failed===0&&/^[a-f0-9]{40}$/.test(evidence.commit);
 const failed=outcome.report.status==='FAIL'&&
  outcome.report.action==='FIX_DEFECT'&&evidence.tests_failed>0;
 if(!verified&&!failed&&!remote)
  return {ready:false,pause:false,reason:'WORK_EVIDENCE_BELOW_GATE'};
 return {ready:true,pause:false,action:outcome.report.action,
  evidence,fingerprint:marker,reportTask:outcome.report.task};
}
export function commitWorkReadiness(task,decision,now=Date.now()){
 if(!decision?.ready||!task.enabled||task.status!=='scheduled'||
    task.schedule_mode!=='after_response'||task.smart_result_gate!==true||
    task.next_at||task.smart_work_ready_marker===decision.fingerprint)return false;
 task.smart_work_ready_marker=decision.fingerprint;
 task.smart_work_expected_action=decision.action;
 task.smart_work_ready_evidence={...decision.evidence,task_id:decision.reportTask};
 task.next_at=new Date(now).toISOString();
 const current=task.work_metrics||{};
 task.work_metrics={
  useful_runs:(current.useful_runs||0)+1,
  reported_files_changed:(current.reported_files_changed||0)+decision.evidence.files_changed,
  reported_tests_passed:(current.reported_tests_passed||0)+decision.evidence.tests_passed,
  reported_tests_failed:(current.reported_tests_failed||0)+decision.evidence.tests_failed,
  externally_verified_runs:(current.externally_verified_runs||0)+(decision.evidence.source==='github_ci_verified'?1:0),
  source:decision.evidence.source==='github_ci_verified'?'github_ci_verified+assistant_self_report':'assistant_self_report',
  updated_at:new Date(now).toISOString()
 };
 return true;
}
export function workEfficiency(task){
 const count=Number(task?.delivery_count)||0;
 const m=task?.work_metrics||{};
 return {
  confirmed_deliveries:count,
  useful_runs:m.useful_runs||0,
  reported_files_changed:m.reported_files_changed||0,
  reported_tests_passed:m.reported_tests_passed||0,
  reported_tests_failed:m.reported_tests_failed||0,
  externally_verified_runs:m.externally_verified_runs||0,
  reported_files_per_delivery:count?(m.reported_files_changed||0)/count:null,
  reported_tests_per_delivery:count?(m.reported_tests_passed||0)/count:null,
  source:(m.externally_verified_runs||0)>0?'github_ci_verified+assistant_self_report':'assistant_self_report_NOT_GIT_CI_VERIFIED'
 };
}


/**
 * A previously confirmed GitHub CI marker may be revalidated without
 * consuming it a second time. This guard never approves a Send on its own.
 */
export function shouldRetryExternalVerification(task,outcome){
 return task?.smart_v2===true&&task.smart_v2_project==='Museum'&&
  task.smart_result_gate===true&&task.schedule_mode==='after_response'&&
  task.status==='scheduled'&&task.enabled===true&&
  !task.verification&&!task.active_slot_id&&!task.smart_v2_pending_action&&!task.manual_once&&
  outcome?.kind==='report'&&outcome.report?.status==='IN_PROGRESS'&&
  outcome.report?.action==='CONTINUE_CURRENT'&&
  task.smart_work_expected_action===outcome.report.action&&
  task.smart_work_ready_marker===outcome.fingerprint&&
  task.smart_work_ready_evidence?.source==='github_ci_verified'&&
  task.smart_work_ready_evidence.prNumber===outcome.githubPrNumber&&
  /^[a-f0-9]{40}$/.test(task.smart_work_ready_evidence.sha||'');
}
/**
 * Recover a ready event dropped BEFORE a click by a transient remote recheck.
 * Caller must provide a fresh independent GitHub+CI proof from the same
 * fingerprint; the verifier rejects PRs created before the last verified Send.
 * No browser operation, click, or delivery happens in this function.
 */
export function rearmVerifiedExternalWork(task,outcome,externalEvidence,now=Date.now()){
 if(!shouldRetryExternalVerification(task,outcome)||task.next_at||
    !externalEvidence?.verified||
    externalEvidence.source!=='github_ci_verified'||
    externalEvidence.fingerprint!==outcome.fingerprint||
    externalEvidence.prNumber!==task.smart_work_ready_evidence.prNumber||
    externalEvidence.sha!==task.smart_work_ready_evidence.sha)return false;
 task.next_at=new Date(now).toISOString();
 return true;
}
