"""Bounded, read-only cabinet observations. No image jobs or cabinet writes."""
import hashlib
import json
import os
import sqlite3
import threading
import time
import zlib
from contextlib import contextmanager
from datetime import date, datetime, timedelta


def _eastern_dst(ts):
    """US Eastern daylight time (post-2007 rules) for a UTC epoch, no tzdata.
    DST starts the second Sunday of March at 2:00 standard (7:00 UTC) and ends
    the first Sunday of November at 2:00 daylight (6:00 UTC)."""
    u = datetime.utcfromtimestamp(ts)
    mar = datetime(u.year, 3, 8)
    start = mar + timedelta(days=(6 - mar.weekday()) % 7, hours=7)
    nov = datetime(u.year, 11, 1)
    end = nov + timedelta(days=(6 - nov.weekday()) % 7, hours=6)
    return start <= u < end


def _load_stat_tz():
    """Timezone for play-stat day/week buckets: VPIN_TZ, default the server
    clock. Slim containers ship no tzdata, so the builtin Eastern rules cover
    that one zone; any other unresolvable zone falls back to the server clock
    with a one-line log."""
    name = os.environ.get('VPIN_TZ') or ''
    if not name:
        return None, False
    try:
        from zoneinfo import ZoneInfo
        return ZoneInfo(name), False
    except Exception:
        pass
    if name == 'America/New_York':
        return None, True
    print(f'[collector] VPIN_TZ {name!r} unavailable without tzdata; bucketing play stats in server local time', flush=True)
    return None, False


