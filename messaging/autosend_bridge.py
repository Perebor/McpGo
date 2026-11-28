"""MCP-09 owner-only queue -> AutoSend read-only preparation.

No method in this module creates, resumes, sends, or retries any AutoSend task.
There is deliberately NO POST client and NO delivery side effect.
"""
import http.client
import json
import os
import pathlib
import re

TOKEN = re.compile(r'[0-9a-f]{64}\Z')
MAX_STATUS_BYTES = 1024 * 1024


def default_token_path():
    state = os.environ.get('MCPHUB_AUTOSEND_STATE')
    if state:
        return pathlib.Path(state).parent / 'control-token'
    if os.name == 'nt':
        base = os.environ.get('APPDATA')
        if not base:
            raise ValueError('AutoSend user data unavailable')
        return pathlib.Path(base) / 'mcpgo-windows' / 'AutoSend' / 'control-token'
    return pathlib.Path.home() / 'Library/Application Support/McpGo/AutoSend/control-token'


def fetch_status(*, token_path=None, port=8972):
    """Bounded, authenticated GET to fixed loopback AutoSend endpoint."""
    file = pathlib.Path(token_path) if token_path is not None else default_token_path()
    info = file.lstat()
    if not file.is_file() or file.is_symlink() or info.st_size != 64:
        raise ValueError('AutoSend credential unavailable')
    token = file.read_text(encoding='ascii')
    if not TOKEN.fullmatch(token):
        raise ValueError('AutoSend credential invalid')
    if type(port) is not int or not 1 <= port <= 65535:
        raise ValueError('AutoSend port invalid')
    conn = http.client.HTTPConnection('127.0.0.1', port=port, timeout=2.0)
    try:
        conn.request('GET', '/api/status', headers={
            'Host': f'127.0.0.1:{port}',
            'X-MCPHub-Client': 'native',
            'X-MCPHub-Token': token,
            'Accept': 'application/json',
        })
        response = conn.getresponse()
        if response.status != 200:
            raise ValueError('AutoSend status unavailable')
        content = response.read(MAX_STATUS_BYTES + 1)
        if len(content) > MAX_STATUS_BYTES:
            raise ValueError('AutoSend status too large')
        data = json.loads(content)
        if not isinstance(data, dict) or data.get('ok') is not True:
            raise ValueError('Unexpected AutoSend status')
        return data
    finally:
        conn.close()


def preview(item, status):
    """Produce an owner-visible decision. Never authorizes a send."""
    def result(decision):
        return {'decision': decision, 'can_send': False, 'mode': 'READ_ONLY'}
    if not isinstance(item, dict) or item.get('state') != 'QUEUED':
        return result('BLOCKED_NOT_QUEUED')
    if item.get('project') not in ('TD', 'Museum'):
        return result('UNKNOWN')
    try:
        payload = item.get('payload')
        if isinstance(payload, str):
            payload = json.loads(payload)
        if not isinstance(payload, dict) or payload.get('context') != 'McpGo' or payload.get('intent') not in ('run_tests', 'inspect_code', 'audit', 'build'):
            return result('UNKNOWN')
    except (TypeError, ValueError):
        return result('UNKNOWN')
    if not isinstance(status, dict) or status.get('ok') is not True or not isinstance(status.get('tasks'), list):
        return result('UNKNOWN')
    candidates = [t for t in status['tasks']
                  if isinstance(t, dict) and t.get('smart_v2_project') == item['project']]
    if len(candidates) != 1:
        return result('UNKNOWN')
    task = candidates[0]
    if task.get('verification') or status.get('busyTask'):
        return result('BLOCKED_PENDING_RECEIPT')
    if task.get('enabled') is True or task.get('status') in ('checking', 'sending', 'verifying', 'scheduled'):
        return result('BLOCKED_ACTIVE')
    if task.get('status') == 'paused' and task.get('enabled') is False:
        return result('BLOCKED_PAUSED')
    if status.get('extensionConnected') is not True or task.get('browserConfirmed') is not True:
        return result('BLOCKED_BROWSER_UNAVAILABLE')
    return result('UNKNOWN')
