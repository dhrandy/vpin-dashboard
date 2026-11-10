import sys,tempfile,unittest,threading,os,json,sqlite3
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'app'))
from collector import Collector

class Tests(unittest.TestCase):
 def setUp(self):
  self.t=1000000.;self.calls=[];self.state={'health':{'cabinet_reachable':True,'game_playing':False},'status':{'gameId':0,'started':None}}
  self.data={'ok':True,'tables':[{'gameId':1,'playCount':0}],'scores':[],'playlists':[]}
  self.c=Collector(tempfile.mkdtemp(),self.status,self.library,clock=lambda:self.t)
 def status(self):self.calls.append('status');return self.state
 def library(self):self.calls.append('library');return self.data
 def advance(self,n=60):self.t+=n
 def test_cadence_dedupe(self):
  self.assertTrue(self.c.step());self.assertEqual(self.calls,['status','library'])
  self.c.step();self.assertEqual(len(self.calls),2)
  for _ in range(5):self.advance();self.c.step()
  self.assertEqual(self.calls.count('status'),6);self.assertEqual(self.calls.count('library'),2)
  self.assertEqual(self.c.summary()['historyCounts'],{'library':1,'status':1})
 def test_busy_then_idle(self):
  self.state['status']['gameId']=1;self.state['health']['game_playing']=True
  self.c.step();self.assertNotIn('library',self.calls)
  self.advance();self.state['status']['gameId']=0;self.state['health']['game_playing']=False;self.c.step()
  self.assertEqual(self.calls.count('library'),1)
 def test_offline_backoff_cap_catchup(self):
  self.state['health']['cabinet_reachable']=False;self.state['status']['gameId']=None
  for expected in [60,120,300,600,900,900,900]:
   self.c.step();self.assertEqual(self.c.next_status-self.t,expected);self.t=self.c.next_status
  self.assertEqual(self.c.failures,5);self.assertNotIn('library',self.calls)
  self.state['health']['cabinet_reachable']=True;self.state['status']['gameId']=0;self.c.step()
  self.assertEqual(self.c.failures,0);self.assertEqual(self.c.next_status-self.t,60);self.assertEqual(self.calls.count('library'),1)
 def test_exception_keeps_last_good(self):
  self.c.step();first=self.c.library();self.advance(300)
  self.c.get_library=lambda:(_ for _ in ()).throw(RuntimeError('https://private.invalid API_KEY=secret'))
  self.c.step();self.assertEqual(self.c.library()['tables'],first['tables'])
  self.assertNotIn('private',json.dumps(self.c.summary()));self.assertIn('Backing off',self.c.summary()['pending'])
  self.assertIsNone(self.c.status()['status']['gameId'])
 def test_incomplete_snapshot(self):
  self.c.step();self.advance(300);self.data={'ok':False};self.c.step()
  self.assertEqual(len(self.c.library()['tables']),1);self.assertEqual(self.c.summary()['historyCounts']['library'],1)
 def test_disabled_manual(self):
  self.c.configure(False,10);self.c.step();self.assertFalse(self.calls)
  self.c.library(refresh=True);self.assertEqual(self.calls,['status','library'])
  self.c.library(refresh=True);self.assertEqual(len(self.calls),2)
  self.advance(30);self.c.library(refresh=True);self.assertEqual(len(self.calls),4)
 def test_interval_validation(self):
  for e,i in [(1,5),(True,0),(True,61),(True,True),(False,'5')]:
   with self.assertRaises(ValueError):self.c.configure(e,i)
 def test_changed_history_and_persistence(self):
  self.c.step();self.data['tables'][0]['playCount']=1;self.advance(300);self.c.step()
  self.assertEqual(self.c.summary()['historyCounts']['library'],2)
  reopened=Collector(os.path.dirname(self.c.path),self.status,self.library,clock=lambda:self.t)
  self.assertEqual(reopened.library()['tables'][0]['playCount'],1)
  self.assertEqual(reopened.summary()['historyCounts']['library'],2)
 def test_stale_status(self):
  self.c.step();self.advance(126);self.assertTrue(self.c.status()['stale']);self.assertFalse(self.c.status()['health'])
 def test_no_duplicate_concurrent_pulls(self):
  entered=threading.Event();release=threading.Event()
  def wait_status():entered.set();release.wait(5);return self.state
  self.c.get_status=wait_status
  t=threading.Thread(target=self.c.step);t.start();self.assertTrue(entered.wait(2));self.assertFalse(self.c.step(manual=True));release.set();t.join(5)
  self.assertEqual(self.calls,['library'])
 def test_retention_caps(self):
  self.c.MAX_ROWS=3;self.c.PAYLOAD_BUDGET=500
  for i in range(8):
   self.data['tables'][0]['playCount']=i;self.c.step();self.advance(300)
  with self.c.db() as db:
   self.assertLessEqual(db.execute('SELECT count(*) FROM history').fetchone()[0],3)
   self.assertLessEqual(db.execute('SELECT sum(length(payload)) FROM history').fetchone()[0],500)
  self.advance(self.c.RETENTION+100);self.c.step()
  with self.c.db() as db:self.assertEqual(db.execute('SELECT count(*) FROM history WHERE at<?',(self.t-self.c.RETENTION,)).fetchone()[0],0)
  self.assertTrue(self.c.library()['ok'])
 def test_huge_snapshot_rejected(self):
  self.c.step();self.advance(300);self.data['huge']='x'*(4*1024*1024+1);self.c.step();self.assertNotIn('huge',self.c.library())
 def test_permissions_and_no_browser_worker(self):
  self.assertEqual(os.stat(self.c.path).st_mode&0o777,0o600)
  self.c.start();self.c.thread.join(timeout=.15);self.c.stop()
  self.assertIn('library',self.calls)
 def test_no_images_or_writes(self):
  self.c.step();self.assertEqual(set(self.calls),{'status','library'})

if __name__=='__main__':unittest.main(verbosity=2)
