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
  POST /api/play      {"gameId": int} -> bridge POST /api/play,
                      which launches the table on the cabinet
                      through VPin Studio. Refused by the bridge
                      (409) while a game is already playing.

No key or cabinet address is ever stored in this file or the repo;
both come from the Dockhand Environment at runtime.
"""
import json
import os
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

PORT = int(os.environ.get("PORT", "8080"))
BRIDGE_URL = os.environ.get("VPIN_BRIDGE_URL", "").rstrip("/")
API_KEY = os.environ.get("VPIN_API_KEY", "")
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


def library_payload():
    games_raw = bridge("GET", "/api/games/json")
    games = games_raw if isinstance(games_raw, list) else []
    tables = []
    for g in games:
        if not isinstance(g, dict):
            continue
        game_id = pick(g, "id", "gameId")
        if game_id is None:
            continue
        tables.append({
            "gameId": int(game_id),
            "name": pick(g, "gameDisplayName", "gameName", "name") or f"Table {game_id}",
            "maker": pick(g, "manufacturer", "vendor", "maker", "brand"),
            "year": as_year(pick(g, "year", "releaseYear", "gameYear")),
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

    return {"ok": True, "tables": tables, "scores": scores, "playlists": playlists}


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
