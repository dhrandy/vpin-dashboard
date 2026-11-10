"""Local users and revocable signed sessions. All state stays in /data."""
from contextlib import contextmanager
import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import threading
import time


class AuthError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


class AuthStore:
    SESSION_SECONDS = 12 * 60 * 60

    def __init__(self, directory):
        self.directory = directory
        os.makedirs(directory, mode=0o700, exist_ok=True)
        self.path = os.path.join(directory, 'users.sqlite3')
        self.setup_path = os.path.join(directory, 'admin-setup-token')
        self.lock = threading.RLock()
        self.hash_slots = threading.BoundedSemaphore(2)
        with self.db() as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS users (
                    id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL,
                    password TEXT NOT NULL, role TEXT NOT NULL,
                    active INTEGER NOT NULL DEFAULT 1);
                CREATE TABLE IF NOT EXISTS sessions (
                    token TEXT PRIMARY KEY, user_id INTEGER NOT NULL,
                    csrf TEXT NOT NULL, expires INTEGER NOT NULL);
                CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS preferences (user_id INTEGER PRIMARY KEY, colorblind INTEGER NOT NULL DEFAULT 0);
                CREATE TABLE IF NOT EXISTS favourites (user_id INTEGER NOT NULL, game_id INTEGER NOT NULL, PRIMARY KEY(user_id,game_id));
                CREATE TABLE IF NOT EXISTS hidden (user_id INTEGER NOT NULL, game_id INTEGER NOT NULL, PRIMARY KEY(user_id,game_id));
                CREATE TABLE IF NOT EXISTS stats_sections (user_id INTEGER NOT NULL, section TEXT NOT NULL, PRIMARY KEY(user_id,section));
                CREATE TABLE IF NOT EXISTS attempts (
                    bucket TEXT PRIMARY KEY, count INTEGER NOT NULL, until_at INTEGER NOT NULL);
            ''')
            row = db.execute("SELECT value FROM settings WHERE key='signing_key'").fetchone()
            if not row:
                db.execute("INSERT INTO settings VALUES ('signing_key', ?)", (secrets.token_hex(32),))
            self.key = (row[0] if row else db.execute("SELECT value FROM settings WHERE key='signing_key'").fetchone()[0]).encode()
        with self.db() as db:
            if 'status_details' not in {row[1] for row in db.execute('PRAGMA table_info(preferences)')}:
                db.execute('ALTER TABLE preferences ADD COLUMN status_details INTEGER NOT NULL DEFAULT 0')
            if 'show_play_time' not in {row[1] for row in db.execute('PRAGMA table_info(preferences)')}:
                db.execute('ALTER TABLE preferences ADD COLUMN show_play_time INTEGER NOT NULL DEFAULT 1')
            if 'show_timer' not in {row[1] for row in db.execute('PRAGMA table_info(preferences)')}:
                db.execute('ALTER TABLE preferences ADD COLUMN show_timer INTEGER NOT NULL DEFAULT 1')
            if 'back_to_top' not in {row[1] for row in db.execute('PRAGMA table_info(preferences)')}:
                db.execute('ALTER TABLE preferences ADD COLUMN back_to_top INTEGER NOT NULL DEFAULT 1')
            if 'show_hidden' not in {row[1] for row in db.execute('PRAGMA table_info(preferences)')}:
                db.execute('ALTER TABLE preferences ADD COLUMN show_hidden INTEGER NOT NULL DEFAULT 0')
        os.chmod(self.path, 0o600)
        if self.needs_setup() and not os.path.exists(self.setup_path):
            fd = os.open(self.setup_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, 'w') as f:
                f.write(secrets.token_urlsafe(32))
        # Dummy record makes unknown-user authentication take the same hash path.
        self.dummy = self.hash_password(secrets.token_urlsafe(32))

    @contextmanager
    def db(self):
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    def needs_setup(self):
        with self.db() as db:
            return db.execute('SELECT count(*) FROM users').fetchone()[0] == 0

    def validate(self, username, password, role):
        if not isinstance(username, str) or not re.fullmatch(r'[a-zA-Z0-9_.-]{3,40}', username):
            raise AuthError('Use a username of 3-40 letters, numbers, dots, underscores or hyphens.')
        if not isinstance(password, str) or not 12 <= len(password) <= 128:
            raise AuthError('Use a password of 12-128 characters.')
        if role not in ('admin', 'viewer'):
            raise AuthError('Choose admin or viewer.')
        return username.lower()

    def hash_password(self, password):
        salt = secrets.token_bytes(16)
        with self.hash_slots:
            digest = hashlib.scrypt(password.encode(), salt=salt, n=2**17, r=8, p=1, maxmem=256*1024*1024)
        return salt.hex() + ':' + digest.hex()

    def verify_password(self, password, record):
        if not isinstance(password, str) or len(password) > 128:
            password = ''
        try:
            salt, expected = record.split(':')
            with self.hash_slots:
                actual = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=2**17, r=8, p=1, maxmem=256*1024*1024)
            return hmac.compare_digest(actual.hex(), expected)
        except (ValueError, TypeError):
            return False

    def throttle(self, ip, username):
        # Do not trust forwarding headers. Behind a proxy this intentionally
        # shares the IP budget; the username budget still works across IPs.
        now = int(time.time())
        keys = [('ip:' + ip, 30), ('user:' + str(username).lower()[:40], 8)]
        with self.lock, self.db() as db:
            db.execute('DELETE FROM attempts WHERE until_at < ?', (now,))
            for key, limit in keys:
                row = db.execute('SELECT count FROM attempts WHERE bucket=?', (key,)).fetchone()
                if row and row[0] >= limit:
                    raise AuthError('Too many attempts. Try again in 15 minutes.', 429)
            for key, _ in keys:
                db.execute('INSERT INTO attempts VALUES (?,1,?) ON CONFLICT(bucket) DO UPDATE SET count=count+1', (key, now+900))
            # Bound attacker-controlled username cardinality.
            db.execute('DELETE FROM attempts WHERE rowid IN (SELECT rowid FROM attempts ORDER BY until_at DESC LIMIT -1 OFFSET 10000)')

    def setup(self, payload, ip):
        self.throttle(ip, 'first-admin-setup')
        username = self.validate(payload.get('username'), payload.get('password'), 'admin')
        password_hash = self.hash_password(payload['password'])
        with self.lock, self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            if db.execute('SELECT count(*) FROM users').fetchone()[0]:
                raise AuthError('Setup is already complete.', 409)
            try:
                with open(self.setup_path) as f:
                    token = f.read().strip()
            except OSError:
                raise AuthError('Setup token is unavailable.', 503)
            supplied = payload.get('setupToken')
            if not isinstance(supplied, str) or not hmac.compare_digest(supplied, token):
                raise AuthError('Setup token is invalid.', 403)
            db.execute('INSERT INTO users(username,password,role) VALUES (?,?,?)', (username,password_hash,'admin'))
        try:
            os.remove(self.setup_path)
        except FileNotFoundError:
            pass
        return self.login(username, payload['password'], ip)

    def login(self, username, password, ip):
        self.throttle(ip, username)
        with self.db() as db:
            row = db.execute('SELECT * FROM users WHERE username=?', (str(username).lower()[:40],)).fetchone()
        valid = self.verify_password(password, row['password'] if row else self.dummy)
        if not row or not valid or not row['active']:
            raise AuthError('Username or password is incorrect.', 401)
        token, csrf = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
        now = int(time.time())
        with self.lock, self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            current = db.execute('SELECT password,active FROM users WHERE id=?', (row['id'],)).fetchone()
            if not current or not current['active'] or current['password'] != row['password']:
                raise AuthError('Credentials changed. Sign in again.', 401)
            db.execute('DELETE FROM sessions WHERE expires < ?', (now,))
            db.execute('DELETE FROM sessions WHERE user_id=? AND token NOT IN (SELECT token FROM sessions WHERE user_id=? ORDER BY expires DESC LIMIT 9)', (row['id'],row['id']))
            db.execute('INSERT INTO sessions VALUES (?,?,?,?)', (hashlib.sha256(token.encode()).hexdigest(),row['id'],csrf,now+self.SESSION_SECONDS))
        signature = hmac.new(self.key, token.encode(), 'sha256').hexdigest()
        return token + '.' + signature

    def session(self, cookie):
        if not cookie or len(cookie) > 200:
            return None
        try:
            token, signature = cookie.split('.')
        except ValueError:
            return None
        if not hmac.compare_digest(signature, hmac.new(self.key, token.encode(), 'sha256').hexdigest()):
            return None
        with self.db() as db:
            row = db.execute('SELECT users.id,username,role,csrf,sessions.token FROM sessions JOIN users ON user_id=users.id WHERE sessions.token=? AND expires>? AND active=1', (hashlib.sha256(token.encode()).hexdigest(),int(time.time()))).fetchone()
        return dict(row) if row else None

    def logout(self, session):
        with self.db() as db:
            db.execute('DELETE FROM sessions WHERE token=?', (session['token'],))

    def list_users(self):
        with self.db() as db:
            return [dict(r) for r in db.execute('SELECT id,username,role,active FROM users ORDER BY username')]

    def create_user(self, payload):
        username = self.validate(payload.get('username'), payload.get('password'), payload.get('role'))
        password_hash = self.hash_password(payload['password'])
        with self.lock, self.db() as db:
            if db.execute('SELECT count(*) FROM users').fetchone()[0] >= 200:
                raise AuthError('User limit reached.')
            try:
                db.execute('INSERT INTO users(username,password,role) VALUES (?,?,?)', (username,password_hash,payload['role']))
            except sqlite3.IntegrityError:
                raise AuthError('That username is already in use.', 409)

    def update_user(self, user_id, payload, actor):
        if not isinstance(payload, dict) or not set(payload) <= {'role','active','password'} or not payload:
            raise AuthError('Provide a role, active state or new password.')
        password_hash = None
        if 'password' in payload:
            self.validate('valid-user',payload['password'],'viewer')
            password_hash = self.hash_password(payload['password'])
        with self.lock, self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute('SELECT * FROM users WHERE id=?',(user_id,)).fetchone()
            if not row:
                raise AuthError('User not found.',404)
            role, active = payload.get('role',row['role']), payload.get('active',bool(row['active']))
            if role not in ('admin','viewer') or type(active) is not bool:
                raise AuthError('Invalid role or active state.')
            if user_id == actor['id'] and (role != 'admin' or not active):
                raise AuthError('You cannot remove your own admin access.')
            if row['role']=='admin' and row['active'] and (role!='admin' or not active):
                if db.execute("SELECT count(*) FROM users WHERE role='admin' AND active=1").fetchone()[0] <= 1:
                    raise AuthError('Keep at least one active admin.')
            db.execute('UPDATE users SET role=?,active=?,password=? WHERE id=?',(role,int(active),password_hash or row['password'],user_id))
            db.execute('DELETE FROM sessions WHERE user_id=?',(user_id,))

    def preferences(self,user_id):
        with self.db() as db:
            row=db.execute('SELECT colorblind,show_timer,show_play_time,status_details,back_to_top,show_hidden FROM preferences WHERE user_id=?',(user_id,)).fetchone()
            return {'colorblind':bool(row[0]) if row else False,'showTimer':bool(row[1]) if row else True,'showPlayTime':bool(row[2]) if row else True,'statusDetails':bool(row[3]) if row else False,'backToTop':bool(row[4]) if row else True,'showHidden':bool(row[5]) if row else False}

    def set_preferences(self,user_id,colorblind,show_timer=True,show_play_time=True,status_details=False,back_to_top=True,show_hidden=False):
        with self.lock,self.db() as db:
            db.execute('INSERT INTO preferences (user_id,colorblind,show_timer,show_play_time,status_details,back_to_top,show_hidden) VALUES (?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET colorblind=excluded.colorblind,show_timer=excluded.show_timer,show_play_time=excluded.show_play_time,status_details=excluded.status_details,back_to_top=excluded.back_to_top,show_hidden=excluded.show_hidden',(user_id,int(colorblind),int(show_timer),int(show_play_time),int(status_details),int(back_to_top),int(show_hidden)))
        return self.preferences(user_id)

    def favourites(self, user_id):
        with self.db() as db:
            return [r[0] for r in db.execute('SELECT game_id FROM favourites WHERE user_id=? ORDER BY game_id',(user_id,))]

    def personal_write_throttle(self,user_id):
        key='personal:'+str(user_id);now=int(time.time())
        with self.lock,self.db() as db:
            db.execute('DELETE FROM attempts WHERE until_at < ?',(now,))
            row=db.execute('SELECT count FROM attempts WHERE bucket=?',(key,)).fetchone()
            if row and row[0]>=120:
                raise AuthError('Too many personal setting changes. Try again in 15 minutes.',429)
            db.execute('INSERT INTO attempts VALUES (?,1,?) ON CONFLICT(bucket) DO UPDATE SET count=count+1',(key,now+900))

    def hidden(self, user_id):
        with self.db() as db:
            return [r[0] for r in db.execute('SELECT game_id FROM hidden WHERE user_id=? ORDER BY game_id',(user_id,))]

    def set_hidden(self,user_id,game_id,is_hidden):
        with self.lock,self.db() as db:
            if is_hidden:
                if db.execute('SELECT count(*) FROM hidden WHERE user_id=?',(user_id,)).fetchone()[0]>=10000:
                    raise AuthError('Hidden table limit reached.')
                db.execute('INSERT OR IGNORE INTO hidden VALUES (?,?)',(user_id,game_id))
            else:
                db.execute('DELETE FROM hidden WHERE user_id=? AND game_id=?',(user_id,game_id))
        return self.hidden(user_id)

    STATS_SECTIONS = ('most', 'least', 'recent', 'tops', 'players', 'makers', 'decades', 'toplist')

    def stats_sections(self, user_id):
        with self.db() as db:
            return [r[0] for r in db.execute('SELECT section FROM stats_sections WHERE user_id=? ORDER BY section',(user_id,))]

    def set_stats_section(self,user_id,section,is_hidden):
        if section not in self.STATS_SECTIONS:
            raise AuthError('Unknown stats section.')
        with self.lock,self.db() as db:
            if is_hidden:
                db.execute('INSERT OR IGNORE INTO stats_sections VALUES (?,?)',(user_id,section))
            else:
                db.execute('DELETE FROM stats_sections WHERE user_id=? AND section=?',(user_id,section))
        return self.stats_sections(user_id)

    def set_favourite(self,user_id,game_id,saved):
        with self.lock,self.db() as db:
            if saved:
                if db.execute('SELECT count(*) FROM favourites WHERE user_id=?',(user_id,)).fetchone()[0]>=10000:
                    raise AuthError('Favorite limit reached.')
                db.execute('INSERT OR IGNORE INTO favourites VALUES (?,?)',(user_id,game_id))
            else:
                db.execute('DELETE FROM favourites WHERE user_id=? AND game_id=?',(user_id,game_id))
        return self.favourites(user_id)

    def branding(self):
        with self.db() as db:
            row=db.execute("SELECT value FROM settings WHERE key='site_name'").fetchone()
            return {'name':row[0] if row else 'Pinball Library'}

    def set_name(self, name):
        if not isinstance(name,str) or not 1 <= len(name.strip()) <= 60 or any(ord(c)<32 for c in name):
            raise AuthError('Use a dashboard name of 1-60 characters.')
        with self.db() as db:
            db.execute("INSERT INTO settings VALUES ('site_name',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",(name.strip(),))
