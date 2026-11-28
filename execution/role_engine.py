"""MCP-10 owner-local multi-process Git worktree roles.

This engine accepts ONLY owner-trusted, bounded Python file changes. Hub messages,
ChatGPT pages, and arbitrary shell text are not an execution source. Roles are
separate subprocesses but NOT OS sandboxed; use fixtures until an owner explicitly
authorizes a repository and its tests.
"""
from __future__ import annotations

import contextlib
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import sys
import time

PROJECT_ROLES = {
    'TD': {'coder': 'td_coder', 'tester': 'td_tester', 'auditor': 'td_auditor'},
    'Museum': {'coder': 'museum_coder', 'tester': 'museum_tester',
               'auditor': 'museum_auditor'},
}
FILE_RE = re.compile(r'(?:src/[a-zA-Z0-9_]+\.py|tests/test_[a-zA-Z0-9_]+\.py)\Z')
TASK_RE = re.compile(r'[a-z][a-z0-9_-]{1,39}\Z')
SHA256 = re.compile(r'[0-9a-f]{64}\Z')
GIT_SHA = re.compile(r'[0-9a-f]{40}\Z')
STATES = ('CLAIMED', 'VERIFIED', 'FAILED', 'UNKNOWN')


class ScopeError(ValueError):
    pass


class UnsafePlan(ValueError):
    pass


class LeaseConflict(RuntimeError):
    pass


class ConflictError(RuntimeError):
    pass


def _digest(obj):
    return hashlib.sha256(json.dumps(obj, sort_keys=True, ensure_ascii=False,
                                     separators=(',', ':')).encode('utf-8')).hexdigest()


def _git(repo, *args, timeout=15):
    result = subprocess.run(['git', '-C', str(repo), *args], text=True,
                            encoding='utf-8', stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, timeout=timeout, shell=False)
    if result.returncode:
        raise RuntimeError('Git operation rejected: ' + str(args[0]) +
                           ' (' + str(result.returncode) + ')')
    return result.stdout.strip()


def _clean_repo(repo):
    repo = Path(repo).resolve(strict=True)
    if repo.is_symlink() or not repo.is_dir():
        raise ScopeError('Invalid source directory')
    if _git(repo, 'rev-parse', '--is-bare-repository') != 'false':
        raise ScopeError('Bare repository forbidden')
    canonical = Path(_git(repo, 'rev-parse', '--show-toplevel')).resolve(strict=True)
    if repo != canonical:
        raise ScopeError('Owner must register a Git top-level checkout')
    if _git(repo, 'status', '--porcelain'):
        raise ScopeError('Source checkout must be clean')
    return repo


def _validate(plan):
    if not isinstance(plan, dict) or set(plan) != {'project','task_id','base_commit','changes'}:
        raise UnsafePlan('Only the bounded, owner-issued plan schema is supported')
    project, task = plan['project'], plan['task_id']
    if project not in PROJECT_ROLES or not isinstance(task,str) or not TASK_RE.fullmatch(task):
        raise UnsafePlan('Unknown project or task')
    if not isinstance(plan['base_commit'],str) or not GIT_SHA.fullmatch(plan['base_commit']):
        raise UnsafePlan('Invalid pinned base commit')
    changes = plan['changes']
    if not isinstance(changes,list) or not 1 <= len(changes) <= 8:
        raise UnsafePlan('Expected 1..8 bounded Python changes')
    seen=set()
    for change in changes:
        if not isinstance(change,dict) or set(change) != {'path','expected_sha256','content'}:
            raise UnsafePlan('Unsupported change envelope')
        file=change['path']
        if not isinstance(file,str) or not FILE_RE.fullmatch(file) or file in seen:
            raise UnsafePlan('Unsafe or duplicate path')
        seen.add(file)
        expected=change['expected_sha256']
        if expected is not None and (not isinstance(expected,str) or not SHA256.fullmatch(expected)):
            raise UnsafePlan('Invalid expected file fingerprint')
        content=change['content']
        if not isinstance(content,str) or not 1 <= len(content.encode('utf-8')) <= 16000 or '\x00' in content:
            raise UnsafePlan('Invalid source content')
    if not any(item['path'].startswith('tests/test_') for item in changes):
        raise UnsafePlan('At least one actual test change required')
    return plan


