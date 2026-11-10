# vpin-dashboard

![Status: alpha](https://img.shields.io/badge/status-alpha-orange) ![Python: 3.12](https://img.shields.io/badge/python-3.12-blue) ![Deployment: Docker Compose](https://img.shields.io/badge/deploy-Docker_Compose-blue)

A self-hosted pinball library and stats dashboard for a cabinet running VPin Studio through vpin-bridge.

**Alpha software.** Features, data formats and setup may change. Back up the persistent data volume before updates. Test on your private network before considering remote access.

## Requirements

- A cabinet running VPin Studio, with [vpin-bridge](https://github.com/dhrandy/vpin-bridge) deployed and configured first. The dashboard requires the bridge; it does not connect directly to VPin Studio.
- Docker with Docker Compose, persistent storage, and private network access from the dashboard to the bridge.
- Trusted HTTPS for dashboard sign-in, including on your local network. Keep the bridge and cabinet private.

## Why two parts?

The dashboard provides the library, stats, accounts and browser interface. [vpin-bridge](https://github.com/dhrandy/vpin-bridge) provides a small API authenticated by an API key, so the dashboard and authorized agents or scripts can read the cabinet's table information without running on the cabinet or accessing its filesystem directly. The bridge runs on a Docker host on your private network and talks to VPin Studio Server on the cabinet. VPin Studio handles cabinet-local files and media. Keeping the API separate lets agents use it without depending on the dashboard interface.

## Features

- Library with playfield previews, search, filters, full table names, play counts and high scores.
- Recently played and Recently added views choose their matching sort order. You can override the sort.
- Stats with most/least played tables, recent play dates and score coverage. Highscore history contains saved snapshots, not guaranteed results from every play.
- Built-in accounts: admins manage users, branding, Sync, Play and Exit table; viewers browse only. Play is hidden and refused when the cabinet is unavailable, busy, or the table is not launchable.
- Refresh requests a coordinated cabinet pull without starting an image job. Browser pages read the saved library/status every 30 seconds; background collection also works when no browser is open. Busy/offline pulls defer rather than overwrite a good library with partial data.
- Sync refreshes the table list and incrementally caches new, missing, changed or previously failed images. It also starts one sequential background preload of details and score history for every table, with progress and unavailable counts. Fresh per-table entries are skipped. Each read is guarded by a live idle check, and a one-second throttle follows each data read. Busy/offline jobs pause, check again once a minute and stop incomplete after two hours; tap Sync to continue after a restart or timeout. No preload starts from regular Refresh or a 30-second page poll. Changed-image detection uses the modification revision supplied by Studio.
- Full re-sync in Admin settings asks for confirmation before re-fetching all images. Existing previews remain available until replacements succeed. Image jobs pause while cabinet status is offline, unknown or busy.
- Editable dashboard name/logo, plus a general cabinet Instructions page loaded from a local Markdown file.
- Hearts on cards and details save Favourites per signed-in user, including viewers. Cabinet favourites stay separate. Personal lists never change cabinet playlists.
- Per-user Settings stores Colorblind-friendly colors and the elapsed-time display on the server, across devices. Colorblind-friendly uses blue/orange with shape and text cues; default hearts are red.
- The centered compact table-name and duration banner links to the reported table card and shows elapsed time from VPin Studio's session start, including pauses. Studio may retain an active session after a crash. Admins get a small dismiss x; its confirmation explains this hides only that session on this dashboard and never re-enables Play. In Settings, Show detailed cabinet status adds last-checked age, crash guidance and a full Dismiss button. This per-user setting defaults off. Dismissal clears on a confirmed idle state or different identified session. Missing/invalid start time shows Time unavailable; elapsed time is not ball-in-play time and can be hidden separately.
- Table cards can show cumulative `X min total` from Studio frontend analytics. This is not the last session duration. Missing values show Time unavailable; each user can hide it in Settings. Requires the current bridge analytics endpoint.
- Install on phones over HTTPS: Android browsers can offer Install app, and iPhone/iPad Safari supports Share > Add to Home Screen. Settings explains both. The generic app icon/name contain no cabinet details. The service worker is network-only: it creates no cache and does not intercept API, login or page requests. Internet access and sign-in are still required.
- Sync status lives beside Sync, not as loose header lines. A separate status target opens the desktop popover without starting a Sync; the phone/tablet menu shows the panel below Sync. The indicator changes shape/color for unavailable items, active jobs and completion. Escape or an outside click closes the desktop popover.
- Compact header lights use different shapes for idle, busy, offline, unknown and stale, with a Status key in Settings and accessible labels. Admin Exit table appears at the top only while Studio reports an active table, and requires confirmation, and can force-close the table and frontend, losing an unsaved game. Both dashboard and bridge revalidate the exact reported session and serialize Exit/Play. An accepted exit is not proof every process stopped; the dashboard waits for fresh reported status. It never auto-launches another table or retries an uncertain exit. Both containers need the matching update.
- Tap a playfield in the details dialog to enlarge the existing 960px-wide cached detail image. Tap the image, the top-right X, or Esc to return. Table details also have a matching top-right X and a bottom Close button. No additional cabinet read or image copy is needed.
- "No B2S or PUP" means the export explicitly reports neither a backglass nor a PUP pack. A reported PUP suppresses the flag. Unknown fields are not treated as absent. Details explain this is not proof of a launch error.
- Phone/tablet hamburger menu and desktop sidebar.

The existing "Top rated" category means the ten highest numeric table scores, not user ratings. Scores from different games are not comparable ratings.

## Deploy with Docker Compose

Use `docker-compose.yml` with the official Python image. There is no Dockerfile or build step.

1. Deploy and configure [vpin-bridge](https://github.com/dhrandy/vpin-bridge) first, following its README. It is required. Confirm the dashboard host can reach it privately, and use its base address and API key in step 4. Keep the bridge/cabinet private.
2. In Dockhand, create a Compose stack and paste the supplied compose file. In another Compose manager, use its stack editor; from a shell, save it as `docker-compose.yml` and use `docker compose up -d`.
3. Change the two host volume paths to persistent folders on your Docker host. Keep `/code` and `/data` as the container targets.
4. Set the environment values below using the manager's Environment editor or exported shell variables. No `.env` file is supplied or required.
5. Start the stack, configure trusted HTTPS/private routing, then follow First admin below. Docker must be able to reach the Python package repository and GitHub for first-time dependencies and updates.

Copy-paste compose:

```yaml
services:
  vpin-dashboard:
    image: python:3.12-slim
    container_name: vpin-dashboard
    restart: unless-stopped
    ports:
      - "8746:8080"
    environment:
      # Set these in Dockhand Environment. None of them are stored
      # in the repo or in this file.
      # VPIN_BRIDGE_URL is your vpin-bridge address on your network.
      # VPIN_API_KEY is the same key the bridge uses (its API_KEY).
      # Playfield pictures come through the bridge too; VPin Studio
      # extracts a frame itself when a table's playfield media is
      # a video, so nothing else is needed for the pictures.
      # The app files come from the public dhrandy/vpin-dashboard
      # repo, which clones with no token or sign-in.
      VPIN_BRIDGE_URL: ${VPIN_BRIDGE_URL}
      VPIN_API_KEY: ${VPIN_API_KEY}
      GIT_REPO: ${GIT_REPO}
      GIT_BRANCH: ${GIT_BRANCH}
      PORT: "8080"
    healthcheck:
      # The root page is served by the app itself and does not depend
      # on the cabinet being on, so it only fails when the app is down.
      test: ["CMD", "python3", "-c", "import urllib.request;urllib.request.urlopen('http://localhost:8080/',timeout=5)"]
      interval: 60s
      timeout: 10s
      retries: 3
      start_period: 60s
    volumes:
      # The container pulls the repo into this folder itself: it
      # clones on first start and pulls the latest files on every
      # restart, so no app files are ever copied by hand. The
      # folder ends up holding the repo checkout (server code under
      # app/ inside it). /data keeps runtime data across updates.
      - /DATA/AppData/vpin-dashboard/app:/code
      - /DATA/AppData/vpin-dashboard/data:/data
    command:
      - sh
      - -c
      - |
        if ! command -v git >/dev/null 2>&1; then
          apt-get update -qq && apt-get install -y -qq git ca-certificates || true
        fi
        BRANCH="$$GIT_BRANCH"
        if [ -z "$$BRANCH" ]; then BRANCH=main; fi
        REPO="$$GIT_REPO"
        if [ -z "$$REPO" ]; then REPO="https://github.com/dhrandy/vpin-dashboard.git"; fi
        if [ -d /code/.git ]; then
          echo "vpin-dashboard: pulling the latest app files from GitHub..."
          git -C /code remote set-url origin "$$REPO" || true
          if git -C /code fetch --depth 1 origin "$$BRANCH"; then
            git -C /code reset --hard "origin/$$BRANCH" || true
          else
            echo "vpin-dashboard: the pull failed, starting with the files already in the app folder."
          fi
        elif [ -f /code/app/server.py ] || [ -f /code/server.py ]; then
          echo "vpin-dashboard: app files found without a git checkout, using them as-is. To switch to automatic pulls, empty the app folder and restart the stack."
        elif command -v git >/dev/null 2>&1; then
          echo "vpin-dashboard: first start, pulling the app files from GitHub..."
          if git clone --depth 1 --branch "$$BRANCH" "$$REPO" /tmp/vpin-clone; then
            cp -a /tmp/vpin-clone/. /code/
            rm -rf /tmp/vpin-clone
          else
            echo "vpin-dashboard: could not pull the files from GitHub. Check that the Docker host can reach GitHub, then restart the stack." >&2
            exit 1
          fi
        fi
        if [ -f /code/app/server.py ]; then
          exec python3 /code/app/server.py
        fi
        if [ -f /code/server.py ]; then
          exec python3 /code/server.py
        fi
        echo "vpin-dashboard: server.py was not found after pulling the files." >&2
        exit 1
```

Set these in your stack's Environment:

- `VPIN_BRIDGE_URL`: your private vpin-bridge base address.
- `VPIN_API_KEY`: the bridge's API key.
- `GIT_REPO`: this public repository's clone URL, or leave blank to use the built-in repository.
- `GIT_BRANCH`: `main`, or leave blank to use `main`.

The existing compose mounts the repository at `/code` and persistent runtime data at `/data`. The server listens on container port 8080, mapped to host port 8746. Keep the data volume across updates: it contains accounts, sessions, preferences/favourites, branding, instructions, cached images and collection history. Playfield previews come through vpin-bridge and VPin Studio; no separate PC bridge is needed.

### HTTPS and network boundary

**HTTPS is required for browser sign-in, including on the LAN.** The session cookie is Secure, HttpOnly and SameSite=Strict. Configure a trusted HTTPS reverse proxy to the dashboard, keep the HTTP app port private, and firewall the bridge and cabinet so they are never directly internet-accessible. Do not publish the Python server port directly. This repository does not configure your proxy, certificates or firewall.

An existing outer authentication gate can remain in place. It does not replace built-in login, and forwarded identity headers do not bypass login. Built-in accounts do not include MFA. Security checks are local tests, not an independent security audit or a guarantee that a public deployment is safe.

### First admin

1. Start the container and open the dashboard through HTTPS.
2. Read the one-time setup token from `/data/auth/admin-setup-token` inside the container, using your private container console or the mounted data volume. Do not post the token publicly.
3. Enter it on the setup screen and choose an admin username and a unique password of at least 12 characters. No default account or password is supplied.
4. Successful setup deletes the token. Add viewer or admin accounts under Admin.

The next startup automatically creates missing favourites/preferences tables and display-preference columns, plus the collection database. Existing accounts are preserved. No new environment variables or compose changes are needed. Back up the data volume before updating.

User and session data is stored in `/data/auth/users.sqlite3`. Changing a user's password, role or active status revokes that user's existing sessions. Sessions have a 12-hour absolute expiry. Keep backups of the data volume private; do not commit it to GitHub. Losing all admin credentials requires an operator recovery process; there is no email password reset.

### Updates

The container fetches the configured branch on every restart, then starts the app. Restart the dashboard stack yourself after changes are shipped. No compose changes are needed for this application update, but HTTPS and private routing must be in place before login will work. A failed fetch uses the previous checkout. A legacy manual install without a git checkout is not automatically converted.

## Background collection and saved data

Collection is enabled by default. In Admin, Background collection can be turned off and the bulk interval set from 1 to 60 minutes (default 5). Only admins can change these controls.

- Status is checked once per 60 seconds while reachable. A bulk pull reads games, export, scores, playlists and cumulative analytics only while idle. Analytics is one bulk read, not a request for every card.
- When offline or the status/pull is incomplete, checks back off at 1, 2, 5, 10 and then 15 minutes, capped there. There are no image downloads, launches or cabinet writes from this worker.
- A good online observation resets backoff; the first idle observation catches up immediately. This is not instant power-on detection: a cabinet coming online can wait up to the current 15-minute backoff. Explicit Refresh requests a check sooner; manual pulls are coalesced/rate-limited to once per 30 seconds and never run in parallel with the collector.
- Dashboard status requests have a 5-second network timeout; the bridge's cabinet request can continue until its own 15-second timeout. Bulk requests use the normal bridge timeouts.
- The latest good library remains available offline; Admin shows collection timestamps. Status older than 125 seconds is unknown, not falsely online. Admin shows last check, last complete pull, pending/backoff state and archive size/counts.
- `/data/observations/observations.sqlite3` stores the latest library plus changed compressed library snapshots and observed status transitions. Unchanged polls do not append duplicate history rows. There is no archive browser/export UI yet.
- History is sampled, not a guaranteed record of every game, session duration or score. Polls may miss short sessions; busy deferral relies on Studio's own cumulative data surviving until the next successful pull.
- History expires at 90 days, 10,000 rows or 25 MiB of compressed archived payload, whichever limit removes old rows first. The 25 MiB is not a whole-database cap: the latest snapshot, indexes and SQLite free-page overhead add space. Individual snapshots are limited to 4 MiB raw / 2 MiB compressed. Back up this database with the rest of `/data` and keep it private.

Table details and Studio saved highscore versions use a separate persistent per-table cache. Last-known safe fields render immediately, show a saved timestamp, and survive restart or cabinet outages. An uncached first view says Not saved yet and starts a background read only when live cabinet status is known idle. Failed refreshes never replace saved data with empty results. Collector history is separate from Studio versions. Interrupted reads, malformed responses and failed cache writes retain last-good data. SQLite uses full synchronous transactions, and image replacements flush a temporary file before atomic rename. A restarted preload can be continued by tapping Sync, which skips saved entries that are still fresh. These checks protect application writes; backups are still needed for disk failure. Cache payloads are bounded to 2,000 entries, 512 KiB per response and 16 MiB total; oldest entries are evicted. Refreshes coalesce with a 60-second retry cooldown; saved data is fresh for five minutes. Built-in favourites/preferences and collector state are local to this dashboard and never written into Studio.

## Cabinet instructions

Create `/data/instructions.md` in the dashboard's mounted data volume, not in the repository checkout. Use this short example as a starting point:

```markdown
# Using the cabinet

## Controls

- Flippers: [add your controls]
- Start a game: [add your controls]
- Exit a table: [add your controls]

## House rules

- [Add food and drink guidance]
- [Add turn-taking rules]
- Ask [contact or role] if you need help.
```

`instructions.example.md` is a longer generic template. Replace all placeholders with your own instructions. The app never copies the example over your file.

Tap Refresh after editing; no restart is needed. A missing, empty or whitespace-only file is ignored: both the Instructions tab and page are hidden. If the page is open when the file becomes empty, the app returns to Library. Instructions are cabinet-wide, not per-table notes, and are visible to all signed-in users.

Supported formatting: headings (`#` to `###`), paragraphs, bullet/numbered lists and fenced code blocks. HTML, link markup and image markup display as text, without executing code or fetching remote content. The file must be UTF-8, a regular file rather than a symlink, and at most 64 KB. Invalid files are not shown; admins see an error banner. Do not put secrets in instructions.

## App layout and data

- `app/server.py`: standard-library HTTP/API server and bridge access. Pillow normalizes preview images and logos.
- `app/auth.py`: local accounts, password hashing and revocable signed sessions.
- `app/collector.py`: single background worker, private SQLite snapshots, deduplication and retention.
- `app/index.html`, `app/app.js`: dashboard UI, no frontend build step.
- `app/login.html`, `app/login.js`: login and first-admin setup.
- `artifact/`: earlier artifact source; not the Python compose app.
- `docker-compose.yml`: container startup, persistent volumes and healthcheck.

The server calls vpin-bridge for games JSON/export, highscores, playlists, descriptive details, scorehistory, thumbnail previews, health/status and admin-authorized Play/Exit. Keys and cabinet addresses come from the environment, not repository content. Cabinet detail fields are allowlisted and text is privacy-filtered; extraDetails is collapsed by default. Unavailable images show a fallback and admin cache diagnostics rather than fabricated previews.

## AI usage

AI was used in development, with extensive automated testing. Testing is not a guarantee that every setup or edge case will work. The maintainer reviews and decides what ships. This is alpha software; automated checks do not replace independent security review or testing on your own hardware. Report bugs without sharing credentials, cabinet addresses or private exports.

## Browser connection recovery

Modal/image reads accept only IDs in the saved library. Per-table background work is capped, deduplicated and byte-bounded; cached payloads stay private in the data volume. Image decoding is limited to PNG/JPEG with byte/pixel limits. Pillow 13.0.0 is pinned in a versioned private directory so an older persisted copy is not silently reused. Repository ignore rules exclude common runtime databases, logs and environment files.

Routine reads pause while the page is hidden or the browser reports offline. Returning to the page or reconnecting requests one refresh; otherwise visible pages read saved dashboard data every 30 seconds. Overlapping refresh cycles are coalesced. A temporary read failure keeps the last library, personal favourites and instructions. Cabinet availability is shown only by the header light and its accessible label, with the Settings key; no cabinet-unavailable or saved-cabinet timestamp line is added above the library. Other failed reads can still identify the missing data, and that notice clears after a successful cycle. Losing contact with the dashboard means cabinet status unknown, not a claim the cabinet itself is offline.

Manual-action failures name the operation. Network failures after a write say its outcome could not be confirmed: check current state before trying again. Play and other writes are never replayed automatically. These messages do not identify whether the underlying cause was the phone connection, proxy or server.

## Tests

Run the synthetic collector regression suite with `python -m unittest discover -s tests -v`. It requires no cabinet access. UI/security and resource checks do not guarantee identical results on every Docker host.

## License

Copyright dhrandy. All rights reserved. No license is granted.
