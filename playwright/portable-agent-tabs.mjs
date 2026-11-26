/** Browser tab arbitration shared unchanged by the macOS/Windows proxies.
 * No Chrome-native APIs or persistent browsing metadata. The underlying
 * Playwright browser_tabs list offers only ephemeral numeric indices, so this
 * layer uses opaque handles anchored to unique URL digests and fails closed
 * when the evidence is ambiguous. Handles are not a substitute for Chrome's
 * official tabId, which Playwright MCP does not expose today.
 */
import {PortableTabIdentity} from './portable-tab-identity.mjs';
import {TabLeaseManager,validTabIndex} from './tab-lease-manager.mjs';

export class PortableAgentTabs {
 constructor({identities=new PortableTabIdentity(),leases=new TabLeaseManager()}={}){
  this.identities=identities;this.leases=leases;this.active=new Map();
 }
 reset(){this.identities.clear();this.leases.clear();this.active.clear();}
 refresh(text){
  const view=this.identities.observe(text);
  const live=new Set(view.tabs.map(t=>t.id));
  this.leases.prune(live);
  for(const [agent,id] of this.active)if(!live.has(id))this.active.delete(agent);
  return view;
 }
 list(agent){
  const view=this.identities.snapshot();
  return {
   generation:view.generation,ambiguous:view.ambiguous,
   tabs:view.tabs.filter(t=>!agent || !this.leases.owner(t.id) || this.leases.owner(t.id)===agent)
     .map(t=>({tab_id:t.id,index_hint:t.index,current:t.current,owner:t.id&&this.leases.owner(t.id)?(this.leases.owner(t.id)===agent?'mine':'reserved'):'unclaimed'})),
   owned:this.owned(agent),
  };
 }
 owned(agent){return agent?[...this.leases.leases].filter(([,entry])=>entry.agent===agent).map(([id])=>id):[];}
 claim(agent,tabId){
  if(!agent)return {ok:false,reason:'AGENT_SCOPE_REQUIRED'};
  if(!this.identities.resolve(tabId))return {ok:false,reason:'TAB_HANDLE_STALE_OR_AMBIGUOUS'};
  const result=this.leases.claim(agent,tabId);
  if(result.ok)this.active.set(agent,tabId);
  return result;
 }
 release(agent,tabId){
  if(!agent)return {ok:false,reason:'AGENT_SCOPE_REQUIRED'};
  const result=this.leases.release(agent,tabId);
  if(result.ok&&this.active.get(agent)===tabId)this.active.delete(agent);
  return result;
 }
 byIndex(index){return validTabIndex(index)?this.identities.byIndex(index):null;}
 owner(id){return id?this.leases.owner(id):null;}
 allowed(agent,tabId){
  if(!tabId)return {ok:false,reason:'TAB_HANDLE_STALE_OR_AMBIGUOUS'};
  const owner=this.owner(tabId);
  return owner&&owner!==agent?{ok:false,reason:'TAB_OWNED_BY_ANOTHER_AGENT'}:{ok:true};
 }
 resolveOwned(agent){
  if(!agent)return null;
  const id=this.active.get(agent)||this.owned(agent)[0];
  return id&&this.owner(id)===agent?this.identities.resolve(id):null;
 }
 explicitNavigation(agent,beforeId,beforeIndex,after){
  if(!agent||!beforeId)return false;
  const ok=this.identities.rebindAfterKnownNavigation(beforeId,beforeIndex,after);
  if(ok){this.leases.prune(new Set(this.identities.entries.keys()));this.active.set(agent,beforeId);}
  return ok;
 }
 status(){return {...this.leases.status(),visibleTabHandles:this.identities.entries.size,ambiguousTabs:this.identities.ambiguous};}
}
