"""Synthetic per-table cache regression tests. No cabinet connection."""
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'app'))
from table_cache import TableCache


class CacheTests(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.TemporaryDirectory()
        self.cache = TableCache(self.root.name)

    def tearDown(self):
        self.root.cleanup()

    def wait(self, key):
        for _ in range(200):
            with self.cache.lock:
                if key not in self.cache.pending:
                    return
            time.sleep(.01)
        self.fail('Background fixture did not finish')

    def test_first_read_immediate_then_persisted(self):
        event = threading.Event()
        def load():
            event.wait(2)
            return {'ok': True, 'details': {'author': 'Example author'}}
        first = self.cache.fetch('details/1', load)
        self.assertTrue(first['cache']['notSaved'])
        self.assertTrue(first['cache']['refreshing'])
        event.set()
        self.wait('details/1')
        reopened = TableCache(self.root.name)
        saved = reopened.fetch('details/1', lambda: self.fail('Fresh entry was fetched again'))
        self.assertEqual(saved['details']['author'], 'Example author')
        self.assertFalse(saved['cache']['notSaved'])

    def test_failure_keeps_old_value(self):
        self.cache._refresh('details/1', lambda: {'details': {'author': 'Saved'}})
        with self.cache.db() as db:
            db.execute('UPDATE cache SET saved=1')
        def fail():
            raise TimeoutError()
        result = self.cache.fetch('details/1', fail)
        self.assertEqual(result['details']['author'], 'Saved')
        self.wait('details/1')
        self.assertEqual(self.cache.read('details/1')[0]['details']['author'], 'Saved')

    def test_duplicate_and_cooldown(self):
        gate = threading.Event()
        calls = []
        def load():
            calls.append(1)
            gate.wait(2)
            raise TimeoutError()
        for _ in range(20):
            self.cache.fetch('details/1', load)
        gate.set()
        self.wait('details/1')
        self.cache.fetch('details/1', load)
        self.assertEqual(len(calls), 1)

    def test_item_and_row_limits(self):
        self.cache.MAX_ITEM = 100
        self.cache._refresh('oversized', lambda: {'value': 'x' * 100})
        self.assertIsNone(self.cache.read('oversized')[0])
        self.cache.MAX_ROWS = 2
        for i in range(5):
            self.cache._refresh(str(i), lambda: {'value': 'ok'})
        with self.cache.db() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM cache').fetchone()[0], 2)

    def test_warm_sequential_and_fresh_skip(self):
        calls = []
        loader = lambda kind, game_id: calls.append((kind, game_id)) or ({'details': {}} if kind == 'details' else {'scores': []})
        self.cache.warm([1], loader, lambda: True)
        for _ in range(400):
            if not self.cache.warm_state()['running']:
                break
            time.sleep(.01)
        self.assertEqual(calls, [('details', 1), ('scorehistory', 1)])
        self.assertEqual(self.cache.warm_state()['done'], 2)
        self.cache.warm([1], loader, lambda: self.fail('Fresh entry requested status'))
        for _ in range(100):
            if not self.cache.warm_state()['running']:
                break
            time.sleep(.01)
        self.assertEqual(len(calls), 2)
        self.assertEqual(self.cache.warm_state()['skipped'], 2)

    def test_warm_pauses_and_deduplicates(self):
        gate = threading.Event()
        calls = []
        def idle():
            gate.wait(2)
            return True
        self.cache.warm([1], lambda kind, gid: calls.append((kind, gid)) or {}, idle)
        duplicate = self.cache.warm([2], lambda *_: self.fail('Duplicate warmer'), lambda: True)
        self.assertTrue(duplicate['running'])
        self.assertEqual(calls, [])
        gate.set()
        for _ in range(400):
            if not self.cache.warm_state()['running']:
                break
            time.sleep(.01)
        self.assertEqual([gid for _, gid in calls], [1, 1])

    def test_warm_busy_pause_then_resume(self):
        checks = iter([False, True, True])
        states = []
        self.cache.warming = {'running': True, 'total': 2, 'done': 0, 'failed': 0, 'skipped': 0, 'paused': False}
        def fetch(key, loader):
            self.cache._refresh(key, loader)
            return {'cache': {'refreshing': False}}
        def sleep(seconds):
            if seconds == 60:
                states.append(self.cache.warm_state()['paused'])
        with patch.object(self.cache, 'fetch', fetch), patch('table_cache.time.sleep', sleep):
            self.cache._warm([1], lambda *_: {'scores': []}, lambda: next(checks))
        self.assertEqual(states, [True])
        self.assertEqual(self.cache.warm_state()['done'], 2)
        self.assertFalse(self.cache.warm_state()['running'])

    def test_payload_budget(self):
        self.cache.MAX_BYTES = 80
        for i in range(10):
            self.cache._refresh(str(i), lambda: {'value': 'example'})
        with self.cache.db() as db:
            self.assertLessEqual(db.execute('SELECT sum(length(CAST(data AS BLOB))) FROM cache').fetchone()[0], 80)


if __name__ == '__main__':
    unittest.main()
