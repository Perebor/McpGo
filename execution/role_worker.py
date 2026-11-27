"""MCP-10 bounded worker phases, each launched as its own Python process.

No arbitrary shell commands or external model; only owner-approved Python
changes and fixed unittest command on isolated Git worktrees.
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

sys.path.insert(0,str(Path(__file__).resolve().parent))
from role_engine import PROJECT_ROLES, _git, _validate, _digest


def _secure_file(worktree, relative):
    root=Path(worktree).resolve(strict=True)
    file=root.joinpath(*relative.split('/'))
    parent=file.parent
    if not parent.is_dir() or parent.is_symlink() or parent.resolve()!=root / relative.split('/')[0]:
        raise ValueError('Unsafe source directory')
    if file.is_symlink() or (file.exists() and not file.is_file()):
        raise ValueError('Unsafe target file')
    return file


def _coder(job):
    work=Path(job['worktrees']['coder'])
    if _git(work,'rev-parse','HEAD')!=job['base_commit']:
        raise ValueError('Coder base mismatch')
    for change in job['changes']:
        file=_secure_file(work,change['path'])
        expected=change['expected_sha256']
        if expected is None:
            if file.exists():
                raise ValueError('Expected new file')
        elif not file.exists() or hashlib.sha256(file.read_bytes().replace(b'\r\n',b'\n')).hexdigest()!=expected:
            raise ValueError('Expected source hash mismatch')
        file.write_bytes(change['content'].encode('utf-8'))
    paths=[change['path'] for change in job['changes']]
    hooks='core.hooksPath='+job['hooks_dir']
    _git(work,'-c',hooks,'add','--',*paths)
    _git(work,'-c',hooks,'-c','commit.gpgsign=false',
         '-c','user.name=McpGo Role Fixture',
         '-c','user.email=mcpgo-fixture@example.invalid',
         'commit','-qm','mcpgo: '+job['project']+'/'+job['task_id'])
    commit=_git(work,'rev-parse','HEAD')
    if _git(work,'rev-parse','HEAD^')!=job['base_commit']:
        raise ValueError('Unexpected parent commit')
    if _git(work,'status','--porcelain'):
        raise ValueError('Coder worktree dirty after commit')
    return {'commit':commit}


def _unittest(worktree):
    root=Path(worktree).resolve(strict=True)
    if not (root/'tests').is_dir() or (root/'tests').is_symlink():
        raise ValueError('Trusted test directory missing')
    # Deliberately fixed command; never execute commands from Hub payloads.
    env={k:os.environ[k] for k in ('SYSTEMROOT','SystemRoot','PATH','Path','TEMP','TMP','HOME')
         if k in os.environ}
    env['PYTHONPATH']=str(root)
    env['PYTHONDONTWRITEBYTECODE']='1'
    proc=subprocess.run([sys.executable,'-m','unittest','discover','-s','tests','-t','.','-v'],
                        cwd=str(root),env=env,stdin=subprocess.DEVNULL,
                        capture_output=True,text=True,encoding='utf-8',
                        errors='replace',timeout=25,shell=False)
    output=(proc.stdout+'\n'+proc.stderr)[:20000]
    return proc.returncode==0,hashlib.sha256(output.encode()).hexdigest()


def _tester(job):
    root=job['worktrees']['tester']
    if _git(root,'rev-parse','HEAD')!=job['commit']:
        raise ValueError('Tester checkout does not match coder commit')
    passed,digest=_unittest(root)
    return {'passed':passed,'test_sha256':digest}


def _auditor(job):
    work=job['worktrees']['auditor']
    commit=job['commit']
    if _git(work,'rev-parse','HEAD')!=commit:
        raise ValueError('Auditor checkout changed')
    if _git(work,'rev-parse','HEAD^')!=job['base_commit']:
        raise ValueError('Audit parent mismatch')
    if _git(work,'status','--porcelain'):
        raise ValueError('Audit checkout dirty')
    observed=set(_git(work,'diff','--name-only',job['base_commit'],commit).splitlines())
    expected={item['path'] for item in job['changes']}
    if observed!=expected:
        raise ValueError('Unexpected changed files detected')
    for item in job['changes']:
        contents=_secure_file(work,item['path']).read_bytes()
        if hashlib.sha256(contents.replace(b'\r\n',b'\n')).hexdigest()!=hashlib.sha256(item['content'].encode()).hexdigest():
            raise ValueError('Code does not match pinned owner plan')
    passed,digest=_unittest(work)
    return {'passed':passed,'audit_sha256':_digest({
        'commit':commit,'paths':sorted(observed),'test_fingerprint':digest})}


def main():
    if len(sys.argv)!=3 or sys.argv[1]!='--worker':
        raise ValueError('Worker requires private owner-plan path')
    path=Path(sys.argv[2])
    if not path.is_file() or path.is_symlink():
        raise ValueError('Unsafe worker plan file')
    job=json.loads(path.read_text(encoding='utf-8'))
    _validate({k:job[k] for k in ('project','task_id','base_commit','changes')})
    role=job.get('role')
    if role not in ('coder','tester','auditor') or (
            job.get('actor')!=PROJECT_ROLES[job['project']][role]):
        raise ValueError('Worker role/project fence')
    if role=='coder':
        result=_coder(job)
    elif role=='tester':
        result=_tester(job)
    else:
        result=_auditor(job)
    ok=result.get('passed',True)
    packet={'role':role,'actor':job['actor'],'pid':os.getpid(),
            'phase':'OK' if ok else 'TEST_FAILED',**result}
    print(json.dumps(packet),flush=True)
    return 0 if ok else 1


if __name__=='__main__':
    try:
        sys.exit(main())
    except Exception as exc:
        # Never disclose paths, Git content, local secrets or raw test output.
        print(json.dumps({'phase':'UNKNOWN','error_type':type(exc).__name__,
                          'safe_detail':str(exc)[:100] if isinstance(exc,ValueError) else ''}),flush=True)
        sys.exit(2)
