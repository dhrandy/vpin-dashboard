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
  GET  /api/details/<gameId>   bridge table details + media
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
    if hit:
        return hit
    with _thumb_lock:
        hit = _thumb_cache_hit(card, detail)
        if hit:
            return hit
        failed_at = _thumb_failures.get(game_id)
        if failed_at and time.time() - failed_at < 600:
            return None, None
        try:
            legacy = os.path.join(THUMB_ROOT, f"{game_id}.img")
            if not force_source and os.path.isfile(legacy) and os.path.getsize(legacy) > 1000:
                with open(legacy, "rb") as f:
                    data = f.read()
                ctype = "image/legacy"
            else:
                ctype, data = bridge_bytes(f"/api/thumb/{game_id}")
            if not ctype.startswith("image/") or len(data) <= 1000:
                raise RuntimeError("no playfield picture available")
            os.makedirs(THUMB_DIR, exist_ok=True)
            if not _store_normalized(card, detail, data):
                raise RuntimeError("playfield normalization failed")
            return _thumb_cache_hit(card, detail) or (None, None)
        except Exception:
            _thumb_failures[game_id] = time.time()
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
_cache_state = {"running": False, "done": 0, "total": 0, "failed": 0, "paused": False}


def start_thumb_cache(tables):
    with _cache_state_lock:
        if _cache_state["running"]:
            return dict(_cache_state)
        _cache_state.update(running=True, done=0, total=len(tables), failed=0, paused=False)
    threading.Thread(target=_warm_thumbs, args=(tables,), daemon=True).start()
    return dict(_cache_state)


def _warm_thumbs(tables):
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
            if changed or not cached:
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
                if changed:
                    with _thumb_lock:
                        for path in (card, detail):
                            try:
                                os.remove(path)
                            except FileNotFoundError:
                                pass
                        _thumb_failures.pop(game_id, None)
                cached = fetch_thumb(game_id, force_source=changed)
            success = bool(cached and cached[0])
            if success:
                with open(stamp + ".tmp", "w") as f:
                    json.dump(revision, f)
                os.replace(stamp + ".tmp", stamp)
            with _cache_state_lock:
                _cache_state["done"] += 1
                _cache_state["failed"] += not success
            time.sleep(.25)
    finally:
        with _cache_state_lock:
            _cache_state.update(running=False, paused=False)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

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
            with open(path, "rb") as f:
                data = f.read()
        except OSError:
            return self._send(404, {"ok": False, "error": "not found"})
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "max-age=86400")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = urlparse(self.path).path
        if path in ("/", "/index.html"):
            return self._send_html(os.path.join(HERE, "index.html"))
        try:
            if path == "/api/cache-thumbs":
                with _cache_state_lock:
                    return self._send(200, dict(_cache_state))
            if path == "/api/library":
                return self._send(200, library_payload())
            if path == "/api/status":
                health = bridge("GET", "/health")
                status = {}
                try:
                    status = bridge("GET", "/api/status")
                except Exception:
                    status = {}
                return self._send(200, {"ok": True, "health": health, "status": status})
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
                return self._send(200, bridge("GET", f"/api/scorehistory/{game_id}"))
            if len(parts) == 3 and parts[0] == "api" and parts[1] == "details":
                details = bridge("GET", f"/api/details/{parts[2]}")
                media = {}
                try:
                    media = bridge("GET", f"/api/media/{parts[2]}")
                except Exception:
                    media = {}
                return self._send(200, {"ok": True, "details": details, "media": media})
            return self._send(404, {"ok": False, "error": "not found"})
        except urllib.error.HTTPError as e:
            return self._send(e.code, {"ok": False, "error": f"bridge HTTP {e.code}"})
        except Exception as e:
            return self._send(502, {"ok": False, "error": str(e)})

    def do_POST(self):
        path = urlparse(self.path).path
        if path == "/api/cache-thumbs":
            try:
                length = int(self.headers.get("Content-Length", 0))
                if length > 200000:
                    return self._send(413, {"ok": False, "error": "cache request too large"})
                body = json.loads(self.rfile.read(length).decode("utf-8"))
                tables = body.get("tables")
                if not isinstance(tables, list) or len(tables) > 10000:
                    raise ValueError()
                items = [{"gameId": int(t["gameId"]), "mediaRevision": str(t.get("mediaRevision") or "")[:200]} for t in tables]
                if any(t["gameId"] <= 0 for t in items):
                    raise ValueError()
                return self._send(202, start_thumb_cache(items))
            except (ValueError, KeyError, TypeError):
                return self._send(400, {"ok": False, "error": "valid table list required"})
        if path != "/api/play":
            return self._send(404, {"ok": False, "error": "not found"})
        try:
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length) if length else b"{}"
            payload = json.loads(body.decode("utf-8") or "{}")
            game_id = int(payload.get("gameId"))
        except Exception as e:
            return self._send(400, {"ok": False, "error": f"gameId required: {e}"})
        try:
            result = bridge("POST", "/api/play", {"gameId": game_id})
            return self._send(200, result if isinstance(result, dict) else {"ok": True, "result": result})
        except urllib.error.HTTPError as e:
            detail = ""
            try:
                detail = e.read().decode("utf-8", "replace")[:300]
            except Exception:
                pass
            return self._send(e.code, {"ok": False, "error": detail or f"bridge HTTP {e.code}"})
        except Exception as e:
            return self._send(502, {"ok": False, "error": str(e)})


if __name__ == "__main__":
    if not API_KEY:
        print("vpin-dashboard refusing to start: VPIN_API_KEY is not set in Dockhand Environment", flush=True)
        raise SystemExit(1)
    try:
        os.makedirs("/data", exist_ok=True)
        os.makedirs(THUMB_DIR, exist_ok=True)
    except Exception:
        pass
    print(f"vpin-dashboard listening on :{PORT}, bridge={BRIDGE_URL or '(unset)'}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
