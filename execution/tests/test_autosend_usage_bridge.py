"""MCP-12: the Python per-project UsageLedger must read automatically mirrored
Node AutoSend receipt observations without pretending to know provider tokens."""
import sys
import tempfile
import unittest
from pathlib import Path
import uuid
import hashlib
import shutil
import subprocess
import json

sys.path.insert(0,str(Path(__file__).resolve().parents[2]))
from execution.usage_ledger import UsageLedger

class AutoSendUsageBridgeTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='mcpgo36-usage-')
        self.addCleanup(self.temp.cleanup)
        self.ledger=UsageLedger(Path(self.temp.name)/'usage.sqlite3')
    def insert(self,project,agent,outcome,task_id=None):
        task_id=task_id or str(uuid.uuid4())
        eid='autosend:'+str(uuid.uuid4())
        with self.ledger._db() as db:
            db.execute('''INSERT INTO autosend_observations(
              event_id,project,agent,task_id,outcome,observed_at,source_kind,event_fingerprint)
              VALUES(?,?,?,?,?,?,?,?)''',(
              eid,project,agent,task_id,outcome,'2026-11-28T07:00:00.000Z',
              'LOCAL_AUTOSEND_RECEIPT_NOT_PROVIDER_SIGNED',
              hashlib.sha256(eid.encode()).hexdigest()))
    def test_summary_separates_dom_chat_reply_from_manual_and_unknown(self):
        self.insert('TD','chatgpt_autosend','CHAT_RESPONSE_OBSERVED')
        self.insert('TD','chatgpt_autosend','OWNER_ATTESTED')
        self.insert('TD','chatgpt_autosend','DELIVERY_UNKNOWN')
        self.insert('Museum','chatgpt_autosend','CHAT_RESPONSE_OBSERVED')
        td=self.ledger.summary('TD','chatgpt_autosend')
        museum=self.ledger.summary('Museum','chatgpt_autosend')
        self.assertEqual(td['observed_chat_responses'],1)
        self.assertEqual(td['owner_attested_responses'],1)
        self.assertEqual(td['delivery_unknown'],1)
        self.assertEqual(museum['observed_chat_responses'],1)
        self.assertEqual(self.ledger.summary('TD','td_coder')['observed_chat_responses'],0)
        self.assertEqual(td['confirmed_model_calls'],0)
        self.assertEqual(td['cost_measurement'],'UNKNOWN')
        self.assertIsNone(td['input_tokens'])
        self.assertEqual(td['chat_delivery_source'],'LOCAL_AUTOSEND_RECEIPT_NOT_PROVIDER_SIGNED')
    def test_actual_node_sqlite_receipt_visible_in_python_ledger_without_manual_import(self):
        node=shutil.which('node')
        self.assertIsNotNone(node,'McpGo Node runtime required for parity acceptance')
        module=Path(__file__).resolve().parents[2]/'autosend'/'model-use-ledger.mjs'
        script="""
            import crypto from 'node:crypto';
            import {modelUsageEventForAttempt,syncModelUsageLedger} from %s;
            const t={id:crypto.randomUUID(),smart_v2_project:'TD'};
            const a={id:crypto.randomUUID(),task_id:t.id,
              result:'verified',time:'2026-11-28T07:00:00.000Z'};
            a.model_usage_observation=modelUsageEventForAttempt(t,a);
            console.log(JSON.stringify(syncModelUsageLedger({tasks:[t],attempts:[a]},%s)));
        """%(json.dumps(module.as_uri()),json.dumps(str(self.ledger.path)))
        first=subprocess.run([node,'--input-type=module','-e',script],
            capture_output=True,text=True,encoding='utf-8')
        self.assertEqual(first.returncode,0,first.stderr)
        self.assertEqual(json.loads(first.stdout)['inserted'],1)
        second=subprocess.run([node,'--input-type=module','-e',script],
            capture_output=True,text=True,encoding='utf-8')
        self.assertEqual(second.returncode,0,second.stderr)
        # Second separate simulated receipt creates another observation: the
        # exact event ID is randomized above and not an idempotency test.
        td=self.ledger.summary('TD','chatgpt_autosend')
        self.assertEqual(td['observed_chat_responses'],2)
        self.assertEqual(td['confirmed_model_calls'],0)
        self.assertEqual(td['cost_measurement'],'UNKNOWN')

    def test_readonly_inspector_never_creates_missing_database_or_writes_events(self):
        from execution.usage_ledger import UsageDenied
        missing=Path(self.temp.name)/'nonexistent.sqlite3'
        self.assertFalse(missing.exists())
        with self.assertRaises(UsageDenied):
            UsageLedger(missing,readonly=True)
        self.assertFalse(missing.exists())
        scope='task:'+str(uuid.uuid4())
        self.insert(scope,'chatgpt_autosend','CHAT_RESPONSE_OBSERVED')
        reader=UsageLedger(self.ledger.path,readonly=True)
        self.assertEqual(reader.summary(scope,'chatgpt_autosend')['observed_chat_responses'],1)
        with self.assertRaises(UsageDenied):
            reader.record_event(event_id='readonly-event',project='TD',
                agent='td_coder',run_id='readonly-run',task_id='test-task',
                kind='MODEL_CLAIMED',route='NORMAL_CHAT',reason='REQUEST_PENDING')

    def test_isolated_chat_task_scope_readonly_summary_and_cli(self):
        chat_id=str(uuid.uuid4())
        scope='task:'+chat_id
        self.insert(scope,'chatgpt_autosend','CHAT_RESPONSE_OBSERVED',task_id=chat_id)
        row=self.ledger.summary(scope,'chatgpt_autosend')
        self.assertEqual(row['observed_chat_responses'],1)
        self.assertEqual(row['confirmed_model_calls'],0)
        self.assertEqual(row['cost_measurement'],'UNKNOWN')
        self.assertEqual(row['verified_commits'],0)
        cli=Path(__file__).resolve().parents[1]/'usage_cli.py'
        result=subprocess.run([sys.executable,str(cli),'summary','--db',str(self.ledger.path),
                               '--project',scope,'--agent','chatgpt_autosend'],
                              capture_output=True,text=True,encoding='utf-8')
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(json.loads(result.stdout)['observed_chat_responses'],1)

    def test_task_scope_never_grants_new_write_permissions_or_cross_project_read(self):
        from execution.usage_ledger import UsageDenied
        task_id=str(uuid.uuid4())
        scope='task:'+task_id
        self.insert(scope,'chatgpt_autosend','CHAT_RESPONSE_OBSERVED',task_id=task_id)
        for project,agent in [('task:invalid','chatgpt_autosend'),
                              (scope,'td_coder'),(scope,'mcpgo_lead'),
                              ('TD','unknown_actor')]:
            with self.subTest(project=project,agent=agent):
                with self.assertRaises(UsageDenied):
                    self.ledger.summary(project,agent)
        with self.assertRaises(UsageDenied):
            self.ledger.record_event(event_id='unsafe-attempt',project=scope,
              agent='chatgpt_autosend',run_id='unsafe-run',task_id='scope-test',
              kind='MODEL_CLAIMED',route='NORMAL_CHAT',reason='REQUEST_PENDING')

    def test_empty_new_ledger_reports_zero_and_unknown_provider(self):
        row=self.ledger.summary('Museum','chatgpt_autosend')
        self.assertEqual(row['observed_chat_responses'],0)
        self.assertEqual(row['delivery_unknown'],0)
        self.assertEqual(row['confirmed_model_calls'],0)
        self.assertEqual(row['cost_measurement'],'UNKNOWN')
if __name__=='__main__':unittest.main()
