/**
 * Read-only, fail-closed GitHub CI evidence for owner-approved Museum AutoSend.
 * Private repository access uses the existing OS Git Credential Manager.
 * No token is persisted, returned to the native API, or logged.
 *
 * The assistant's reply supplies only a PR NUMBER, never an API URL,
 * repository, SHA, workflow status, or success claim. All those values are
 * independently verified against fixed official GitHub endpoints.
 */
import {spawnSync} from 'node:child_process';

const OWNER='Perebor';
const REPO='Museum';
const FULL_NAME=OWNER+'/'+REPO;
const REQUIRED_WORKFLOWS=Object.freeze([
 'Museum starter checks',
 'Fictional museum XSS Chromium guard'
]);
const SENTINEL='OWNER_CONSENT_20261126_MUSEUM_BRANCH_PR_CI';
const SHA=/^[a-f0-9]{40}$/;
const FINGERPRINT=/^[a-f0-9]{64}$/;
const MIN_PR=1,MAX_PR=999999;

export function parseGitHubPrNumber(text){
 if(typeof text!=='string'||text.length>12000)return null;
 const matches=[...text.matchAll(/\bPR[ \t]*(?:[№#][ \t]*|[ \t]+)(\d{1,6})\b/gi)];
 const found=new Set(matches.map(m=>Number(m[1])));
 return found.size===1&&[...found][0]>=MIN_PR&&[...found][0]<=MAX_PR
  ?[...found][0]:null;
}
function authorized(task,outcome){
 return task?.id==='1fdf7be0-6362-4a6b-90aa-d3402ac5144f'&&
  task.smart_v2===true&&task.smart_v2_project==='Museum'&&
  task.smart_result_gate===true&&task.schedule_mode==='after_response'&&
  task.enabled===true&&task.status==='scheduled'&&
  !task.verification&&!task.active_slot_id&&!task.smart_v2_pending_action&&!task.manual_once&&
  task.smart_v2_last_action&&
  typeof task.message==='string'&&task.message.includes(SENTINEL)&&
  typeof task.url==='string'&&task.url.includes('-moi-muzei-istoriia/c/')&&
  outcome?.kind==='report'&&outcome.report?.status==='IN_PROGRESS'&&
  outcome.report?.action==='CONTINUE_CURRENT'&&
  outcome.report?.task==='REL-001'&&
  FINGERPRINT.test(outcome.fingerprint||'')&&
  Number.isSafeInteger(outcome.githubPrNumber)&&
  outcome.githubPrNumber>=MIN_PR&&outcome.githubPrNumber<=MAX_PR;
}
function getCredential(){
 // Non-interactive only; never let a background AutoSend open a browser OAuth prompt.
 const r=spawnSync('git',['credential','fill'],{
  input:'protocol=https\nhost=github.com\n\n',encoding:'utf8',
  timeout:9000,maxBuffer:16000,windowsHide:true,
  env:{...process.env,GCM_INTERACTIVE:'never',GIT_TERMINAL_PROMPT:'0'}
 });
 if(r.status!==0)return null;
 const password=(r.stdout||'').split(/\r?\n/).find(x=>x.startsWith('password='))?.slice(9);
 return password&&password.length<5000?password:null;
}
async function liveGithubGetter(){
 const token=getCredential();
 if(!token)return null;
 const headers={
  Authorization:'Bearer '+token,
  Accept:'application/vnd.github+json',
  'User-Agent':'McpGo-AutoSend-readonly',
  'X-GitHub-Api-Version':'2022-11-28'
 };
 return async(route)=>{
  if(typeof route!=='string'||!/^\/pulls\/[1-9]\d{0,5}$|^\/actions\/runs\?head_sha=[a-f0-9]{40}&per_page=50$/.test(route))
   return null;
  try{
   const res=await fetch('https://api.github.com/repos/'+FULL_NAME+route,{
    headers,redirect:'error',signal:AbortSignal.timeout(10000)
   });
   if(!res.ok)return null;
   const contentLength=Number(res.headers.get('content-length')||0);
   if(contentLength>1200000)return null;
   const text=await res.text();
   if(text.length>1200000)return null;
   return JSON.parse(text);
  }catch{return null}
 };
}
/**
 * @returns {null|{verified:true,source:'github_ci_verified',fingerprint:string,
 *  repo:string,prNumber:number,sha:string,workflows:Array,provenAt:string}}
 */
export async function verifyGitHubCI(task,outcome,{getJson=null}={}){
 if(!authorized(task,outcome))return null;
 const prNumber=outcome.githubPrNumber;
 const get=typeof getJson==='function'?getJson:await liveGithubGetter();
 if(!get)return null;
 try{
  const pr=await get('/pulls/'+prNumber);
  if(!pr||pr.number!==prNumber||pr.state!=='open'||pr.draft!==true||
     pr.merged!==false||pr.head?.repo?.full_name!==FULL_NAME||
     pr.base?.repo?.full_name!==FULL_NAME||pr.base.ref!=='main'||
     !/^integration\/museum-[A-Za-z0-9_-]+$/.test(pr.head.ref||'')||
     !SHA.test(pr.head.sha||''))return null;
  const sent=Date.parse(task.last_success_at||'');
  const created=Date.parse(pr.created_at||'');
  if(!Number.isFinite(sent)||!Number.isFinite(created)||created<sent||
     created>Date.now()+60000)return null;

  const runs=await get('/actions/runs?head_sha='+pr.head.sha+'&per_page=50');
  if(!runs||!Array.isArray(runs.workflow_runs))return null;
  const proven=[];
  for(const name of REQUIRED_WORKFLOWS){
   const candidates=runs.workflow_runs.filter(r=>r?.name===name&&r?.head_sha===pr.head.sha&&
    r.event==='pull_request'&&Array.isArray(r.pull_requests)&&
    r.pull_requests.some(p=>p?.number===prNumber));
   if(!candidates.length)return null;
   // An older successful run cannot override a newer pending or failed rerun.
   candidates.sort((a,b)=>Number(b.id||0)-Number(a.id||0));
   const latest=candidates[0];
   if(!Number.isSafeInteger(latest.id)||latest.id<1||
      latest.status!=='completed'||latest.conclusion!=='success')return null;
   proven.push({name,runId:latest.id});
  }
  return {verified:true,source:'github_ci_verified',fingerprint:outcome.fingerprint,
   repo:FULL_NAME,prNumber,sha:pr.head.sha,workflows:proven,provenAt:new Date().toISOString()};
 }catch{return null}
}
export class GitHubCIObserver{
 constructor({verify=verifyGitHubCI,cacheMs=55000}={}){
  this.verify=verify;this.cacheMs=cacheMs;this.cache=new Map();
 }
 async check(task,outcome,{forDispatch=false}={}){
  if(!authorized(task,outcome))return null;
  const key=[task.id,task.last_success_at,outcome.fingerprint,outcome.githubPrNumber].join('\0');
  const item=this.cache.get(key);
  if(!forDispatch&&item&&Date.now()-item.at<this.cacheMs)return item.result;
  const result=await this.verify(task,outcome);
  this.cache.set(key,{result,at:Date.now()});
  if(this.cache.size>24)this.cache.delete(this.cache.keys().next().value);
  return result;
 }
}
