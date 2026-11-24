/** Passive browser state. Only verified browser operations establish connection.
 * HTTP success, tool success, transport health and site-side commit are distinct.
 * Never record URLs, page text, tokens, scope handles or argument data here.
 */
import {responseMessage} from './mcp-response.mjs';
export const SHARED_CLIENT='MCPGO';
const BROWSER_LOST=/extension (?:did not connect|disconnected|connection|not found)|browser (?:has been )?closed|browser is not connected|chrome (?:connection|extension) (?:closed|disconnected|timed out)|failed to connect to (?:browser|chrome)|target page, context or browser has been closed/i;
function rpcMessage(response){
 if(response?.message)return response.message;
 try{return responseMessage(response.body,response.headers?.['content-type']||'application/json');}
 catch{return null;}
}
export function browserTransportFailed(response){
 if(!response||response.status===404||response.status===503)return true;
 if(response.status!==200)return false;
 const message=rpcMessage(response);
 if(message?.error)return BROWSER_LOST.test(String(message.error.message||''));
 if(message?.result?.isError)return BROWSER_LOST.test((message.result.content||[])
   .filter(c=>c.type==='text').map(c=>c.text||'').join(' ').slice(0,2000));
 return false;
}
export class BrowserReconnectError extends Error{
 constructor(retryAfterMs){
  super('Browser connection is in cooldown; retry after '+Math.ceil(retryAfterMs/1000)+' seconds');
  this.code='BROWSER_RECONNECT_COOLDOWN';this.retryAfterMs=retryAfterMs;
 }
}
export class BrowserSessionManager{
 constructor({now=()=>Date.now(),minDelayMs=3000,maxDelayMs=60000}={}){
  this.now=now;this.minDelayMs=minDelayMs;this.maxDelayMs=maxDelayMs;
  this.browserState='unknown';this.mcpState='unknown';this.transportState='unknown';
  this.sessionGeneration=0;this.connectAttempts=0;this.failedConnections=0;
  this.consecutiveFailures=0;this.retryAt=0;this.lastBrowserConnectedAt=null;
  this.lastFailureCode=null;this.lastOutcome='unknown';this.pending=false;
 }
 markMcpReady(){this.mcpState='ready';this.transportState='ready';}
 markMcpUnavailable(){
  this.mcpState='unavailable';this.transportState='unavailable';this.browserState='unknown';
  this.sessionGeneration++;this.pending=false;this.retryAt=0;this.consecutiveFailures=0;
  this.lastOutcome='session_expired';this.lastFailureCode='MCP_SESSION_EXPIRED';
 }
 beforeBrowserCall(){
  const wait=this.retryAt-this.now();if(wait>0)throw new BrowserReconnectError(wait);
  if(this.browserState!=='connected'&&!this.pending){
   this.pending=true;this.browserState=this.consecutiveFailures?'recovering':'connecting';
   this.connectAttempts++;
  }
 }
 recordBrowserEvent(type,code=null){
  this.pending=false;this.lastOutcome=type;
  switch(type){
   case 'browser_disconnected':
   case 'transport_unavailable':{
    this.failedConnections++;this.consecutiveFailures++;
    this.browserState=type==='browser_disconnected'?'degraded':'unknown';
    this.transportState=type==='transport_unavailable'?'unavailable':'ready';
    this.lastFailureCode=code||(type==='browser_disconnected'?'BROWSER_CONNECTION_FAILED':'MCP_TRANSPORT_UNAVAILABLE');
    this.retryAt=this.now()+Math.min(this.maxDelayMs,this.minDelayMs*2**Math.min(6,this.consecutiveFailures-1));
    return;
   }
   case 'outcome_unknown':
    this.browserState='unknown';this.transportState='unknown';
    this.lastFailureCode=code||'BROWSER_ACTION_OUTCOME_UNKNOWN';return;
   case 'session_expired':
    this.markMcpUnavailable();return;
   case 'tool_error':
    this.browserState='connected';this.mcpState='ready';this.transportState='ready';
    this.retryAt=0;this.consecutiveFailures=0;this.lastFailureCode=code||'BROWSER_TOOL_ERROR';return;
   case 'completed':
    this.browserState='connected';this.mcpState='ready';this.transportState='ready';
    this.retryAt=0;this.consecutiveFailures=0;this.lastFailureCode=null;
    this.lastBrowserConnectedAt=new Date(this.now()).toISOString();return;
   default:
    if(['connecting','recovering'].includes(this.browserState))this.browserState='unknown';
  }
 }
 recordBrowserResult(response){
  if(!response || response.status===503)return this.recordBrowserEvent('transport_unavailable');
  if(response.status===404)return this.recordBrowserEvent('session_expired');
  if(response.status!==200)return this.recordBrowserEvent('command_rejected');
  if(browserTransportFailed(response))return this.recordBrowserEvent('browser_disconnected');
  const message=rpcMessage(response);
  if(!message)return this.recordBrowserEvent('outcome_unknown','INVALID_MCP_RESPONSE');
  if(message.error||message.result?.isError)return this.recordBrowserEvent('tool_error');
  return this.recordBrowserEvent('completed');
 }
 status(){return {mcp:this.mcpState,transport:this.transportState,browser:this.browserState,
  shared:true,sessionName:SHARED_CLIENT,generation:this.sessionGeneration,
  attempts:this.connectAttempts,failures:this.failedConnections,
  cooldownMs:Math.max(0,this.retryAt-this.now()),lastConnectedAt:this.lastBrowserConnectedAt,
  lastFailureCode:this.lastFailureCode,lastOutcome:this.lastOutcome};}
}
