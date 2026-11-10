#!/usr/bin/env python3
"""
vpin-dashboard - self-hosted server.

Runs on the Docker host under Dockhand (CasaOS-style compose, official
Python image, no Dockerfile). It serves the library + stats web UI
and a small JSON API that talks to the vpin bridge:

  VPIN_BRIDGE_URL  base URL of the vpin bridge on the home network
  VPIN_API_KEY     the bridge API key (same value the bridge calls
                   API_KEY in its own Dockhand Environment)
  PORT             listen port inside the container (default 8080)

Endpoints:
  GET  /              the web UI (index.html beside this file)
  GET  /api/library   tables + scores + playlists merged from the
                      bridge (/api/games/json, /api/highscores,
                      /api/playlists)
  GET  /api/status    bridge /health + cabinet /api/status merged
  GET  /api/details/<gameId>   allowlisted descriptive table details
  GET  /api/thumb/<gameId>     playfield picture (PNG or JPEG)
                      for a table, cached under /data/thumbs.
                      Streamed from VPin Studio through the vpin
                      bridge; VPin Studio extracts a frame itself
                      when the PlayField media is a video. 404
                      when no picture is available.
  POST /api/play      {"gameId": int} -> bridge POST /api/play,
                      which launches the table on the cabinet
                      through VPin Studio. Refused by the bridge
                      (409) while a game is already playing.

No key or cabinet address is ever stored in this file or the repo;
both come from the Dockhand Environment at runtime.
"""
import base64
import hmac
import re
import stat
from http.cookies import SimpleCookie
from auth import AuthStore, AuthError
import csv
import io
import json
import os
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

PORT = int(os.environ.get("PORT", "8080"))
BRIDGE_URL = os.environ.get("VPIN_BRIDGE_URL", "").rstrip("/")
API_KEY = os.environ.get("VPIN_API_KEY", "")
THUMB_ROOT = os.environ.get("THUMB_DIR", "/data/thumbs")
THUMB_DIR = os.path.join(THUMB_ROOT, "upright-v1")
# Pillow is installed once into this folder on first use, so the app
# files alone (pulled from the repo on restart) are enough: no
# compose change and no repeated install cost.
PYLIBS = os.path.join(os.path.dirname(THUMB_ROOT.rstrip("/")) or "/", "pylibs")
if os.path.isdir(PYLIBS) and PYLIBS not in sys.path:
    sys.path.insert(0, PYLIBS)
HERE = os.path.dirname(os.path.abspath(__file__))
AUTH_DIR = os.environ.get("AUTH_DIR", "/data/auth")
INSTRUCTIONS_PATH = os.path.join(os.path.dirname(AUTH_DIR), "instructions.md")
AUTH = None
_AUTH_LOCK = threading.Lock()

def auth_store():
    global AUTH
    with _AUTH_LOCK:
        if AUTH is None:
            AUTH = AuthStore(AUTH_DIR)
    return AUTH

