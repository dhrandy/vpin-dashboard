"""Synthetic interrupted-sync tests. No live cabinet, process or account work."""
import io
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'app'))
import server
from collector import Collector
from table_cache import TableCache


class Interruptions(unittest.TestCase):
    def setUp(self):
        self.directory=tempfile.TemporaryDirectory()
        self.cache=TableCache(self.directory.name)
        self.cache._refresh('details/1',lambda:{'details':{'author':'Last good'}})

    def tearDown(self):
        self.directory.cleanup()

    def kill_writer(self,path,statement,args):
        # Terminate after SQLite has changed pages but before commit. This
        # models a dashboard process stop, not physical disk failure.
        script='''import sqlite3,sys,json,time
p,sql,args=json.loads(sys.argv[1])
db=sqlite3.connect(p)
db.execute('PRAGMA synchronous=FULL')
db.execute('BEGIN IMMEDIATE')
db.execute(sql,args)
print('uncommitted',flush=True)
time.sleep(60)
'''
        child=subprocess.Popen([sys.executable,'-c',script,json.dumps([path,statement,args])],stdout=subprocess.PIPE,text=True)
        try:
            self.assertEqual(child.stdout.readline().strip(),'uncommitted')
            child.kill();child.wait(timeout=5)
        finally:
            if child.poll() is None:child.kill();child.wait()
            child.stdout.close()
        with sqlite3.connect(path) as db:
            self.assertEqual(db.execute('PRAGMA integrity_check').fetchone()[0],'ok')

    def test_killed_cache_writer_recovers_old_value(self):
        self.kill_writer(self.cache.path,'UPDATE cache SET data=? WHERE key=?',['{"details":{"author":"Partial"}}','details/1'])
        self.assertEqual(TableCache(self.directory.name).read('details/1')[0]['details']['author'],'Last good')

    def test_killed_snapshot_writer_recovers_old_value(self):
        root=Path(self.directory.name)/'collector'
        collector=Collector(str(root),lambda:{},lambda:{})
        with collector.db() as db:
            collector._record(db,'library',{'ok':True,'tables':[{'gameId':1}],'scores':[]},1)
        self.kill_writer(collector.path,'UPDATE state SET value=? WHERE key=?',['{"at":2,"data":{"ok":true,"tables":[]}}','latest_library'])
        reopened=Collector(str(root),lambda:{},lambda:{})
        self.assertEqual(reopened.library()['tables'],[{'gameId':1}])

    def test_transaction_failure_after_cache_insert_rolls_back(self):
        with self.cache.db() as db:
            db.execute("CREATE TRIGGER fail_update BEFORE INSERT ON cache BEGIN SELECT RAISE(ABORT,'fixture'); END")
        self.cache._refresh('details/1',lambda:{'details':{'author':'New'}})
        self.assertEqual(self.cache.read('details/1')[0]['details']['author'],'Last good')

    def test_truncated_json_and_timeout_keep_old_cache(self):
        for failure in [json.JSONDecodeError('truncated','{"details":',11),TimeoutError('fixture')]:
            def load():raise failure
            self.cache._refresh('details/1',load)
            self.assertEqual(self.cache.read('details/1')[0]['details']['author'],'Last good')

    def test_malformed_history_never_replaces_good(self):
        self.cache._refresh('scorehistory/1',lambda:{'scores':[{'createdAt':'2026-01-01T00:00:00Z','scores':[{'score':100}]}]})
        for malformed in [{'scores':[None]},{'scores':[{'scores':None}]},{'scores':[{'scores':[None]}]}, {'raw':'incomplete'}]:
            def bridge(method,path,**kwargs):return {'gameId':0} if path=='/api/status' else malformed
            with patch.object(server,'bridge',bridge):
                self.cache._refresh('scorehistory/1',lambda:server.modal_read('scorehistory',1))
            self.assertEqual(self.cache.read('scorehistory/1')[0]['scores'][0]['scores'][0]['score'],100)

    def test_cut_image_never_replaces_preview(self):
        card=Path(self.directory.name)/'card.jpg';detail=Path(self.directory.name)/'detail.jpg'
        card.write_bytes(b'last-good-card');detail.write_bytes(b'last-good-detail')
        with patch.object(server,'_ensure_pillow',lambda:True):
            self.assertFalse(server._store_normalized(str(card),str(detail),b'\x89PNG\r\n\x1a\ncut'))
        self.assertEqual(card.read_bytes(),b'last-good-card')
        self.assertEqual(detail.read_bytes(),b'last-good-detail')

    def test_analytics_cut_aborts_whole_snapshot(self):
        def good(method,path,**kwargs):
            return {'/api/games/json':[{'id':1,'gameDisplayName':'Example'}],'/api/games':{'raw':'id;gameDisplayName\n1;Example\n'},'/api/highscores':{'highscores':[]},'/api/playlists':[],'/api/analytics':{'ok':True,'entries':[{'gameId':1,'timePlayedSecs':123}]}}[path]
        with patch.object(server,'bridge',good):
            saved=server.library_payload(strict=True)
        collector=Collector(str(Path(self.directory.name)/'stats'),lambda:{'health':{'cabinet_reachable':True},'status':{'gameId':0}},lambda:saved,clock=lambda:1000)
        collector.step()
        for failure in [TimeoutError(),json.JSONDecodeError('cut','{',1),ValueError('Malformed analytics')]:
            def cut(method,path,**kwargs):
                if path=='/api/analytics':raise failure
                return good(method,path,**kwargs)
            collector.next_status=0;collector.catch_up=True;collector.get_library=lambda:server.library_payload(strict=True)
            with patch.object(server,'bridge',cut):
                self.assertFalse(collector.step())
            self.assertEqual(collector.library()['tables'][0]['timePlayedSecs'],123)


if __name__=='__main__':unittest.main()
