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
  self.assertEqual(self.c.status()['status']['gameId'],0)
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
 def test_failure_keeps_last_good_status(self):
  self.state['status']['gameId']=7;self.state['health']['game_playing']=True
  self.c.step();self.advance()
  self.c.get_status=lambda:(_ for _ in ()).throw(RuntimeError('timeout'))
  self.c.step();st=self.c.status()
  self.assertEqual(st['status']['gameId'],7);self.assertNotIn('stale',st)
 def test_active_session_never_stale(self):
  self.state['status']['gameId']=7;self.state['health']['game_playing']=True
  self.c.step();self.advance(100000);st=self.c.status()
  self.assertNotIn('stale',st);self.assertEqual(st['status']['gameId'],7)
  self.assertGreater(self.t-st['checkedAt'],125)
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
 def test_dismiss_exact_session_persists_without_changing_busy(self):
  self.state['status']={'gameId':12,'started':'2026-11-09T20:00:00+00:00'};self.state['health']['game_playing']=True
  self.c.step();result=self.c.dismiss_session(12,self.state['status']['started'])
  self.assertTrue(result['dismissed']);self.assertEqual(result['status']['gameId'],12);self.assertTrue(result['health']['game_playing'])
  other=Collector(os.path.dirname(self.c.path),self.status,self.library,clock=lambda:self.t)
  self.assertTrue(other.status()['dismissed'])
  self.advance();self.c.step();self.assertTrue(self.c.status()['dismissed'])
  self.state['status']['started']='2026-11-09T21:00:00+00:00';self.advance();self.c.step();self.assertFalse(self.c.status()['dismissed'])
 def test_dismiss_conflict_and_unknown_start(self):
  self.c.step()
  for gid,start in [(12,'x'),(True,'x'),(0,None)]:
   with self.assertRaises(ValueError):self.c.dismiss_session(gid,start)
  self.state['status']={'gameId':12,'started':'2026-11-09T20:00:00+00:00'};self.state['health']['game_playing']=True
  self.advance();self.c.step();self.advance(126)
  with self.assertRaises(ValueError):self.c.dismiss_session(12,self.state['status']['started'])
 def test_dismiss_offline_preserved_idle_clears(self):
  self.state['status']={'gameId':12,'started':'2026-11-09T20:00:00+00:00'};self.state['health']['game_playing']=True
  self.c.step();self.c.dismiss_session(12,self.state['status']['started'])
  self.state['health']['cabinet_reachable']=False;self.advance();self.c.step()
  with self.c.db() as db:self.assertIsNotNone(self.c.read(db,'dismissed_session'))
  self.state['health']={'cabinet_reachable':True,'game_playing':False};self.state['status']={'gameId':0,'started':None};self.advance();self.c.step()
  with self.c.db() as db:self.assertIsNone(self.c.read(db,'dismissed_session'))
 def test_no_images_or_writes(self):
  self.c.step();self.assertEqual(set(self.calls),{'status','library'})

 def test_plays_by_week(self):
  # Snapshot 1: 10 total plays. A week later snapshot 2: 25 total -> 15 plays that week.
  self.data={'ok':True,'tables':[{'gameId':1,'playCount':10}],'scores':[],'playlists':[]}
  self.c.step()
  self.advance(7*86400+3600)
  self.data={'ok':True,'tables':[{'gameId':1,'playCount':25}],'scores':[],'playlists':[]}
  self.c.step(manual=True)
  weeks=self.c.plays_by_week()
  self.assertEqual(len(weeks),8)
  self.assertEqual(weeks[-1]['plays'],15)
  self.assertEqual(sum(w['plays'] for w in weeks),15)
 def test_plays_by_week_empty_and_clamped(self):
  self.assertEqual([w['plays'] for w in self.c.plays_by_week()],[0]*8)
  self.c.step()
  self.advance(3600)
  self.data={'ok':True,'tables':[{'gameId':1,'playCount':0}],'scores':[],'playlists':[]}
  self.c.step(manual=True)  # playCount dropped (table removed): no negative plays
  self.assertEqual(sum(w['plays'] for w in self.c.plays_by_week()),0)
 def test_plays_by_day(self):
  # Snapshot 1: 10 total plays. A day later snapshot 2: 25 -> 15 plays on that day.
  self.data={'ok':True,'tables':[{'gameId':1,'playCount':10}],'scores':[],'playlists':[]}
  self.c.step()
  self.advance(86400+3600)
  self.data={'ok':True,'tables':[{'gameId':1,'playCount':25}],'scores':[],'playlists':[]}
  self.c.step(manual=True)
  days=self.c.plays_by_day()
  self.assertEqual(len(days),91)
  self.assertEqual(sum(d['plays'] for d in days),15)
  import time as _t
  today=self.c._stat_local_date(self.t).isoformat()
  self.assertEqual({d['date']:d['plays'] for d in days}[today],15)
  # Whole weeks: first day is a Monday.
  first=days[0]['date']
  self.assertEqual(_t.localtime(_t.mktime(_t.strptime(first,'%Y-%m-%d'))).tm_wday,0)
 def test_plays_by_day_empty_and_clamped(self):
  self.assertEqual(sum(d['plays'] for d in self.c.plays_by_day()),0)
  self.assertEqual(len(self.c.plays_by_day()),91)
  self.c.step()
  self.advance(3600)
  self.data={'ok':True,'tables':[{'gameId':1,'playCount':0}],'scores':[],'playlists':[]}
  self.c.step(manual=True)  # playCount dropped: no negative plays
  self.assertEqual(sum(d['plays'] for d in self.c.plays_by_day()),0)
 def test_stats_default_is_server_clock(self):
  self.assertIsNone(self.c._stat_tz)
  self.assertFalse(self.c._eastern_builtin)
 def test_plays_by_day_buckets_in_stats_timezone(self):
  # 11:27 PM at UTC-5 is already the next day in UTC: evening plays belong to the local day.
  import calendar
  os.environ['VPIN_TZ']='Etc/GMT+5'  # fixed UTC-5, no city name
  try:
   c=Collector(tempfile.mkdtemp(),self.status,self.library,clock=lambda:self.t)
   self.t=float(calendar.timegm((2026,11,14,3,27,0)))  # 10:27 PM at UTC-5, Nov 13
   self.data={'ok':True,'tables':[{'gameId':1,'playCount':10}],'scores':[],'playlists':[]}
   c.step()
   self.advance(3600)  # 11:27 PM at UTC-5 Nov 13 = 4:27 AM UTC Nov 14
   self.assertEqual(c._stat_local_date(self.t).isoformat(),'2026-11-13')
   self.data={'ok':True,'tables':[{'gameId':1,'playCount':24}],'scores':[],'playlists':[]}
   c.step(manual=True)
   days={d['date']:d['plays'] for d in c.plays_by_day()}
   self.assertEqual(days['2026-11-13'],14)
   self.assertEqual(days['2026-11-14'],0)
  finally:
   del os.environ['VPIN_TZ']
 def test_plays_by_week_buckets_in_stats_timezone(self):
  import calendar
  os.environ['VPIN_TZ']='Etc/GMT+5'
  try:
   c=Collector(tempfile.mkdtemp(),self.status,self.library,clock=lambda:self.t)
   self.t=float(calendar.timegm((2026,11,14,3,27,0)))
   self.data={'ok':True,'tables':[{'gameId':1,'playCount':10}],'scores':[],'playlists':[]}
   c.step()
   self.advance(3600)
   self.data={'ok':True,'tables':[{'gameId':1,'playCount':24}],'scores':[],'playlists':[]}
   c.step(manual=True)
   weeks=c.plays_by_week()
   self.assertEqual(weeks[-1]['plays'],14)
   self.assertEqual(weeks[-1]['week'],'Nov 9')
  finally:
   del os.environ['VPIN_TZ']
 def test_builtin_eastern_used_when_tzdata_missing(self):
  # Slim images ship no tzdata: the one-zone builtin rules must take over.
  import sys, calendar
  os.environ['VPIN_TZ']='America/New_York'
  saved=sys.modules.get('zoneinfo')
  sys.modules['zoneinfo']=None  # make the zoneinfo import fail
  try:
   c=Collector(tempfile.mkdtemp(),self.status,self.library,clock=lambda:self.t)
   self.assertTrue(c._eastern_builtin)
   ts=float(calendar.timegm((2026,11,14,4,27,0)))  # 11:27 PM EST Nov 13
   self.assertEqual(c._stat_local_date(ts).isoformat(),'2026-11-13')
   ts=float(calendar.timegm((2026,7,14,4,27,0)))   # 12:27 AM EDT Jul 14
   self.assertEqual(c._stat_local_date(ts).isoformat(),'2026-07-14')
  finally:
   if saved is None: sys.modules.pop('zoneinfo',None)
   else: sys.modules['zoneinfo']=saved
   del os.environ['VPIN_TZ']
 def test_vpin_tz_override(self):
  try:
   from zoneinfo import ZoneInfo
   ZoneInfo('UTC')
  except Exception:
   self.skipTest('no tzdata on this host')
  import calendar
  os.environ['VPIN_TZ']='UTC'
  try:
   c=Collector(tempfile.mkdtemp(),self.status,self.library,clock=lambda:self.t)
   self.t=float(calendar.timegm((2026,11,14,3,27,0)))
   self.data={'ok':True,'tables':[{'gameId':1,'playCount':10}],'scores':[],'playlists':[]}
   c.step()
   self.advance(3600)
   self.data={'ok':True,'tables':[{'gameId':1,'playCount':24}],'scores':[],'playlists':[]}
   c.step(manual=True)
   days={d['date']:d['plays'] for d in c.plays_by_day()}
   self.assertEqual(days['2026-11-14'],14)
   self.assertEqual(days['2026-11-13'],0)
  finally:
   del os.environ['VPIN_TZ']
 def test_invalid_vpin_tz_falls_back_to_server_clock(self):
  os.environ['VPIN_TZ']='Mars/Olympus'
  try:
   c=Collector(tempfile.mkdtemp(),self.status,self.library,clock=lambda:self.t)
   self.assertIsNone(c._stat_tz)
   self.assertFalse(c._eastern_builtin)
  finally:
   del os.environ['VPIN_TZ']
 def test_builtin_eastern_matches_zoneinfo(self):
  try:
   from zoneinfo import ZoneInfo
   tz=ZoneInfo('America/New_York')
  except Exception:
   self.skipTest('no tzdata on this host')
  import calendar
  from datetime import datetime as dt, timezone
  from collector import _eastern_dst
  t0=calendar.timegm((2026,1,1,0,0,0))
  for h in range(0,8784,6):  # offset parity with the IANA database across all of 2026
   ts=t0+h*3600
   zoff=dt.fromtimestamp(ts,timezone.utc).astimezone(tz).utcoffset().total_seconds()
   boff=-14400 if _eastern_dst(ts) else -18000
   self.assertEqual(zoff,boff,f'offset mismatch at epoch {ts}')
if __name__=='__main__':unittest.main(verbosity=2)
