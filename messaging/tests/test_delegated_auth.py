import importlib.util
import pathlib
import sqlite3
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location('delegated_auth', pathlib.Path(__file__).resolve().parents[1] / 'delegated_auth.py')
if SPEC.origin and pathlib.Path(SPEC.origin).exists():
    auth = importlib.util.module_from_spec(SPEC)
    SPEC.loader.exec_module(auth)
else:
    auth = None


class DelegatedAuthTest(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(auth, 'delegated auth source must exist')
        self.db = sqlite3.connect(':memory:')
        auth.initialize(self.db)
        self.key = bytes.fromhex('a1' * 32)
        auth.grant(self.db, 'agentA', 'projectA', self.key)

    def signed(self, *, agent='agentA', project='projectA', method='GET', path='/api/work/pending?project=projectA', timestamp=1000, nonce='nonce-0001', key=None):
        return auth.sign(key or self.key, agent, project, method, path, timestamp, nonce)

    def test_valid_signature_consumed_once(self):
        signature = self.signed()
        self.assertTrue(auth.verify_and_consume(self.db, 'agentA', 'projectA', 'GET', '/api/work/pending?project=projectA', 1000, 'nonce-0001', signature, now=1001))
        self.assertFalse(auth.verify_and_consume(self.db, 'agentA', 'projectA', 'GET', '/api/work/pending?project=projectA', 1000, 'nonce-0001', signature, now=1001))

    def test_rejects_wrong_scope_path_verb_and_signature(self):
        signature = self.signed()
        attempts = [('agentB', 'projectA', 'GET', '/api/work/pending?project=projectA'), ('agentA', 'projectB', 'GET', '/api/work/pending?project=projectA'), ('agentA', 'projectA', 'POST', '/api/work/pending?project=projectA'), ('agentA', 'projectA', 'GET', '/api/work/pending?project=projectB')]
        for agent, project, method, path in attempts:
            self.assertFalse(auth.verify_and_consume(self.db, agent, project, method, path, 1000, 'nonce-0001', signature, now=1001))
        self.assertFalse(auth.verify_and_consume(self.db, 'agentA', 'projectA', 'GET', '/api/work/pending?project=projectA', 1000, 'nonce-0001', '0'*64, now=1001))

    def test_expired_future_and_revoked(self):
        sig = self.signed()
        self.assertFalse(auth.verify_and_consume(self.db, 'agentA', 'projectA', 'GET', '/api/work/pending?project=projectA', 1000, 'nonce-0001', sig, now=1200))
        self.assertFalse(auth.verify_and_consume(self.db, 'agentA', 'projectA', 'GET', '/api/work/pending?project=projectA', 1000, 'nonce-0001', sig, now=900))
        auth.revoke(self.db, 'agentA', 'projectA')
        self.assertFalse(auth.verify_and_consume(self.db, 'agentA', 'projectA', 'GET', '/api/work/pending?project=projectA', 1000, 'nonce-0001', sig, now=1001))

    def test_replay_survives_database_reopen(self):
        with tempfile.TemporaryDirectory() as d:
            file = pathlib.Path(d) / 'auth.db'
            db = sqlite3.connect(file)
            auth.initialize(db)
            auth.grant(db, 'agentA', 'projectA', self.key)
            sig = self.signed()
            self.assertTrue(auth.verify_and_consume(db, 'agentA', 'projectA', 'GET', '/api/work/pending?project=projectA', 1000, 'nonce-0001', sig, now=1001))
            db.close()
            db = sqlite3.connect(file)
            self.assertFalse(auth.verify_and_consume(db, 'agentA', 'projectA', 'GET', '/api/work/pending?project=projectA', 1000, 'nonce-0001', sig, now=1001))
            db.close()


    def test_key_rotation_and_invalid_nonce_fail_closed(self):
        previous = self.signed()
        auth.grant(self.db, 'agentA', 'projectA', bytes.fromhex('b2' * 32))
        self.assertFalse(auth.verify_and_consume(self.db, 'agentA', 'projectA', 'GET', '/api/work/pending?project=projectA', 1000, 'nonce-0001', previous, now=1001))
        for nonce in ('bad', 'bad\\nnonce', '!' * 10):
            with self.assertRaises(ValueError):
                auth.sign(self.key, 'agentA', 'projectA', 'GET', '/api/work/pending?project=projectA', 1000, nonce)

    def test_concurrent_replay_has_single_winner(self):
        import concurrent.futures
        with tempfile.TemporaryDirectory() as d:
            file = pathlib.Path(d) / 'auth.db'
            db = sqlite3.connect(file)
            auth.initialize(db)
            auth.grant(db, 'agentA', 'projectA', self.key)
            db.close()
            sig = self.signed()
            def attempt(_):
                conn = sqlite3.connect(file, timeout=3)
                try:
                    return auth.verify_and_consume(conn, 'agentA', 'projectA', 'GET', '/api/work/pending?project=projectA', 1000, 'nonce-0001', sig, now=1001)
                finally:
                    conn.close()
            with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
                results = list(pool.map(attempt, range(16)))
            self.assertEqual(sum(results), 1)
if __name__ == '__main__':
    unittest.main()
