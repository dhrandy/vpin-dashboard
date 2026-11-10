"""Synthetic preference migration and per-user persistence checks."""
import sys
from pathlib import Path
import sqlite3
import tempfile
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'app'))
from auth import AuthStore
class PreferenceTests(unittest.TestCase):
    def test_back_top_migration_preserves_existing_preferences_and_hearts(self):
        with tempfile.TemporaryDirectory() as folder:
            store=AuthStore(folder)
            with store.db() as db:
                db.execute('INSERT INTO preferences(user_id,colorblind,show_timer,show_play_time,status_details,back_to_top) VALUES (1,1,0,0,1,1)')
                db.execute('INSERT INTO favourites VALUES (1,42)')
                db.execute('ALTER TABLE preferences DROP COLUMN back_to_top')
            store=AuthStore(folder)
            self.assertEqual(store.preferences(1),dict(colorblind=True,showTimer=False,showPlayTime=False,statusDetails=True,backToTop=True,showHidden=False))
            store.set_preferences(1,True,False,False,True,False)
            self.assertFalse(AuthStore(folder).preferences(1)['backToTop'])
            self.assertTrue(store.preferences(2)['backToTop'])
            self.assertEqual(store.favourites(1),[42])
if __name__=='__main__':unittest.main()
