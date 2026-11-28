import sqlite3
import tempfile
import unittest
from pathlib import Path
from messaging.work_queue import (
    setup_queue, enqueue_task, lease_next, finish_task, fail_task,
    queue_summary, mark_expired_unknown, grant_actor_scope
)


class WorkQueueTest(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(':memory:', isolation_level=None)
        setup_queue(self.db)
        for name in ('agent-alpha', 'agent-beta'):
            for project in ('TD', 'Museum'):
                grant_actor_scope(self.db, name, project)

    def tearDown(self):
        self.db.close()

    def payload(self):
        return {'intent': 'run_tests', 'context': 'McpGo', 'branch': 'work/test'}

    def test_scoped_idempotent_enqueue(self):
        a = enqueue_task(self.db, 'TD', 'f' * 64, self.payload(), now_ms=1000)
        again = enqueue_task(self.db, 'TD', 'f' * 64, self.payload(), now_ms=1100)
        b = enqueue_task(self.db, 'Museum', 'f' * 64, self.payload(), now_ms=1200)
        self.assertEqual(a['id'], again['id'])
        self.assertEqual(a['duplicate'], False)
        self.assertTrue(again['duplicate'])
        self.assertNotEqual(a['id'], b['id'])
        self.assertEqual(queue_summary(self.db), {'QUEUED': 2, 'LEASED': 0, 'ACKED': 0, 'VERIFIED': 0, 'FAILED': 0, 'UNKNOWN': 0})

    def test_one_lease_per_item_and_project_fence(self):
        a = enqueue_task(self.db, 'TD', 'a' * 64, self.payload(), now_ms=1000)
        job = lease_next(self.db, 'TD', 'agent-alpha', now_ms=2000, ttl_ms=5000)
        self.assertEqual(job['id'], a['id'])
        self.assertEqual(job['project'], 'TD')
        self.assertEqual(job['agent'], 'agent-alpha')
        self.assertIsNone(lease_next(self.db, 'TD', 'agent-beta', now_ms=2001, ttl_ms=5000))
        self.assertIsNone(lease_next(self.db, 'Museum', 'agent-beta', now_ms=2001, ttl_ms=5000))
        self.assertEqual(queue_summary(self.db)['LEASED'], 1)

    def test_receipt_requires_exact_lease_token_and_agent(self):
        enqueue_task(self.db, 'TD', 'a' * 64, self.payload(), now_ms=1000)
        item = lease_next(self.db, 'TD', 'agent-alpha', now_ms=2000, ttl_ms=5000)
        self.assertFalse(finish_task(self.db, item['id'], 'agent-beta', item['lease_token'], 'c' * 64, now_ms=3000))
        self.assertFalse(finish_task(self.db, item['id'], 'agent-alpha', 'bad', 'c' * 64, now_ms=3000))
        self.assertTrue(finish_task(self.db, item['id'], 'agent-alpha', item['lease_token'], 'c' * 64, now_ms=3000))
        self.assertFalse(finish_task(self.db, item['id'], 'agent-alpha', item['lease_token'], 'c' * 64, now_ms=3001))
        self.assertEqual(queue_summary(self.db)['ACKED'], 1)

    def test_timeout_unknown_never_automatically_requeues_or_resends(self):
        enqueue_task(self.db, 'TD', 'a' * 64, self.payload(), now_ms=1000)
        item = lease_next(self.db, 'TD', 'agent-alpha', now_ms=2000, ttl_ms=5000)
        self.assertEqual(mark_expired_unknown(self.db, now_ms=7001), 1)
        self.assertEqual(queue_summary(self.db)['UNKNOWN'], 1)
        self.assertIsNone(lease_next(self.db, 'TD', 'agent-beta', now_ms=8000, ttl_ms=5000))
        self.assertFalse(finish_task(self.db, item['id'], 'agent-alpha', item['lease_token'], 'c' * 64, now_ms=8000))

    def test_failure_is_terminal_and_cannot_be_double_counted(self):
        enqueue_task(self.db, 'TD', 'b' * 64, self.payload(), now_ms=1000)
        item = lease_next(self.db, 'TD', 'agent-alpha', now_ms=2000, ttl_ms=5000)
        self.assertTrue(fail_task(self.db, item['id'], 'agent-alpha', item['lease_token'], now_ms=3000))
        self.assertFalse(fail_task(self.db, item['id'], 'agent-alpha', item['lease_token'], now_ms=3001))
        self.assertEqual(queue_summary(self.db)['FAILED'], 1)

    def test_invalid_fingerprint_project_and_arbitrary_commands_rejected(self):
        for project, fingerprint, payload in [
            ('Other', 'a' * 64, self.payload()),
            ('TD', 'bad', self.payload()),
            ('TD', 'a' * 64, {'intent': 'send_chat', 'context': 'McpGo'}),
            ('TD', 'a' * 64, {'intent': 'run_tests', 'context': 'McpGo', 'command': 'rm -rf /'}),
        ]:
            with self.assertRaises(ValueError):
                enqueue_task(self.db, project, fingerprint, payload, now_ms=1000)
        self.assertEqual(queue_summary(self.db)['QUEUED'], 0)


    def test_persistent_lease_does_not_duplicate_after_process_restart(self):
        with tempfile.TemporaryDirectory() as folder:
            filename = str(Path(folder) / 'queue.sqlite3')
            first = sqlite3.connect(filename, isolation_level=None)
            setup_queue(first)
            grant_actor_scope(first, 'agent-one', 'Museum')
            grant_actor_scope(first, 'agent-two', 'Museum')
            created = enqueue_task(first, 'Museum', 'd' * 64, self.payload(), now_ms=1000)
            leased = lease_next(first, 'Museum', 'agent-one', now_ms=2000, ttl_ms=5000)
            first.close()
            restarted = sqlite3.connect(filename, isolation_level=None)
            setup_queue(restarted)
            try:
                self.assertIsNone(lease_next(restarted, 'Museum', 'agent-two', now_ms=2001, ttl_ms=5000))
                self.assertEqual(created['id'], leased['id'])
                self.assertTrue(finish_task(restarted, leased['id'], 'agent-one',
                                            leased['lease_token'], 'c' * 64, now_ms=3000))
                self.assertEqual(queue_summary(restarted)['ACKED'], 1)
            finally:
                restarted.close()

    def test_duplicate_fingerprint_with_different_payload_is_not_silently_accepted(self):
        enqueue_task(self.db, 'TD', 'e' * 64, self.payload(), now_ms=1000)
        with self.assertRaises(ValueError):
            enqueue_task(self.db, 'TD', 'e' * 64,
                         {'intent': 'build', 'context': 'McpGo'}, now_ms=1100)
        self.assertEqual(queue_summary(self.db)['QUEUED'], 1)


if __name__ == '__main__':
    unittest.main()
