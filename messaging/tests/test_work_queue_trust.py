"""MCP-09 RED: deny cross-project claims and self-verified results."""
import sqlite3
import unittest
from messaging import work_queue as q


class QueueTrustTest(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(':memory:', isolation_level=None)
        q.setup_queue(self.db)

    def tearDown(self):
        self.db.close()

    def payload(self):
        return {'intent': 'run_tests', 'context': 'McpGo', 'branch': 'work/fixture'}

    def test_unregistered_actor_cannot_claim_any_project(self):
        q.enqueue_task(self.db, 'TD', 'a' * 64, self.payload(), now_ms=1000)
        self.assertIsNone(q.lease_next(self.db, 'TD', 'untrusted', now_ms=2000, ttl_ms=5000))
        self.assertEqual(q.queue_summary(self.db)['QUEUED'], 1)

    def test_scoped_agent_cannot_cross_project_or_reclaim_after_revoke(self):
        q.grant_actor_scope(self.db, 'agent-td', 'TD')
        q.enqueue_task(self.db, 'TD', 'b' * 64, self.payload(), now_ms=1000)
        q.enqueue_task(self.db, 'Museum', 'b' * 64, self.payload(), now_ms=1000)
        self.assertIsNone(q.lease_next(self.db, 'Museum', 'agent-td', now_ms=2000, ttl_ms=5000))
        claim = q.lease_next(self.db, 'TD', 'agent-td', now_ms=2000, ttl_ms=5000)
        self.assertIsNotNone(claim)
        q.revoke_actor_scope(self.db, 'agent-td', 'TD')
        self.assertFalse(q.finish_task(self.db, claim['id'], 'agent-td', claim['lease_token'],
                                      'f' * 64, now_ms=2100))
        self.assertIsNone(q.lease_next(self.db, 'TD', 'agent-td', now_ms=2100, ttl_ms=5000))

    def test_agent_ack_must_not_count_as_independently_verified(self):
        q.grant_actor_scope(self.db, 'agent-td', 'TD')
        q.enqueue_task(self.db, 'TD', 'c' * 64, self.payload(), now_ms=1000)
        claim = q.lease_next(self.db, 'TD', 'agent-td', now_ms=2000, ttl_ms=5000)
        self.assertTrue(q.finish_task(self.db, claim['id'], 'agent-td', claim['lease_token'],
                                      'd' * 64, now_ms=2500))
        status = q.queue_summary(self.db)
        self.assertEqual(status['ACKED'], 1)
        self.assertEqual(status['VERIFIED'], 0)
        self.assertFalse(q.confirm_verified_result(self.db, claim['id'], 'd' * 64,
                                                    verifier=lambda _item, _sha: False, now_ms=2600))
        self.assertEqual(q.queue_summary(self.db)['ACKED'], 1)
        self.assertTrue(q.confirm_verified_result(self.db, claim['id'], 'd' * 64,
                                                   verifier=lambda _item, _sha: True, now_ms=2600))
        self.assertFalse(q.confirm_verified_result(self.db, claim['id'], 'd' * 64,
                                                    verifier=lambda _item, _sha: True, now_ms=2601))
        self.assertEqual(q.queue_summary(self.db)['VERIFIED'], 1)

    def test_expired_unknown_is_never_promoted_to_verified(self):
        q.grant_actor_scope(self.db, 'agent-td', 'TD')
        q.enqueue_task(self.db, 'TD', 'e' * 64, self.payload(), now_ms=1000)
        claim = q.lease_next(self.db, 'TD', 'agent-td', now_ms=2000, ttl_ms=5000)
        q.mark_expired_unknown(self.db, now_ms=7001)
        self.assertFalse(q.confirm_verified_result(self.db, claim['id'], 'd' * 64,
                                                    verifier=lambda _item, _sha: True, now_ms=7002))
        self.assertEqual(q.queue_summary(self.db)['UNKNOWN'], 1)

    def test_existing_queue_schema_upgrades_without_losing_lease_or_replaying(self):
        old = sqlite3.connect(':memory:', isolation_level=None)
        try:
            old.execute("""CREATE TABLE mcpgo_work_queue(
                id TEXT PRIMARY KEY,project TEXT NOT NULL CHECK(project IN ('TD','Museum')),
                fingerprint TEXT NOT NULL,payload TEXT NOT NULL,
                state TEXT NOT NULL CHECK(state IN ('QUEUED','LEASED','VERIFIED','FAILED','UNKNOWN')),
                agent TEXT,lease_token TEXT,lease_expires_ms INTEGER,
                result_fingerprint TEXT,created_ms INTEGER NOT NULL,updated_ms INTEGER NOT NULL,
                UNIQUE(project,fingerprint))""")
            old.execute("""INSERT INTO mcpgo_work_queue
                VALUES ('legacy','TD',?,?, 'LEASED','agent-td',?,5000,NULL,1000,2000)""",
                        ('a' * 64, '{"context":"McpGo","intent":"run_tests"}', 'b' * 64))
            q.setup_queue(old)
            self.assertEqual(q.queue_summary(old)['LEASED'], 1)
            self.assertIsNone(q.lease_next(old, 'TD', 'agent-td', now_ms=3000, ttl_ms=5000))
            q.mark_expired_unknown(old, now_ms=5001)
            self.assertEqual(q.queue_summary(old)['UNKNOWN'], 1)
            q.grant_actor_scope(old, 'agent-td', 'TD')
            self.assertFalse(q.finish_task(old, 'legacy', 'agent-td', 'b' * 64,
                                           'c' * 64, now_ms=5002))
            self.assertEqual(q.queue_summary(old)['UNKNOWN'], 1)
            q.enqueue_task(old, 'TD', 'f' * 64, self.payload(), now_ms=6000)
            after = q.lease_next(old, 'TD', 'agent-td', now_ms=6100, ttl_ms=5000)
            self.assertIsNotNone(after)
            self.assertTrue(q.finish_task(old, after['id'], 'agent-td',
                                          after['lease_token'], 'c' * 64, now_ms=6200))
            self.assertEqual(q.queue_summary(old)['ACKED'], 1)
        finally:
            old.close()

    def test_unverified_ack_survives_restart_without_becoming_verified(self):
        import tempfile
        from pathlib import Path
        with tempfile.TemporaryDirectory() as folder:
            filename = str(Path(folder) / 'queue.sqlite3')
            first = sqlite3.connect(filename, isolation_level=None)
            q.setup_queue(first)
            q.grant_actor_scope(first, 'agent-td', 'TD')
            q.enqueue_task(first, 'TD', 'd' * 64, self.payload(), now_ms=1000)
            claim = q.lease_next(first, 'TD', 'agent-td', now_ms=2000, ttl_ms=5000)
            self.assertTrue(q.finish_task(first, claim['id'], 'agent-td',
                                          claim['lease_token'], 'e' * 64, now_ms=2500))
            first.close()
            restarted = sqlite3.connect(filename, isolation_level=None)
            try:
                q.setup_queue(restarted)
                self.assertEqual(q.queue_summary(restarted)['ACKED'], 1)
                self.assertEqual(q.queue_summary(restarted)['VERIFIED'], 0)
                self.assertIsNone(q.lease_next(restarted, 'TD', 'agent-td',
                                               now_ms=3000, ttl_ms=5000))
            finally:
                restarted.close()