@contextlib.contextmanager
def _exclusive(path, *, wait_s=0):
    """Atomic lock; stale locks require owner inspection, never auto-reclaim."""
    path.parent.mkdir(parents=True, exist_ok=True)
    deadline=time.monotonic()+wait_s
    descriptor=None
    while descriptor is None:
        try:
            descriptor=os.open(str(path), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except FileExistsError:
            if time.monotonic() >= deadline:
                raise LeaseConflict('Resource already leased: owner resolution required')
            time.sleep(.025)
    try:
        os.write(descriptor, str(os.getpid()).encode('ascii'))
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    try:
        yield
    finally:
        path.unlink(missing_ok=True)


class RoleEngine:
    """Owner-local coordinator; separate coder/tester/auditor OS processes."""
    def __init__(self, state_root, worktree_root):
        self.state=Path(state_root).resolve()
        self.worktrees=Path(worktree_root).resolve()
        if self.state.is_symlink() or self.worktrees.is_symlink():
            raise ScopeError('Symlink state/workspace root forbidden')
        self.state.mkdir(parents=True, exist_ok=True)
        self.worktrees.mkdir(parents=True, exist_ok=True)
        self.db=self.state/'roles.sqlite3'
        if self.db.is_symlink():
            raise ScopeError('Unsafe registry')
        with self._connect() as con:
            con.execute('''CREATE TABLE IF NOT EXISTS projects (
                project TEXT PRIMARY KEY,repo TEXT NOT NULL UNIQUE)''')
            con.execute('''CREATE TABLE IF NOT EXISTS runs (
                project TEXT NOT NULL,task TEXT NOT NULL,
                plan_sha TEXT NOT NULL,status TEXT NOT NULL,
                receipt TEXT, PRIMARY KEY(project,task))''')
    @contextlib.contextmanager
    def _connect(self):
        con=sqlite3.connect(self.db,timeout=10)
        try:
            con.execute('PRAGMA busy_timeout=10000')
            con.execute('PRAGMA journal_mode=WAL')
            with con:
                yield con
        finally:
            con.close()

    def register(self, project, repo):
        if project not in PROJECT_ROLES:
            raise ScopeError('Unknown owner-approved project')
        path=str(_clean_repo(repo))
        with self._connect() as con:
            existing=con.execute('SELECT project,repo FROM projects WHERE project=? OR repo=?',
                                 (project,path)).fetchall()
            if existing and any(row != (project,path) for row in existing):
                raise ScopeError('Project/repo mapping conflict; no cross-project reuse')
            if not existing:
                con.execute('INSERT INTO projects VALUES (?,?)', (project,path))
        return {'project': project,'repo':path}

    def _repo(self, project):
        if project not in PROJECT_ROLES:
            raise ScopeError('Unknown project')
        with self._connect() as con:
            row=con.execute('SELECT repo FROM projects WHERE project=?',(project,)).fetchone()
        if row is None:
            raise ScopeError('Project not registered by owner')
        return Path(row[0])

    def check_scope(self, actor, project, role):
        if project not in PROJECT_ROLES or role not in ('coder','tester','auditor') or (
                PROJECT_ROLES[project][role] != actor):
            raise ScopeError('Agent/project/role fence denied')
        self._repo(project)
        return True

    def _lock_path(self, repo, project, task):
        key=hashlib.sha256((str(repo).casefold()+'|'+project+'|'+task).encode()).hexdigest()
        return self.state/'locks'/('branch-'+key+'.lock')

    @contextlib.contextmanager
    def reserve_branch(self, project, task_id):
        if not isinstance(task_id,str) or not TASK_RE.fullmatch(task_id):
            raise UnsafePlan('Invalid task')
        repo=self._repo(project)
        with _exclusive(self._lock_path(repo,project,task_id)):
            yield

    @contextlib.contextmanager
    def _git_metadata_lock(self, repo):
        key=hashlib.sha256(str(repo).casefold().encode()).hexdigest()
        with _exclusive(self.state/'locks'/('git-'+key+'.lock'),wait_s=8):
            yield

    def _create_worktree(self, repo, dest, revision, *, branch=None):
        if dest.exists():
            raise LeaseConflict('Existing worktree: no automatic reuse')
        if not dest.parent.resolve()==self.worktrees:
            raise ScopeError('Worktree must remain inside owner-approved directory')
        with self._git_metadata_lock(repo):
            if branch:
                _git(repo,'worktree','add','--quiet','-b',branch,str(dest),revision)
            else:
                _git(repo,'worktree','add','--quiet','--detach',str(dest),revision)
        return str(dest)

    def _role(self, role, job, *, timeout=40):
        assert role in ('coder','tester','auditor')
        file=self.state/'jobs'/f"{job['project']}-{job['task_id']}-{role}.json"
        file.parent.mkdir(parents=True,exist_ok=True)
        # Separate minimal files bound to one exact role. Never place secrets here.
        with open(file,'x',encoding='utf-8') as f:
            json.dump({**job,'role':role,
                       'actor':PROJECT_ROLES[job['project']][role]},f,sort_keys=True)
        result=subprocess.run([sys.executable,str(Path(__file__).with_name('role_worker.py').resolve()),
                               '--worker',str(file)],capture_output=True,
                              text=True,encoding='utf-8',timeout=timeout,shell=False)
        try:
            payload=json.loads(result.stdout)
        except (ValueError,TypeError):
            raise RuntimeError('Worker receipt unavailable (UNKNOWN)')
        if payload.get('role')!=role or payload.get('actor')!=PROJECT_ROLES[job['project']][role]:
            raise RuntimeError('Worker identity receipt mismatch')
        if result.returncode and payload.get('phase')!='TEST_FAILED':
            raise RuntimeError('Worker failed without safely classifiable proof')
        return payload

    def summary(self, project):
        self._repo(project)
        state=dict.fromkeys(STATES,0)
        with self._connect() as con:
            for status,count in con.execute('SELECT status,COUNT(*) FROM runs WHERE project=? GROUP BY status',(project,)):
                state[status]=count
        return state

    def run(self, plan):
        plan=_validate(plan)
        project,task=plan['project'],plan['task_id']
        repo=self._repo(project)
        plan_sha=_digest(plan)
        with self._connect() as con:
            existing=con.execute('SELECT plan_sha,status,receipt FROM runs WHERE project=? AND task=?',(project,task)).fetchone()
        if existing:
            if existing[0]!=plan_sha:
                raise ConflictError('Task identifier reused with a different plan')
            if existing[1]=='VERIFIED':
                return json.loads(existing[2])
            raise LeaseConflict('Unresolved or failed task must not be automatically retried')
        with self.reserve_branch(project,task):
            # Atomic claim across independent coordinators/processes.
            with self._connect() as con:
                try:
                    con.execute('INSERT INTO runs VALUES (?,?,?, ?,NULL)',(project,task,plan_sha,'CLAIMED'))
                except sqlite3.IntegrityError:
                    raise LeaseConflict('Another coordinator claimed this task')
            branch='mcpgo/'+project+'/'+task
            receipt={'status':'UNKNOWN','project':project,'task_id':task,
                     'branch':branch,'plan_sha256':plan_sha,
                     'base_commit':plan['base_commit'],'roles':['coordinator'],
                     'coordinator_actor':'mcpgo_lead',
                     'role_pids':{'coordinator':os.getpid()},'worktrees':{},'tester_pass':False,
                     'auditor_pass':False}
            try:
                if _git(repo,'rev-parse','HEAD')!=plan['base_commit']:
                    raise ScopeError('Pinned base changed; resolve with owner')
                if _git(repo,'status','--porcelain'):
                    raise ScopeError('Owner checkout is dirty')
                job={'project':project,'task_id':task,'base_commit':plan['base_commit'],
                     'branch':branch,'repo':str(repo),'changes':plan['changes'],
                     'worktrees':{},'hooks_dir':str(self.state/'empty-hooks')}
                Path(job['hooks_dir']).mkdir(parents=True,exist_ok=True)
                for role in ('coder',):
                    workdir=self.worktrees/f'{project}-{task}-{role}'
                    job['worktrees'][role]=self._create_worktree(repo,workdir,plan['base_commit'],branch=branch)
                coder=self._role('coder',job)
                receipt['role_pids']['coder']=coder['pid']
                receipt['roles'].append('coder')
                receipt['worktrees']['coder']=job['worktrees']['coder']
                commit=coder['commit']
                if not GIT_SHA.fullmatch(commit) or _git(repo,'rev-parse',branch)!=commit:
                    raise RuntimeError('Coder commit not independently found')
                receipt['commit']=commit
                for role in ('tester','auditor'):
                    workdir=self.worktrees/f'{project}-{task}-{role}'
                    job['worktrees'][role]=self._create_worktree(repo,workdir,commit)
                job['commit']=commit
                tester=self._role('tester',job)
                receipt['role_pids']['tester']=tester['pid']
                receipt['roles'].append('tester')
                receipt['worktrees']['tester']=job['worktrees']['tester']
                receipt['tester_pass']=tester.get('passed') is True
                receipt['test_sha256']=tester.get('test_sha256')
                if receipt['tester_pass']:
                    audit=self._role('auditor',job)
                    receipt['role_pids']['auditor']=audit['pid']
                    receipt['roles'].append('auditor')
                    receipt['worktrees']['auditor']=job['worktrees']['auditor']
                    receipt['auditor_pass']=audit.get('passed') is True
                    receipt['audit_sha256']=audit.get('audit_sha256')
                receipt['status']='VERIFIED' if receipt['tester_pass'] and receipt['auditor_pass'] else 'FAILED'
            except (Exception,BaseException) as e:
                # The coder may have committed even if the worker receipt was lost.
                # No automatic branch cleanup, lease requeue or retry on UNKNOWN.
                receipt['status']='UNKNOWN'
                receipt['reason']=type(e).__name__+': '+str(e)[:160]
            with self._connect() as con:
                con.execute('UPDATE runs SET status=?,receipt=? WHERE project=? AND task=? AND status=?',
                            (receipt['status'],json.dumps(receipt,sort_keys=True),project,task,'CLAIMED'))
            return receipt
