"""Local night isolation, optimistic updates, and strict import parsing."""
import json
from pathlib import Path
import sys
import tempfile
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'app'))
from auth import AuthStore, AuthError
import game_night as gn

class NightTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.store=AuthStore(self.tmp.name)
        self.tables=[{'gameId':1,'name':'Test Table (Bally 1992) Author v1.0','maker':'Bally','year':1992},
                     {'gameId':2,'name':'Other Table','maker':'Williams','year':1980}]
    def test_state_persistence_and_isolation(self):
        self.assertTrue(gn.read(self.store,1)['enabled'])
        body={'action':'new','revision':0,'theme':'random','maker':'','ids':[1,2]}
        gn.update(self.store,1,body)
        with self.assertRaises(AuthError) as e:gn.update(self.store,1,body)
        self.assertEqual(e.exception.status,409)
        d=gn.update(self.store,1,{'action':'check','revision':1,'id':1,'checked':True})
        self.assertEqual(d['night']['checked'],[1]);self.assertIsNone(gn.read(self.store,2)['night'])
        self.assertEqual(gn.read(AuthStore(self.tmp.name),1)['night']['checked'],[1])
        d=gn.update(self.store,1,{'action':'check','revision':2,'id':1,'checked':False})
        self.assertEqual(d['night']['checked'],[])
    def test_caps_do_not_replace_active_night(self):
        self.assertEqual(gn.read(self.store,1)['cap'],10)
        night=gn.update(self.store,1,{'action':'new','revision':0,'theme':'random','maker':'','ids':[1,2]})
        night=gn.update(self.store,1,{'action':'check','revision':1,'id':1,'checked':True})
        for cap in (15,20,10):
            next_state=gn.update(self.store,1,{'action':'cap','revision':night['revision'],'cap':cap})
            self.assertEqual(next_state['night'],night['night'])
            self.assertEqual(next_state['cap'],cap)
            night=next_state
        for cap in (0,11,30,True,'20'):
            with self.assertRaises(AuthError):gn.update(self.store,1,{'action':'cap','revision':night['revision'],'cap':cap})
        night=gn.update(self.store,1,{'action':'cap','revision':night['revision'],'cap':20})
        night=gn.update(self.store,1,{'action':'new','revision':night['revision'],'theme':'random','maker':'','ids':list(range(1,21))})
        self.assertEqual(len(night['night']['ids']),20)
        self.assertEqual(night['night']['checked'],[])
        self.assertEqual(gn.read(AuthStore(self.tmp.name),1)['cap'],20)

    def test_settings_and_invalid_actions(self):
        d=gn.update(self.store,1,{'action':'settings','revision':0,'enabled':False,'showImports':False,'hiddenThemes':['random']})
        self.assertFalse(d['enabled']);self.assertEqual(d['hiddenThemes'],['random'])
        for ids in [[],[1,1],list(range(1,12)),[True],[-1],['1']]:
            with self.assertRaises(AuthError):gn.update(self.store,1,{'action':'new','revision':1,'theme':'random','maker':'','ids':ids})
        with self.assertRaises(AuthError):gn.update(self.store,1,{'action':'settings','revision':1,'enabled':True,'showImports':True,'hiddenThemes':['nope']})
    def test_import_roundtrip_edit_and_delete(self):
        source='My night\nTest Table\nMissing table'
        b={'action':'preview','id':None,'revision':0,'source':source}
        p=gn.save_custom(self.store,b,self.tables);self.assertEqual(p['gameIds'],[1]);self.assertEqual(p['report'][1]['status'],'not found')
        self.assertEqual(gn.custom(self.store),[])
        b['action']='save';result=gn.save_custom(self.store,b,self.tables)
        self.assertEqual(len(gn.custom(self.store)),1)
        t=gn.custom(self.store)[0]
        b.update(id=result['id'],revision=t['revision'],source='Renamed\nOther Table')
        gn.save_custom(self.store,b,self.tables)
        with self.assertRaises(AuthError):gn.save_custom(self.store,b,self.tables)
        gn.delete_custom(self.store,{'action':'delete','id':result['id'],'revision':2})
        self.assertEqual(gn.custom(self.store),[])
    def test_ambiguity_and_metadata(self):
        tables=self.tables+[dict(self.tables[0],gameId=3,maker='Stern',year=2007)]
        t=gn.parse_import('Test night\nTest Table')
        self.assertEqual(gn.resolve(t,tables)['report'][0]['status'],'ambiguous')
        t=gn.parse_import(json.dumps({'name':'Test night','tables':[{'name':'Test Table','maker':'Bally','year':1992}]}))
        self.assertEqual(gn.resolve(t,tables)['gameIds'],[1])
    def test_import_validation(self):
        invalid=['a','a\n<script>','<b>\ntable','a\nTest\nTest','x'*32769,'{"name":"x","tables":[],"extra":1}',
            json.dumps({'name':'x','tables':['x']*101}),json.dumps({'name':'x','tables':[{'name':'t','year':True}]}),
            json.dumps({'name':'x','tables':[{'name':'t','other':'no'}]})]
        for source in invalid:
            with self.subTest(source=source[:80]):
                with self.assertRaises(AuthError):gn.parse_import(source)


# HTTP-level checks include viewer permissions, CSRF, and shared imports.
from test_stats_sections import StatsSectionTests
class NightAPITests(StatsSectionTests):
    def setUp(self):
        super().setUp()
        with self.store_db() as db:
            db.execute('DELETE FROM game_nights');db.execute('DELETE FROM night_themes')
    def store_db(self):
        import server
        return server.AUTH.db()
    def test_viewer_night_and_admin_only_imports(self):
        import server
        with server.COLLECTOR.db() as db:
            server.COLLECTOR.put(db,'latest_library',{'at':server.COLLECTOR.clock(),'data':{'ok':True,'tables':[{'gameId':1,'name':'Test table','maker':'Bally','year':1992}]}})
        body={'action':'new','revision':0,'theme':'random','maker':'','ids':[1]}
        self.assertEqual(self.request('/api/game-night','POST',body,self.viewer,self.csrf)[0],200)
        self.assertEqual(self.request('/api/game-night','POST',body,self.viewer,self.csrf)[0],409)
        self.assertEqual(self.request('/api/game-night','POST',body,self.viewer)[0],403)
        body={'action':'preview','id':None,'revision':0,'source':'Night\nTest table'}
        self.assertEqual(self.request('/api/night-themes','POST',body,self.viewer,self.csrf)[0],403)
        server.AUTH.create_user({'username':'manager','password':'test-password-very-long','role':'admin'})
        admin=server.AUTH.login('manager','test-password-very-long','manager')
        token=server.AUTH.session(admin)['csrf']
        self.assertEqual(self.request('/api/night-themes','POST',body,admin,token)[1]['gameIds'],[1])
        body['action']='save'
        result=self.request('/api/night-themes','POST',body,admin,token)
        self.assertEqual(result[0],200)
        items=self.request('/api/night-themes',cookie=self.viewer)[1]['themes']
        self.assertEqual(len(items),1);self.assertNotIn('source',items[0]);self.assertNotIn('revision',items[0])
        delete={'action':'delete','id':result[1]['id'],'revision':1}
        self.assertEqual(self.request('/api/night-themes','POST',delete,self.viewer,self.csrf)[0],403)
        self.assertEqual(self.request('/api/night-themes','POST',delete,admin,token)[0],200)
        self.assertEqual(self.request('/api/game-night',cookie=admin)[1]['night'],None)

if __name__ == "__main__":
    unittest.main()
