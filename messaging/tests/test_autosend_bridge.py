"""AutoSend integration contract: GET status ONLY, never a delivery command."""
import importlib.util
import json
import pathlib
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BASE = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('autosend_bridge', BASE / 'autosend_bridge.py')
if spec.origin and pathlib.Path(spec.origin).exists():
    bridge = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(bridge)
else:
    bridge = None

ITEM = {'id': 'fixture-work', 'project': 'TD', 'state': 'QUEUED',
        'payload': json.dumps({'context': 'McpGo', 'intent': 'run_tests'})}

class StatusOnlyServer(BaseHTTPRequestHandler):
    calls = []
    def do_GET(self):
        self.__class__.calls.append((self.command, self.path))
        if self.path != '/api/status' or self.headers.get('X-MCPHub-Client') != 'native' or self.headers.get('X-MCPHub-Token') != 'a' * 64:
            self.send_response(403)
            self.end_headers()
            return
        response = json.dumps({'ok': True, 'extensionConnected': False,
            'busyTask': '', 'tasks': [{'id': 'test-task-id', 'smart_v2_project': 'TD',
                                      'status': 'paused', 'enabled': False, 'verification': None}]}).encode()
        self.send_response(200)
        self.send_header('Content-Length', str(len(response)))
        self.end_headers()
        self.wfile.write(response)
    def do_POST(self):
        self.__class__.calls.append((self.command, self.path))
        self.send_response(500)
        self.end_headers()
    def log_message(self, fmt, *args):
        pass


class AutoSendBridgeTest(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(bridge)
    def test_exact_project_paused_and_unknown_fail_closed(self):
        status = {'ok': True, 'extensionConnected': False, 'busyTask': '', 'tasks': [
            {'smart_v2_project': 'TD', 'enabled': False, 'status': 'paused', 'verification': None}]}
        result = bridge.preview(ITEM, status)
        self.assertEqual(result['decision'], 'BLOCKED_PAUSED')
        self.assertFalse(result['can_send'])
        self.assertEqual(bridge.preview(ITEM, None)['decision'], 'UNKNOWN')
        self.assertEqual(bridge.preview(ITEM, {'ok': True, 'tasks': []})['decision'], 'UNKNOWN')
        self.assertEqual(bridge.preview({**ITEM, 'state': 'ACKED'}, status)['decision'], 'BLOCKED_NOT_QUEUED')
        self.assertEqual(bridge.preview(ITEM, {**status, 'tasks': status['tasks'] * 2})['decision'], 'UNKNOWN')
        self.assertEqual(bridge.preview(ITEM, {**status, 'tasks': [
            {**status['tasks'][0], 'status': 'sending', 'enabled': True}]})['decision'], 'BLOCKED_ACTIVE')
        self.assertEqual(bridge.preview(ITEM, {**status, 'tasks': [
            {**status['tasks'][0], 'verification': {'id': 'unknown'}}]})['decision'], 'BLOCKED_PENDING_RECEIPT')
    def test_read_status_only_get_and_token_never_exposed(self):
        with tempfile.TemporaryDirectory() as temp:
            path = pathlib.Path(temp) / 'control-token'
            path.write_text('a' * 64)
            StatusOnlyServer.calls = []
            server = ThreadingHTTPServer(('127.0.0.1', 0), StatusOnlyServer)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                status = bridge.fetch_status(token_path=path, port=server.server_port)
                self.assertEqual(status['ok'], True)
                self.assertEqual(StatusOnlyServer.calls, [('GET', '/api/status')])
                result = bridge.preview(ITEM, status)
                self.assertFalse(result['can_send'])
                self.assertNotIn('a' * 64, repr(result))
            finally:
                server.shutdown()
                server.server_close()
                thread.join(3)

if __name__ == '__main__':
    unittest.main()
