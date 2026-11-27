"""MCP-12 explicit owner-approved local work adapter; no model dispatch.

Uses the already bounded MCP-10 RoleEngine. Executes at most one owner-pinned
Git plan, then records only independently rechecked Git/test/audit evidence.
Uncertain or failing work never falls through to another model.
"""
from __future__ import annotations

from execution.role_engine import LeaseConflict,ConflictError
from execution.usage_ledger import UsageDenied,_identity


def run_owner_local_once(engine,ledger,plan,run_id,agent):
    """Run one owner-trusted local plan, not an arbitrary Hub/browser instruction.

    For VERIFIED local Git work, this function verifies and records the existing
    RoleEngine SQLite/Git proof. UNKNOWN never gets a repeat execution.
    """
    if not isinstance(plan,dict):
        raise UsageDenied('An explicit owner-pinned code plan is required')
    project,task=plan.get('project'),plan.get('task_id')
    _identity(project,agent,run_id,task)
    engine.check_scope(agent,project,'coder')
    try:
        receipt=engine.run(plan)
    except ConflictError:
        # The task identifier belongs to another pinned plan. Do not retry
        # and do not overwrite the original event with a different story.
        return {'status':'UNKNOWN','next_action':'NEED_OWNER',
                'usage_event':'UNKNOWN','model_dispatch':'NONE',
                'reason':'CONFLICTING_OWNER_PLAN'}
    except LeaseConflict:
        with engine._connect() as con:
            row=con.execute('SELECT status FROM runs WHERE project=? AND task=?',
                            (project,task)).fetchone()
        kind,reason='BLOCKED',('LOCAL_CHECK_FAILED' if row and row[0]=='FAILED'
                               else 'PENDING_RECEIPT')
        ledger_event=ledger.record_event(
            event_id='blocked:'+project+':'+agent+':'+task,project=project,
            agent=agent,run_id=run_id,task_id=task,kind=kind,
            route='NONE',reason=reason)
        return {'status':'UNKNOWN','next_action':'NEED_OWNER',
                'usage_event':ledger_event,'model_dispatch':'NONE',
                'reason':'EXISTING_RUN_NOT_SAFE_TO_RETRY'}
    if receipt.get('status')=='VERIFIED':
        try:
            event=ledger.capture_verified_role_run(engine,project,agent,run_id,task)
            return {'status':'VERIFIED','next_action':'NO_MODEL',
                    'usage_event':event,'model_dispatch':'NONE',
                    'reason':'INDEPENDENT_GIT_TEST_AUDIT'}
        except UsageDenied:
            # Work may have committed; owner must inspect before any retry.
            return {'status':'UNKNOWN','next_action':'NEED_OWNER',
                    'usage_event':'UNKNOWN','model_dispatch':'NONE',
                    'reason':'LEDGER_PROOF_NOT_DURABLE'}
    reason=('LOCAL_CHECK_FAILED' if receipt.get('status')=='FAILED'
            else 'PENDING_RECEIPT')
    event=ledger.record_event(event_id='blocked:'+project+':'+agent+':'+task,
         project=project,agent=agent,run_id=run_id,task_id=task,
         kind='BLOCKED',route='NONE',reason=reason)
    return {'status':receipt.get('status','UNKNOWN'),'next_action':'NEED_OWNER',
            'usage_event':event,'model_dispatch':'NONE','reason':reason}
