#!/usr/bin/env python3
"""
vpin-dashboard - self-hosted server.

Runs on Randy's NAS under Dockhand (CasaOS-style compose, official
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
  GET  /api/thumb/<gameId>     playfield picture (JPEG) for a
                      table, cached under /data/thumbs. Fetched
                      from the cabinet through the PC bridge
                      (PC_BRIDGE_URL / PC_BRIDGE_KEY, optional):
                      the PlayField media is a video, so a frame
                      is grabbed from it with ffmpeg on the
                      cabinet. 404 when no picture is available.
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
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

PORT = int(os.environ.get("PORT", "8080"))
BRIDGE_URL = os.environ.get("VPIN_BRIDGE_URL", "").rstrip("/")
API_KEY = os.environ.get("VPIN_API_KEY", "")
# Optional: the PC bridge running on the cabinet PC. Only used to
# fetch playfield pictures: the cabinet's PlayField media is a
# video, so the app asks the PC bridge to grab a frame from that
# video with ffmpeg on the cabinet and reads the JPEG back. When
# these are unset, cards simply show no picture.
PC_BRIDGE_URL = os.environ.get("PC_BRIDGE_URL", "").rstrip("/")
PC_BRIDGE_KEY = os.environ.get("PC_BRIDGE_KEY", "")
THUMB_DIR = "/data/thumbs"
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
        "lastPlayed", "modified", "dateModified",
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
            "addedAt": pick(g, "dateAdded"),
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
            "addedAt": ex.get("modifiedAt"),
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
        "thumbsEnabled": bool(PC_BRIDGE_URL and PC_BRIDGE_KEY),
    }


def pcbridge(method, path, payload=None, timeout=60):
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(PC_BRIDGE_URL + path, data=data, method=method)
    req.add_header("X-Api-Key", PC_BRIDGE_KEY)
    req.add_header("Accept", "application/json")
    if data:
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = resp.read()
        try:
            return json.loads(body.decode("utf-8"))
        except Exception:
            return None


_thumb_failures = {}
_thumb_lock = threading.Lock()

_PS_ROOTS = "'C:\\PinUPSystem','C:\\vPinball','C:\\Visual Pinball'"


def _ps_locate(name):
    safe = name.replace("'", "''")
    return (
        "$f = Get-ChildItem -Path " + _PS_ROOTS +
        " -Recurse -Filter '" + safe + "' -ErrorAction SilentlyContinue"
        " | Select-Object -First 1 -ExpandProperty FullName;"
        " if ($f) { $f } else { 'MISS' }"
    )


def fetch_thumb(game_id):
    """Path to a cached playfield JPEG for the table, or None.

    Fetches through the PC bridge on the cabinet when needed: the
    PlayField media is a video there, so a frame is grabbed from
    it with ffmpeg on the cabinet (Popper keeps an ffmpeg for its
    recorder); a still-image PlayField is downscaled with
    System.Drawing instead. Results cache under /data/thumbs;
    failures are remembered for 10 minutes so a missing picture
    costs one attempt, not one per page view.
    """
    cached = os.path.join(THUMB_DIR, f"{game_id}.jpg")
    try:
        if os.path.isfile(cached) and os.path.getsize(cached) > 4000:
            return cached
    except OSError:
        pass
    if not PC_BRIDGE_URL or not PC_BRIDGE_KEY:
        return None
    with _thumb_lock:
        try:
            if os.path.isfile(cached) and os.path.getsize(cached) > 4000:
                return cached
        except OSError:
            pass
        failed_at = _thumb_failures.get(game_id)
        if failed_at and time.time() - failed_at < 600:
            return None
        result = _fetch_thumb_uncached(game_id, cached)
        if result is None:
            _thumb_failures[game_id] = time.time()
        return result


def _fetch_thumb_uncached(game_id, cached):
    try:
        media = bridge("GET", f"/api/media/{game_id}")
        screens = (media or {}).get("media") or {}
        entries = screens.get("PlayField") or []
        name = None
        is_video = True
        for e in entries:
            if str(e.get("mimeType", "")).startswith("image/"):
                name = e.get("name")
                is_video = False
                break
        if name is None:
            for e in entries:
                if e.get("mimeType") == "video/mp4":
                    name = e.get("name")
                    break
        if not name:
            return None
        located = pcbridge("POST", "/api/exec", {
            "cmd": _ps_locate(name), "shell": "powershell", "timeout": 240,
        }, timeout=260)
        path = ((located or {}).get("stdout") or "").strip()
        if not located or not located.get("ok") or not path or path == "MISS":
            return None
        safe_path = path.replace("'", "''")
        if is_video:
            cmd = (
                "$ff = (Get-Command ffmpeg -ErrorAction SilentlyContinue).Source;"
                " if (-not $ff) { $ff = Get-ChildItem -Path " + _PS_ROOTS +
                " -Recurse -Filter 'ffmpeg.exe' -ErrorAction SilentlyContinue"
                " | Select-Object -First 1 -ExpandProperty FullName };"
                " if (-not $ff) { 'NOFFMPEG'; exit };"
                " New-Item -ItemType Directory -Force -Path 'thumbs' | Out-Null;"
                " & $ff -y -ss 3 -i '" + safe_path + "' -frames:v 1"
                " -vf 'scale=480:-2' -q:v 3 'thumbs\\" + str(game_id) + ".jpg';"
                " if ((Test-Path 'thumbs\\" + str(game_id) + ".jpg')"
                " -and (Get-Item 'thumbs\\" + str(game_id) + ".jpg').Length -gt 4000)"
                " { 'OK' } else { 'FAIL' }"
            )
        else:
            cmd = (
                "Add-Type -AssemblyName System.Drawing;"
                " $img = [System.Drawing.Image]::FromFile('" + safe_path + "');"
                " $w = [Math]::Min(480, $img.Width);"
                " $h = [int]($img.Height * $w / $img.Width);"
                " $bmp = New-Object System.Drawing.Bitmap($w, $h);"
                " $g = [System.Drawing.Graphics]::FromImage($bmp);"
                " $g.DrawImage($img, 0, 0, $w, $h);"
                " New-Item -ItemType Directory -Force -Path 'thumbs' | Out-Null;"
                " $bmp.Save('thumbs\\" + str(game_id) + ".jpg',"
                " [System.Drawing.Imaging.ImageFormat]::Jpeg); 'OK'"
            )
        ran = pcbridge("POST", "/api/exec", {
            "cmd": cmd, "shell": "powershell", "timeout": 240,
        }, timeout=260)
        if not ran or "OK" not in (ran.get("stdout") or ""):
            return None
        got = pcbridge("GET", f"/api/file?path=thumbs/{game_id}.jpg", timeout=60)
        if not got or got.get("encoding") != "base64" or not got.get("content"):
            return None
        data = base64.b64decode(got["content"])
        if len(data) <= 4000:
            return None
        os.makedirs(THUMB_DIR, exist_ok=True)
        with open(cached, "wb") as f:
            f.write(data)
        return cached
    except Exception:
        return None


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
                thumb = fetch_thumb(thumb_id)
                if thumb is None:
                    return self._send(404, {"ok": False, "error": "no playfield picture available"})
                return self._send_file(thumb, "image/jpeg")
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
    except Exception:
        pass
    print(f"vpin-dashboard listening on :{PORT}, bridge={BRIDGE_URL or '(unset)'}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
