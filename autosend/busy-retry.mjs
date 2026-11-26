/**
 * Confirmed busy-CHAT retry policy for interval AutoSend.
 *
 * The scheduler still ticks every 10 seconds. This narrows the next *check*
 * after a definite active-generation signal, but NEVER bypasses the browser's
 * final pre-click guards or replays a committed/unknown send receipt.
 *
 * Not a backlog: one next_at only, without queued missed messages.
 */
export const BUSY_RETRY_MS=60_000;
export function deferBusyIntervalRetry(task,reason,now=Date.now()) {
 if(reason!=='busy'||task?.schedule_mode!=='interval'||task.status!=='scheduled'||
    task.enabled!==true||task.active_slot_id||task.verification)
  return false;
 const regularNext=Date.parse(task.next_at||'');
 if(!Number.isFinite(now)||!Number.isFinite(regularNext))return false;
 const next=Math.min(regularNext,now+BUSY_RETRY_MS);
 if(next===regularNext)return false;
 task.next_at=new Date(next).toISOString();
 return true;
}

/**
 * Only explicitly confirmed active generation may accelerate the next check.
 * Browser transport failures, unknown stream statuses, and other changed
 * page evidence stay on the conservative configured interval.
 */
export function confirmedBusyRetryReason(result) {
 if(result?.status==='deferred'&&result.reason==='busy')return 'busy';
 if(result?.status==='deferred'&&result.reason==='preclick'&&
    result.evidence?.code==='GENERATION_ACTIVE')return 'busy';
 if(result?.status==='refused'&&result.reason==='guard-refused'&&
    result.code==='GENERATION_ACTIVE')return 'busy';
 return null;
}