class Collector:
    RETENTION = 90 * 86400
    PAYLOAD_BUDGET = 25 * 1024 * 1024
    MAX_ROWS = 10000

    def __init__(self, directory, get_status, get_library, clock=time.time):
        os.makedirs(directory, mode=0o700, exist_ok=True)
        self.path = os.path.join(directory, 'observations.sqlite3')
        self.get_status, self.get_library, self.clock = get_status, get_library, clock
        self.lock = threading.RLock()
        self.pull_lock = threading.Lock()
        self.stop_event = threading.Event()
        self.changed = threading.Event()
        self.next_status = 0
        self.failures = 0
        self.last_manual = 0
        self.catch_up = True
        self.thread = None
        self._stat_tz, self._eastern_builtin = _load_stat_tz()
        with self.db() as db:
            db.execute('PRAGMA auto_vacuum=INCREMENTAL')
            db.executescript('''
              CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL, interval INTEGER NOT NULL);
              INSERT OR IGNORE INTO settings VALUES (1,1,5);
              CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
              CREATE TABLE IF NOT EXISTS history (id INTEGER PRIMARY KEY, at REAL NOT NULL, kind TEXT NOT NULL, digest TEXT NOT NULL, payload BLOB NOT NULL);
              CREATE INDEX IF NOT EXISTS history_at ON history(at);
            ''')
        os.chmod(self.path, 0o600)

    @contextmanager
    def db(self):
        with self.lock:
            db = sqlite3.connect(self.path, timeout=10)
            db.execute("PRAGMA synchronous=FULL")
            try:
                with db:
                    yield db
            finally:
                db.close()

    @staticmethod
    def put(db, key, value):
        db.execute('INSERT INTO state VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', (key, json.dumps(value, separators=(',', ':'))))

    @staticmethod
    def read(db, key, default=None):
        row = db.execute('SELECT value FROM state WHERE key=?', (key,)).fetchone()
        return json.loads(row[0]) if row else default

    def configure(self, enabled, interval):
        if type(enabled) is not bool or type(interval) is not int or not 1 <= interval <= 60:
            raise ValueError('Choose enabled on/off and an interval from 1 to 60 minutes.')
        with self.db() as db:
            db.execute('UPDATE settings SET enabled=?,interval=? WHERE id=1', (int(enabled), interval))
        self.next_status = 0
        self.changed.set()
        return self.summary()

    def summary(self):
        with self.db() as db:
            config = db.execute('SELECT enabled,interval FROM settings WHERE id=1').fetchone()
            counts = dict(db.execute('SELECT kind,count(*) FROM history GROUP BY kind'))
            size = db.execute('SELECT coalesce(sum(length(payload)),0) FROM history').fetchone()[0]
            return {'enabled': bool(config[0]), 'interval': config[1], 'lastChecked': self.read(db, 'last_checked'), 'lastSuccess': self.read(db, 'last_success'), 'lastError': self.read(db, 'last_error'), 'pending': self.read(db, 'pending', 'Awaiting first check'), 'nextCheck': self.next_status if config[0] else None, 'historyCounts': counts, 'payloadBytes': size, 'retentionDays': 90, 'payloadBudgetBytes': self.PAYLOAD_BUDGET, 'maxRows': self.MAX_ROWS}

    def _record(self, db, kind, payload, now):
        raw = json.dumps(payload, sort_keys=True, separators=(',', ':')).encode()
        if len(raw)>4*1024*1024:
            raise ValueError('Snapshot exceeds the 4 MB text limit.')
        digest = hashlib.sha256(raw).hexdigest()
        # Observe transitions, not one duplicate row per poll. Keep the latest snapshot separately.
        old = self.read(db, kind + '_digest')
        if digest != old:
            packed = zlib.compress(raw, 6)
            if len(packed) > 2 * 1024 * 1024:
                raise ValueError('Snapshot exceeds the 2 MB compressed limit.')
            db.execute('INSERT INTO history(at,kind,digest,payload) VALUES (?,?,?,?)', (now, kind, digest, packed))
            self.put(db, kind + '_digest', digest)
        self.put(db, 'latest_' + kind, {'at': now, 'data': payload})

    def _prune(self, db, now):
        db.execute('DELETE FROM history WHERE at < ?', (now - self.RETENTION,))
        db.execute('DELETE FROM history WHERE id IN (SELECT id FROM history ORDER BY id DESC LIMIT -1 OFFSET ?)', (self.MAX_ROWS,))
        size = db.execute('SELECT coalesce(sum(length(payload)),0) FROM history').fetchone()[0]
        if size > self.PAYLOAD_BUDGET:
            for row in db.execute('SELECT id,length(payload) FROM history ORDER BY id').fetchall():
                db.execute('DELETE FROM history WHERE id=?', (row[0],))
                size -= row[1]
                if size <= self.PAYLOAD_BUDGET:
                    break
        db.execute('PRAGMA incremental_vacuum(64)')

    def step(self, manual=False):
        now = self.clock()
        if manual and now - self.last_manual < 30:
            return False
        config = self.summary()
        if not manual and (not config['enabled'] or now < self.next_status):
            return False
        if not self.pull_lock.acquire(blocking=False):
            return False
        try:
            if manual:
                self.last_manual = now
            status = self.get_status()
            reachable = status.get('health', {}).get('cabinet_reachable') is True
            state = status.get('status', {})
            known = type(state.get('gameId')) is int
            busy = status.get('health', {}).get('game_playing') is True or (known and state['gameId'] > 0)
            with self.db() as db:
                self.put(db, 'last_checked', now)
                self._record(db, 'status', status, now)
                dismissed = self.read(db, 'dismissed_session')
                key = self.session_key(status)
                # Only a known idle state or a positively different session clears dismissal.
                if reachable and known and (state['gameId'] <= 0 or (key and dismissed != key)):
                    self.put(db, 'dismissed_session', None)
                self.put(db, 'pending', 'Cabinet busy: bulk pull deferred' if busy else 'Cabinet unavailable: bulk pull deferred' if not reachable or not known else 'Idle')
                self._prune(db, now)
            if not reachable or not known:
                raise ConnectionError('Status unavailable')
            if self.failures:
                self.catch_up=True
            self.failures = 0
            with self.db() as db:
                self.put(db, 'last_error', None)
            self.next_status = now + 60
            if busy:
                return True
            last = config['lastSuccess'] or 0
            if manual or self.catch_up or now - last >= config['interval'] * 60:
                library = self.get_library()
                if not isinstance(library, dict) or library.get('ok') is not True or not isinstance(library.get('tables'), list) or not isinstance(library.get('scores'), list):
                    raise ValueError('Incomplete snapshot')
                with self.db() as db:
                    self._record(db, 'library', library, now)
                    self.put(db, 'last_success', now)
                    self.put(db, 'last_error', None)
                    self.put(db, 'pending', 'Up to date')
                    self._prune(db, now)
                self.catch_up=False
            return True
        except Exception:
            self.failures = min(self.failures+1,5)
            self.catch_up=True
            delay = [60, 120, 300, 600, 900][min(self.failures - 1, 4)]
            self.next_status = now + delay
            with self.db() as db:
                # Never persist upstream errors, credentials or private URLs.
                # Keep the last good status; it ages honestly through checkedAt.
                self.put(db, 'last_error', 'Cabinet pull unavailable. Retaining the last good snapshot.')
                self.put(db, 'pending', 'Backing off after an unavailable or incomplete pull')
                self._prune(db, now)
            return False
        finally:
            self.pull_lock.release()

    def _play_points(self):
        """(timestamp, total recorded plays) for each saved library snapshot."""
        with self.db() as db:
            rows = db.execute("SELECT at,payload FROM history WHERE kind='library' ORDER BY at").fetchall()
            latest = self.read(db, 'latest_library')
        points = []
        for at, packed in rows:
            try:
                data = json.loads(zlib.decompress(packed))
            except Exception:
                continue
            tables = data.get('tables') if isinstance(data, dict) else None
            if not isinstance(tables, list):
                continue
            total = sum(t.get('playCount') for t in tables if isinstance(t, dict) and type(t.get('playCount')) is int)
            points.append((float(at), total))
        if isinstance(latest, dict) and isinstance(latest.get('data'), dict):
            tables = latest['data'].get('tables')
            if isinstance(tables, list):
                total = sum(t.get('playCount') for t in tables if isinstance(t, dict) and type(t.get('playCount')) is int)
                at = float(latest.get('at') or 0)
                if not points or points[-1][0] != at:
                    points.append((at, total))
        # Key weeks by the Monday date, not epoch arithmetic: DST transitions
        # make fixed 7-day offsets drift an hour off the bucket boundaries.
        return points

    def _stat_local_date(self, ts):
        """Calendar date of an epoch in the stats timezone (VPIN_TZ)."""
        if self._eastern_builtin:
            off = -14400 if _eastern_dst(ts) else -18000
            return datetime.utcfromtimestamp(ts + off).date()
        if self._stat_tz is not None:
            return datetime.fromtimestamp(ts, self._stat_tz).date()
        lt = time.localtime(ts)
        return date(lt.tm_year, lt.tm_mon, lt.tm_mday)

    def _play_days(self, weeks):
        """(ordered day dates, ISO-date -> plays) for whole weeks starting
        Monday in the stats timezone. Day buckets use date arithmetic, so DST
        transitions cannot drift the boundaries."""
        monday0 = self._stat_local_date(self.clock())
        monday0 -= timedelta(days=monday0.weekday())
        first = monday0 - timedelta(days=(weeks - 1) * 7)
        days = [first + timedelta(days=i) for i in range(weeks * 7)]
        buckets = {d.isoformat(): 0 for d in days}
        points = self._play_points()
        for (a0, t0), (a1, t1) in zip(points, points[1:]):
            delta = max(0, t1 - t0)
            if not delta:
                continue
            k = self._stat_local_date(a1).isoformat()
            if k in buckets:
                buckets[k] += delta
        return days, buckets

    def plays_by_week(self, weeks=8):
        """Plays recorded per week, from saved library snapshots.

        Each history row is a changed library snapshot; the delta of total
        recorded plays between consecutive snapshots is attributed to the
        week of the later snapshot. Negative deltas (table removed) count as
        zero. History starts with this dashboard's first sync and is kept
        for the retention window, so early weeks fill in over time. Weeks
        start on Mondays in the stats timezone (VPIN_TZ, or the server clock).
        """
        days, buckets = self._play_days(weeks)
        out = []
        for i in range(weeks):
            monday = days[i * 7]
            total = sum(buckets[(monday + timedelta(days=j)).isoformat()] for j in range(7))
            out.append({'week': monday.strftime('%b ') + str(monday.day), 'plays': total})
        return out

    def plays_by_day(self, weeks=13):
        """Plays recorded per day, same snapshot deltas as plays_by_week,
        attributed to the day of the later snapshot. Returns whole weeks
        starting on a Monday so the heatmap grid aligns. Days are calendar
        days in the stats timezone (VPIN_TZ, or the server clock), so evening
        plays land on the local day instead of tomorrow in UTC."""
        days, buckets = self._play_days(weeks)
        return [{'date': d.isoformat(), 'plays': buckets[d.isoformat()]} for d in days]

    def library(self, refresh=False):
        if refresh:
            self.step(manual=True)
        with self.db() as db:
            latest = self.read(db, 'latest_library')
        if not latest:
            return {'ok': False, 'error': 'No saved library yet. Collection waits until the cabinet is reachable and idle.', 'tables': [], 'scores': [], 'playlists': [], 'thumbsEnabled': True}
        result = dict(latest['data'])
        result['collection'] = {'capturedAt': latest['at'], 'saved': True}
        return result

    def status(self):
        with self.db() as db:
            latest = self.read(db, 'latest_status')
            dismissed = self.read(db, 'dismissed_session')
        if not latest:
            return {'ok': True, 'health': {}, 'status': {'gameId': 0, 'started': None}, 'stale': True, 'checkedAt': None}
        data = latest['data']
        session = data.get('status', {}) if isinstance(data, dict) else {}
        active = type(session.get('gameId')) is int and session['gameId'] > 0
        if self.clock() - latest['at'] > 125 and not active:
            return {'ok': True, 'health': {}, 'status': {'gameId': 0, 'started': None}, 'stale': True, 'checkedAt': latest['at']}
        return {**data, 'checkedAt': latest['at'], 'dismissed': bool(dismissed and dismissed == self.session_key(latest['data']))}

    @staticmethod
    def session_key(data):
        state = data.get('status', {})
        game_id, started = state.get('gameId'), state.get('started')
        return [game_id, started] if type(game_id) is int and game_id > 0 and isinstance(started, str) and started else None

    def dismiss_session(self, game_id, started):
        with self.db() as db:
            latest = self.read(db, 'latest_status')
            key = [game_id, started]
            if type(game_id) is not int or type(started) is not str or not latest or self.clock() - latest['at'] > 125 or self.session_key(latest['data']) != key:
                raise ValueError('This session changed or cannot be identified. Refresh and try again.')
            self.put(db, 'dismissed_session', key)
        return self.status()

    def start(self):
        if self.thread:
            return
        def run():
            while not self.stop_event.is_set():
                try:
                    self.step()
                    enabled=self.summary()['enabled']
                    delay=max(1,self.next_status-self.clock()) if enabled else 900
                except Exception:
                    delay=60
                self.changed.wait(min(delay,900))
                self.changed.clear()
        self.thread = threading.Thread(target=run, name='cabinet-collector', daemon=True)
        self.thread.start()

    def stop(self):
        self.stop_event.set()
        self.changed.set()
        if self.thread:
            self.thread.join(timeout=2)
