"""MCP-09 owner-local typed handoff queue. No ChatGPT delivery or commands.

The queue is intentionally not exposed to HTTP until MCP-08 agent-scoped
capability tokens, signatures, TTL and replay guards are implemented.
"""
import json
import re
import secrets
import sqlite3
import uuid

PROJECTS = frozenset({'TD', 'Museum'})
INTENTS = frozenset({'run_tests', 'inspect_code', 'audit', 'build'})
HEX256 = re.compile(r'^[a-f0-9]{64}$')
AGENT = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$')
STATES = ('QUEUED', 'LEASED', 'VERIFIED', 'FAILED', 'UNKNOWN')


def _valid_task(project, fingerprint, payload):
    if project not in PROJECTS or not isinstance(fingerprint, str) or not HEX256.fullmatch(fingerprint):
        raise ValueError('Untrusted project or fingerprint')
    if not isinstance(payload, dict) or set(payload) - {'intent', 'context', 'branch'}:
        raise ValueError('Unsupported queue payload fields')
    if payload.get('intent') not in INTENTS or payload.get('context') != 'McpGo':
        raise ValueError('Queue cannot authorize untrusted instructions')
    branch = payload.get('branch')
    if branch is not None and (not isinstance(branch, str) or len(branch) > 160 or
                               any(c in branch for c in ('\\', '\n', '\r', '..', ':')) or
                               not re.fullmatch(r'[A-Za-z0-9_./-]+', branch)):
        raise ValueError('Invalid branch hint')
    return json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(',', ':'))


def setup_queue(db):
    db.execute("""CREATE TABLE IF NOT EXISTS mcpgo_work_queue(
        id TEXT PRIMARY KEY,
        project TEXT NOT NULL CHECK(project IN ('TD','Museum')),
        fingerprint TEXT NOT NULL,
        payload TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('QUEUED','LEASED','VERIFIED','FAILED','UNKNOWN')),
        agent TEXT,
        lease_token TEXT,
        lease_expires_ms INTEGER,
        result_fingerprint TEXT,
        created_ms INTEGER NOT NULL,
        updated_ms INTEGER NOT NULL,
        UNIQUE(project, fingerprint))""")
    db.execute("""CREATE INDEX IF NOT EXISTS mcpgo_work_pending
        ON mcpgo_work_queue(project, state, created_ms)""")


def enqueue_task(db, project, fingerprint, payload, *, now_ms):
    data = _valid_task(project, fingerprint, payload)
    if not isinstance(now_ms, int) or now_ms <= 0:
        raise ValueError('Invalid timestamp')
    item_id = str(uuid.uuid4())
    db.execute('BEGIN IMMEDIATE')
    try:
        row = db.execute('SELECT id,payload FROM mcpgo_work_queue WHERE project=? AND fingerprint=?',
                         (project, fingerprint)).fetchone()
        if row:
            if row[1] != data:
                raise ValueError('Conflicting request with reused fingerprint')
            result = {'id': row[0], 'duplicate': True}
        else:
            db.execute("""INSERT INTO mcpgo_work_queue
                (id,project,fingerprint,payload,state,created_ms,updated_ms)
                VALUES (?,?,?,?,?,?,?)""",
                       (item_id, project, fingerprint, data, 'QUEUED', now_ms, now_ms))
            result = {'id': item_id, 'duplicate': False}
        db.execute('COMMIT')
        return result
    except Exception:
        db.execute('ROLLBACK')
        raise


def lease_next(db, project, agent, *, now_ms, ttl_ms):
    if project not in PROJECTS or not isinstance(agent, str) or not AGENT.fullmatch(agent):
        raise ValueError('Unknown agent or project')
    if not isinstance(now_ms, int) or now_ms <= 0 or not isinstance(ttl_ms, int) or not 1000 <= ttl_ms <= 300000:
        raise ValueError('Invalid lease lifetime')
    db.execute('BEGIN IMMEDIATE')
    try:
        row = db.execute("""SELECT id,payload FROM mcpgo_work_queue
            WHERE project=? AND state='QUEUED' ORDER BY created_ms,id LIMIT 1""", (project,)).fetchone()
        if row is None:
            db.execute('COMMIT')
            return None
        lease_token = secrets.token_hex(32)
        expires = now_ms + ttl_ms
        affected = db.execute("""UPDATE mcpgo_work_queue
            SET state='LEASED', agent=?,lease_token=?,lease_expires_ms=?,updated_ms=?
            WHERE id=? AND state='QUEUED'""",
            (agent, lease_token, expires, now_ms, row[0])).rowcount
        if affected != 1:
            raise RuntimeError('Lost queue lease')
        db.execute('COMMIT')
        return {'id': row[0], 'project': project, 'agent': agent,
                'lease_token': lease_token, 'lease_expires_ms': expires,
                'payload': json.loads(row[1])}
    except Exception:
        db.execute('ROLLBACK')
        raise


def _finish(db, item_id, agent, lease_token, now_ms, state, fingerprint=None):
    if not isinstance(item_id, str) or not isinstance(agent, str) or not AGENT.fullmatch(agent):
        return False
    if not isinstance(lease_token, str) or not HEX256.fullmatch(lease_token):
        return False
    if not isinstance(now_ms, int) or now_ms <= 0:
        return False
    if state == 'VERIFIED' and (not isinstance(fingerprint, str) or not HEX256.fullmatch(fingerprint)):
        return False
    db.execute('BEGIN IMMEDIATE')
    try:
        changed = db.execute("""UPDATE mcpgo_work_queue SET state=?,result_fingerprint=?,
            updated_ms=?, lease_token=NULL,lease_expires_ms=NULL
            WHERE id=? AND agent=? AND lease_token=? AND state='LEASED'
            AND lease_expires_ms>?""", (state, fingerprint, now_ms, item_id,
                                         agent, lease_token, now_ms)).rowcount
        db.execute('COMMIT')
        return changed == 1
    except Exception:
        db.execute('ROLLBACK')
        raise


def finish_task(db, item_id, agent, lease_token, result_fingerprint, *, now_ms):
    return _finish(db, item_id, agent, lease_token, now_ms, 'VERIFIED', result_fingerprint)


def fail_task(db, item_id, agent, lease_token, *, now_ms):
    return _finish(db, item_id, agent, lease_token, now_ms, 'FAILED')


def mark_expired_unknown(db, *, now_ms):
    if not isinstance(now_ms, int) or now_ms <= 0:
        raise ValueError('Invalid timestamp')
    db.execute('BEGIN IMMEDIATE')
    try:
        changed = db.execute("""UPDATE mcpgo_work_queue
            SET state='UNKNOWN',updated_ms=? WHERE state='LEASED'
            AND lease_expires_ms<=?""", (now_ms, now_ms)).rowcount
        db.execute('COMMIT')
        return changed
    except Exception:
        db.execute('ROLLBACK')
        raise


def queue_summary(db):
    counts = dict.fromkeys(STATES, 0)
    for state, count in db.execute('SELECT state,COUNT(*) FROM mcpgo_work_queue GROUP BY state'):
        counts[state] = count
    return counts
