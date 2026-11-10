# vpin-dashboard

A self-hosted pinball library and stats dashboard for a cabinet running VPin Studio through vpin-bridge.

## Features

- Library with playfield previews, search, filters, full table names, play counts and high scores.
- Recently played and Recently added views choose their matching sort order. You can override the sort.
- Stats with most/least played tables, recent play dates and score coverage. Highscore history contains saved snapshots, not guaranteed results from every play.
- Built-in accounts: admins manage users, branding, Sync and Play; viewers browse only. Play is hidden and refused when the cabinet is unavailable, busy, or the table is not launchable.
- Refresh updates library data, scores, play counts and status for everyone, without starting an image job. Data also refreshes every 30 seconds.
- Sync refreshes the table list and incrementally caches new, missing, changed or previously failed images. Existing cache hits are skipped. Changed-image detection uses the modification revision supplied by Studio.
- Full re-sync in Admin settings asks for confirmation before re-fetching all images. Existing previews remain available until replacements succeed. Image jobs pause while cabinet status is offline, unknown or busy.
- Editable dashboard name/logo, plus a general cabinet Instructions page loaded from a local Markdown file.
- Phone hamburger menu, tablet layouts and desktop sidebar.

The existing "Top rated" category means the ten highest numeric table scores, not user ratings. Scores from different games are not comparable ratings.

## Deploy with Docker Compose

Use `docker-compose.yml` with the official Python image. There is no Dockerfile or build step.

Set these in your stack's Environment:

- `VPIN_BRIDGE_URL`: your private vpin-bridge base address.
- `VPIN_API_KEY`: the bridge's API key.
- `GIT_REPO`: this public repository's clone URL, or leave blank to use the built-in repository.
- `GIT_BRANCH`: `main`, or leave blank to use `main`.

The existing compose mounts the repository at `/code` and persistent runtime data at `/data`. The server listens on container port 8080, mapped to host port 8746. Keep the data volume across updates: it contains accounts, sessions, branding, instructions and cached images. Playfield previews come through vpin-bridge and VPin Studio; no separate PC bridge is needed.

### HTTPS and network boundary

**HTTPS is required for browser sign-in, including on the LAN.** The session cookie is Secure, HttpOnly and SameSite=Strict. Configure a trusted HTTPS reverse proxy to the dashboard, keep the HTTP app port private, and firewall the bridge and cabinet so they are never directly internet-accessible. Do not publish the Python server port directly. This repository does not configure your proxy, certificates or firewall.

An existing outer authentication gate can remain in place. It does not replace built-in login, and forwarded identity headers do not bypass login. Built-in accounts do not include MFA. Security checks are local tests, not an independent security audit or a guarantee that a public deployment is safe.

### First admin

1. Start the container and open the dashboard through HTTPS.
2. Read the one-time setup token from `/data/auth/admin-setup-token` inside the container, using your private container console or the mounted data volume. Do not post the token publicly.
3. Enter it on the setup screen and choose an admin username and a unique password of at least 12 characters. No default account or password is supplied.
4. Successful setup deletes the token. Add viewer or admin accounts under Admin.

User and session data is stored in `/data/auth/users.sqlite3`. Changing a user's password, role or active status revokes that user's existing sessions. Sessions have a 12-hour absolute expiry. Keep backups of the data volume private; do not commit it to GitHub. Losing all admin credentials requires an operator recovery process; there is no email password reset.

### Updates

The container fetches the configured branch on every restart, then starts the app. Restart the dashboard stack yourself after changes are shipped. No compose changes are needed for this application update, but HTTPS and private routing must be in place before login will work. A failed fetch uses the previous checkout. A legacy manual install without a git checkout is not automatically converted.

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
- `app/index.html`, `app/app.js`: dashboard UI, no frontend build step.
- `app/login.html`, `app/login.js`: login and first-admin setup.
- `artifact/`: earlier artifact source; not the Python compose app.
- `docker-compose.yml`: container startup, persistent volumes and healthcheck.

The server calls vpin-bridge for games JSON/export, highscores, playlists, descriptive details, scorehistory, thumbnail previews, health/status and admin-authorized Play. Keys and cabinet addresses come from the environment, not repository content. Cabinet detail fields are allowlisted and text is privacy-filtered; extraDetails is collapsed by default. Unavailable images show a fallback and admin cache diagnostics rather than fabricated previews.
