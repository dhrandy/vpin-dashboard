"""Instructions file caching: saved copy served, file re-read only on change."""
import os
import sys
import tempfile
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'app'))
import server


class InstructionsCacheTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.path = os.path.join(self._tmp.name, 'instructions.md')
        self._old_path = server.INSTRUCTIONS_PATH
        server.INSTRUCTIONS_PATH = self.path
        server._INSTRUCTIONS_CACHE.clear()
        self.reads = 0
        self._old_read = server._read_instructions_file
        def counting():
            self.reads += 1
            return self._old_read()
        server._read_instructions_file = counting

    def tearDown(self):
        server.INSTRUCTIONS_PATH = self._old_path
        server._read_instructions_file = self._old_read
        server._INSTRUCTIONS_CACHE.clear()
        self._tmp.cleanup()

    def write(self, text, mtime=None):
        # Filesystem mtime granularity varies, so tests set mtimes explicitly.
        with open(self.path, 'w', encoding='utf-8') as handle:
            handle.write(text)
        self._mtime = getattr(self, '_mtime', 1_700_000_000_000_000_000) + 1_000_000_000
        os.utime(self.path, ns=(self._mtime, mtime if mtime is not None else self._mtime))

    def test_unchanged_file_served_from_cache(self):
        self.write('# Hello')
        self.assertEqual(server.read_instructions()['text'], '# Hello')
        self.assertEqual(server.read_instructions()['text'], '# Hello')
        self.assertEqual(self.reads, 1)

    def test_changed_mtime_triggers_reread(self):
        self.write('# One')
        server.read_instructions()
        self.write('# Two')
        self.assertEqual(server.read_instructions()['text'], '# Two')
        self.assertEqual(self.reads, 2)

    def test_same_mtime_and_size_keeps_saved_copy(self):
        self.write('# One')
        first_mtime = os.stat(self.path).st_mtime_ns
        server.read_instructions()
        self.write('# Two', mtime=first_mtime)
        self.assertEqual(server.read_instructions()['text'], '# One')
        self.assertEqual(self.reads, 1)

    def test_missing_file_cached_then_created_file_picked_up(self):
        result = server.read_instructions()
        self.assertTrue(result['ok'])
        self.assertFalse(result['configured'])
        self.assertEqual(server.read_instructions(), result)
        self.assertEqual(self.reads, 1)
        self.write('# New')
        self.assertEqual(server.read_instructions()['text'], '# New')

    def test_deleted_file_returns_to_unconfigured(self):
        self.write('# One')
        self.assertTrue(server.read_instructions()['configured'])
        os.unlink(self.path)
        result = server.read_instructions()
        self.assertFalse(result['configured'])

    def test_oversize_file_error_cached_until_file_changes(self):
        self.write('x' * 70000)
        result = server.read_instructions()
        self.assertFalse(result['ok'])
        self.assertEqual(server.read_instructions(), result)
        self.assertEqual(self.reads, 1)
        self.write('# Small')
        self.assertTrue(server.read_instructions()['ok'])

    def test_returned_copy_does_not_poison_cache(self):
        self.write('# Hello')
        server.read_instructions()['text'] = 'mutated'
        self.assertEqual(server.read_instructions()['text'], '# Hello')


if __name__ == '__main__':
    unittest.main()
