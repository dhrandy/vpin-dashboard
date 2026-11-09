DROP TABLE entries;
--> statement-breakpoint
CREATE TABLE tables (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cabinet_game_id INTEGER NOT NULL UNIQUE,
  name TEXT NOT NULL,
  maker TEXT,
  year INTEGER,
  raw_json TEXT,
  details_json TEXT,
  media_json TEXT,
  detail_fetched_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  table_id INTEGER NOT NULL,
  cabinet_game_id INTEGER,
  score INTEGER NOT NULL,
  initials TEXT,
  rank INTEGER NOT NULL DEFAULT 1,
  line_text TEXT,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE playlists (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  game_ids_json TEXT NOT NULL DEFAULT '[]'
);
--> statement-breakpoint
CREATE TABLE bridge_sync (
  id INTEGER PRIMARY KEY,
  last_attempt_at INTEGER,
  last_success_at INTEGER,
  last_error TEXT,
  table_count INTEGER NOT NULL DEFAULT 0,
  score_count INTEGER NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE TABLE cabinet_status (
  id INTEGER PRIMARY KEY,
  reachable INTEGER,
  game_playing INTEGER NOT NULL DEFAULT 0,
  playing_game_id INTEGER,
  playing_text TEXT,
  checked_at INTEGER
);
--> statement-breakpoint
CREATE TABLE play_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cabinet_game_id INTEGER NOT NULL,
  table_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
