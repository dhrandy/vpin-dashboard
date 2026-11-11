"""Local hostile HTTP requests. No live services or cabinet actions."""
import http.client
import io
import json
from pathlib import Path
import secrets
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'app'))
import server as s
from auth import AuthStore,AuthError
from collector import Collector

class SecurityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp=tempfile.TemporaryDirectory()
        cls.old=(s.AUTH,s.AUTH_DIR,s.COLLECTOR,s._TABLE_CACHE)
        s.AUTH_DIR=cls.tmp.name;s.AUTH=AuthStore(cls.tmp.name)
        password=secrets.token_urlsafe(24)
        s.AUTH.setup({'username':'owner','password':password,'setupToken':Path(s.AUTH.setup_path).read_text()},'setup')
        s.AUTH.create_user({'username':'reader','password':password,'role':'viewer'})
        cls.admin=s.AUTH.login('owner',password,'admin');cls.viewer=s.AUTH.login('reader',password,'viewer')
        cls.csrf=s.AUTH.session(cls.admin)['csrf'];cls.vcsrf=s.AUTH.session(cls.viewer)['csrf']
        s.COLLECTOR=Collector(str(Path(cls.tmp.name)/'history'),lambda:{},lambda:{})
        s._TABLE_CACHE=None
        cls.web=s.LimitedServer(('127.0.0.1',0),s.Handler)
        threading.Thread(target=cls.web.serve_forever,daemon=True).start()
    @classmethod
    def tearDownClass(cls):
        cls.web.shutdown();cls.web.server_close()
        s.AUTH,s.AUTH_DIR,s.COLLECTOR,s._TABLE_CACHE=cls.old
        cls.tmp.cleanup()
    def request(self,path,method='GET',body=None,cookie=None,csrf=None,headers=None):
        h={}
        if cookie:h['Cookie']='__Host-vpin_session='+cookie
        if csrf:h['X-CSRF-Token']=csrf
        if body is not None:
            if not isinstance(body,str):body=json.dumps(body)
            h['Content-Type']='application/json'
        h.update(headers or {})
        c=http.client.HTTPConnection('127.0.0.1',self.web.server_port,timeout=5)
        c.request(method,path,body=body,headers=h);r=c.getresponse();result=(r.status,dict(r.getheaders()),r.read());c.close();return result
    def test_private_reads_and_traversal_require_login(self):
        for path in ['/api/library','/api/status','/api/preferences','/api/favourites','/api/details/1','/api/scorehistory/1','/api/thumb/1','/api/settings','/api/settings/logo','/api/admin/users','/api/collection','/app.js','/pwa.js','/../auth/users.sqlite3','/%2e%2e/auth/users.sqlite3']:
            self.assertEqual(self.request(path)[0],401,path)
    def test_public_pwa_has_only_generic_metadata(self):
        for path in ['/manifest.webmanifest','/sw.js','/pwa-icon-192.png?v=2','/pwa-icon-512.png?v=2']:
            code,h,data=self.request(path);self.assertEqual(code,200)
            self.assertEqual(h['Cache-Control'],'private, no-store')
            for secret in [self.admin.encode(),self.csrf.encode(),b'owner',b'reader']:self.assertNotIn(secret,data)
        worker=self.request('/sw.js')[2]
        self.assertNotIn(b'caches.',worker);self.assertNotIn(b'respondWith',worker)
    def test_viewers_cannot_mutate_cabinet_or_admin(self):
        with patch.object(s,'bridge',side_effect=AssertionError('Unexpected upstream')) as upstream:
            for path in ['/api/exit','/api/play','/api/modal-cache','/api/cache-thumbs','/api/settings','/api/admin/users','/api/collection','/api/status/dismiss']:
                self.assertEqual(self.request(path,'POST',{},self.viewer,self.vcsrf)[0],403,path)
            upstream.assert_not_called()
        for path in ['/api/admin/users','/api/collection']:self.assertEqual(self.request(path,cookie=self.viewer)[0],403)
    def test_csrf_and_cross_origin_blocked(self):
        for path in ['/api/play','/api/exit','/api/preferences','/api/auth/logout']:
            self.assertEqual(self.request(path,'POST',{},self.admin)[0],403)
            self.assertEqual(self.request(path,'POST',{},self.admin,'wrong')[0],403)
            self.assertEqual(self.request(path,'POST',{},self.admin,self.csrf,{'Sec-Fetch-Site':'cross-site'})[0],403)
        for path in ['/api/auth/login','/api/auth/setup']:
            self.assertEqual(self.request(path,'POST',{})[0],403)
            self.assertEqual(self.request(path,'POST',{},headers={'X-Vpin-Request':'1','Sec-Fetch-Site':'cross-site'})[0],403)
    def test_framing_and_json_limits(self):
        for headers,status in [({'Transfer-Encoding':'chunked'},400),({'Content-Length':'200001'},413),({'Content-Type':'text/plain'},415)]:
            self.assertEqual(self.request('/api/preferences','POST',{},self.viewer,self.vcsrf,headers)[0],status)
        for body in ['[]','null','{broken']:
            self.assertEqual(self.request('/api/preferences','POST',body,self.viewer,self.vcsrf)[0],400)
    def test_preference_user_isolation_and_types(self):
        for body in [{'backToTop':'false'},{'backToTop':0},{'backToTop':False,'userId':1}]:
            self.assertEqual(self.request('/api/preferences','POST',body,self.viewer,self.vcsrf)[0],400)
        self.assertEqual(self.request('/api/preferences','POST',{'backToTop':False},self.viewer,self.vcsrf)[0],200)
        self.assertFalse(json.loads(self.request('/api/preferences',cookie=self.viewer)[2])['backToTop'])
        self.assertTrue(json.loads(self.request('/api/preferences',cookie=self.admin)[2])['backToTop'])
    def test_favorites_ids_and_user_injection(self):
        for body in [{'gameId':True,'saved':True},{'gameId':1,'saved':True,'userId':1}]:
            self.assertEqual(self.request('/api/favourites','POST',body,self.viewer,self.vcsrf)[0],400)
        self.assertEqual(self.request('/api/favourites','POST',{'gameId':1,'saved':True},self.viewer,self.vcsrf)[0],404)
    def test_unknown_table_reads_never_touch_upstream(self):
        with patch.object(s,'bridge',side_effect=AssertionError('Unexpected upstream')) as upstream:
            for kind in ['details','scorehistory','thumb']:
                self.assertEqual(self.request('/api/'+kind+'/123',cookie=self.viewer)[0],404)
            upstream.assert_not_called()
    def test_exit_disabled_never_touches_upstream(self):
        with patch.object(s,'bridge',side_effect=AssertionError('Exit must not reach an old bridge')) as upstream:
            for body in [{}, {'gameId':12,'started':'2026-01-01T00:00:00+00:00'}]:
                code,_,data=self.request('/api/exit','POST',body,self.admin,self.csrf)
                self.assertEqual(code,503)
                self.assertIn(b'physical Exit button',data)
            upstream.assert_not_called()
    def test_control_serialized(self):
        s._CONTROL_LOCK.acquire()
        try:
            for path in ['/api/play','/api/exit']:self.assertEqual(self.request(path,'POST',{},self.admin,self.csrf)[0],409)
        finally:s._CONTROL_LOCK.release()
    def test_cookie_and_security_headers(self):
        code,h,data=self.request('/api/auth/status')
        for k in ['Content-Security-Policy','X-Frame-Options','X-Content-Type-Options','Strict-Transport-Security']:self.assertIn(k,h)
        self.assertNotIn('Python',h['Server']);self.assertNotIn('Access-Control-Allow-Origin',h)
        self.assertIsNone(json.loads(data)['user'])
        self.assertEqual(self.request('/api/auth/status',cookie=self.admin+'forged')[0],200)
        self.assertIsNone(json.loads(self.request('/api/auth/status',cookie=self.admin+'forged')[2])['user'])
    def test_privacy_redaction_and_field_allowlist(self):
        for secret in ['http://private.invalid/data','C:\\private\\tables','192.0.2.10','password=fixture']:
            self.assertEqual(s.public_text(secret),'[Private field hidden]')
        with patch.object(s,'bridge',side_effect=[{'gameId':0},{'author':'Example','password':'hidden','privatePath':'hidden'}]):
            self.assertEqual(s.modal_read('details',1),{'ok':True,'details':{'author':'Example'}})
    def test_login_race_cannot_mint_session_after_password_reset(self):
        with tempfile.TemporaryDirectory() as folder:
            store=AuthStore(folder);password=secrets.token_urlsafe(24)
            store.setup({'username':'owner','password':password,'setupToken':Path(store.setup_path).read_text()},'setup')
            def verify(candidate,record):
                with store.db() as db:db.execute("UPDATE users SET password='changed-after-verification'");db.execute('DELETE FROM sessions')
                return True
            with patch.object(store,'verify_password',verify):
                with self.assertRaises(AuthError):store.login('owner',password,'race')
            with store.db() as db:self.assertEqual(db.execute('SELECT count(*) FROM sessions').fetchone()[0],0)
    def test_disabled_account_cannot_finish_inflight_login(self):
        with tempfile.TemporaryDirectory() as folder:
            store=AuthStore(folder);password=secrets.token_urlsafe(24)
            store.setup({'username':'owner','password':password,'setupToken':Path(store.setup_path).read_text()},'setup')
            def verify(candidate,record):
                with store.db() as db:db.execute('UPDATE users SET active=0');db.execute('DELETE FROM sessions')
                return True
            with patch.object(store,'verify_password',verify):
                with self.assertRaises(AuthError):store.login('owner',password,'race')
            with store.db() as db:self.assertEqual(db.execute('SELECT count(*) FROM sessions').fetchone()[0],0)
if __name__=='__main__':unittest.main()
