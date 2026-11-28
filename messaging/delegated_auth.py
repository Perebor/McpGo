"""Offline, owner-issued per-actor HMAC credentials. Not yet wired to Hub HTTP."""
import hashlib
import hmac
import re
import sqlite3

IDENTIFIER = re.compile(r'[A-Za-z][A-Za-z0-9_-]{0,63}\Z')
SIGNATURE = re.compile(r'[0-9a-f]{64}\Z')
NONCE = re.compile(r'[A-Za-z0-9_-]{8,128}\Z')
TTL_SECONDS = 60


def initialize(db):
    db.execute('''CREATE TABLE IF NOT EXISTS delegated_grants (
      actor TEXT NOT NULL, project TEXT NOT NULL, secret BLOB NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY(actor,project))''')
    db.execute('''CREATE TABLE IF NOT EXISTS delegated_nonces (
      actor TEXT NOT NULL, project TEXT NOT NULL, nonce TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      PRIMARY KEY(actor,project,nonce))''')
    db.commit()


def grant(db, actor, project, secret):
    if not valid_name(actor) or not valid_name(project) or not isinstance(secret, bytes) or len(secret) != 32:
        raise ValueError('Invalid delegated grant')
    with db:
        db.execute('''INSERT INTO delegated_grants(actor,project,secret,enabled)
          VALUES(?,?,?,1) ON CONFLICT(actor,project) DO UPDATE SET
          secret=excluded.secret, enabled=1''', (actor, project, secret))
        db.execute('DELETE FROM delegated_nonces WHERE actor=? AND project=?', (actor, project))


def revoke(db, actor, project):
    with db:
        db.execute('UPDATE delegated_grants SET enabled=0 WHERE actor=? AND project=?', (actor, project))


def valid_name(value):
    return isinstance(value, str) and IDENTIFIER.fullmatch(value) is not None


def payload(actor, project, method, path, timestamp, nonce, *, body=b''):
    if not all(map(valid_name, (actor, project))) or method not in ('GET', 'POST'):
        raise ValueError('Invalid actor, project, or method')
    if not isinstance(path, str) or not path.startswith('/api/') or '\n' in path or '\r' in path or len(path) > 1024:
        raise ValueError('Invalid request path')
    if type(timestamp) is not int or timestamp < 0 or not isinstance(nonce, str) or not NONCE.fullmatch(nonce):
        raise ValueError('Invalid timestamp or nonce')
    if not isinstance(body, bytes):
        raise ValueError('Invalid signed body')
    if method == 'GET':
        # Legacy message inbox has no project tag; never delegate its contents.
        if path != '/api/work/pending?project=' + project or body:
            raise ValueError('Delegated GET is restricted to own inbox')
        fields = (actor, project, method, path, str(timestamp), nonce)
    elif path in ('/api/work/claim', '/api/work/ack'):
        # Authenticate the raw POST bytes, not a mutable parsed JSON object.
        fields = (actor, project, method, path, str(timestamp), nonce, hashlib.sha256(body).hexdigest())
    else:
        raise ValueError('Delegated route is forbidden')
    return '\n'.join(fields).encode('utf-8')


def sign(secret, actor, project, method, path, timestamp, nonce, *, body=b''):
    if not isinstance(secret, bytes) or len(secret) != 32:
        raise ValueError('Invalid signing key')
    return hmac.new(secret, payload(actor, project, method, path, timestamp, nonce, body=body), hashlib.sha256).hexdigest()


def verify_and_consume(db, actor, project, method, path, timestamp, nonce, signature, *, now, body=b''):
    """Fail closed; nonce is committed before success and persists across restarts."""
    try:
        if type(now) is not int or abs(now - timestamp) > TTL_SECONDS:
            return False
        signed_payload = payload(actor, project, method, path, timestamp, nonce, body=body)
        if not isinstance(signature, str) or not SIGNATURE.fullmatch(signature):
            return False
        with db:
            row = db.execute('SELECT secret FROM delegated_grants WHERE actor=? AND project=? AND enabled=1', (actor, project)).fetchone()
            if row is None:
                return False
            expected = hmac.new(row[0], signed_payload, hashlib.sha256).hexdigest()
            if not hmac.compare_digest(expected, signature):
                return False
            db.execute('DELETE FROM delegated_nonces WHERE expires_at < ?', (now,))
            result = db.execute('INSERT OR IGNORE INTO delegated_nonces(actor,project,nonce,expires_at) VALUES(?,?,?,?)', (actor, project, nonce, max(now, timestamp) + TTL_SECONDS))
            return result.rowcount == 1
    except (ValueError, TypeError, sqlite3.Error):
        return False