def read_instructions():
    try:
        fd = os.open(INSTRUCTIONS_PATH, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, "rb") as source:
            info = os.fstat(source.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_size > 65536:
                return {"ok":False,"error":"Instructions must be a regular UTF-8 file under 64 KB."}
            data=source.read(65537)
            if len(data)>65536:
                return {"ok":False,"error":"Instructions exceed the 64 KB limit."}
            return {"ok":True,"text":data.decode("utf-8"),"configured":True}
    except FileNotFoundError:
        return {"ok":True,"text":"","configured":False}
    except (OSError,UnicodeError):
        return {"ok":False,"error":"Instructions could not be read. Check the file format and permissions."}

def public_started(value):
    if not isinstance(value,str) or len(value)>64:
        return None
    try:
        parsed=datetime.fromisoformat(value.replace('Z','+00:00'))
        if parsed.tzinfo is None or parsed.timestamp()>time.time()+5:
            return None
        return parsed.isoformat()
    except (ValueError,OverflowError,OSError):
        return None

def public_text(value):
    text = str(value)[:2000]
    if (API_KEY and API_KEY in text) or re.search(r"https?://|www\.|[A-Za-z]:[\\/]|\\\\[\w.-]+\\|(?:^|\s)/(?:[\w.-]+/)+|\b(?:\d{1,3}\.){3}\d{1,3}\b|\b[\w-]+\.(?:[a-z]{2,63})\b|[\w.+-]+@[\w.-]+|(?:api[_ -]?key|password|secret|bearer)\s*[:=]", text, re.I):
        return "[Private field hidden]"
    return text

def safe_value(value):
    if isinstance(value, str): return public_text(value)
    if isinstance(value, list): return [safe_value(x) for x in value]
    if isinstance(value, dict): return {public_text(k):safe_value(v) for k,v in value.items()}
    return value

def safe_history(value):
    def score(s):
        return {k:safe_value(v) for k,v in s.items() if k in {"position","playerInitials","score","label","suffix"}} if isinstance(s, dict) else {}
    if not isinstance(value, dict) or not isinstance(value.get("scores"),list):
        return {"scores":[]}
    return {"scores":[{"createdAt":public_text(h.get("createdAt", "")),"scores":[score(s) for s in h.get("scores",[]) if isinstance(s,dict)]} for h in value["scores"] if isinstance(h,dict) and isinstance(h.get("scores"),list)]}


def bridge(method, path, payload=None, timeout=30):
    if not BRIDGE_URL:
        raise RuntimeError("VPIN_BRIDGE_URL is not set in Dockhand Environment")
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(BRIDGE_URL + path, data=data, method=method)
    req.add_header("X-Api-Key", API_KEY)
    req.add_header("Accept", "application/json")
    if data:
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = resp.read()
        try:
            return json.loads(body.decode("utf-8"))
        except Exception:
            return {"raw": body.decode("utf-8", "replace")}


def pick(obj, *keys):
    for key in keys:
        value = obj.get(key)
        if value is not None and value != "":
            return value
    return None


def as_year(value):
    try:
        year = int(value)
    except (TypeError, ValueError):
        return None
    return year if 1900 <= year <= 2100 else None


def as_play_count(value):
    """Negative means unreported, not an unplayed table."""
    try:
        n = int(value)
        return n if n >= 0 else None
    except (TypeError, ValueError):
        return None


def parse_raw_scores(text):
    """Parse the cabinet semicolon high-score export: all 10 slots."""
    out = []
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("gameId;"):
            continue
        fields = line.split(";")
        if len(fields) < 5:
            continue
        try:
            game_id = int(fields[0].strip())
        except ValueError:
            continue
        for slot in range(10):
            initials = fields[3 + slot * 2].strip() if len(fields) > 3 + slot * 2 else ""
            score_raw = fields[4 + slot * 2].strip().replace(",", "") if len(fields) > 4 + slot * 2 else ""
            if not score_raw:
                continue
            try:
                score = int(score_raw)
            except ValueError:
                continue
            if score > 0:
                out.append({
                    "gameId": game_id,
                    "score": score,
                    "initials": initials or None,
                    "rank": slot + 1,
                })
    return out


def parse_cabinet_dt(value):
    """Cabinet export dates look like 'Nov 8, 2026, 3:41:42 PM'."""
    if not value:
        return None
    value = value.replace("\u202f", " ").replace("\u00a0", " ").strip()
    for fmt in ("%b %d, %Y, %I:%M:%S %p", "%b %d, %Y, %I:%M %p"):
        try:
            return datetime.strptime(value, fmt).strftime("%Y-%m-%dT%H:%M:%S")
        except ValueError:
            continue
    return None


def parse_games_export(text):
    """Parse the cabinet semicolon tables export (bridge /api/games).

    One header row of field names, then one row per table. The
    export merges the games fields and the table-details fields,
    so it is the only bridge payload that carries manufacturer and
    gameYear; /api/games/json has neither. Feature badges come
    from directB2SFile / rom / altColorType / pupPackInstalled.
    Returns {gameId: {name, maker, year, badges, lastPlayedAt}}.
    """
    out = {}
    if not text:
        return out
    try:
        rows = list(csv.reader(io.StringIO(text), delimiter=";"))
    except Exception:
        return out
    if not rows:
        return out
    hdr = rows[0]

    def idx(name, occ=0):
        hits = [i for i, h in enumerate(hdr) if h == name]
        return hits[occ] if len(hits) > occ else -1

    cols = {k: idx(k) for k in (
        "id", "manufacturer", "gameYear", "directB2SFile", "rom",
        "romName", "altColorType", "pupPackInstalled", "pupPackName",
        "lastPlayed", "modified", "dateModified", "numberPlayed", "numberPlays",
    )}
    cols["name"] = idx("gameDisplayName", 0)

    def cell(r, i):
        return r[i].strip() if 0 <= i < len(r) else ""

    for r in rows[1:]:
        try:
            gid = int(cell(r, cols["id"]))
        except ValueError:
            continue
        badges = []
        if cell(r, cols["directB2SFile"]).lower() == "true":
            badges.append("B2S")
        if cell(r, cols["rom"]) or cell(r, cols["romName"]):
            badges.append("ROM")
        if cell(r, cols["pupPackInstalled"]).lower() == "true" or cell(r, cols["pupPackName"]):
            badges.append("PUP")
        if cell(r, cols["altColorType"]):
            badges.append("Color")
        out[gid] = {
            "name": cell(r, cols["name"]) or None,
            "maker": cell(r, cols["manufacturer"]) or None,
            "year": as_year(cell(r, cols["gameYear"])),
            "badges": badges,
            "lastPlayedAt": parse_cabinet_dt(cell(r, cols["lastPlayed"])),
            "playCount": as_play_count(cell(r, cols["numberPlayed"]))
            if as_play_count(cell(r, cols["numberPlayed"])) is not None
            else as_play_count(cell(r, cols["numberPlays"])),
            "modifiedAt": parse_cabinet_dt(cell(r, cols["modified"]))
            or parse_cabinet_dt(cell(r, cols["dateModified"])),
        }
    return out


def library_payload():
    games_raw = bridge("GET", "/api/games/json")
    games = games_raw if isinstance(games_raw, list) else []
    export = {}
    try:
        exp = bridge("GET", "/api/games")
        if isinstance(exp, dict) and isinstance(exp.get("raw"), str):
            export = parse_games_export(exp["raw"])
    except Exception:
        export = {}
    tables = []
    seen = set()
    for g in games:
        if not isinstance(g, dict):
            continue
        game_id = pick(g, "id", "gameId")
        if game_id is None:
            continue
        game_id = int(game_id)
        seen.add(game_id)
        ex = export.get(game_id, {})
        tables.append({
            "gameId": game_id,
            "launchable": game_id > 0,
            "name": pick(g, "gameDisplayName", "gameName", "name") or ex.get("name") or f"Table {game_id}",
            "maker": ex.get("maker") or pick(g, "manufacturer", "vendor", "maker", "brand"),
            "year": ex.get("year") or as_year(pick(g, "year", "releaseYear", "gameYear")),
            "badges": ex.get("badges", []),
            "needsAttention": bool(ex) and "B2S" not in ex.get("badges", []),
            "tags": g.get("tags") if isinstance(g.get("tags"), list) else [],
            "lastPlayedAt": ex.get("lastPlayedAt"),
            "playCount": as_play_count(g.get("numberPlayed"))
            if as_play_count(g.get("numberPlayed")) is not None
            else ex.get("playCount"),
            "addedAt": pick(g, "dateAdded"),
            "mediaRevision": str(g.get("modified") or ex.get("modifiedAt") or ""),
        })
    for game_id, ex in export.items():
        if game_id in seen:
            continue
        tables.append({
            "gameId": game_id,
            "launchable": False,
            "name": ex.get("name") or f"Table {game_id}",
            "maker": ex.get("maker"),
            "year": ex.get("year"),
            "badges": ex.get("badges", []),
            "needsAttention": "B2S" not in ex.get("badges", []),
            "tags": [],
            "lastPlayedAt": ex.get("lastPlayedAt"),
            "playCount": ex.get("playCount"),
            "addedAt": ex.get("modifiedAt"),
            "mediaRevision": str(ex.get("modifiedAt") or ""),
        })

    scores = []
    try:
        hs = bridge("GET", "/api/highscores")
        if isinstance(hs, dict) and isinstance(hs.get("highscores"), list):
            for e in hs["highscores"]:
                if not isinstance(e, dict):
                    continue
                try:
                    scores.append({
                        "gameId": int(e.get("gameId")),
                        "score": int(e.get("score")),
                        "initials": e.get("playerInitials") or None,
                        "rank": 1,
                    })
                except (TypeError, ValueError):
                    continue
        elif isinstance(hs, dict) and isinstance(hs.get("raw"), str):
            scores = parse_raw_scores(hs["raw"])
    except Exception:
        scores = []

    playlists = []
    try:
        pls = bridge("GET", "/api/playlists")
        if isinstance(pls, list):
            for p in pls:
                if not isinstance(p, dict):
                    continue
                members = pick(p, "gameIds", "games", "game_ids") or []
                ids = []
                for m in members if isinstance(members, list) else []:
                    if isinstance(m, int):
                        ids.append(m)
                    elif isinstance(m, dict) and isinstance(m.get("id"), int):
                        ids.append(m["id"])
                playlists.append({
                    "id": pick(p, "id", "playlistId"),
                    "name": pick(p, "name", "playlistName") or "Playlist",
                    "gameIds": ids,
                })
    except Exception:
        playlists = []

    return {
        "ok": True,
        "tables": tables,
        "scores": scores,
        "playlists": playlists,
        "thumbsEnabled": True,
    }


def bridge_bytes(path, timeout=60):
    """Raw bridge call for endpoints that return files, not JSON."""
    if not BRIDGE_URL:
        raise RuntimeError("VPIN_BRIDGE_URL is not set in Dockhand Environment")
    req = urllib.request.Request(BRIDGE_URL + path, method="GET")
    req.add_header("X-Api-Key", API_KEY)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.headers.get("Content-Type", ""), resp.read()


_thumb_failures = {}
_thumb_failure_reasons = {}
_thumb_lock = threading.Lock()


def fetch_thumb(game_id, force_source=False):
    """(card, detail) for a cached playfield picture, or (None, None).

    Each entry is (content_type, path): card is a small JPEG for the
    grid, detail a sharper one for the dialog. The source comes from
    the vpin bridge (GET /api/thumb/<id>), which streams VPin
    Studio's PlayField media; VPin Studio extracts a PNG frame
    itself when the PlayField is a video, so no file or shell access
    on the cabinet is needed. PlayField frames come back turned
    sideways (landscape), so they are rotated upright once, cached
    at both sizes under /data/thumbs, and the full-size source is
    never sent to the browser. Failures are remembered for 10
    minutes so a missing picture costs one attempt, not one per
    page view. Invalid images or an unavailable decoder return no
    picture rather than silently caching sideways originals.
    """
    card = os.path.join(THUMB_DIR, f"{game_id}.jpg")
    detail = os.path.join(THUMB_DIR, f"{game_id}-large.jpg")
    hit = _thumb_cache_hit(card, detail)
    if hit and not force_source:
        return hit
    with _thumb_lock:
        hit = _thumb_cache_hit(card, detail)
        if hit and not force_source:
            return hit
        failed_at = _thumb_failures.get(game_id)
        if failed_at and not force_source and time.time() - failed_at < 600:
            return None, None
        failure_reason = "Source timeout or connection failed"
        try:
            legacy = os.path.join(THUMB_ROOT, f"{game_id}.img")
            if not force_source and os.path.isfile(legacy) and os.path.getsize(legacy) > 1000:
                with open(legacy, "rb") as f:
                    data = f.read()
                ctype = "image/legacy"
            else:
                ctype, data = bridge_bytes(f"/api/thumb/{game_id}")
            if not ctype.startswith("image/"):
                failure_reason = "Source response is not an image"
                raise ValueError()
            if len(data) <= 1000:
                failure_reason = "Source image is missing or too small"
                raise ValueError()
            os.makedirs(THUMB_DIR, exist_ok=True)
            if not _store_normalized(card, detail, data):
                failure_reason = "Image decoder or normalization failed"
                raise ValueError()
            return _thumb_cache_hit(card, detail) or (None, None)
        except Exception as exc:
            _thumb_failures[game_id] = time.time()
            reason = f"Source HTTP {exc.code}" if isinstance(exc,urllib.error.HTTPError) else failure_reason
            _thumb_failure_reasons[game_id] = reason
            return None, None


def _thumb_cache_hit(card, detail):
    try:
        if os.path.isfile(card) and os.path.getsize(card) > 1000 \
                and os.path.isfile(detail) and os.path.getsize(detail) > 1000:
            return ("image/jpeg", card), ("image/jpeg", detail)
    except OSError:
        pass
    return None


_pillow_attempted = False


def _ensure_pillow():
    global _pillow_attempted
    try:
        import PIL.Image  # noqa
        return True
    except ImportError:
        pass
    if _pillow_attempted:
        return False
    _pillow_attempted = True
    try:
        os.makedirs(PYLIBS, exist_ok=True)
        subprocess.run(
            [sys.executable, "-m", "pip", "install", "--quiet",
             "--only-binary=:all:", "--target", PYLIBS, "pillow==12.0.0"],
            timeout=120, check=False,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if PYLIBS not in sys.path:
            sys.path.insert(0, PYLIBS)
        import PIL.Image  # noqa
        return True
    except Exception:
        return False


def _store_normalized(card_path, detail_path, data):
    """Rotate upright if sideways, then save card (480px) and detail
    (960px) JPEGs. Returns False when Pillow is unavailable."""
    if not _ensure_pillow():
        return False
    try:
        from PIL import Image, ImageOps
        img = ImageOps.exif_transpose(Image.open(io.BytesIO(data)))
        img.load()
        img = img.convert("RGB")
        if img.width > img.height:
            # Playfield media is stored turned 90 degrees
            # counterclockwise; rotating CW puts the flippers back
            # at the bottom. Already-upright (portrait) pictures
            # are left alone.
            img = img.transpose(Image.Transpose.ROTATE_270)
        for path, width, quality in ((card_path, 480, 82), (detail_path, 960, 85)):
            out = img
            if img.width > width:
                out = img.resize((width, round(img.height * width / img.width)), Image.Resampling.LANCZOS)
            out.save(path + ".tmp", "JPEG", quality=quality)
            os.replace(path + ".tmp", path)
        return True
    except Exception:
        return False



_cache_state_lock = threading.Lock()
_cache_state = {"running": False, "done": 0, "total": 0, "failed": 0, "paused": False, "failedTables": []}


def start_thumb_cache(tables, full=False):
    with _cache_state_lock:
        if _cache_state["running"]:
            raise AuthError("An image sync is already running. Wait for it to finish.",409)
        _cache_state.update(running=True, done=0, total=len(tables), failed=0, paused=False, failedTables=[])
    threading.Thread(target=_warm_thumbs, args=(tables,full), daemon=True).start()
    return dict(_cache_state)


def _warm_thumbs(tables, full=False):
    try:
        os.makedirs(THUMB_DIR, exist_ok=True)
        for table in tables:
            game_id = table["gameId"]
            revision = str(table.get("mediaRevision") or "")
            stamp = os.path.join(THUMB_DIR, f"{game_id}.revision.json")
            old = None
            try:
                with open(stamp) as f:
                    old = json.load(f)
            except (OSError, ValueError):
                pass
            card = os.path.join(THUMB_DIR, f"{game_id}.jpg")
            detail = os.path.join(THUMB_DIR, f"{game_id}-large.jpg")
            changed = old is not None and old != revision
            cached = _thumb_cache_hit(card, detail)
            retry = game_id in _thumb_failures
            if full or changed or retry or not cached:
                # Status must be known idle before any uncached upstream work.
                while True:
                    try:
                        status = bridge("GET", "/api/status")
                        idle = isinstance(status, dict) and "gameId" in status and int(status["gameId"]) <= 0
                    except Exception:
                        idle = False
                    with _cache_state_lock:
                        _cache_state["paused"] = not idle
                    if idle:
                        break
                    time.sleep(10)
                with _thumb_lock:
                    _thumb_failures.pop(game_id,None)
                    _thumb_failure_reasons.pop(game_id,None)
                # Keep the previous image on disk until replacement succeeds.
                cached = fetch_thumb(game_id, force_source=full or changed or retry)
            success = bool(cached and cached[0])
            if success:
                with open(stamp + ".tmp", "w") as f:
                    json.dump(revision, f)
                os.replace(stamp + ".tmp", stamp)
            with _cache_state_lock:
                _cache_state["done"] += 1
                _cache_state["failed"] += not success
                if not success:
                    _cache_state["failedTables"].append({"gameId":game_id,"reason":_thumb_failure_reasons.get(game_id,"No usable preview")})
            time.sleep(.25)
    finally:
        with _cache_state_lock:
            _cache_state.update(running=False, paused=False)


class Handler(BaseHTTPRequestHandler):
    server_version = "vpin-dashboard"
    sys_version = ""

    def setup(self):
        super().setup()
        self.connection.settimeout(15)

    def log_message(self, *args):
        pass

    def end_headers(self):
        self.send_header("Cache-Control", "private, no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("X-Robots-Tag", "noindex, nofollow, noarchive, nosnippet")
        self.send_header("Strict-Transport-Security", "max-age=31536000")
        self.send_header("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; object-src 'none'")
        self.send_header("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
        super().end_headers()

    def _session(self):
        try:
            cookie = SimpleCookie(self.headers.get("Cookie", ""))
            return auth_store().session(cookie["__Host-vpin_session"].value) if "__Host-vpin_session" in cookie else None
        except Exception:
            return None

    def _require(self, admin=False):
        session = self._session()
        if not session:
            self._send(401, {"ok":False,"error":"Sign in required."})
            return None
        if admin and session['role'] != 'admin':
            self._send(403, {"ok":False,"error":"Admin access required."})
            return None
        return session

    def _csrf(self, session):
        supplied = self.headers.get('X-CSRF-Token', '')
        return bool(supplied) and hmac.compare_digest(supplied,session['csrf'])

    def _body(self):
        if self.headers.get('Transfer-Encoding'):
            raise AuthError('Transfer encoding is not supported.',400)
        if self.headers.get('Content-Type','').split(';')[0].strip() != 'application/json':
            raise AuthError('JSON content required.',415)
        try:
            length = int(self.headers.get('Content-Length','0'))
        except ValueError:
            raise AuthError('Invalid request length.')
        if not 0 < length <= 200000:
            raise AuthError('Request body too large or empty.',413)
        try:
            body = json.loads(self.rfile.read(length).decode('utf-8'))
        except (ValueError,UnicodeError):
            raise AuthError('Invalid JSON.')
        if not isinstance(body,dict):
            raise AuthError('JSON object required.')
        return body

    def _cookie(self, value):
        self.send_header('Set-Cookie', '__Host-vpin_session=' + value + '; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=' + str(AuthStore.SESSION_SECONDS if value else 0))

    def _auth_reply(self, cookie):
        data = b'{"ok":true}'
        self.send_response(200)
        self._cookie(cookie)
        self.send_header('Content-Type','application/json')
        self.send_header('Content-Length',str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _send(self, code, obj):
        data = json.dumps(obj).encode("utf-8") if not isinstance(obj, bytes) else obj
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _send_html(self, path):
        try:
            with open(path, "rb") as f:
                data = f.read()
        except OSError:
            return self._send(404, {"ok": False, "error": "index.html not found"})
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _send_file(self, path, content_type):
        try:
            if path in (os.path.join(HERE,'brand-default.png'),os.path.join(HERE,'favicon-default.png')):
                with open(path+'.b64','rb') as f:
                    data=base64.b64decode(f.read(),validate=False)
            else:
                with open(path, "rb") as f:
                    data = f.read()
        except (OSError,ValueError):
            return self._send(404, {"ok": False, "error": "not found"})
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = urlparse(self.path).path
        if path == '/brand-default.png':
            return self._send_file(os.path.join(HERE,'brand-default.png'),'image/png')
        if path in ('/favicon.png','/favicon.ico'):
            custom = os.path.join(AUTH_DIR,'site-logo.png')
            target = custom if self._session() and os.path.isfile(custom) else os.path.join(HERE,'favicon-default.png')
            return self._send_file(target,'image/png')
        if path == '/robots.txt':
            return self._send_text(200,b'User-agent: *\nDisallow: /\n','text/plain')
        if path in ('/login','/login.html'):
            return self._send_html(os.path.join(HERE,'login.html'))
        if path == '/login.js':
            return self._send_text_file('login.js','application/javascript')
        if path == '/api/auth/status':
            session = self._session()
            return self._send(200, {'ok':True,'setupRequired':auth_store().needs_setup(),'user':{k:session[k] for k in ('id','username','role','csrf')} if session else None})
        if path in ("/", "/index.html"):
            if not self._session():
                self.send_response(303)
                self.send_header('Location','/login')
                self.send_header('Content-Length','0')
                self.end_headers()
                return
            return self._send_html(os.path.join(HERE, "index.html"))
        if not self._require(admin=path == '/api/admin/users'):
            return
        if path == '/app.js':
            return self._send_text_file('app.js','application/javascript')
        if path == '/api/preferences':
            return self._send(200,{'ok':True,**auth_store().preferences(self._session()['id'])})
        if path == '/api/favourites':
            return self._send(200,{'ok':True,'gameIds':auth_store().favourites(self._session()['id'])})
        if path == '/api/instructions':
            return self._send(200,read_instructions())
        if path == '/api/settings':
            return self._send(200,auth_store().branding())
        if path == '/api/settings/logo':
            logo = os.path.join(AUTH_DIR,'site-logo.png')
            if os.path.isfile(logo):
                return self._send_file(logo,'image/png')
            return self._send_file(os.path.join(HERE,'brand-default.png'),'image/png')
        if path == '/api/admin/users':
            return self._send(200,{'ok':True,'users':auth_store().list_users()})
        try:
            if path == "/api/cache-thumbs":
                with _cache_state_lock:
                    state = dict(_cache_state)
                if self._session()['role'] != 'admin':
                    state.pop('failedTables',None)
                return self._send(200,state)
            if path == "/api/library":
                return self._send(200, safe_value(library_payload()))
            if path == "/api/status":
                health = bridge("GET", "/health")
                status = {}
                try:
                    status = bridge("GET", "/api/status")
                except Exception:
                    status = {}
                return self._send(200, {"ok": True, "health": {k:bool(health.get(k)) for k in ("cabinet_reachable","game_playing")}, "status": {"gameId":int(status.get("gameId") or 0),"started":public_started(status.get("started")) if int(status.get("gameId") or 0)>0 else None}})
            parts = [p for p in path.split("/") if p]
            if len(parts) == 3 and parts[0] == "api" and parts[1] == "thumb":
                try:
                    thumb_id = int(parts[2])
                except ValueError:
                    return self._send(400, {"ok": False, "error": "bad table id"})
                card, detail = fetch_thumb(thumb_id)
                pick = detail if parse_qs(urlparse(self.path).query).get("full") == ["1"] else card
                if pick is None:
                    return self._send(404, {"ok": False, "error": "no playfield picture available"})
                return self._send_file(pick[1], pick[0])
            if len(parts) == 3 and parts[0] == "api" and parts[1] == "scorehistory":
                try:
                    game_id = int(parts[2])
                    if game_id <= 0:
                        raise ValueError()
                except ValueError:
                    return self._send(400, {"ok": False, "error": "bad table id"})
                return self._send(200, safe_history(bridge("GET", f"/api/scorehistory/{game_id}")))
            if len(parts) == 3 and parts[0] == "api" and parts[1] == "details":
                try:
                    game_id = int(parts[2])
                    if game_id <= 0: raise ValueError()
                except ValueError:
                    return self._send(400,{"ok":False,"error":"bad table id"})
                details = bridge("GET", f"/api/details/{game_id}")
                allowed = {'author','designedBy','gameDisplayName','gameName','gameRating','gameTheme','gameType','gameVersion','gameYear','manufacturer','numberOfPlayers','numberPlays','category','extraDetails'}
                clean = {k:safe_value(v) for k,v in details.items() if k in allowed and isinstance(v,(str,int,float,bool))} if isinstance(details,dict) else {}
                return self._send(200, {"ok": True, "details":clean})
            return self._send(404, {"ok": False, "error": "not found"})
        except urllib.error.HTTPError as e:
            return self._send(e.code, {"ok": False, "error": f"bridge HTTP {e.code}"})
        except Exception as e:
            return self._send(502, {"ok": False, "error": "The cabinet service is unavailable."})

    def _send_text(self, code, data, ctype):
        self.send_response(code)
        self.send_header('Content-Type',ctype)
        self.send_header('Content-Length',str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _send_text_file(self, name, ctype):
        with open(os.path.join(HERE,name),'rb') as f:
            return self._send_text(200,f.read(),ctype)

    def do_POST(self):
        path = urlparse(self.path).path
        try:
            # A non-simple custom header plus application/json prevents login
            # and bootstrap CSRF. No cross-origin CORS responses are issued.
            if path in ('/api/auth/login','/api/auth/setup'):
                if self.headers.get('X-Vpin-Request') != '1' or self.headers.get('Sec-Fetch-Site') == 'cross-site':
                    raise AuthError('Same-origin request required.',403)
                body = self._body()
                store = auth_store()
                cookie = store.setup(body,self.client_address[0]) if path.endswith('/setup') else store.login(body.get('username'),body.get('password'),self.client_address[0])
                return self._auth_reply(cookie)
            session = self._require(admin=path not in ('/api/auth/logout','/api/favourites','/api/preferences'))
            if not session:
                return
            if not self._csrf(session) or self.headers.get('Sec-Fetch-Site') == 'cross-site':
                raise AuthError('Session check failed. Reload and try again.',403)
            body = self._body()
            if path == '/api/auth/logout':
                auth_store().logout(session)
                return self._auth_reply('')
            if path == '/api/preferences':
                if not set(body) or not set(body)<={'colorblind','showTimer'} or any(type(v) is not bool for v in body.values()):
                    raise AuthError('Valid display preferences required.')
                store=auth_store();store.personal_write_throttle(session['id'])
                current=store.preferences(session['id']);current.update(body)
                return self._send(200,{'ok':True,**store.set_preferences(session['id'],current['colorblind'],current['showTimer'])})
            if path == '/api/favourites':
                game_id=body.get('gameId');saved=body.get('saved')
                if type(game_id) is not int or not 0<game_id<=2147483647 or type(saved) is not bool:
                    raise AuthError('Valid table ID and saved state required.')
                if set(body)!={'gameId','saved'}:
                    raise AuthError('Only table ID and saved state are accepted.')
                store=auth_store();store.personal_write_throttle(session['id'])
                # Removing a stale favourite must still work after a table is uninstalled.
                if saved and not any(t['gameId']==game_id for t in library_payload()['tables']):
                    raise AuthError('Table is not in the cabinet library.',404)
                return self._send(200,{'ok':True,'gameIds':store.set_favourite(session['id'],game_id,saved)})
            if path == '/api/settings':
                name = body.get('name')
                if public_text(name) != name:
                    raise AuthError('Do not include server addresses or secrets in the dashboard name.')
                logo = body.get('logo')
                data = None
                if logo is not None:
                    if not isinstance(logo,str) or len(logo)>150000:
                        raise AuthError('Logo is too large.')
                    try:
                        data=base64.b64decode(logo,validate=True)
                        if not _ensure_pillow():
                            raise AuthError('Image decoder is unavailable.',503)
                        from PIL import Image
                        with Image.open(io.BytesIO(data)) as img:
                            if img.format not in ('PNG','JPEG') or img.width>2048 or img.height>2048 or img.width<1 or img.height<1:
                                raise ValueError()
                            img.load()
                            img=img.convert('RGBA')
                            img.thumbnail((256,256))
                            output=io.BytesIO()
                            img.save(output,'PNG')
                            data=output.getvalue()
                    except AuthError:
                        raise
                    except Exception:
                        raise AuthError('Valid PNG or JPEG logo required.')
                auth_store().set_name(name)
                if data is not None:
                    with _AUTH_LOCK:
                        target=os.path.join(AUTH_DIR,'site-logo.png')
                        with open(target+'.tmp','wb') as f: f.write(data)
                        os.chmod(target+'.tmp',0o600)
                        os.replace(target+'.tmp',target)
                return self._send(200,{'ok':True})
            if path == '/api/admin/users':
                auth_store().create_user(body)
                return self._send(201,{'ok':True})
            if re.fullmatch(r'/api/admin/users/[0-9]+',path):
                auth_store().update_user(int(path.rsplit('/',1)[1]),body,session)
                return self._send(200,{'ok':True})
            if path == '/api/cache-thumbs':
                tables = body.get('tables')
                if not isinstance(tables,list) or len(tables)>10000:
                    raise AuthError('Valid table list required.')
                try:
                    items = [{'gameId':int(t['gameId']),'mediaRevision':str(t.get('mediaRevision') or '')[:200]} for t in tables]
                    if any(t['gameId']<=0 or t['gameId']>2147483647 for t in items): raise ValueError()
                except (ValueError,KeyError,TypeError,OverflowError):
                    raise AuthError('Valid table list required.')
                full = body.get('full',False)
                if type(full) is not bool:
                    raise AuthError('Invalid resync mode.')
                return self._send(202,start_thumb_cache(items,full=full))
            if path == '/api/play':
                try:
                    game_id = int(body.get('gameId'))
                    if game_id<=0 or game_id>2147483647: raise ValueError()
                except (ValueError,TypeError,OverflowError):
                    raise AuthError('Valid gameId required.')
                health = bridge('GET','/health')
                if not isinstance(health,dict) or health.get('cabinet_reachable') is not True:
                    raise AuthError('Cabinet is offline or not detected.',503)
                status = bridge('GET','/api/status')
                if health.get('game_playing') or not isinstance(status,dict) or 'gameId' not in status or int(status['gameId'])>0:
                    raise AuthError('Cabinet is busy or its state is unknown.',409)
                games = bridge('GET','/api/games/json')
                valid = isinstance(games,list) and any(isinstance(g,dict) and str(g.get('id',g.get('gameId'))) == str(game_id) for g in games)
                if not valid:
                    raise AuthError('No launchable table was detected for this entry.',404)
                bridge('POST','/api/play',{'gameId':game_id})
                return self._send(200,{'ok':True})
            return self._send(404,{'ok':False,'error':'Not found.'})
        except AuthError as e:
            return self._send(e.status,{'ok':False,'error':str(e)})
        except urllib.error.HTTPError as e:
            code = e.code if e.code in (404,409,502,503,504) else 502
            return self._send(code,{'ok':False,'error':'Cabinet is busy.' if code==409 else 'The cabinet request failed.'})
        except Exception:
            return self._send(502,{'ok':False,'error':'The request could not be completed.'})


class LimitedServer(ThreadingHTTPServer):
    """Bound request concurrency so slow clients cannot spawn endless threads."""
    daemon_threads = True
    request_queue_size = 32
    slots = threading.BoundedSemaphore(24)

    def process_request(self, request, client_address):
        if not self.slots.acquire(blocking=False):
            request.close()
            return
        try:
            super().process_request(request,client_address)
        except Exception:
            self.slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request,client_address)
        finally:
            self.slots.release()


if __name__ == "__main__":
    if not API_KEY:
        print("vpin-dashboard refusing to start: VPIN_API_KEY is not set in Dockhand Environment", flush=True)
        raise SystemExit(1)
    try:
        os.makedirs("/data", exist_ok=True)
        os.makedirs(THUMB_DIR, exist_ok=True)
    except Exception:
        pass
    auth_store()
    print(f"vpin-dashboard listening on :{PORT}; HTTPS is required for login", flush=True)
    LimitedServer(("0.0.0.0", PORT), Handler).serve_forever()
