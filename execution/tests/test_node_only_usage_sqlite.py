"""Regression: Node AutoSend is allowed to create the shared SQLite first.

The Python inspector must be read-only and gracefully treat its own optional
tables as empty rather than mutating the Node-owned database.
"""
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0,str(Path(__file__).resolve().parents[2]))
from execution.usage_ledger import UsageLedger

class NodeOnlyAutoSendLedgerTest(unittest.TestCase):
    def test_node_first_sqlite_receipt_is_readable_without_python_schema_or_writes(self):
        node=shutil.which('node')
        self.assertIsNotNone(node)
        with tempfile.TemporaryDirectory(prefix='mcpgo37-node-first-') as name:
            file=Path(name)/'usage.sqlite3'
            module=(Path(__file__).resolve().parents[2]/
                    'autosend'/'model-use-ledger.mjs').as_uri()
            source="""
                import crypto from 'node:crypto';
                import {modelUsageEventForAttempt,syncModelUsageLedger} from %s;
                const t={id:crypto.randomUUID(),smart_v2_project:'TD'};
                const a={id:crypto.randomUUID(),task_id:t.id,
                   result:'verified',time:'2026-11-28T07:40:00.000Z'};
                a.model_usage_observation=modelUsageEventForAttempt(t,a);
                console.log(JSON.stringify(syncModelUsageLedger(
                    {tasks:[t],attempts:[a]},%s)));
            """%(json.dumps(module),json.dumps(str(file)))
            result=subprocess.run([node,'--input-type=module','-e',source],
                capture_output=True,text=True,encoding='utf-8')
            self.assertEqual(result.returncode,0,result.stderr)
            self.assertEqual(json.loads(result.stdout)['inserted'],1)
            raw_before=file.read_bytes()
            reader=UsageLedger(file,readonly=True)
            row=reader.summary('TD','chatgpt_autosend')
            self.assertEqual(row['observed_chat_responses'],1)
            self.assertEqual(row['verified_git_work_links'],0)
            self.assertEqual(row['verified_commits'],0)
            self.assertEqual(row['codex_observed_sessions'],0)
            self.assertEqual(row['confirmed_model_calls'],0)
            self.assertEqual(row['cost_measurement'],'UNKNOWN')
            self.assertEqual(file.read_bytes(),raw_before)
if __name__=='__main__':
    unittest.main()
