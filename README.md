# vpin-dashboard

A self-hosted pinball library and stats dashboard for a Visual Pinball
cabinet running VPin Studio, reached through a vpin-bridge.

- **Library page**: browse every table on the cabinet, search, sort,
  and filter, with each table's top scores from the cabinet score
  export. Modeled on the Visual Pinball Infinite library view.
- **Stats page**: totals, top tables by best score, a player
  leaderboard from score initials, tables by maker and decade, and
  score coverage.
- **Play**: tapping Play on a table launches it on the cabinet
  through VPin Studio (the bridge forwards to VPin Studio's launch
  endpoint). The game runs on the cabinet; this app only triggers
  the launch. The bridge refuses while a game is already playing.
- **Sync button** (top right of the web app): syncs with the
  cabinet and saves the info on the server. Sync is incremental:
  it pulls from the cabinet, compares against what is already
  saved, and only adds the new or missing tables, scores,
  playlists, and playfield thumbnails. What is already saved is
  not re-downloaded or overwritten, and after a sync the page
  shows everything the cabinet has.

## Layout

- `app/server.py` — the server (Python standard library only). Serves
  the UI and a small JSON API that talks to the vpin bridge.
- `app/index.html` — the web UI (single file, no build step).
- `artifact/` — the Muse web artifact source (React client in
  `client/`, server actions in `server/`, Drizzle migrations in
  `drizzle/`). This is the live app: library grid with playfield
  thumbnails and B2S/ROM/PUP/Color badges, sidebar categories,
  playlists and Browse By, the Stats page, and the Sync button.
  Host-specific values (bridge addresses, keys) are read from the
  environment and are not stored in this repo.
- `docker-compose.yml` — Dockhand/CasaOS-style stack: official
  Python image, no Dockerfile, host-path volumes under
  `/DATA/AppData/vpin-dashboard`. The container pulls the repo
  files itself (clone on first start, pull on every restart), so
  no app files are copied by hand.

## Deploy on the NAS (Dockhand)

The compose file is the only file you handle; the Docker stack
pulls everything else from this repo on its own.

1. Create a stack in Dockhand from `docker-compose.yml`.
2. In Dockhand Environment, set:
   - `VPIN_BRIDGE_URL` — the vpin-bridge address on your network.
   - `VPIN_API_KEY` — the same key the bridge uses (its `API_KEY`).
   - Optional, for playfield pictures on the cards:
     `PC_BRIDGE_URL` and `PC_BRIDGE_KEY` — the PC bridge running
     on the cabinet PC. The app grabs a frame from each table's
     playfield video through it and caches the pictures under
     `/data/thumbs`. Leave them unset and the cards show no
     picture.
   Neither value is stored in this repo. The repo is public, so the
   container pulls the app files itself with no GitHub token.
3. Start the stack and open the dashboard on port 8746. On first
   start the container clones the repo into
   `/DATA/AppData/vpin-dashboard/app` on the NAS, then runs
   `app/server.py` from that checkout.

## Updates

Restart the stack. On every start the container pulls the latest
files from GitHub first, then starts the server with the new
code: no rebuild, no file copying. If a pull fails (for example
the NAS is offline), it starts with the files it already has. An
older manual install (files copied in by hand, no git checkout)
keeps running as-is; empty the `app` folder and restart once to
switch it to automatic pulls.

## How it gets data

The server calls the vpin bridge with the `X-Api-Key` header:

- `GET /api/games/json` for the table list and mod tags
- `GET /api/games` for the semicolon tables export, parsed for
  maker, year, and the B2S/ROM/PUP/Color badges (the export's
  table-details fields are the only bridge payload that carries
  manufacturer and gameYear; `/api/games/json` has neither)
- `GET /api/highscores` for scores (top score per table, or the raw
  export with up to 10 scores per table)
- `GET /api/playlists`, `GET /api/details/<id>`, `GET /api/media/<id>`
- `GET /health` and `GET /api/status` for the cabinet status light
  and Now Playing banner
- `POST /api/play` with `{"gameId": <id>}` to launch a table

Playfield pictures (`GET /api/thumb/<id>`) come from the cabinet
itself through the PC bridge when `PC_BRIDGE_URL` and
`PC_BRIDGE_KEY` are set: the PlayField media on the cabinet is a
video, so the server asks the PC bridge to grab a frame from that
video with ffmpeg on the cabinet and reads the JPEG back. Pictures
cache under `/data/thumbs`, so each table is fetched once.

If the cabinet is off, the dashboard shows an offline state and no
tables or scores are invented.
