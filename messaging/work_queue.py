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
STATES = ('QUEUED', 'LEASED', 'ACKED', 'VERIFIED', 'FAILED', 'UNKNOWN')


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
    existing = db.execute("""SELECT sql FROM sqlite_master
                              WHERE type='table' AND name='mcpgo_work_queue'""").fetchone()
    if existing is not None and "'ACKED'" not in existing[0]:
        legacy = "'QUEUED','LEASED','VERIFIED','FAILED','UNKNOWN'"
        if legacy not in existing[0] or db.in_transaction:
            raise ValueError('Unsupported queue schema: refuse unsafe migration')
        # A legacy table cannot store ACKED. Rebuild under an IMMEDIATE
        # transaction: all existing in-flight leases remain LEASED, never
        # requeued, and any error restores the original table automatically.
        db.execute('BEGIN IMMEDIATE')
        try:
            db.execute("""CREATE TABLE mcpgo_work_queue_v2(
                id TEXT PRIMARY KEY,
                project TEXT NOT NULL CHECK(project IN ('TD','Museum')),
                fingerprint TEXT NOT NULL,
                payload TEXT NOT NULL,
                state TEXT NOT NULL CHECK(state IN ('QUEUED','LEASED','ACKED','VERIFIED','FAILED','UNKNOWN')),
                agent TEXT,lease_token TEXT,lease_expires_ms INTEGER,
                result_fingerprint TEXT,created_ms INTEGER NOT NULL,
                updated_ms INTEGER NOT NULL,UNIQUE(project,fingerprint))""")
            db.execute("""INSERT INTO mcpgo_work_queue_v2
                (id,project,fingerprint,payload,state,agent,lease_token,
                 lease_expires_ms,result_fingerprint,created_ms,updated_ms)
                SELECT id,project,fingerprint,payload,state,agent,lease_token,
                       lease_expires_ms,result_fingerprint,created_ms,updated_ms
                FROM mcpgo_work_queue""")
            db.execute('DROP TABLE mcpgo_work_queue')
            db.execute('ALTER TABLE mcpgo_work_queue_v2 RENAME TO mcpgo_work_queue')
            db.execute('COMMIT')
        except Exception:
            db.execute('ROLLBACK')
            raise
    db.execute("""CREATE TABLE IF NOT EXISTS mcpgo_work_queue(
        id TEXT PRIMARY KEY,
        project TEXT NOT NULL CHECK(project IN ('TD','Museum')),
        fingerprint TEXT NOT NULL,
        payload TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('QUEUED','LEASED','ACKED','VERIFIED','FAILED','UNKNOWN')),
        agent TEXT,
        lease_token TEXT,
        lease_expires_ms INTEGER,
        result_fingerprint TEXT,
        created_ms INTEGER NOT NULL,
        updated_ms INTEGER NOT NULL,
        UNIQUE(project, fingerprint))""")
    db.execute("""CREATE TABLE IF NOT EXISTS mcpgo_actor_scopes(
        agent TEXT NOT NULL,
        project TEXT NOT NULL CHECK(project IN ('TD','Museum')),
        PRIMARY KEY(agent,project))""")
    db.execute("""CREATE INDEX IF NOT EXISTS mcpgo_work_pending
        ON mcpgo_work_queue(project, state, created_ms)""")


def grant_actor_scope(db, agent, project):
    """Owner-only local administrative grant, deliberately not exposed to HTTP."""
    if not isinstance(agent, str) or not AGENT.fullmatch(agent) or project not in PROJECTS:
        raise ValueError('Invalid grant')
    db.execute('INSERT OR IGNORE INTO mcpgo_actor_scopes(agent,project) VALUES (?,?)',
               (agent, project))


def revoke_actor_scope(db, agent, project):
    if not isinstance(agent, str) or not AGENT.fullmatch(agent) or project not in PROJECTS:
        raise ValueError('Invalid revoke')
    db.execute('DELETE FROM mcpgo_actor_scopes WHERE agent=? AND project=?',
               (agent, project))


def _has_scope(db, agent, project):
    return db.execute('SELECT 1 FROM mcpgo_actor_scopes WHERE agent=? AND project=?',
                      (agent, project)).fetchone() is not None


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
        if not _has_scope(db, agent, project):
            db.execute('COMMIT')
            return None
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
        # A revoked actor cannot attest completion of a previously granted lease.
        scope = db.execute('SELECT project FROM mcpgo_work_queue WHERE id=?', (item_id,)).fetchone()
        if not scope or not _has_scope(db, agent, scope[0]):
            db.execute('COMMIT')
            return False
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
    return _finish(db, item_id, agent, lease_token, now_ms, 'ACKED', result_fingerprint)


def confirm_verified_result(db, item_id, result_fingerprint, *, verifier, now_ms):
    """Owner-local transition after *independent* verification. Not exposed to HTTP.

    The verifier must consult external trusted evidence. An agent ACK is never
    proof by itself. Verification failures and mismatched fingerprints fail closed.
    """
    if not isinstance(item_id, str) or not isinstance(result_fingerprint, str) or not HEX256.fullmatch(result_fingerprint):
        return False
    if not isinstance(now_ms, int) or now_ms <= 0 or not callable(verifier):
        return False
    db.execute('BEGIN IMMEDIATE')
    try:
        row = db.execute("""SELECT project,state,result_fingerprint FROM mcpgo_work_queue
                             WHERE id=?""", (item_id,)).fetchone()
        if not row or row[1] != 'ACKED' or row[2] != result_fingerprint:
            db.execute('COMMIT')
            return False
        # The verifier is trusted code, NEVER a Boolean supplied by an agent's
        # message or an HTTP caller.
        if verifier(item_id, result_fingerprint) is not True:
            db.execute('COMMIT')
            return False
        updated = db.execute("""UPDATE mcpgo_work_queue SET state='VERIFIED',updated_ms=?
                                  WHERE id=? AND state='ACKED' AND result_fingerprint=?""",
                             (now_ms, item_id, result_fingerprint)).rowcount
        db.execute('COMMIT')
        return updated == 1
    except Exception:
        db.execute('ROLLBACK')
        raise


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
