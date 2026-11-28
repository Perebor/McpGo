"""MCP-12: code-free Codex local telemetry, scoped by actual session cwd."""
import json
from pathlib import Path
import tempfile
import unittest
import uuid
import sys
import subprocess

sys.path.insert(0,str(Path(__file__).resolve().parents[2]))
from execution.usage_ledger import UsageLedger, UsageDenied, UsageConflict
from execution.role_engine import RoleEngine
from execution.codex_usage import read_codex_usage, capture_codex_usage

def row(kind,payload):
    return json.dumps({'timestamp':'2026-11-28T02:05:00.000Z','type':kind,
                       'payload':payload},separators=(',',':'),ensure_ascii=False)+'\n'
def total(i,c,o,r=0):
    return {'input_tokens':i,'cached_input_tokens':c,'cache_write_input_tokens':0,
            'output_tokens':o,'reasoning_output_tokens':r,'total_tokens':i+o}
def token(i,c,o,r=0):
    return row('event_msg',{'type':'token_count','info':{
        'total_token_usage':total(i,c,o,r),'last_token_usage':total(i,c,o,r)}})
class CodexUsageTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='mcpgo12-codex-')
        self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)
        self.codex=self.root/'.codex'
        self.session_dir=self.codex/'sessions'/'2026'/'11'/'28'
        self.session_dir.mkdir(parents=True)
        self.repo=self.root/'owner_td_fixture';self.repo.mkdir()
        def git(*args):
            return subprocess.check_output(['git','-C',str(self.repo),*args],text=True).strip()
        git('init','-q')
        self.engine=RoleEngine(self.root/'roles',self.root/'worktrees')
        self.engine.register('TD',self.repo)
        self.sid=str(uuid.uuid4())
        self.session=self.session_dir/('rollout-2026-11-28T02-05-00-'+self.sid+'.jsonl')
        self.meta=row('session_meta',{'id':self.sid,'cwd':str(self.repo),
                    'model_provider':'openai','timestamp':'2026-11-28T02:05:00.000Z'})
        self.ledger=UsageLedger(self.root/'usage.sqlite3')
    def write(self,*lines):
        self.session.write_text(self.meta+''.join(lines),encoding='utf-8')
    def test_scoped_codex_response_totals_recorded_once_and_incremental_after_append(self):
        self.write(row('event_msg',{'type':'user_message','message':'private secrets not imported'}),
                   token(100,0,20,7),token(220,100,40,9))
        snap=read_codex_usage(self.session,self.codex,self.repo)
        self.assertEqual(snap['session_id'],self.sid)
        self.assertEqual(snap['input_tokens'],220)
        self.assertEqual(snap['cached_input_tokens'],100)
        self.assertEqual(snap['output_tokens'],40)
        self.assertEqual(snap['token_update_events'],2)
        self.assertNotIn('private secrets',str(snap))
        event=capture_codex_usage(self.ledger,self.session,self.codex,self.repo,'TD','td_coder','codex-run',owner_engine=self.engine)
        self.assertEqual(event,'RECORDED')
        self.assertEqual(capture_codex_usage(self.ledger,self.session,self.codex,self.repo,'TD','td_coder','codex-run',owner_engine=self.engine),
                         'ALREADY_RECORDED')
        self.write(token(100,0,20,7),token(220,100,40,9),token(360,210,61,13))
        self.assertEqual(capture_codex_usage(self.ledger,self.session,self.codex,self.repo,'TD','td_coder','codex-run',owner_engine=self.engine),
                         'UPDATED')
        s=UsageLedger(self.ledger.path).summary('TD','td_coder')
        self.assertEqual(s['codex_observed_input_tokens'],360)
        self.assertEqual(s['codex_observed_cached_input_tokens'],210)
        self.assertEqual(s['codex_observed_output_tokens'],61)
        self.assertEqual(s['codex_observed_token_updates'],3)
        self.assertEqual(s['codex_observed_sessions'],1)
        self.assertEqual(s['cost_measurement'],'UNKNOWN')
        self.assertEqual(s['codex_usage_source'],'LOCAL_CODEX_SESSION_NOT_PROVIDER_SIGNED')
        self.assertEqual(s['model_claims'],0)
        self.assertEqual(s['confirmed_model_calls'],0)
        # No raw messages or local file paths in the database
        raw=self.ledger.path.read_bytes()
        self.assertNotIn(b'private secrets',raw)
        self.assertNotIn(str(self.repo).encode(),raw)
    def test_local_owner_cli_imports_only_authorized_session_and_reports_source_label(self):
        self.write(token(100,0,20))
        cmd=[sys.executable,str(Path(__file__).resolve().parents[1]/'usage_cli.py'),
             'capture-codex','--db',str(self.ledger.path),
             '--session',str(self.session),'--codex-root',str(self.codex),
             '--engine-state',str(self.root/'roles'),
             '--engine-worktrees',str(self.root/'worktrees'),
             '--project','TD','--agent','td_coder','--run-id','codex-run']
        first=subprocess.run(cmd,capture_output=True,text=True,encoding='utf-8')
        self.assertEqual(first.returncode,0,first.stderr)
        output=json.loads(first.stdout)
        self.assertEqual(output['event'],'RECORDED')
        self.assertEqual(output['summary']['codex_observed_input_tokens'],100)
        self.assertEqual(output['summary']['codex_usage_source'],
                         'LOCAL_CODEX_SESSION_NOT_PROVIDER_SIGNED')
        again=subprocess.run(cmd,capture_output=True,text=True,encoding='utf-8')
        self.assertEqual(again.returncode,0,again.stderr)
        self.assertEqual(json.loads(again.stdout)['event'],'ALREADY_RECORDED')

    def test_project_scope_and_local_source_restrictions_fail_closed(self):
        self.write(token(100,0,20))
        wrong=self.root/'other_project';wrong.mkdir()
        with self.assertRaises(UsageDenied):
            read_codex_usage(self.session,self.codex,wrong)
        with self.assertRaises(UsageDenied):
            capture_codex_usage(self.ledger,self.session,self.codex,wrong,'TD','td_coder','codex-run',owner_engine=self.engine)
        with self.assertRaises(UsageDenied):
            capture_codex_usage(self.ledger,self.session,self.codex,self.repo,'Museum','museum_coder','codex-run',owner_engine=self.engine)
        fake=self.root/'arbitrary.jsonl';fake.write_text(self.meta+token(999,0,900))
        with self.assertRaises(UsageDenied):
            read_codex_usage(fake,self.codex,self.repo)
        with self.assertRaises(UsageDenied):
            capture_codex_usage(self.ledger,self.session,self.codex,self.repo,'TD','museum_coder','codex-run',owner_engine=self.engine)
    def test_malformed_negative_and_regressed_usage_never_inflate(self):
        bad=[token(-1,0,20),
             token(100,101,20),
             token(100,0,20)+token(90,0,20),
             row('event_msg',{'type':'token_count','info':{'total_token_usage':{'input_tokens':500}}}),
             row('event_msg',{'type':'token_count','info':None})]
        for content in bad:
            with self.subTest(content=content[:60]):
                self.write(content)
                with self.assertRaises(UsageDenied):
                    capture_codex_usage(self.ledger,self.session,self.codex,self.repo,'TD','td_coder','codex-run',owner_engine=self.engine)
        self.assertEqual(self.ledger.summary('TD','td_coder')['codex_observed_sessions'],0)
    def test_no_proven_event_or_wrong_session_id_cannot_claim_real_tokens(self):
        self.write(row('event_msg',{'type':'model_message','message':'1500 tokens!'}))
        with self.assertRaises(UsageDenied):
            read_codex_usage(self.session,self.codex,self.repo)
        self.session.write_text(row('session_meta',{'id':str(uuid.uuid4()),'cwd':str(self.repo),
                    'model_provider':'openai'})+token(100,0,20))
        with self.assertRaises(UsageDenied):
            read_codex_usage(self.session,self.codex,self.repo)
    def test_same_codex_session_cannot_be_attributed_twice_or_rewritten(self):
        self.write(token(100,0,20))
        capture_codex_usage(self.ledger,self.session,self.codex,self.repo,'TD','td_coder','codex-run',owner_engine=self.engine)
        with self.assertRaises((UsageDenied,UsageConflict)):
            capture_codex_usage(self.ledger,self.session,self.codex,self.repo,'TD','mcpgo_lead','codex-run',owner_engine=self.engine)
        self.write(token(50,0,10))
        with self.assertRaises((UsageDenied,UsageConflict)):
            capture_codex_usage(self.ledger,self.session,self.codex,self.repo,'TD','td_coder','codex-run',owner_engine=self.engine)
        self.assertEqual(self.ledger.summary('TD','td_coder')['codex_observed_input_tokens'],100)
if __name__=='__main__':unittest.main()
