/**
 * McpGo browser workspace handles, shared by macOS and Windows.
 * A workspace is NOT an authentication principal. The existing authenticated
 * MCP connection/local McpGo instance is the trust boundary. Possession of
 * this unguessable locator alone must not bypass a stable conversation scope,
 * an existing session's tab ownership, or the proxy's browser action checks.
 *
 * Handles live only as long as this proxy process; we do not persist tab
 * identities or credentials across Chrome/backend restarts.
 */
import {randomBytes} from 'node:crypto';

export const WORKSPACE_ID_RE=/^ws_[A-Za-z0-9_-]{32}$/;
export const validWorkspaceId=value=>typeof value==='string'&&WORKSPACE_ID_RE.test(value);

export class BrowserWorkspaceRegistry {
  constructor({now=()=>Date.now(),ttlMs=24*60*60*1000,maxWorkspaces=512}={}){
    this.now=now;this.ttlMs=ttlMs;this.maxWorkspaces=maxWorkspaces;
    this.byId=new Map();this.byAgent=new Map();
  }
  sweep(){
    const now=this.now();
    for(const [id,entry] of this.byId){
      if(entry.expires<=now){this.byId.delete(id);if(this.byAgent.get(entry.agent)===id)this.byAgent.delete(entry.agent);}
    }
    while(this.byId.size>this.maxWorkspaces){
      const id=this.byId.keys().next().value;this.drop(id);
    }
  }
  drop(id){
    const entry=this.byId.get(id);
    this.byId.delete(id);
    if(entry&&this.byAgent.get(entry.agent)===id)this.byAgent.delete(entry.agent);
  }
  ensure(agent){
    if(!agent) return null;
    this.sweep();
    const id=this.byAgent.get(agent);
    if(id){const entry=this.byId.get(id);if(entry){entry.expires=this.now()+this.ttlMs;return id;}}
    const next='ws_'+randomBytes(24).toString('base64url');
    this.byId.set(next,{agent,expires:this.now()+this.ttlMs});
    this.byAgent.set(agent,next);
    this.sweep();
    return next;
  }
  lookup(workspaceId){
    if(!validWorkspaceId(workspaceId))return null;
    this.sweep();const entry=this.byId.get(workspaceId);
    if(!entry)return null;
    entry.expires=this.now()+this.ttlMs;
    return {agent:entry.agent,workspaceId};
  }
  /**
   * Explicit resume is allowed only from a newly bound, unoccupied transport
   * session inside the same trusted McpGo instance. Stable header identities
   * are immutable and cannot be reassigned by a model-supplied workspace ID.
   */
  resolve(currentAgent,mode,requestedId,{hasOwnedTabs=false}={}){
    if(!requestedId)return {agent:currentAgent,workspaceId:this.ensure(currentAgent),resumed:false};
    if(!validWorkspaceId(requestedId))return {error:'INVALID_WORKSPACE_ID'};
    const target=this.lookup(requestedId);
    if(!target)return {error:'UNKNOWN_OR_EXPIRED_WORKSPACE'};
    if(target.agent===currentAgent)return {...target,resumed:false};
    if(!currentAgent||mode==='legacy')return {error:'WORKSPACE_REQUIRES_MCP_SESSION'};
    if(mode==='stable')return {error:'WORKSPACE_STABLE_SCOPE_CONFLICT'};
    if(hasOwnedTabs)return {error:'WORKSPACE_CURRENT_AGENT_HAS_TABS'};
    // OpenAI per-request session hints may rotate within one conversation.
    // Allow an explicit high-entropy workspace capability to resume safely.
    if(mode!=='transport'&&mode!=='workspace'&&mode!=='observed')
      return {error:'WORKSPACE_SCOPE_UNSUPPORTED'};
    return {...target,resumed:true,oldAgent:currentAgent};
  }
  adopt(oldAgent,newAgent){
    if(oldAgent===newAgent)return;
    const stale=this.byAgent.get(oldAgent);
    if(stale)this.drop(stale);
  }
  status(){this.sweep();return {workspaceCount:this.byId.size};}
}
