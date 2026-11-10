"""Private bounded read cache for safe per-table modal responses."""
from contextlib import contextmanager
import json
import os
import sqlite3
import threading
import time


class TableCache:
    MAX_BYTES = 16 * 1024 * 1024
    MAX_ROWS = 2000
    MAX_ITEM = 512 * 1024

    def __init__(self, root):
        os.makedirs(root, mode=0o700, exist_ok=True)
        self.path = os.path.join(root, 'table-cache.sqlite3')
        self.lock = threading.Lock()
        self.pending = set()
        self.retry_at = {}
        with self.db() as db:
            db.execute('PRAGMA auto_vacuum=INCREMENTAL')
            db.execute('CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, data TEXT NOT NULL, saved REAL NOT NULL)')
        os.chmod(self.path, 0o600)

    @contextmanager
    def db(self):
        db=sqlite3.connect(self.path,timeout=5)
        db.execute("PRAGMA synchronous=FULL")
        try:
            with db:
                yield db
        finally:
            db.close()

    def read(self, key):
        with self.db() as db:
            row = db.execute('SELECT data,saved FROM cache WHERE key=?', (key,)).fetchone()
        return (json.loads(row[0]), row[1]) if row else (None, None)

    def fetch(self, key, loader):
        data, saved = self.read(key)
        now = time.time()
        with self.lock:
            start = len(self.pending) < 4 and key not in self.pending and now >= self.retry_at.get(key, 0) and (saved is None or now - saved >= 300)
            if start:
                self.pending.add(key)
                self.retry_at[key] = now + 60
                if len(self.retry_at) > self.MAX_ROWS:
                    self.retry_at = {k: v for k, v in self.retry_at.items() if v > now or k in self.pending}
                    while len(self.retry_at)>self.MAX_ROWS:
                        victim=next((k for k in self.retry_at if k not in self.pending),None)
                        if victim is None:break
                        self.retry_at.pop(victim,None)
            refreshing = key in self.pending
        if start:
            threading.Thread(target=self._refresh, args=(key, loader), daemon=True).start()
        return {**(data or {}), 'cache': {'savedAt': saved, 'refreshing': refreshing, 'notSaved': saved is None}}

    def _refresh(self, key, loader):
        try:
            data = json.dumps(loader(), separators=(',', ':'), allow_nan=False)
            if len(data.encode()) > self.MAX_ITEM:
                raise ValueError('Modal response exceeds cache item limit')
            with self.db() as db:
                db.execute('INSERT OR REPLACE INTO cache VALUES (?,?,?)', (key, data, time.time()))
                # Bound persistent data across every table and both response kinds.
                rows = db.execute('SELECT key,length(CAST(data AS BLOB)) FROM cache ORDER BY saved DESC').fetchall()
                total = 0
                for i, (old_key, size) in enumerate(rows):
                    total += size
                    if i >= self.MAX_ROWS or total > self.MAX_BYTES:
                        db.execute('DELETE FROM cache WHERE key=?', (old_key,))
                db.execute('PRAGMA incremental_vacuum')
        except Exception:
            # Last-known data stays intact; no cabinet data or paths in logs.
            pass
        finally:
            with self.lock:
                self.pending.discard(key)

    def warm_state(self):
        with self.lock:
            return dict(getattr(self, 'warming', {'running': False, 'total': 0, 'done': 0, 'failed': 0, 'skipped': 0, 'paused': False}))

    def warm(self, ids, loader, idle):
        with self.lock:
            if getattr(self, 'warming', {}).get('running'):
                return dict(self.warming)
            self.warming = {'running': True, 'total': len(ids) * 2, 'done': 0, 'failed': 0, 'skipped': 0, 'paused': False}
        threading.Thread(target=self._warm, args=(ids, loader, idle), daemon=True).start()
        return self.warm_state()

    def _warm(self, ids, loader, idle):
        deadline = time.monotonic() + 7200
        try:
            for game_id in ids:
                for kind in ('details', 'scorehistory'):
                    key = f'{kind}/{game_id}'
                    data, saved = self.read(key)
                    if saved and time.time() - saved < 300:
                        with self.lock:
                            self.warming['done'] += 1
                            self.warming['skipped'] += 1
                        continue
                    while not idle():
                        with self.lock:
                            self.warming['paused'] = True
                        if time.monotonic() > deadline:
                            return
                        time.sleep(60)
                    with self.lock:
                        self.warming['paused'] = False
                    # Same deduplicated loader as first-open reads. The worker
                    # waits for each read and throttles, never fans out tables.
                    result = self.fetch(key, lambda: loader(kind, game_id))
                    while key in self.pending:
                        time.sleep(.1)
                    _, after = self.read(key)
                    with self.lock:
                        self.warming['done'] += 1
                        self.warming['failed'] += int(after is None or after == saved)
                    time.sleep(1)
                    if time.monotonic() > deadline:
                        return
        finally:
            with self.lock:
                self.warming['running'] = False
                self.warming['paused'] = False
                self.warming['incomplete'] = self.warming['done'] < self.warming['total']
