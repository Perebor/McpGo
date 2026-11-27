"""MCP-10 Hub signed queue -> real local roles -> ACK, isolated HTTP fixture only."""
import importlib.util
import json
import pathlib
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request

ROOT=pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT))
sys.path.insert(0,str(ROOT/'execution'/'tests'))
import test_role_engine as fixture
from execution.role_engine import RoleEngine,_digest
try:
 from execution.hub_role_adapter import DelegatedQueueClient,execute_once
except ImportError:
 DelegatedQueueClient=None
 execute_once=None

spec=importlib.util.spec_from_file_location('hub_fixture_mcp10', ROOT/'messaging'/'hub.py')
hub=importlib.util.module_from_spec(spec)
spec.loader.exec_module(hub)

class HubRoleAdapterE2E(unittest.TestCase):
 def setUp(self):
  self.assertIsNotNone(DelegatedQueueClient,'role adapter missing')
  self.fx=fixture.RoleE2E('test_actor_project_fence')
  self.fx.setUp()
  self.temp=tempfile.TemporaryDirectory(prefix='mcpgo10-hub-')
  self.addCleanup(self.temp.cleanup)
  self.old_db=hub.DATA
  hub.DATA=pathlib.Path(self.temp.name)/'hub.sqlite3'
  self.token=hub.ensure_owner_token()
  from http.server import ThreadingHTTPServer
  self.http=ThreadingHTTPServer(('127.0.0.1',0),hub.Handler)
  self.thread=threading.Thread(target=self.http.serve_forever,daemon=True)
  self.thread.start()
  self.addCleanup(self.cleanup_hub)
  self.repo_engine=self.fx.engine()
  self.owner('/api/agents',{'id':'td_coder','label':'Test TD coder'})
  grant=self.owner('/api/work/grant',{'agent':'td_coder','project':'TD'})
  self.worker=DelegatedQueueClient('td_coder','TD',bytes.fromhex(grant['secret']),port=self.http.server_port)
 def cleanup_hub(self):
  self.http.shutdown();self.http.server_close();self.thread.join(3)
  hub.DATA=self.old_db
  self.fx.doCleanups()
 def owner(self,path,body=None):
  data=None if body is None else json.dumps(body).encode()
  headers={'Host':'127.0.0.1:8971','X-MCPHub-Client':'native',
           'X-MCPHub-Token':self.token,'Content-Type':'application/json'}
  req=urllib.request.Request('http://127.0.0.1:'+str(self.http.server_port)+path,
                              data=data,headers=headers)
  with urllib.request.urlopen(req,timeout=4) as res:
   return json.load(res)
 def test_valid_signed_claim_runs_three_roles_and_acks_without_chat_send(self):
  plan=self.fx.plan(task='hub-task')
  self.owner('/api/work/enqueue',{'project':'TD','fingerprint':_digest(plan),
             'payload':{'intent':'build','context':'McpGo'}})
  result=execute_once(self.repo_engine,plan,self.worker)
  self.assertEqual(result['status'],'ACKED')
  self.assertEqual(result['execution']['status'],'VERIFIED')
  self.assertEqual(len(result['execution']['role_pids']),4)
  self.assertTrue(result['execution']['tester_pass'] and result['execution']['auditor_pass'])
  summary=self.owner('/api/work/summary')
  self.assertEqual(summary['ACKED'],1)
  self.assertEqual(summary['VERIFIED'],0)
  self.assertEqual(self.owner('/api/status')['messages'],0)
  self.assertEqual(execute_once(self.repo_engine,plan,self.worker)['status'],'NO_TASK')
  self.assertEqual(self.repo_engine.summary('TD')['VERIFIED'],1)

 def test_signed_lease_with_mismatched_fingerprint_cannot_execute(self):
  plan=self.fx.plan(task='mismatch')
  self.owner('/api/work/enqueue',{'project':'TD','fingerprint':'b'*64,
             'payload':{'intent':'build','context':'McpGo'}})
  result=execute_once(self.repo_engine,plan,self.worker)
  self.assertEqual(result['status'],'UNKNOWN')
  self.assertEqual(self.repo_engine.summary('TD')['VERIFIED'],0)
  summary=self.owner('/api/work/summary')
  self.assertEqual(summary['LEASED'],1)
  self.assertEqual(summary['ACKED'],0)

 def test_wrong_project_actor_and_revocation_fails_closed(self):
  plan=self.fx.plan(task='cross-project')
  with self.assertRaises(ValueError):
   DelegatedQueueClient('td_coder','Museum',self.worker.secret,port=self.http.server_port)
  self.owner('/api/work/enqueue',{'project':'TD','fingerprint':_digest(plan),
             'payload':{'intent':'build','context':'McpGo'}})
  self.owner('/api/work/revoke',{'agent':'td_coder','project':'TD'})
  result=execute_once(self.repo_engine,plan,self.worker)
  self.assertEqual(result['status'],'NEED_OWNER')
  self.assertEqual(result['stage'],'DELEGATION_REVOKED_OR_FORBIDDEN')
  self.assertEqual(self.repo_engine.summary('TD')['VERIFIED'],0)
  self.assertEqual(self.owner('/api/work/summary')['QUEUED'],1)

 def test_unregistered_repository_returns_need_owner_without_claim(self):
  unapproved=RoleEngine(pathlib.Path(self.temp.name)/'unapproved',
                        pathlib.Path(self.temp.name)/'worktrees')
  plan=self.fx.plan(task='unapproved-owner')
  result=execute_once(unapproved,plan,self.worker)
  self.assertEqual(result['status'],'NEED_OWNER')
  self.assertEqual(self.owner('/api/work/summary')['LEASED'],0)
  self.assertEqual(self.owner('/api/work/summary')['ACKED'],0)

if __name__=='__main__':unittest.main()
