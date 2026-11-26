/**
 * Cooperative, per-tab leases within one shared Playwright context.
 * A lease protects against accidental interference between McpGo clients,
 * not malicious impersonation (agent ID is supplied by the local client).
 * No titles, cookies, URLs, screenshots, or credentials are stored.
 */
const AGENT_RE=/^[A-Za-z0-9._:-]{3,64}$/;
export function validAgentId(value){return typeof value==='string' && AGENT_RE.test(value);}
export function validTabIndex(value){return Number.isSafeInteger(value)&&value>=0&&value<100000;}
export function validTabKey(value){return validTabIndex(value)||(typeof value==='string'&&/^tab-[a-f0-9-]{36}$/.test(value));}

export class TabLeaseManager {
 constructor({now=()=>Date.now(),ttlMs=600000}={}){
  this.now=now;this.ttlMs=ttlMs;this.leases=new Map();this.generation=0;
 }
 clear(){this.leases.clear();this.generation++;}
 sweep(){const now=this.now();for(const [key,entry] of this.leases)if(entry.expires<=now)this.leases.delete(key);}
 owner(tab){this.sweep();return this.leases.get(tab)?.agent??null;}
 count(){this.sweep();return this.leases.size;}
 claim(agent,tab){
  if(!validAgentId(agent)||!validTabKey(tab))throw Error('INVALID_TAB_LEASE_ARGUMENT');
  this.sweep();const previous=this.leases.get(tab);
  if(previous && previous.agent!==agent)return {ok:false,reason:'TAB_OWNED_BY_ANOTHER_AGENT'};
  this.leases.set(tab,{agent,expires:this.now()+this.ttlMs});
  return {ok:true,...(typeof tab==='string'?{tab_id:tab}:{tab_index:tab}),expires_in_seconds:Math.ceil(this.ttlMs/1000)};
 }
 release(agent,tab){
  if(!validAgentId(agent)||!validTabKey(tab))throw Error('INVALID_TAB_LEASE_ARGUMENT');
  this.sweep();const previous=this.leases.get(tab);
  if(previous && previous.agent!==agent)return {ok:false,reason:'TAB_OWNED_BY_ANOTHER_AGENT'};
  return {ok:this.leases.delete(tab)};
 }
 check(agent,tab,{claimUnowned=false}={}){
  if(!validTabKey(tab))return {ok:false,reason:'INVALID_TAB_INDEX'};
  const previous=this.owner(tab);
  if(previous && previous!==agent)return {ok:false,reason:'TAB_OWNED_BY_ANOTHER_AGENT'};
  if(claimUnowned && !previous && agent) return this.claim(agent,tab);
  if(agent && !previous) return {ok:false,reason:'TAB_LEASE_REQUIRED'};
  return {ok:true};
 }
  prune(active){
    this.sweep();
    for(const key of this.leases.keys())if(typeof key==='string'&&!active.has(key))this.leases.delete(key);
  }
 // No client identifiers in status output.
 status(){return {leasedTabCount:this.count(),leaseGeneration:this.generation};}
}

export function parseTabIndices(text){
 const indices=new Set();let current=null;
 for(const line of String(text).split(/\r?\n/)){
  const match=line.match(/^\s*-\s*(\d+):\s*(.*)$/);
  if(!match)continue;
  const index=Number(match[1]);
  if(!validTabIndex(index))continue;
  indices.add(index);
  if(/^\(current\)/.test(match[2]))current=index;
 }
 return {indices,current};
}
