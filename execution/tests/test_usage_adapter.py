"""MCP-12 actual owner-local runner integration, never a model dispatch."""
import hashlib
import pathlib
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[2]))
from execution.role_engine import RoleEngine
from execution.usage_ledger import UsageLedger, UsageDenied
from execution.usage_adapter import run_owner_local_once

def git(repo,*args):
    return subprocess.check_output(['git','-C',str(repo),*args],text=True,encoding='utf-8').strip()

class OwnerLocalAdapterTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix='mcpgo12-adapter-')
        self.addCleanup(self.tmp.cleanup)
        self.root=pathlib.Path(self.tmp.name)
        self.repo=self.root/'owner_td';self.repo.mkdir()
        git(self.repo,'init','-q')
        git(self.repo,'config','user.name','Local Fixture')
        git(self.repo,'config','user.email','fixture@example.invalid')
        (self.repo/'src').mkdir();(self.repo/'tests').mkdir()
        old='def calc(x):\n    return x\n'
        (self.repo/'src'/'scale.py').write_text(old,encoding='utf-8')
        (self.repo/'tests'/'__init__.py').write_text('',encoding='utf-8')
        git(self.repo,'add','.')
        git(self.repo,'commit','-qm','trusted owner fixture')
        self.base=git(self.repo,'rev-parse','HEAD')
        self.engine=RoleEngine(self.root/'engine',self.root/'worktrees')
        self.engine.register('TD',self.repo)
        self.ledger=UsageLedger(self.root/'ledger.sqlite3')
        self.old=old

    def plan(self,task='feature-a',broken=False):
        test='import unittest\nfrom src.scale import calc\nclass ScaleTest(unittest.TestCase):\n    def test_scale(self):\n        self.assertEqual(calc(3),6)\n'
        return {'project':'TD','task_id':task,'base_commit':self.base,'changes':[
          {'path':'src/scale.py','expected_sha256':hashlib.sha256(self.old.encode()).hexdigest(),
           'content':'def calc(x):\n    return x * '+('8' if broken else '2')+'\n'},
          {'path':'tests/test_scale.py','expected_sha256':None,'content':test}
        ]}

    def test_real_verified_git_work_is_recorded_without_model_invocation(self):
        plan=self.plan()
        a=run_owner_local_once(self.engine,self.ledger,plan,'run-fixture-a','td_coder')
        self.assertEqual(a['status'],'VERIFIED')
        self.assertEqual(a['usage_event'],'RECORDED')
        self.assertEqual(a['model_dispatch'],'NONE')
        self.assertEqual(a['next_action'],'NO_MODEL')
        self.assertEqual(self.ledger.summary('TD','td_coder')['verified_commits'],1)
        self.assertEqual(self.ledger.summary('TD','td_coder')['model_claims'],0)
        repeat=run_owner_local_once(self.engine,self.ledger,plan,'run-fixture-a','td_coder')
        self.assertEqual(repeat['usage_event'],'ALREADY_RECORDED')
        self.assertEqual(self.ledger.summary('TD','td_coder')['verified_commits'],1)
        self.assertEqual(git(self.repo,'rev-parse','HEAD'),self.base)

    def test_failed_local_tests_block_with_no_model_fallback_and_no_unsafe_retry(self):
        result=run_owner_local_once(self.engine,self.ledger,self.plan(broken=True),'run-failed','td_coder')
        self.assertEqual(result['status'],'FAILED')
        self.assertEqual(result['model_dispatch'],'NONE')
        self.assertEqual(result['next_action'],'NEED_OWNER')
        self.assertEqual(self.ledger.summary('TD','td_coder')['blocked'],1)
        self.assertEqual(self.ledger.summary('TD','td_coder')['verified_commits'],0)
        again=run_owner_local_once(self.engine,self.ledger,self.plan(broken=True),'run-failed','td_coder')
        self.assertEqual(again['status'],'UNKNOWN')
        self.assertEqual(again['next_action'],'NEED_OWNER')
        self.assertEqual(self.ledger.summary('TD','td_coder')['blocked'],1)

    def test_wrong_project_actor_must_not_run_owner_plan_or_emit_metrics(self):
        with self.assertRaises((UsageDenied,ValueError)):
            run_owner_local_once(self.engine,self.ledger,self.plan(),'run-other','museum_coder')
        self.assertEqual(self.engine.summary('TD')['VERIFIED'],0)
        self.assertEqual(self.ledger.summary('TD','td_coder')['verified_commits'],0)

if __name__=='__main__':unittest.main()
