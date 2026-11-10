"""Synthetic per-account stats section visibility checks."""
import http.client
import json
from pathlib import Path
import secrets
import sys
import tempfile
import threading
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'app'))
import server as s
from auth import AuthStore
from collector import Collector


class StatsSectionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.old = (s.AUTH, s.AUTH_DIR, s.COLLECTOR, s._TABLE_CACHE)
        s.AUTH_DIR = cls.tmp.name
        s.AUTH = AuthStore(cls.tmp.name)
        password = secrets.token_urlsafe(24)
        s.AUTH.create_user({'username': 'reader', 'password': password, 'role': 'viewer'})
        cls.viewer = s.AUTH.login('reader', password, 'viewer')
        cls.csrf = s.AUTH.session(cls.viewer)['csrf']
        s.COLLECTOR = Collector(str(Path(cls.tmp.name) / 'history'), lambda: {}, lambda: {})
        s._TABLE_CACHE = None
        cls.web = s.LimitedServer(('127.0.0.1', 0), s.Handler)
        threading.Thread(target=cls.web.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.web.shutdown(); cls.web.server_close()
        s.AUTH, s.AUTH_DIR, s.COLLECTOR, s._TABLE_CACHE = cls.old
        cls.tmp.cleanup()

    def request(self, path, method='GET', body=None, cookie=None, csrf=None):
        h = {}
        if cookie: h['Cookie'] = '__Host-vpin_session=' + cookie
        if csrf: h['X-CSRF-Token'] = csrf
        if body is not None:
            if not isinstance(body, str): body = json.dumps(body)
            h['Content-Type'] = 'application/json'
        c = http.client.HTTPConnection('127.0.0.1', self.web.server_port, timeout=5)
        c.request(method, path, body=body, headers=h)
        r = c.getresponse(); result = (r.status, json.loads(r.read())); c.close()
        return result

    def setUp(self):
        for section in AuthStore.STATS_SECTIONS:
            s.AUTH.set_stats_section(1, section, False)

    def test_round_trip_and_persistence(self):
        code, data = self.request('/api/stats-sections', cookie=self.viewer)
        self.assertEqual((code, data), (200, {'ok': True, 'hidden': []}))
        code, data = self.request('/api/stats-sections', 'POST', {'section': 'players', 'hidden': True}, self.viewer, self.csrf)
        self.assertEqual((code, data), (200, {'ok': True, 'hidden': ['players']}))
        self.assertEqual(AuthStore(self.tmp.name).stats_sections(1), ['players'])
        code, data = self.request('/api/stats-sections', 'POST', {'section': 'players', 'hidden': False}, self.viewer, self.csrf)
        self.assertEqual((code, data), (200, {'ok': True, 'hidden': []}))

    def test_validation(self):
        for body in [{'section': 'nope', 'hidden': True}, {'section': 'players', 'hidden': 'yes'},
                     {'section': 'players'}, {'section': 'players', 'hidden': True, 'extra': 1}, {}]:
            self.assertEqual(self.request('/api/stats-sections', 'POST', body, self.viewer, self.csrf)[0], 400, body)
        self.assertEqual(self.request('/api/stats-sections')[0], 401)
        self.assertEqual(self.request('/api/stats-sections', 'POST', {'section': 'players', 'hidden': True}, self.viewer)[0], 403)

    def test_per_user_isolation(self):
        s.AUTH.create_user({'username': 'other', 'password': secrets.token_urlsafe(24), 'role': 'viewer'})
        s.AUTH.set_stats_section(2, 'makers', True)
        code, data = self.request('/api/stats-sections', cookie=self.viewer)
        self.assertEqual(data['hidden'], [])


if __name__ == '__main__':
    unittest.main()
