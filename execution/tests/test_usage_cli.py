"""Read-only CLI contract for owner inspectable MCP-12 metrics."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[2]))
from execution.usage_ledger import UsageLedger

CLI=Path(__file__).resolve().parents[1]/'usage_cli.py'

class UsageCliTest(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory(prefix='mcpgo12-cli-')
  self.addCleanup(self.tmp.cleanup)
  self.root=Path(self.tmp.name)
  self.db=self.root/'usage.sqlite3'
  self.ledger=UsageLedger(self.db)
 def run_cli(self,*args):
  result=subprocess.run([sys.executable,str(CLI),*args],capture_output=True,
                        text=True,encoding='utf-8',timeout=10)
  self.assertEqual(result.returncode,0,result.stderr)
  return json.loads(result.stdout)
 def test_summary_is_read_only_and_refuses_to_make_up_token_measurements(self):
  self.ledger.record_event(event_id='evt-claim-1',project='Museum',
      agent='museum_coder',run_id='run-a',task_id='task-a',
      kind='MODEL_CLAIMED',route='NORMAL_CHAT',reason='REQUEST_PENDING')
  out=self.run_cli('summary','--db',str(self.db),'--project','Museum',
                  '--agent','museum_coder')
  self.assertEqual(out['model_claims'],1)
  self.assertEqual(out['confirmed_model_calls'],0)
  self.assertIsNone(out['input_tokens'])
  self.assertEqual(out['token_measurement'],'UNKNOWN')
 def test_route_is_advisory_only(self):
  out=self.run_cli('route','--local','EXHAUSTED','--ordinary','UNKNOWN',
         '--limited','AVAILABLE','--owner-paid')
  self.assertEqual(out['action'],'WAIT_UNKNOWN')
  self.assertFalse(out['dispatch_performed'])
 def test_fixture_comparison_is_explicit_simulation(self):
  file=self.root/'scenarios.json'
  file.write_text(json.dumps([
    {'local':'VERIFIED','normal':'AVAILABLE','limited':'AVAILABLE','paid':False},
    {'local':'EXHAUSTED','normal':'AVAILABLE','limited':'AVAILABLE','paid':False}
  ]),encoding='utf-8')
  out=self.run_cli('compare','--fixtures',str(file))
  self.assertEqual(out['policy_model_claims'],1)
  self.assertEqual(out['kind'],'SIMULATION_NOT_ACTUAL_SAVINGS')
  self.assertEqual(out['money_saved'],'UNKNOWN')
if __name__=='__main__':unittest.main()
