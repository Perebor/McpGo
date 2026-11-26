/**
 * Process-local, task-scoped permission evidence for the dedicated AutoSend
 * Playwright Extension group. Nothing is restored automatically after restart.
 * An approved tab is learned only from an explicit read-only preview or an
 * exact verified outgoing delivery; it is never inferred from backend TCP.
 */
export class TabApproval {
 constructor(){this.ids=new Set()}
 has(id){return typeof id==='string'&&this.ids.has(id)}
 update(id,found){
  if(typeof id!=='string'||!id)return;
  if(found===true)this.ids.add(id);
  else this.ids.delete(id);
 }
 reset(){this.ids.clear()}
 get size(){return this.ids.size}
}
export function mayAutoObserve(task,approved){
 if(task?.smart_v2===true&&task?.smart_result_gate===true)
  return !!task.smart_v2_last_action&&approved===true;
 return true;
}
export function mayAutoDispatch(task,approved){
 if(task?.schedule_mode==='after_response'&&task?.smart_v2===true&&task?.smart_result_gate===true)
  return task.manual_once===true||approved===true;
 return true;
}
