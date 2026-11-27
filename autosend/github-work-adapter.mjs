/**
 * MCP-05 read-only, project-scoped GitHub Git/CI/test adapters.
 * No browser action or Send. No URLs, repository names or credentials may be
 * supplied by the ChatGPT answer. Application-owned policy is the authority.
 */
import {spawnSync} from 'node:child_process';
const SHA=/^[a-f0-9]{40}$/;
const FP=/^[a-f0-9]{64}$/;
const REPO=/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ROUTE=[
 /^\/pulls\/[1-9]\d{0,5}$/,
 /^\/commits\/[a-f0-9]{40}$/,
 /^\/actions\/runs\?head_sha=[a-f0-9]{40}&per_page=100$/,
 /^\/actions\/runs\/[1-9]\d{0,17}\/jobs\?per_page=100$/
];
function credential(){
 // GCM must never prompt an unattended agent. Do not return or log outputs.
 try{
  const r=spawnSync('git',['credential','fill'],{
   input:'protocol=https\nhost=github.com\n\n',encoding:'utf8',
   timeout:6500,maxBuffer:16000,windowsHide:true,
   env:{...process.env,GCM_INTERACTIVE:'never',GIT_TERMINAL_PROMPT:'0'}
  });
  const password=r.status===0?(r.stdout||'').split(/\r?\n/)
   .find(s=>s.startsWith('password='))?.slice(9):null;
  return password&&password.length<5000?password:null;
 }catch{return null;}
}
export async function createGitHubReadOnlyGetter({repo,token=null,fetchImpl=fetch}={}){
 if(typeof repo!=='string'||!REPO.test(repo))return null;
 const secret=token||credential();
 if(typeof secret!=='string'||!secret)return null;
 return async route=>{
  if(typeof route!=='string'||!ROUTE.some(r=>r.test(route)))return null;
  try{
   const res=await fetchImpl('https://api.github.com/repos/'+repo+route,{
    method:'GET',redirect:'error',
    headers:{Authorization:'Bearer '+secret,
     Accept:'application/vnd.github+json',
     'X-GitHub-Api-Version':'2022-11-28',
     'User-Agent':'McpGo-GitWork-readonly'},
    signal:AbortSignal.timeout(9000)
   });
   if(!res?.ok)return null;
   const size=Number(res.headers?.get?.('content-length')||0);
   if(!Number.isFinite(size)||size>1000000)return null;
   const body=await res.text();
   if(body.length>1000000)return null;
   return JSON.parse(body);
  }catch{return null;}
 };
}
function trustworthyPolicy(policy,task){
 if(!policy||policy.project!==task.smart_v2_project||!REPO.test(policy.repo||'')||
    typeof policy.baseBranch!=='string'||policy.baseBranch!=='main'||
    typeof policy.branchPrefix!=='string'||!/^[A-Za-z0-9_/-]+$/.test(policy.branchPrefix)||
    !Array.isArray(policy.requiredWorkflows)||policy.requiredWorkflows.length<1||
    policy.requiredWorkflows.length>5||!policy.requiredTestJobs)return false;
 const names=policy.requiredWorkflows;
 if(new Set(names).size!==names.length)return false;
 for(const n of names){
  if(typeof n!=='string'||!n||n.length>120)return false;
  const job=policy.requiredTestJobs[n];
  if(!job||typeof job.job!=='string'||!job.job||
     typeof job.step!=='string'||!job.step)return false;
 }
 return true;
}
function fresh(timestamp,start,now){
 const t=Date.parse(timestamp||'');
 return Number.isFinite(t)&&t>=start&&t<=now+60000;
}
function validCommit(commit,sha,start,now){
 if(!commit||commit.sha!==sha||
    !fresh(commit.commit?.committer?.date,start,now)||
    !Array.isArray(commit.files)||commit.files.length<1||
    commit.files.length>250)return false;
 return commit.files.some(f=>f&&typeof f.filename==='string'&&
  ['added','modified','renamed'].includes(f.status)&&
  Number.isSafeInteger(f.changes)&&f.changes>0);
}
function getNewestRun(runs,name){
 const entries=runs?.workflow_runs;
 if(!Array.isArray(entries)||entries.length>100)return null;
 const matches=entries.filter(x=>x?.name===name);
 if(!matches.length||matches.some(x=>!Number.isSafeInteger(x.id)||x.id<1))return null;
 return matches.reduce((a,b)=>a.id>=b.id?a:b);
}
function validJobs(response,definition){
 if(!Array.isArray(response?.jobs)||response.jobs.length>100)return false;
 const named=response.jobs.filter(j=>j?.name===definition.job);
 if(named.length!==1)return false;
 const job=named[0];
 return job.status==='completed'&&job.conclusion==='success'&&
  Array.isArray(job.steps)&&job.steps.length<=150&&
  job.steps.some(s=>s?.name===definition.step&&
   s.status==='completed'&&s.conclusion==='success');
}
/**
 * Independently verifies exactly one changed commit, all required GitHub
 * workflow runs and the exact successful test steps defined in local policy.
 * Missing token, unknown policy or any partial/forged evidence returns null.
 */
