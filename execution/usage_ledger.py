"""MCP-12 owner-local evidence ledger and non-dispatching model route advisor.

Neither this module nor its callers bypass quotas, make model calls, retry
unknown sends, infer tokens, or assert provider-side completion without proof.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3

PROJECT_ACTORS = {
    'TD': frozenset(('td_coder','td_tester','td_auditor','mcpgo_lead','chatgpt_autosend')),
    'Museum': frozenset(('museum_coder','museum_tester','museum_auditor','mcpgo_lead','chatgpt_autosend')),
}
IDENT = re.compile(r'[a-zA-Z][a-zA-Z0-9_.:-]{2,99}\Z')
TASK = re.compile(r'[a-z][a-z0-9_-]{1,39}\Z')
SHA256 = re.compile(r'[a-f0-9]{64}\Z')
TASK_SCOPE = re.compile(r'task:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\Z',re.I)
GIT_SHA = re.compile(r'[a-f0-9]{40}\Z')
STATES = frozenset(('AVAILABLE','UNAVAILABLE','UNKNOWN'))
LOCAL = frozenset(('VERIFIED','PENDING','EXHAUSTED','BLOCKED'))
REASONS = {
    'MODEL_CLAIMED': frozenset(('REQUEST_PENDING',)),
    'BLOCKED': frozenset(('QUOTA_UNKNOWN','OWNER_PERMISSION','UNAVAILABLE',
                         'PENDING_RECEIPT','LOCAL_CHECK_FAILED')),
    'RETRY_PRECLICK': frozenset(('CONFIRMED_PRECLICK_NO_SEND',)),
}
KINDS = frozenset((*REASONS,'GIT_VERIFIED'))


class UsageConflict(ValueError):
    """Same durable event ID submitted with different content."""


class UsageDenied(ValueError):
    """A missing receipt, unsafe account/route or forged event was rejected."""


def choose_route(local: str, ordinary: str, limited: str, owner_paid: bool) -> dict:
    """Advisory only. Never opens a model or dispatches queued work.

    UNKNOWN ordinary availability never triggers an escalation. Limited-cost
    tiers require explicit owner permission and provider availability.
    """
    if local not in LOCAL or ordinary not in STATES or limited not in STATES or type(owner_paid) is not bool:
        raise UsageDenied('Invalid routing evidence; no model dispatch')
    if local == 'VERIFIED':
        action,reason='NO_MODEL','INDEPENDENT_LOCAL_RESULT'
    elif local == 'PENDING':
        action,reason='LOCAL_CHECK','LOCAL_WORK_NOT_FINISHED'
    elif local == 'BLOCKED':
        action,reason='BLOCKED','RESOLVE_LOCAL_BLOCKER'
    elif ordinary == 'AVAILABLE':
        action,reason='NORMAL_CHAT','LOCAL_CHECKS_EXHAUSTED'
    elif ordinary == 'UNKNOWN':
        action,reason='WAIT_UNKNOWN','ORDINARY_QUOTA_NOT_VERIFIED'
    elif not owner_paid:
        action,reason='NEED_OWNER','LIMITED_TIER_NOT_AUTHORIZED'
    elif limited == 'AVAILABLE':
        action,reason='LIMITED_MODEL','OWNER_AUTHORIZED_AFTER_ORDINARY_UNAVAILABLE'
    elif limited == 'UNKNOWN':
        action,reason='WAIT_UNKNOWN','LIMITED_QUOTA_NOT_VERIFIED'
    else:
        action,reason='BLOCKED','NO_AVAILABLE_MODEL_TIER'
    return {'action':action,'reason':reason,'dispatch_performed':False,
            'tokens':'UNKNOWN','cost':'UNKNOWN'}


def compare_fixture(fixtures: list[dict]) -> dict:
    """Compare hypothetical claims on identical fixtures, not real savings."""
    if not isinstance(fixtures,list) or len(fixtures)>1000:
        raise UsageDenied('Invalid bounded fixture')
    choices=[]
    for item in fixtures:
        if not isinstance(item,dict) or set(item) != {'local','normal','limited','paid'}:
            raise UsageDenied('Invalid fixture schema')
        choices.append(choose_route(item['local'],item['normal'],item['limited'],item['paid'])['action'])
    proposed=sum(x in ('NORMAL_CHAT','LIMITED_MODEL') for x in choices)
    local_only=sum(x == 'NO_MODEL' for x in choices)
    return {
        'kind':'SIMULATION_NOT_ACTUAL_SAVINGS',
        'fixture_count':len(fixtures),
        'baseline_hypothetical_model_claims':len(fixtures),
        'policy_model_claims':proposed,
        'policy_local_no_model':local_only,
        'policy_wait_or_blocked':len(fixtures)-proposed-local_only,
        'tokens':'UNKNOWN','money_saved':'UNKNOWN',
        'verified_commits_from_fixture':None,
    }


def _identity(project,agent,run_id,task_id):
    if project not in PROJECT_ACTORS or agent not in PROJECT_ACTORS[project] or (
        not isinstance(run_id,str) or not IDENT.fullmatch(run_id)) or (
        not isinstance(task_id,str) or not TASK.fullmatch(task_id)):
        raise UsageDenied('Invalid project/agent/run/task scope')


def _digest(obj):
    return hashlib.sha256(json.dumps(obj,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()


class UsageLedger:
    """Durable local events and cumulative Codex counters; never stores prompts."""
    def __init__(self,path,*,readonly=False):
        self.path=Path(path).absolute()
        self.readonly=readonly is True
        if type(readonly) is not bool or self.path.is_symlink() or self.path.parent.is_symlink():
            raise UsageDenied('Unsafe ledger path or access mode')
        if self.readonly:
            if not self.path.is_file():
                raise UsageDenied('Read-only ledger unavailable; no database created')
            return
        self.path.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
        with self._db() as db:
            db.execute('''CREATE TABLE IF NOT EXISTS usage_events(
                event_id TEXT PRIMARY KEY,project TEXT NOT NULL,agent TEXT NOT NULL,
                run_id TEXT NOT NULL,task_id TEXT NOT NULL,kind TEXT NOT NULL,
                route TEXT NOT NULL,reason TEXT NOT NULL,
                fingerprint TEXT NOT NULL,commit_sha TEXT,test_sha TEXT,audit_sha TEXT,
                created_utc TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
            )''')
            db.execute('CREATE INDEX IF NOT EXISTS usage_project_agent ON usage_events(project,agent)')
            db.execute('''CREATE TABLE IF NOT EXISTS codex_session_usage(
                session_id TEXT PRIMARY KEY,
                project TEXT NOT NULL, agent TEXT NOT NULL, run_id TEXT NOT NULL,
                input_tokens INTEGER NOT NULL, cached_input_tokens INTEGER NOT NULL,
                cache_write_input_tokens INTEGER NOT NULL,
                output_tokens INTEGER NOT NULL, reasoning_output_tokens INTEGER NOT NULL,
                total_tokens INTEGER NOT NULL, token_updates INTEGER NOT NULL,
                source_digest TEXT NOT NULL,
                observed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
            )''')
            db.execute('CREATE INDEX IF NOT EXISTS usage_codex_by_actor ON codex_session_usage(project,agent)')
            # Same SQLite file as the Node AutoSend process: owner-local,
            # idempotent and source-scoped. Not signed provider billing data.
            db.execute('''CREATE TABLE IF NOT EXISTS autosend_observations(
                event_id TEXT PRIMARY KEY,project TEXT NOT NULL,agent TEXT NOT NULL,
                task_id TEXT NOT NULL,outcome TEXT NOT NULL,observed_at TEXT NOT NULL,
                source_kind TEXT NOT NULL,event_fingerprint TEXT NOT NULL
            )''')
            db.execute('CREATE INDEX IF NOT EXISTS autosend_usage_by_actor ON autosend_observations(project,agent)')
        if os.name!='nt':
            os.chmod(self.path,0o600)

    def _db(self):
        class Connection:
            def __init__(inner,filepath,readonly):
                inner.filepath=filepath
                inner.readonly=readonly
            def __enter__(inner):
                if inner.readonly:
                    inner.con=sqlite3.connect(inner.filepath.as_uri()+'?mode=ro',
                                             timeout=10,uri=True)
                    inner.con.execute('PRAGMA busy_timeout=10000')
                else:
                    inner.con=sqlite3.connect(str(inner.filepath),timeout=10)
                    inner.con.execute('PRAGMA busy_timeout=10000')
                    inner.con.execute('PRAGMA journal_mode=WAL')
                    inner.con.execute('BEGIN IMMEDIATE')
                return inner.con
            def __exit__(inner,exc_type,exc,tb):
                try:
                    if not inner.readonly:
                        if exc_type is None: inner.con.commit()
                        else: inner.con.rollback()
                finally: inner.con.close()
        return Connection(self.path,self.readonly)

    def _insert(self,event,allow_verification=False):
        if self.readonly:
            raise UsageDenied('Read-only usage inspector cannot record events')
        ident=event['event_id']
        if not isinstance(ident,str) or not IDENT.fullmatch(ident):
            raise UsageDenied('Invalid stable event identity')
        _identity(event['project'],event['agent'],event['run_id'],event['task_id'])
        kind,route,reason=event['kind'],event['route'],event['reason']
        if kind not in KINDS or (
            kind == 'GIT_VERIFIED' and not allow_verification):
            raise UsageDenied('Verification requires independent local role-engine evidence')
        if kind == 'GIT_VERIFIED':
            if route!='NONE' or reason!='INDEPENDENT_GIT_TEST_AUDIT' or any(
                not SHA256.fullmatch(event[k]) for k in ('test_sha','audit_sha')
            ) or not GIT_SHA.fullmatch(event['commit_sha']):
                raise UsageDenied('Invalid verified proof')
        elif (kind not in REASONS or reason not in REASONS[kind] or
              (route not in ('NORMAL_CHAT','LIMITED_MODEL') if kind=='MODEL_CLAIMED'
               else route!='NONE') or
              any(event[k] is not None for k in ('commit_sha','test_sha','audit_sha'))):
            raise UsageDenied('Invalid evidence or tier for run event')
        fingerprint=_digest(event)
        with self._db() as con:
            row=con.execute('SELECT fingerprint FROM usage_events WHERE event_id=?',(ident,)).fetchone()
            if row:
                if row[0]!=fingerprint:
                    raise UsageConflict('Conflicting replay of already recorded usage event')
                return 'ALREADY_RECORDED'
            if kind=='RETRY_PRECLICK':
                if con.execute('''SELECT 1 FROM usage_events WHERE
                    project=? AND agent=? AND run_id=? AND kind='MODEL_CLAIMED' LIMIT 1''',
                    (event['project'],event['agent'],event['run_id'])).fetchone():
                    raise UsageDenied('Unknown model claim cannot be retried automatically')
            try:
                con.execute('''INSERT INTO usage_events
                    (event_id,project,agent,run_id,task_id,kind,route,reason,
                     fingerprint,commit_sha,test_sha,audit_sha)
                    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)''',(
                    ident,event['project'],event['agent'],event['run_id'],event['task_id'],
                    kind,route,reason,fingerprint,event['commit_sha'],
                    event['test_sha'],event['audit_sha']))
            except sqlite3.IntegrityError as e:
                raise UsageConflict('Duplicate event identity') from e
        return 'RECORDED'

    def record_event(self,*,event_id,project,agent,run_id,task_id,kind,route,reason,**extras):
        if extras:
            raise UsageDenied('Untrusted token counts, costs, or extra fields forbidden')
        return self._insert(dict(event_id=event_id,project=project,agent=agent,
                                 run_id=run_id,task_id=task_id,kind=kind,
                                 route=route,reason=reason,
                                 commit_sha=None,test_sha=None,audit_sha=None))

    def record_codex_observation(self,project,agent,run_id,snapshot):
        """One scoped cumulative local Codex source; no self-reported tokens.

        Session IDs are globally unique, so copying a source between actors or
        projects cannot double-count its totals. Appends update one row.
        This local evidence is NOT a cryptographic provider/billing receipt.
        """
        if self.readonly:
            raise UsageDenied('Read-only usage inspector cannot record events')
        _identity(project,agent,run_id,'codex-scope')
        keys={'session_id','input_tokens','cached_input_tokens','cache_write_input_tokens',
              'output_tokens','reasoning_output_tokens','total_tokens',
              'token_update_events','observed_increases','source_digest','source_kind'}
        if not isinstance(snapshot,dict) or set(snapshot)!=keys or (
            snapshot['source_kind']!='LOCAL_CODEX_SESSION_NOT_PROVIDER_SIGNED'):
            raise UsageDenied('Untrusted Codex usage shape')
        from execution.codex_usage import FIELDS
        if any(type(snapshot[k]) is not int or snapshot[k]<0 or snapshot[k]>10**13
               for k in FIELDS) or not SHA256.fullmatch(snapshot['source_digest']):
            raise UsageDenied('Invalid normalized local Codex token numbers')
        # Apply the same numeric constraints at the durable SQLite trust boundary;
        # callers other than the JSONL reader must not inflate impossible totals.
        if (snapshot['cached_input_tokens']+snapshot['cache_write_input_tokens']>
            snapshot['input_tokens'] or
            snapshot['reasoning_output_tokens']>snapshot['output_tokens'] or
            snapshot['total_tokens']!=snapshot['input_tokens']+snapshot['output_tokens']):
            raise UsageDenied('Inconsistent Codex cumulative token arithmetic')
        if type(snapshot['token_update_events']) is not int or snapshot['token_update_events']<1 or (
            type(snapshot['observed_increases']) is not int or
            snapshot['observed_increases']<1 or
            snapshot['observed_increases']>snapshot['token_update_events']):
            raise UsageDenied('Missing normalized Codex usage changes')
        from execution.codex_usage import SESSION_RE
        sid=snapshot['session_id']
        if not isinstance(sid,str) or not SESSION_RE.fullmatch(sid):
            raise UsageDenied('Invalid Codex session ID')
        values=(sid,project,agent,run_id,
                *(snapshot[k] for k in FIELDS),
                snapshot['token_update_events'],snapshot['source_digest'])
        with self._db() as con:
            row=con.execute('''SELECT project,agent,run_id,input_tokens,cached_input_tokens,
                        cache_write_input_tokens,output_tokens,reasoning_output_tokens,
                        total_tokens,token_updates,source_digest
                FROM codex_session_usage WHERE session_id=?''',(sid,)).fetchone()
            if row is None:
                con.execute('''INSERT INTO codex_session_usage(
                    session_id,project,agent,run_id,input_tokens,cached_input_tokens,
                    cache_write_input_tokens,output_tokens,reasoning_output_tokens,
                    total_tokens,token_updates,source_digest)
                    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)''',values)
                return 'RECORDED'
            if tuple(row[:3])!=(project,agent,run_id):
                raise UsageConflict('Codex session already attributed to another scoped run')
            prior=tuple(row[3:9]);after=tuple(snapshot[k] for k in FIELDS)
            if any(next_value<old_value for next_value,old_value in zip(after,prior)) or (
                snapshot['token_update_events']<row[9]):
                raise UsageDenied('Codex usage regressed; investigate before import')
            if after==prior and snapshot['source_digest']==row[10]:
                return 'ALREADY_RECORDED'
            if after==prior or after[-1]==prior[-1]:
                raise UsageConflict('Codex telemetry changed without token increase')
            con.execute('''UPDATE codex_session_usage SET
                input_tokens=?,cached_input_tokens=?,cache_write_input_tokens=?,
                output_tokens=?,reasoning_output_tokens=?,total_tokens=?,
                token_updates=?,source_digest=?,
                observed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
                WHERE session_id=?''',(*after,snapshot['token_update_events'],
                                      snapshot['source_digest'],sid))
            return 'UPDATED'

    def capture_verified_role_run(self,engine,project,agent,run_id,task_id):
        """Recheck the owner-registered repo, RoleEngine SQLite and Git commit.

        A model/agent's JSON self-report is *never* a verified work receipt.
        The local coder's Git SHA and independent tester/auditor receipts must
        be durably present. This does not certify external CI/provider usage.
        """
        _identity(project,agent,run_id,task_id)
        try:
            from execution.role_engine import PROJECT_ROLES,_git
            if PROJECT_ROLES[project]['coder']!=agent:
                raise UsageDenied('Only the registered coder may own this verified run')
            engine.check_scope(agent,project,'coder')
            repo=engine._repo(project)
            with engine._connect() as con:
                row=con.execute('SELECT plan_sha,status,receipt FROM runs WHERE project=? AND task=?',
                                (project,task_id)).fetchone()
            if not row or row[1]!='VERIFIED' or not row[2]:
                raise UsageDenied('Independent role execution has no VERIFIED receipt')
            rec=json.loads(row[2])
            commit=rec.get('commit')
            tests=rec.get('test_sha256')
            audit=rec.get('audit_sha256')
            if (rec.get('status')!='VERIFIED' or rec.get('project')!=project or
                rec.get('task_id')!=task_id or rec.get('plan_sha256')!=row[0] or
                rec.get('tester_pass') is not True or rec.get('auditor_pass') is not True or
                not isinstance(commit,str) or not GIT_SHA.fullmatch(commit) or
                not isinstance(tests,str) or not SHA256.fullmatch(tests) or
                not isinstance(audit,str) or not SHA256.fullmatch(audit)):
                raise UsageDenied('Invalid independent role/test/audit receipt')
            branch=rec.get('branch')
            base=rec.get('base_commit')
            if (branch != 'mcpgo/'+project+'/'+task_id or not isinstance(base,str)
                or not GIT_SHA.fullmatch(base) or
                _git(repo,'rev-parse',branch)!=commit or
                _git(repo,'rev-parse',commit+'^')!=base):
                raise UsageDenied('Git branch or parent does not match verified receipt')
            paths=_git(repo,'diff','--name-only',base,commit).splitlines()
            if not any(x.startswith('src/') and x.endswith('.py') for x in paths) or (
                not any(x.startswith('tests/test_') and x.endswith('.py') for x in paths)):
                raise UsageDenied('No independent source and test changes in Git commit')
            event=dict(event_id='verified:'+project+':'+agent+':'+task_id,
                       project=project,agent=agent,run_id=run_id,task_id=task_id,
                       kind='GIT_VERIFIED',route='NONE',
                       reason='INDEPENDENT_GIT_TEST_AUDIT',
                       commit_sha=commit,test_sha=tests,audit_sha=audit)
            return self._insert(event,allow_verification=True)
        except UsageDenied:
            raise
        except (OSError,ValueError,RuntimeError,KeyError,sqlite3.Error) as e:
            raise UsageDenied('Local proof unavailable or inconsistent') from e

    def work_links(self,project,agent):
        """Read exact local Git SHA/PR ↔ receipt associations, not causation.

        These records were mirrored from owner-registered GitHub CI adapter
        verdicts plus an existing DOM-verified AutoSend receipt. Never infer
        provider-billed tokens or fabricate a new Git verification.
        """
        if project not in ('TD','Museum') or agent!='chatgpt_autosend':
            raise UsageDenied('Only registered project AutoSend work links are readable')
        with self._db() as con:
            exists=con.execute("""SELECT 1 FROM sqlite_master
                WHERE type='table' AND name='verified_work_links'""").fetchone()
            if not exists:
                return []
            rows=con.execute("""SELECT task_id,project,receipt_event_id,repo,
                git_sha,pr_number,proof_fingerprint,result_observed_at,
                evidence_source FROM verified_work_links
                WHERE project=? AND agent=?
                ORDER BY result_observed_at,receipt_event_id""",
                (project,agent)).fetchall()
        names=('task_id','project','receipt_event_id','repo','git_sha',
               'pr_number','proof_fingerprint','result_observed_at',
               'evidence_source')
        return [dict(zip(names,row)) for row in rows]

    def summary(self,project,agent):
        # AutoSend records standalone owner-approved test chats as task:UUID.
        # This is read-only scope; all ledger write paths still call _identity.
        if not (isinstance(project,str) and TASK_SCOPE.fullmatch(project)
                and agent=='chatgpt_autosend'):
            _identity(project,agent,'summary','summary')
        with self._db() as con:
            rows=con.execute('''SELECT kind,COUNT(*)
                FROM usage_events WHERE project=? AND agent=? GROUP BY kind''',
                (project,agent)).fetchall()
            commits=con.execute('''SELECT COUNT(DISTINCT commit_sha) FROM usage_events
                WHERE project=? AND agent=? AND kind='GIT_VERIFIED' ''',
                (project,agent)).fetchone()[0]
            codex=con.execute('''SELECT COUNT(*),SUM(input_tokens),SUM(cached_input_tokens),
                SUM(output_tokens),SUM(reasoning_output_tokens),SUM(token_updates)
                FROM codex_session_usage WHERE project=? AND agent=?''',
                (project,agent)).fetchone()
            observed=con.execute('''SELECT
                SUM(CASE WHEN outcome='CHAT_RESPONSE_OBSERVED' THEN 1 ELSE 0 END),
                SUM(CASE WHEN outcome='OWNER_ATTESTED' THEN 1 ELSE 0 END),
                SUM(CASE WHEN outcome='DELIVERY_UNKNOWN' THEN 1 ELSE 0 END)
                FROM autosend_observations WHERE project=? AND agent=?''',
                (project,agent)).fetchone()
            # New Node-ledger schema is optional: older deployed databases
            # remain readable without DDL or a schema migration on query.
            has_work_links=con.execute('''SELECT 1 FROM sqlite_master
                WHERE type='table' AND name='verified_work_links' ''').fetchone()
            linked=con.execute('''SELECT COUNT(*) FROM verified_work_links
                WHERE project=? AND agent=?''',(project,agent)).fetchone()[0]                 if has_work_links else 0
        counts=dict(rows)
        model=counts.get('MODEL_CLAIMED',0)
        return {'project':project,'agent':agent,
                'model_claims':model,'confirmed_model_calls':0,
                'unverified_model_claims':model,
                'blocked':counts.get('BLOCKED',0),
                'preclick_retries':counts.get('RETRY_PRECLICK',0),
                'verified_commits':commits,
                'verified_test_runs':counts.get('GIT_VERIFIED',0),
                'observed_chat_responses':observed[0] or 0,
                'owner_attested_responses':observed[1] or 0,
                'delivery_unknown':observed[2] or 0,
                'verified_git_work_links':linked,
                'work_link_source':'LOCAL_GITHUB_CI_ADAPTER_TEMPORAL_LINK'
                    if linked else None,
                'work_link_note':'chronological association, NOT proof of causation',
                'chat_delivery_source':'LOCAL_AUTOSEND_RECEIPT_NOT_PROVIDER_SIGNED'
                    if any(x for x in observed) else None,
                'useful_verified_per_model_claim':commits/model if model else None,
                'input_tokens':None,'output_tokens':None,
                'codex_observed_sessions':codex[0] or 0,
                'codex_observed_input_tokens':codex[1] or 0,
                'codex_observed_cached_input_tokens':codex[2] or 0,
                'codex_observed_output_tokens':codex[3] or 0,
                'codex_observed_reasoning_output_tokens':codex[4] or 0,
                'codex_observed_token_updates':codex[5] or 0,
                'codex_usage_source':'LOCAL_CODEX_SESSION_NOT_PROVIDER_SIGNED'
                    if codex[0] else None,
                'token_measurement':'LOCAL_CODEX_TELEMETRY_NOT_PROVIDER_SIGNED'
                    if codex[0] else 'UNKNOWN',
                'cost_measurement':'UNKNOWN',
                'evidence_source':'owner_local_git_role_engine_not_provider',
                'model_claim_note':'claims are NOT confirmed provider invocations'}
