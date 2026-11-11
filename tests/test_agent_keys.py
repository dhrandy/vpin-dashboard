"""Agent API key access. Local HTTP and store tests; no live cabinet."""
import http.client
import json
from pathlib import Path
import secrets
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'app'))
import server as s
from auth import AuthStore,AuthError
from collector import Collector

LIBRARY={'ok':True,'tables':[{'gameId':11,'name':'Wheel of Fortune'},{'gameId':22,'name':'Jeopardy!'}],'scores':[],'playlists':[{'id':5,'name':'Favorites','gameIds':[11]}]}

class AgentKeyHttpTests(unittest.TestCase):
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
        with s.COLLECTOR.db() as db:
            s.COLLECTOR._record(db,'library',LIBRARY,time.time())
        s._TABLE_CACHE=None
        cls.web=s.LimitedServer(('127.0.0.1',0),s.Handler)
        threading.Thread(target=cls.web.serve_forever,daemon=True).start()
        _,cls.key=s.AUTH.create_agent_key('tests')
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
    def agent(self,path,method='GET',body=None,key=None):
        return self.request(path,method,body,headers={'X-Api-Key':key if key is not None else self.key})
    def test_agent_reads_saved_library_with_snapshot_age(self):
        code,_,data=self.agent('/api/library')
        self.assertEqual(code,200)
        payload=json.loads(data)
        self.assertEqual([t['name'] for t in payload['tables']],['Wheel of Fortune','Jeopardy!'])
        self.assertEqual(payload['playlists'][0]['name'],'Favorites')
        self.assertTrue(payload['collection']['saved'])
        self.assertGreater(payload['collection']['capturedAt'],0)
    def test_agent_reads_status_and_themes(self):
        self.assertEqual(self.agent('/api/status')[0],200)
        code,_,data=self.agent('/api/night-themes')
        self.assertEqual(code,200)
        self.assertEqual(json.loads(data)['themes'],[])
    def test_agent_key_cannot_reach_other_reads(self):
        for path in ['/api/details/11','/api/scorehistory/11','/api/thumb/11','/api/admin/users','/api/admin/agent-keys','/api/collection','/api/preferences','/api/favourites','/app.js','/']:
            self.assertEqual(self.agent(path)[0],404,path)
    def test_agent_key_cannot_write_outside_playlists(self):
        for path in ['/api/play','/api/exit','/api/preferences','/api/hidden','/api/favourites','/api/admin/users','/api/admin/agent-keys','/api/collection','/api/settings','/api/game-night','/api/night-themes','/api/cache-thumbs','/api/modal-cache','/api/status/dismiss','/api/auth/logout']:
            code,_,_=self.agent(path,'POST',{})
            self.assertIn(code,(401,404),path)
    def test_no_or_bad_key_rejected(self):
        self.assertEqual(self.request('/api/agent/playlists','POST',{'name':'x'})[0],401)
        code,_,data=self.agent('/api/library',key='vpk_wrong')
        self.assertEqual(code,401)
        self.assertEqual(self.agent('/api/agent/playlists','POST',{'name':'x'},key='vpk_wrong')[0],401)
    def test_revoked_key_stops_working(self):
        key_id,key=s.AUTH.create_agent_key('temp')
        self.assertEqual(self.agent('/api/library',key=key)[0],200)
        s.AUTH.revoke_agent_key(key_id)
        self.assertEqual(self.agent('/api/library',key=key)[0],401)
    def test_admin_key_management(self):
        self.assertEqual(self.request('/api/admin/agent-keys',cookie=self.viewer)[0],403)
        self.assertEqual(self.request('/api/admin/agent-keys')[0],401)
        self.assertEqual(self.request('/api/admin/agent-keys','POST',{'label':'x'},self.viewer,self.vcsrf)[0],403)
        code,_,data=self.request('/api/admin/agent-keys','POST',{'label':'from admin'},self.admin,self.csrf)
        self.assertEqual(code,201)
        created=json.loads(data)
        self.assertTrue(created['key'].startswith('vpk_'))
        code,_,data=self.request('/api/admin/agent-keys',cookie=self.admin)
        listing=json.loads(data)['keys']
        entry=[k for k in listing if k['id']==created['id']][0]
        self.assertEqual(entry['label'],'from admin')
        self.assertNotIn('key',entry)
        self.assertNotIn('key_hash',entry)
        self.assertNotIn(created['key'],json.dumps(listing))
        self.assertEqual(self.request(f"/api/admin/agent-keys/{created['id']}",'POST',{'revoked':True},self.admin,self.csrf)[0],200)
        self.assertEqual(self.agent('/api/library',key=created['key'])[0],401)
    def test_admin_key_validation(self):
        for body in [{},{'label':''},{'label':'   '},{'label':'x'*41},{'label':'a\tb'}]:
            self.assertEqual(self.request('/api/admin/agent-keys','POST',body,self.admin,self.csrf)[0],400,body)
        self.assertEqual(self.request('/api/admin/agent-keys/999','POST',{'revoked':True},self.admin,self.csrf)[0],404)
        self.assertEqual(self.request('/api/admin/agent-keys/1','POST',{},self.admin,self.csrf)[0],400)
    def test_playlist_create_validates_and_forwards_minimum(self):
        with patch.object(s,'bridge',return_value={'ok':True,'result':{'id':7,'name':'Game Shows'}}) as upstream:
            code,_,data=self.agent('/api/agent/playlists','POST',{'name':'Game Shows'})
            self.assertEqual(code,200)
            self.assertEqual(json.loads(data)['playlist'],{'id':7,'name':'Game Shows'})
            args,kwargs=upstream.call_args
            self.assertEqual(args[:2],('POST','/api/playlists/save'))
            self.assertEqual(args[2],{'id':-1,'name':'Game Shows'})
        with patch.object(s,'bridge',side_effect=AssertionError('Unexpected upstream')) as upstream:
            for body in [{},{'name':''},{'name':'  '},{'name':'x'*61},{'name':'a\nb'},{'name':'ok','id':5},{'name':5}]:
                self.assertEqual(self.agent('/api/agent/playlists','POST',body)[0],400,body)
            upstream.assert_not_called()
    def test_playlist_rename_requires_known_playlist(self):
        with patch.object(s,'bridge',return_value={'ok':True,'result':{'id':5,'name':'New'}}) as upstream:
            self.assertEqual(self.agent('/api/agent/playlists/5','POST',{'name':'New'})[0],200)
            args,_=upstream.call_args
            self.assertEqual(args[2],{'id':5,'name':'New'})
            self.assertEqual(self.agent('/api/agent/playlists/999','POST',{'name':'New'})[0],404)
    def test_playlist_table_add_and_remove(self):
        with patch.object(s,'bridge',return_value={'ok':True}) as upstream:
            self.assertEqual(self.agent('/api/agent/playlists/5/tables','POST',{'gameId':22,'action':'add'})[0],200)
            self.assertEqual(upstream.call_args[0][:2],('POST','/api/playlists/5/22'))
            self.assertEqual(self.agent('/api/agent/playlists/5/tables','POST',{'gameId':22,'action':'remove'})[0],200)
            self.assertEqual(upstream.call_args[0][:2],('DELETE','/api/playlists/5/22'))
        with patch.object(s,'bridge',side_effect=AssertionError('Unexpected upstream')) as upstream:
            for body in [{'gameId':22},{'action':'add'},{'gameId':22,'action':'delete'},{'gameId':'22','action':'add'},{'gameId':True,'action':'add'},{'gameId':0,'action':'add'},{'gameId':22,'action':'add','extra':1}]:
                self.assertEqual(self.agent('/api/agent/playlists/5/tables','POST',body)[0],400,body)
            self.assertEqual(self.agent('/api/agent/playlists/5/tables','POST',{'gameId':999,'action':'add'})[0],404)
            self.assertEqual(self.agent('/api/agent/playlists/999/tables','POST',{'gameId':22,'action':'add'})[0],404)
            upstream.assert_not_called()
    def test_bridge_failure_is_reported(self):
        import urllib.error
        with patch.object(s,'bridge',side_effect=urllib.error.HTTPError('u',500,'e',{},None)):
            self.assertEqual(self.agent('/api/agent/playlists','POST',{'name':'Game Shows'})[0],502)
        with patch.object(s,'bridge',side_effect=ConnectionError('down')):
            self.assertEqual(self.agent('/api/agent/playlists','POST',{'name':'Game Shows'})[0],502)

class AgentKeyStoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.store=AuthStore(self.tmp.name)
    def tearDown(self):
        self.tmp.cleanup()
    def test_wrong_key_lockout_counts_only_bad_keys(self):
        key_id,key=self.store.create_agent_key('lockout')
        for _ in range(30):
            with self.assertRaises(AuthError) as ctx:
                self.store.agent_key('vpk_bad','10.0.0.9')
            self.assertEqual(ctx.exception.status,401)
        with self.assertRaises(AuthError) as ctx:
            self.store.agent_key('vpk_bad','10.0.0.9')
        self.assertEqual(ctx.exception.status,429)
        # A valid key is never throttled, even from the same locked-out IP.
        self.assertEqual(self.store.agent_key(key,'10.0.0.9')['id'],key_id)
    def test_write_throttle_allows_then_blocks(self):
        key_id,_=self.store.create_agent_key('writes')
        for _ in range(60):
            self.store.agent_write_throttle(key_id)
        with self.assertRaises(AuthError) as ctx:
            self.store.agent_write_throttle(key_id)
        self.assertEqual(ctx.exception.status,429)
    def test_key_material_only_returned_at_creation(self):
        key_id,key=self.store.create_agent_key('secret')
        listing=self.store.list_agent_keys()
        self.assertNotIn(key,json.dumps(listing))
        digest=[r for r in listing if r['id']==key_id]
        self.assertTrue(digest)
    def test_key_limit(self):
        for i in range(self.store.AGENT_KEY_LIMIT):
            self.store.create_agent_key('k'+str(i))
        with self.assertRaises(AuthError):
            self.store.create_agent_key('over')
    def test_revoke_then_create_frees_slot(self):
        ids=[]
        for i in range(self.store.AGENT_KEY_LIMIT):
            key_id,_=self.store.create_agent_key('k'+str(i));ids.append(key_id)
        self.store.revoke_agent_key(ids[0])
        self.store.create_agent_key('again')

if __name__=='__main__':
    unittest.main()