export async function verifyGitHubWork(task,outcome,{policy,getJson=null,makeClient=null,now=Date.now()}={}){
 if(!task||!trustworthyPolicy(policy,task)||!outcome||outcome.kind!=='report'||
    !outcome.report||['BLOCKED','NEED_OWNER'].includes(outcome.report.status)||
    !FP.test(outcome.fingerprint||'')||
    !Number.isSafeInteger(outcome.githubPrNumber)||outcome.githubPrNumber<1||
    outcome.githubPrNumber>999999||!Number.isFinite(now))return null;
 const start=Date.parse(task.last_success_at||'');
 if(!Number.isFinite(start)||start>now)return null;
 const get=typeof getJson==='function'?getJson:
  typeof makeClient==='function'?await makeClient(policy.repo):
  await createGitHubReadOnlyGetter({repo:policy.repo});
 if(typeof get!=='function')return null;
 try{
  const n=outcome.githubPrNumber;
  const pr=await get('/pulls/'+n);
  if(!pr||pr.number!==n||pr.state!=='open'||pr.draft!==true||
     pr.merged!==false||pr.head?.repo?.full_name!==policy.repo||
     pr.base?.repo?.full_name!==policy.repo||
     pr.base.ref!==policy.baseBranch||
     typeof pr.head.ref!=='string'||!pr.head.ref.startsWith(policy.branchPrefix)||
     !SHA.test(pr.head.sha||'')||!fresh(pr.created_at,start,now)||
     !fresh(pr.updated_at,start,now))return null;
  const sha=pr.head.sha;
  // A claimed commit must agree with the independently fetched PR head.
  const claimed=outcome.workEvidence?.commit;
  if(claimed&&claimed!=='NONE'&&claimed!==sha)return null;
  const commit=await get('/commits/'+sha);
  if(!validCommit(commit,sha,start,now))return null;
  const changedAt=Date.parse(commit.commit.committer.date);
  const runs=await get('/actions/runs?head_sha='+sha+'&per_page=100');
  const proven=[];
  for(const name of policy.requiredWorkflows){
   const latest=getNewestRun(runs,name);
   if(!latest||latest.head_sha!==sha||latest.event!=='pull_request'||
      latest.status!=='completed'||latest.conclusion!=='success'||
      !Array.isArray(latest.pull_requests)||
      !latest.pull_requests.some(p=>p?.number===n)||
      !fresh(latest.created_at,changedAt,now)||
      !fresh(latest.updated_at,changedAt,now))return null;
   const jobs=await get('/actions/runs/'+latest.id+'/jobs?per_page=100');
   if(!validJobs(jobs,policy.requiredTestJobs[name]))return null;
   proven.push({name,runId:latest.id});
  }
  return {verified:true,source:'github_ci_verified',project:policy.project,
   repo:policy.repo,fingerprint:outcome.fingerprint,prNumber:n,sha,
   workflows:proven,testsVerified:true,provenAt:new Date(now).toISOString()};
 }catch{return null;}
}
