/** Serial browser scheduler. Bounded priority bursts prevent AutoSend starvation.
 * An uncertain dispatched mutation quarantines the shared active tab until
 * a controlled proxy/backend recovery; never guess that a timed-out click ended.
 */
export class BrowserActionQueue {
  constructor({now=()=>Date.now(), maxWaiting=16, waitMs=12000, maxPriorityBurst=3}={}) {
    this.now=now;this.maxWaiting=maxWaiting;this.waitMs=waitMs;
    this.maxPriorityBurst=maxPriorityBurst;this.priorityBurst=0;
    this.held=false;this.startedAt=0;this.waiters=[];this.quarantined=false;
  }
  status(){
    const now=this.now();
    return {active:this.held,waiting:this.waiters.length,
      activeMs:this.held?now-this.startedAt:0,
      oldestWaitMs:this.waiters.length?now-Math.min(...this.waiters.map(w=>w.createdAt)):0,
      blocked:this.quarantined||this.waiters.length>=8||(this.held&&now-this.startedAt>45000),
      quarantined:this.quarantined};
  }
  release(){
    let released=false;
    return ()=>{if(released)return;released=true;this.next();};
  }
  next(){
    if(this.quarantined){
      for(const waiter of this.waiters.splice(0)){
        waiter.cleanup();waiter.reject(Error('BROWSER_ACTION_OUTCOME_UNKNOWN'));
      }
      this.held=false;this.startedAt=0;return;
    }
    while(this.waiters.length){
      const firstNormal=this.waiters.findIndex(w=>!w.priority);
      const firstHigh=this.waiters.findIndex(w=>w.priority);
      const chooseHigh=firstHigh>=0 && (firstNormal<0 || this.priorityBurst<this.maxPriorityBurst);
      const index=chooseHigh?firstHigh:firstNormal;
      const waiter=this.waiters.splice(index,1)[0];waiter.cleanup();
      if(waiter.signal?.aborted){waiter.reject(Error('BROWSER_QUEUE_CLIENT_GONE'));continue;}
      this.priorityBurst=chooseHigh?this.priorityBurst+1:0;
      this.startedAt=this.now();waiter.resolve(this.release());return;
    }
    this.held=false;this.startedAt=0;this.priorityBurst=0;
  }
  quarantine(){this.quarantined=true;this.next();}
  acquire({signal,priority=false,budgetMs=this.waitMs}={}){
    if(this.quarantined)return Promise.reject(Error('BROWSER_ACTION_OUTCOME_UNKNOWN'));
    if(signal?.aborted)return Promise.reject(Error('BROWSER_QUEUE_CLIENT_GONE'));
    if(!this.held){this.held=true;this.startedAt=this.now();return Promise.resolve(this.release());}
    if(this.waiters.length>=this.maxWaiting)return Promise.reject(Error('BROWSER_QUEUE_FULL'));
    return new Promise((resolve,reject)=>{
      let timer;
      const waiter={resolve,reject,signal,priority,createdAt:this.now(),cleanup:()=>{
        clearTimeout(timer);signal?.removeEventListener('abort',cancel);
      }};
      const cancel=()=>{
        const index=this.waiters.indexOf(waiter);
        if(index<0)return;
        this.waiters.splice(index,1);waiter.cleanup();
        reject(Error(signal?.aborted?'BROWSER_QUEUE_CLIENT_GONE':'BROWSER_QUEUE_WAIT_TIMEOUT'));
      };
      timer=setTimeout(cancel,Math.max(1,Math.min(this.waitMs,budgetMs)));timer.unref?.();
      signal?.addEventListener('abort',cancel,{once:true});
      this.waiters.push(waiter);
    });
  }
}
