import {streamBusy,streamReady} from './stream-monitor.mjs';
/** A smart continuation requires an observed active assistant response followed
 * by two stable clean observations. An idle page after arming is not enough. */
export function trackSmartContinuation(task,observation,now=Date.now()){
 if(task.schedule_mode!=='after_response'||!task.enabled||task.status!=='scheduled'||task.next_at)return false;
 if((task.continuations_sent||0)>=(task.max_continuations||20))return false;
 const busy=observation.streamStatus===undefined?
  !!(observation.stop||observation.busyText):streamBusy(observation);
 const serverReady=observation.streamStatus===undefined?!busy:streamReady(observation);
 const ready=observation.urlValid!==false && serverReady && !observation.connectionInterrupted &&
  observation.pageReady==='complete' && observation.editorCount===1 &&
  !String(observation.editorText||'').trim();
 if(busy){
  const changed=!task.smart_seen_busy||task.smart_ready_since;
  task.smart_seen_busy=true;task.smart_ready_since=null;task.smart_last_marker=null;
  return Boolean(changed);
 }
 if(!task.smart_seen_busy)return false;
 if(!ready){
  if(task.smart_ready_since){task.smart_ready_since=null;task.smart_last_marker=null;return true;}
  return false;
 }
 const marker=[observation.userCount||0,observation.lastUserHash||'',observation.assistantRevision??''].join(':');
 if(task.smart_last_marker!==marker){
  task.smart_last_marker=marker;
  task.smart_ready_since=new Date(now).toISOString();
  return true;
 }
 const since=Date.parse(task.smart_ready_since||'');
 if(!Number.isFinite(since))return false;
 if(now-since<(task.delay_seconds||30)*1000)return false;
 task.next_at=new Date(now).toISOString();
 task.smart_seen_busy=false;task.smart_ready_since=null;
 return true;
}
