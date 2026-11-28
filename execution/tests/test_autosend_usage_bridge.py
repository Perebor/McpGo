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

    def test_actual_node_verified_git_work_link_is_visible_to_python_readonly(self):
        node=shutil.which('node')
        self.assertIsNotNone(node)
        root=Path(__file__).resolve().parents[2]
        model=(root/'autosend'/'model-use-ledger.mjs').as_uri()
        work=(root/'autosend'/'work-result.mjs').as_uri()
        script="""
            import crypto from 'node:crypto';
            import {modelUsageEventForAttempt,syncModelUsageLedger} from %s;
            import {inspectWorkResult,commitObservedWorkResult} from %s;
            const t={id:crypto.randomUUID(),smart_v2_project:'Museum',
              last_success_at:'2026-11-28T07:20:00.000Z'};
            const fingerprint='b'.repeat(64),sha='a'.repeat(40);
            const policy={project:'Museum',repo:'Perebor/Museum',
              requiredWorkflows:['Museum starter checks','Fictional museum XSS Chromium guard']};
            const outcome={kind:'report',fingerprint,
              report:{status:'IN_PROGRESS',action:'CONTINUE_CURRENT'},
              workEvidence:{source:'assistant_self_report',
                files_changed:2,tests_passed:8,tests_failed:0}};
            const evidence={verified:true,testsVerified:true,source:'github_ci_verified',
              project:'Museum',repo:policy.repo,fingerprint,sha,prNumber:17,
              provenAt:'2026-11-28T07:42:00.000Z',
              workflows:policy.requiredWorkflows.map((name,i)=>({name,runId:100+i}))};
            const time=Date.parse('2026-11-28T07:45:00.000Z');
            const verdict=await inspectWorkResult(t,outcome,{policy,now:time,
              verify:async()=>evidence});
            if(!commitObservedWorkResult(t,verdict,time))throw Error('Missing work proof');
            const a={id:crypto.randomUUID(),task_id:t.id,result:'verified',
              time:'2026-11-28T07:40:00.000Z'};
            a.model_usage_observation=modelUsageEventForAttempt(t,a);
            console.log(JSON.stringify(syncModelUsageLedger({tasks:[t],attempts:[a]},%s)));
        """%(json.dumps(model),json.dumps(work),json.dumps(str(self.ledger.path)))
        run=subprocess.run([node,'--input-type=module','-e',script],
            capture_output=True,text=True,encoding='utf-8')
        self.assertEqual(run.returncode,0,run.stderr)
        self.assertEqual(json.loads(run.stdout)['linked'],1)
        summary=UsageLedger(self.ledger.path,readonly=True).summary('Museum','chatgpt_autosend')
        self.assertEqual(summary['observed_chat_responses'],1)
        self.assertEqual(summary['verified_git_work_links'],1)
        self.assertEqual(summary['confirmed_model_calls'],0)
        self.assertIsNone(summary['input_tokens'])
        self.assertEqual(summary['cost_measurement'],'UNKNOWN')
        links=UsageLedger(self.ledger.path,readonly=True).work_links('Museum','chatgpt_autosend')
        self.assertEqual(len(links),1)
        self.assertEqual(links[0]['git_sha'],'a'*40)
        self.assertEqual(links[0]['pr_number'],17)
        self.assertEqual(links[0]['repo'],'Perebor/Museum')
        self.assertTrue(links[0]['receipt_event_id'].startswith('autosend:'))
        self.assertEqual(links[0]['evidence_source'],
                         'LOCAL_GITHUB_CI_ADAPTER_TEMPORAL_LINK')
        cli=Path(__file__).resolve().parents[1]/'usage_cli.py'
        result=subprocess.run([sys.executable,str(cli),'links','--db',str(self.ledger.path),
                               '--project','Museum'],
                              capture_output=True,text=True,encoding='utf-8')
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(json.loads(result.stdout)[0]['git_sha'],'a'*40)

    def test_verified_git_link_inspector_reads_legacy_db_without_creating_table(self):
        reader=UsageLedger(self.ledger.path,readonly=True)
        self.assertEqual(reader.work_links('TD','chatgpt_autosend'),[])
        from execution.usage_ledger import UsageDenied
        with self.assertRaises(UsageDenied):
            reader.work_links('task:'+str(uuid.uuid4()),'chatgpt_autosend')

    def test_verified_git_work_receipt_link_is_separate_from_calls_and_tokens(self):
        # Fixture mirrors the Node-side link schema, but independently verifies
        # Python summary does not conflate CI result with billed ChatGPT calls.
        task_id=str(uuid.uuid4())
        self.insert('Museum','chatgpt_autosend','CHAT_RESPONSE_OBSERVED',task_id=task_id)
        with self.ledger._db() as db:
            db.execute('''CREATE TABLE verified_work_links (
                result_fingerprint TEXT PRIMARY KEY,task_id TEXT NOT NULL,
                project TEXT NOT NULL,agent TEXT NOT NULL,
                receipt_event_id TEXT NOT NULL,repo TEXT NOT NULL,
                git_sha TEXT NOT NULL,pr_number INTEGER NOT NULL,
                proof_fingerprint TEXT NOT NULL,result_observed_at TEXT NOT NULL,
                evidence_source TEXT NOT NULL,event_fingerprint TEXT NOT NULL)''')
            db.execute('''INSERT INTO verified_work_links VALUES(?,?,?,?,?,?,?,?,?,?,?,?)''',(
                'b'*64,task_id,'Museum','chatgpt_autosend','autosend:'+str(uuid.uuid4()),
                'Perebor/Museum','a'*40,17,'c'*64,
                '2026-11-28T07:45:00.000Z',
                'LOCAL_GITHUB_CI_ADAPTER_TEMPORAL_LINK','d'*64))
        observed=self.ledger.summary('Museum','chatgpt_autosend')
        self.assertEqual(observed['verified_git_work_links'],1)
        self.assertEqual(observed['observed_chat_responses'],1)
        self.assertEqual(observed['confirmed_model_calls'],0)
        self.assertEqual(observed['cost_measurement'],'UNKNOWN')
        self.assertEqual(observed['verified_commits'],0,
                         'A temporal association is not a RoleEngine Git commit proof')
        self.assertEqual(self.ledger.summary('TD','chatgpt_autosend')['verified_git_work_links'],0)

    def test_old_ledger_without_git_work_link_table_must_not_crash(self):
        # preview.36 deployed ledger does not yet have the new work-link table.
        row=UsageLedger(self.ledger.path,readonly=True).summary('TD','chatgpt_autosend')
        self.assertEqual(row['verified_git_work_links'],0)

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
