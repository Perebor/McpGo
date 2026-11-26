/**
 * Portable MCP agent scope registry. No platform-specific Chrome APIs.
 * A downstream MCP transport session is a scoped agent ONLY while it keeps
 * presenting its returned session id. Reconnects can retain identity through
 * an explicit stable x-mcpgo-agent-id or x-mcpgo-conversation-id header.
 * We never infer a conversation from clientInfo.name: multiple chats can have
 * the same name. Legacy clients without a transport id remain unscoped.
 */
import {randomUUID, createHash} from 'node:crypto';

const SCOPE_RE=/^[A-Za-z0-9._:-]{3,128}$/;
const SID_RE=/^[a-f0-9-]{36}$/;
export const validScopeHint=value=>typeof value==='string'&&SCOPE_RE.test(value);
export const normalizeHint=(headers={})=>{
  const hint=headers['x-mcpgo-agent-id']||headers['x-mcpgo-conversation-id'];
  return validScopeHint(hint)?hint:null;
};
export class AgentScopeRegistry {
  constructor({now=()=>Date.now(),ttlMs=7200000,maxSessions=512}={}){
    this.now=now;this.ttlMs=ttlMs;this.maxSessions=maxSessions;
    this.sessions=new Map();this.salt=randomUUID();
  }
  _id(hint){
    return 'agent-'+createHash('sha256').update(this.salt+'\0'+hint).digest('hex').slice(0,32);
  }
  sweep(){
    const before=this.now();
    for(const [sid,entry] of this.sessions){
      if(entry.expires<=before)this.sessions.delete(sid);
    }
    while(this.sessions.size>=this.maxSessions)this.sessions.delete(this.sessions.keys().next().value);
  }
  create(headers={}){
    this.sweep();
    const sid=randomUUID();
    const hint=normalizeHint(headers);
    const agent=hint?this._id(hint):'agent-'+randomUUID();
    const mode=hint?'stable':'transport';
    this.sessions.set(sid,{agent,mode,expires:this.now()+this.ttlMs});
    return {sessionId:sid,agent,mode};
  }
  resolve(headers={}){
    this.sweep();
    const sid=headers['mcp-session-id'];
    if(typeof sid==='string'&&SID_RE.test(sid)){
      const bound=this.sessions.get(sid);
      if(bound){
        const hint=normalizeHint(headers);
        if(hint&&this._id(hint)!==bound.agent)return {error:'AGENT_IDENTITY_CONFLICT'};
        bound.expires=this.now()+this.ttlMs;
        return {agent:bound.agent,mode:bound.mode,sessionId:sid};
      }
      return {error:'MCPGO_SESSION_EXPIRED'};
    }
    const hint=normalizeHint(headers);
    if(hint)return {agent:this._id(hint),mode:'stable',sessionId:null};
    return {agent:null,mode:'legacy',sessionId:null};
  }
  adoptWorkspace(headers={},agent){
    const sid=headers['mcp-session-id'];
    if(typeof sid!=='string')return {error:'WORKSPACE_REQUIRES_MCP_SESSION'};
    const session=this.sessions.get(sid);
    if(!session)return {error:'MCPGO_SESSION_EXPIRED'};
    if(session.mode==='stable'&&session.agent!==agent)
      return {error:'WORKSPACE_STABLE_SCOPE_CONFLICT'};
    session.agent=agent;
    if(session.mode!=='stable')session.mode='workspace';
    session.expires=this.now()+this.ttlMs;
    return {agent:session.agent,mode:session.mode,sessionId:sid};
  }
  remove(headers={}){
    const sid=headers['mcp-session-id'];
    if(typeof sid==='string'&&this.sessions.has(sid))this.sessions.delete(sid);
  }
  status(){this.sweep();return {activeMcpSessions:this.sessions.size};}
}
