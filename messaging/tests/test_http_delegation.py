"""Contract and security regression for owner + actor-scoped Hub HTTP."""
import hashlib
import io
import importlib.util
import json
import pathlib
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

BASE = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('hub_delegation_test', BASE / 'hub.py')
hub = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hub)
spec_auth = importlib.util.spec_from_file_location('delegate_auth_test', BASE / 'delegated_auth.py')
auth = importlib.util.module_from_spec(spec_auth)
spec_auth.loader.exec_module(auth)


class HubDelegationHTTPTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.previous = hub.DATA
        hub.DATA = pathlib.Path(self.temp.name) / 'hub.sqlite3'
        self.owner_token = hub.ensure_owner_token()
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), hub.Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.owner('/api/agents', {'id': 'workerA', 'label': 'Worker A'})
        self.owner('/api/agents', {'id': 'workerB', 'label': 'Worker B'})
        self.owner('/api/agents', {'id': 'director', 'label': 'Director', 'role': 'orchestrator'})
        self.key = bytes.fromhex(self.owner('/api/work/grant', {'agent': 'workerA', 'project': 'TD'})['secret'])

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(3)
        hub.DATA = self.previous
        self.temp.cleanup()

    def request(self, route, body=None, headers=None):
        data = None if body is None else json.dumps(body, separators=(',', ':'), sort_keys=True).encode()
        req = urllib.request.Request('http://127.0.0.1:' + str(self.server.server_port) + route,
            data=data,
            headers={'Host': '127.0.0.1:8971',
                     **({'Content-Type': 'application/json'} if data is not None else {}),
                     **(headers or {})})
        with urllib.request.urlopen(req, timeout=4) as res:
            return res.status, json.load(res)

    def owner(self, route, body=None):
        return self.request(route, body, {'X-MCPHub-Client': 'native', 'X-MCPHub-Token': self.owner_token})[1]

    def delegated(self, route, body=None, *, actor='workerA', project='TD', key=None,
                  timestamp=None, nonce='nonce-10001', signature=None):
        raw = None if body is None else json.dumps(body, separators=(',', ':'), sort_keys=True).encode()
        ts = int(time.time()) if timestamp is None else timestamp
        method = 'POST' if raw is not None else 'GET'
        if signature is None:
            try:
                signature = auth.sign(key or self.key, actor, project, method, route, ts, nonce, body=raw or b'')
            except ValueError:
                # Forbidden routes cannot be signed by the public signer; also assert HTTP rejects them.
                signature = '0' * 64
        return self.request(route, body, {
            'X-MCPHub-Client': 'delegate',
            'X-MCPHub-Actor': actor,
            'X-MCPHub-Project': project,
            'X-MCPHub-Time': str(ts),
            'X-MCPHub-Nonce': nonce,
            'X-MCPHub-Signature': signature})

    def assert_forbidden(self, function):
        with self.assertRaises(urllib.error.HTTPError) as err:
            function()
        self.assertEqual(err.exception.code, 403)

    def test_project_scoped_pending_view_does_not_expose_legacy_messages(self):
        self.owner('/api/work/enqueue', {'project': 'TD', 'fingerprint': 'd' * 64,
            'payload': {'intent': 'run_tests', 'context': 'McpGo'}})
        result = self.delegated('/api/work/pending?project=TD')
        self.assertEqual(result[1], {'project': 'TD', 'queued': 1})
        self.assert_forbidden(lambda: self.delegated('/api/inbox?agent=workerB', nonce='nonce-10002'))
        self.assert_forbidden(lambda: self.delegated('/api/history?viewer=director', nonce='nonce-10003'))
        self.assert_forbidden(lambda: self.delegated('/api/agents', nonce='nonce-10004'))
        self.assert_forbidden(lambda: self.delegated('/api/work/summary', nonce='nonce-10005'))
        self.assert_forbidden(lambda: self.delegated('/api/work/pending?project=Museum', project='Museum', nonce='nonce-10006'))
        self.assert_forbidden(lambda: self.delegated('/api/work/pending?project=TD', actor='workerB', nonce='nonce-10007'))
        self.assert_forbidden(lambda: self.delegated('/api/work/pending?project=TD', timestamp=int(time.time()) - 1000, nonce='nonce-10008'))

    def test_delegated_actor_cannot_read_unscoped_legacy_messages(self):
        # Legacy Hub messages have no project column. An agent's inbox can
        # contain data from another project, even when its actor ID matches.
        self.owner('/api/messages', {'sender': 'hub', 'recipient': 'workerA', 'body': 'unscoped private content'})
        self.assert_forbidden(lambda: self.delegated('/api/inbox?agent=workerA', nonce='nonce-50001'))

    def test_owner_only_grant_and_orchestrator_escalation_denied(self):
        self.assert_forbidden(lambda: self.delegated('/api/work/grant',
            {'agent': 'workerB', 'project': 'TD'}, nonce='nonce-10009'))
        self.assert_forbidden(lambda: self.delegated('/api/agents/role',
            {'id': 'workerA', 'role': 'orchestrator'}, nonce='nonce-10010'))
        with self.assertRaises(urllib.error.HTTPError) as err:
            self.owner('/api/work/grant', {'agent': 'director', 'project': 'TD'})
        self.assertEqual(err.exception.code, 400)
        with self.assertRaises(urllib.error.HTTPError) as err:
            self.owner('/api/work/grant', {'agent': 'workerA', 'project': 'Outside'})
        self.assertEqual(err.exception.code, 400)

    def test_owner_readonly_preview_is_guarded_and_never_arms_autosend(self):
        from unittest.mock import patch
        item = self.owner('/api/work/enqueue', {'project': 'TD', 'fingerprint': 'c' * 64,
            'payload': {'intent': 'inspect_code', 'context': 'McpGo'}})
        status = {'ok': True, 'extensionConnected': False, 'busyTask': '',
                  'tasks': [{'smart_v2_project': 'TD', 'status': 'paused', 'enabled': False,
                             'verification': None}]}
        with patch.object(hub.autosend_bridge, 'fetch_status', return_value=status) as fetch:
            result = self.owner('/api/work/preview?id=' + item['id'])
        self.assertEqual(fetch.call_count, 1)
        self.assertEqual(result['preview']['decision'], 'BLOCKED_PAUSED')
        self.assertFalse(result['preview']['can_send'])
        self.assert_forbidden(lambda: self.delegated('/api/work/preview?id=' + item['id'],
                                                    nonce='nonce-50009'))
        self.assertEqual(self.owner('/api/work/summary')['QUEUED'], 1)

    def test_signed_claim_ack_only_ack_not_verified_and_durable_no_replay(self):
        fp = 'f' * 64
        task = self.owner('/api/work/enqueue', {'project': 'TD', 'fingerprint': fp,
            'payload': {'intent': 'run_tests', 'context': 'McpGo'}})
        self.assertFalse(task['duplicate'])
        body = {'agent': 'workerA', 'project': 'TD'}
        _, result = self.delegated('/api/work/claim', body, nonce='nonce-20001')
        lease = result['task']
        self.assertEqual(lease['project'], 'TD')
        self.assertEqual(lease['id'], task['id'])
        ack = {'agent': 'workerA', 'project': 'TD', 'id': lease['id'],
               'lease_token': lease['lease_token'], 'result_fingerprint': 'e' * 64}
        self.assertEqual(self.delegated('/api/work/ack', ack, nonce='nonce-20002')[1]['state'], 'ACKED')
        self.assertEqual(self.owner('/api/work/summary')['ACKED'], 1)
        self.assertEqual(self.owner('/api/work/summary')['VERIFIED'], 0)
        self.assert_forbidden(lambda: self.delegated('/api/work/ack', ack, nonce='nonce-20002'))
        self.assertIsNone(self.delegated('/api/work/claim', body, nonce='nonce-20003')[1]['task'])

    def test_signed_body_tamper_and_replay_are_denied_before_mutation(self):
        self.owner('/api/work/enqueue', {'project': 'TD', 'fingerprint': 'a' * 64,
            'payload': {'intent': 'audit', 'context': 'McpGo'}})
        now = int(time.time())
        payload = {'agent': 'workerA', 'project': 'TD'}
        signed = auth.sign(self.key, 'workerA', 'TD', 'POST', '/api/work/claim',
                           now, 'nonce-30001', body=json.dumps(payload, sort_keys=True, separators=(',', ':')).encode())
        self.assert_forbidden(lambda: self.delegated('/api/work/claim',
                              {'agent': 'workerB', 'project': 'TD'}, nonce='nonce-30001', timestamp=now, signature=signed))
        self.assertEqual(self.delegated('/api/work/claim', payload, nonce='nonce-30001', timestamp=now, signature=signed)[1]['task']['project'], 'TD')
        self.assert_forbidden(lambda: self.delegated('/api/work/claim', payload, nonce='nonce-30001', timestamp=now, signature=signed))

    def test_revoke_denies_previous_signature_and_cross_project_claim(self):
        self.owner('/api/work/enqueue', {'project': 'TD', 'fingerprint': 'b' * 64,
            'payload': {'intent': 'build', 'context': 'McpGo'}})
        self.assert_forbidden(lambda: self.delegated('/api/work/claim', {'agent': 'workerA', 'project': 'Museum'},
                                                    project='Museum', nonce='nonce-40001'))
        self.owner('/api/work/revoke', {'agent': 'workerA', 'project': 'TD'})
        self.assert_forbidden(lambda: self.delegated('/api/work/claim', {'agent': 'workerA', 'project': 'TD'}, nonce='nonce-40002'))
        self.assertEqual(self.owner('/api/work/summary')['QUEUED'], 1)

class DelegatedDeniedHTTPFramingTest(unittest.TestCase):
    def test_denied_delegated_post_consumes_bounded_request_body_before_403(self):
        # A Windows TCP connection can be reset on early HTTP response when a
        # rejected POST body remains unread. The 403 must be unambiguous to clients.
        body=b'{"project":"TD","agent":"workerA","padding":"' + b'x'*8000 + b'"}'
        class FakeRequest(hub.Handler):
            def __init__(self):pass
            path='/api/work/grant'
            headers={'X-MCPHub-Client':'delegate','Content-Length':str(len(body))}
            rfile=io.BytesIO(body)
            code=None
            def result(self,obj,code):
                self.code=code
                self.remaining=len(body)-self.rfile.tell()
                self.error=obj.get('error')
        req=FakeRequest()
        hub.Handler.do_POST(req)
        self.assertEqual(req.code,403)
        self.assertEqual(req.error,'Delegated route forbidden')
        self.assertEqual(req.remaining,0,'Unread bounded POST body can reset Windows HTTP clients')


if __name__ == '__main__':
    unittest.main()
