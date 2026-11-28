"""MCP-12 source RED/GREEN tests. Only isolated Git and SQLite fixtures."""
import hashlib
import pathlib
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[2]))
from execution.usage_ledger import UsageLedger, choose_route, compare_fixture, UsageConflict, UsageDenied
from execution.role_engine import RoleEngine


class UsageLedgerTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='mcpgo12-')
        self.addCleanup(self.temp.cleanup)
        self.root=pathlib.Path(self.temp.name)
        self.file=self.root/'owner_ledger.sqlite3'
        self.ledger=UsageLedger(self.file)

    def test_local_first_normal_then_explicit_limited_unknown_blocks_and_never_escapes(self):
        self.assertEqual(choose_route('PENDING','AVAILABLE','AVAILABLE',False)['action'],'LOCAL_CHECK')
        self.assertEqual(choose_route('VERIFIED','AVAILABLE','AVAILABLE',False)['action'],'NO_MODEL')
        self.assertEqual(choose_route('EXHAUSTED','AVAILABLE','AVAILABLE',False)['action'],'NORMAL_CHAT')
        self.assertEqual(choose_route('EXHAUSTED','UNKNOWN','AVAILABLE',True)['action'],'WAIT_UNKNOWN')
        self.assertEqual(choose_route('EXHAUSTED','UNAVAILABLE','AVAILABLE',False)['action'],'NEED_OWNER')
        self.assertEqual(choose_route('EXHAUSTED','UNAVAILABLE','AVAILABLE',True)['action'],'LIMITED_MODEL')
        self.assertEqual(choose_route('EXHAUSTED','UNAVAILABLE','UNKNOWN',True)['action'],'WAIT_UNKNOWN')
        self.assertEqual(choose_route('BLOCKED','AVAILABLE','AVAILABLE',True)['action'],'BLOCKED')
        with self.assertRaises((ValueError,UsageDenied)):
            choose_route('EXHAUSTED',0,True,True)
        for row in [
          choose_route('EXHAUSTED','AVAILABLE','AVAILABLE',False),
          choose_route('EXHAUSTED','UNAVAILABLE','AVAILABLE',True)
        ]:
            self.assertFalse(row['dispatch_performed'])

    def test_claimed_calls_are_not_verified_usage_or_tokens_and_survive_restart(self):
        event=dict(event_id='evt-call-1',project='TD',agent='td_coder',
                   run_id='run-a',task_id='task-a',kind='MODEL_CLAIMED',
                   route='NORMAL_CHAT',reason='REQUEST_PENDING')
        self.assertEqual(self.ledger.record_event(**event),'RECORDED')
        self.assertEqual(UsageLedger(self.file).record_event(**event),'ALREADY_RECORDED')
        summary=UsageLedger(self.file).summary('TD','td_coder')
        self.assertEqual(summary['model_claims'],1)
        self.assertEqual(summary['confirmed_model_calls'],0)
        self.assertEqual(summary['unverified_model_claims'],1)
        self.assertIsNone(summary['input_tokens'])
        self.assertIsNone(summary['output_tokens'])
        self.assertEqual(summary['token_measurement'],'UNKNOWN')
        self.assertEqual(summary['verified_commits'],0)

    def test_conflicting_replay_scopes_invalid_actors_and_forged_verification_rejected(self):
        event=dict(event_id='evt-call-1',project='TD',agent='td_coder',
                   run_id='run-a',task_id='task-a',kind='MODEL_CLAIMED',
                   route='NORMAL_CHAT',reason='REQUEST_PENDING')
        self.ledger.record_event(**event)
        with self.assertRaises(UsageConflict):
            self.ledger.record_event(**{**event,'project':'Museum','agent':'museum_coder'})
        with self.assertRaises(UsageConflict):
            self.ledger.record_event(**{**event,'route':'LIMITED_MODEL'})
        with self.assertRaises(UsageDenied):
            self.ledger.record_event(**{**event,'event_id':'other-2','agent':'museum_coder'})
        with self.assertRaises(UsageDenied):
            self.ledger.record_event(**{**event,'event_id':'forged','kind':'GIT_VERIFIED'})
        with self.assertRaises(UsageDenied):
            self.ledger.record_event(**{**event,'event_id':'paid-1','route':'LIMITED_MODEL','reason':'REQUEST_PENDING',
                                       'token_count':1200})

    def test_blocked_and_preclick_retries_count_but_unknown_model_claim_blocks_retry(self):
        common=dict(project='TD',agent='td_coder',run_id='run-a',task_id='task-a')
        self.ledger.record_event(**common,event_id='blocked-1',kind='BLOCKED',
                                 route='NONE',reason='QUOTA_UNKNOWN')
        self.ledger.record_event(**common,event_id='retry-1',kind='RETRY_PRECLICK',
                                 route='NONE',reason='CONFIRMED_PRECLICK_NO_SEND')
        self.ledger.record_event(**common,event_id='claim-1',kind='MODEL_CLAIMED',
                                 route='NORMAL_CHAT',reason='REQUEST_PENDING')
        with self.assertRaises(UsageDenied):
            self.ledger.record_event(**common,event_id='retry-2',kind='RETRY_PRECLICK',
                                     route='NONE',reason='CONFIRMED_PRECLICK_NO_SEND')
        s=self.ledger.summary('TD','td_coder')
        self.assertEqual((s['blocked'],s['preclick_retries'],s['model_claims']), (1,1,1))
        self.assertEqual(self.ledger.summary('Museum','museum_coder')['model_claims'],0)

    def test_local_engine_independently_verified_commit_test_and_audit_count_once(self):
        repo=self.root/'fixture_td';repo.mkdir()
        def git(*args):
            return subprocess.check_output(['git','-C',str(repo),*args],text=True,encoding='utf-8').strip()
        git('init','-q')
        git('config','user.name','Local Test')
        git('config','user.email','local@example.invalid')
        (repo/'src').mkdir();(repo/'tests').mkdir()
        old='def calc(x):\n    return x\n'
        (repo/'src'/'calc.py').write_text(old,encoding='utf-8')
        (repo/'tests'/'__init__.py').write_text('',encoding='utf-8')
        git('add','.');git('commit','-qm','baseline')
        base=git('rev-parse','HEAD')
        engine=RoleEngine(self.root/'roles',self.root/'worktrees')
        engine.register('TD',repo)
        plan={'project':'TD','task_id':'task-a','base_commit':base,'changes':[
          {'path':'src/calc.py','expected_sha256':hashlib.sha256(old.encode()).hexdigest(),
           'content':'def calc(x):\n    return x * 2\n'},
          {'path':'tests/test_calc.py','expected_sha256':None,
           'content':'import unittest\nfrom src.calc import calc\nclass TestCalc(unittest.TestCase):\n    def test_calc(self):\n        self.assertEqual(calc(3),6)\n'}]}
        receipt=engine.run(plan)
        self.assertEqual(receipt['status'],'VERIFIED')
        self.assertEqual(self.ledger.capture_verified_role_run(engine,'TD','td_coder','run-a','task-a'),'RECORDED')
        self.assertEqual(self.ledger.capture_verified_role_run(engine,'TD','td_coder','run-a','task-a'),'ALREADY_RECORDED')
        s=UsageLedger(self.file).summary('TD','td_coder')
        self.assertEqual((s['verified_commits'],s['verified_test_runs']),(1,1))
        self.assertIsNone(s['useful_verified_per_model_claim'])
        self.assertEqual(s['token_measurement'],'UNKNOWN')
        with self.assertRaises(UsageDenied):
            self.ledger.capture_verified_role_run(engine,'TD','museum_coder','run-a','task-a')
        with self.assertRaises(UsageDenied):
            self.ledger.capture_verified_role_run(engine,'TD','td_coder','run-other','task-missing')
        # Git evidence is rechecked rather than trusting a copied assistant receipt.
        git('update-ref','refs/heads/mcpgo/TD/task-a',base)
        with self.assertRaises(UsageDenied):
            self.ledger.capture_verified_role_run(engine,'TD','td_coder','another','task-a')

    def test_concurrent_duplicate_claims_only_one_event_survives_wal_restart(self):
        import concurrent.futures
        event=dict(event_id='evt-concurrent',project='Museum',
                   agent='museum_coder',run_id='run-concurrent',task_id='task-a',
                   kind='MODEL_CLAIMED',route='NORMAL_CHAT',reason='REQUEST_PENDING')
        with concurrent.futures.ThreadPoolExecutor(max_workers=12) as executor:
            outcomes=list(executor.map(lambda _:UsageLedger(self.file).record_event(**event),range(12)))
        self.assertEqual(outcomes.count('RECORDED'),1)
        self.assertEqual(outcomes.count('ALREADY_RECORDED'),11)
        self.assertEqual(UsageLedger(self.file).summary('Museum','museum_coder')['model_claims'],1)

    def test_equal_fixtures_compare_attempt_claims_not_token_costs_or_unsupported_savings(self):
        fixtures=[
          {'local':'VERIFIED','normal':'AVAILABLE','limited':'AVAILABLE','paid':False},
          {'local':'VERIFIED','normal':'AVAILABLE','limited':'AVAILABLE','paid':False},
          {'local':'BLOCKED','normal':'AVAILABLE','limited':'AVAILABLE','paid':False},
          {'local':'EXHAUSTED','normal':'AVAILABLE','limited':'AVAILABLE','paid':False},
          {'local':'EXHAUSTED','normal':'UNKNOWN','limited':'AVAILABLE','paid':False},
          {'local':'EXHAUSTED','normal':'UNAVAILABLE','limited':'AVAILABLE','paid':True},
        ]
        comparison=compare_fixture(fixtures)
        self.assertEqual(comparison['fixture_count'],6)
        self.assertEqual(comparison['baseline_hypothetical_model_claims'],6)
        self.assertEqual(comparison['policy_model_claims'],2)
        self.assertEqual(comparison['policy_local_no_model'],2)
        self.assertEqual(comparison['policy_wait_or_blocked'],2)
        self.assertEqual(comparison['tokens'],'UNKNOWN')
        self.assertEqual(comparison['money_saved'],'UNKNOWN')
        self.assertEqual(comparison['kind'],'SIMULATION_NOT_ACTUAL_SAVINGS')

if __name__=='__main__':unittest.main()
