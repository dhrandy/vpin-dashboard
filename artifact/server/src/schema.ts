// Drizzle schema for Pinball Library and Stats.
//
// tables: one row per table on the cabinet, upserted by cabinet
// game id on every bridge pull. maker/year are best-effort fields
// from the VPin Studio games payload; raw_json keeps the original
// game object (truncated) so nothing the cabinet reported is lost.
// details_json / media_json hold the per-table responses from
// `vpin details` / `vpin media`, fetched on demand.
// scores: high-score entries pulled from the cabinet export. The
// bridge's parsed form carries the top score per table; the raw
// semicolon export carries up to 10 per table (rank = slot).
// playlists: cabinet playlists with their member game ids as JSON.
// bridge_sync / cabinet_status: single-row (id = 1) caches of the
// latest bridge pull and cabinet health reading.
// play_requests: one row per Play tap; the launch itself runs on
// the cabinet through VPin Studio via the vpin bridge.

import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const tables = sqliteTable("tables", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  cabinetGameId: integer("cabinet_game_id").notNull().unique(),
  name: text("name").notNull(),
  maker: text("maker"),
  year: integer("year"),
  rawJson: text("raw_json"),
  detailsJson: text("details_json"),
  mediaJson: text("media_json"),
  detailFetchedAt: integer("detail_fetched_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const scores = sqliteTable("scores", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  tableId: integer("table_id").notNull(),
  cabinetGameId: integer("cabinet_game_id"),
  score: integer("score").notNull(),
  initials: text("initials"),
  rank: integer("rank").notNull().default(1),
  lineText: text("line_text"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const playlists = sqliteTable("playlists", {
  id: integer("id").primaryKey(),
  name: text("name").notNull(),
  gameIdsJson: text("game_ids_json").notNull().default("[]"),
});

export const bridgeSync = sqliteTable("bridge_sync", {
  id: integer("id").primaryKey(),
  lastAttemptAt: integer("last_attempt_at", { mode: "timestamp_ms" }),
  lastSuccessAt: integer("last_success_at", { mode: "timestamp_ms" }),
  lastError: text("last_error"),
  tableCount: integer("table_count").notNull().default(0),
  scoreCount: integer("score_count").notNull().default(0),
});

export const cabinetStatus = sqliteTable("cabinet_status", {
  id: integer("id").primaryKey(),
  reachable: integer("reachable"),
  gamePlaying: integer("game_playing").notNull().default(0),
  playingGameId: integer("playing_game_id"),
  playingText: text("playing_text"),
  checkedAt: integer("checked_at", { mode: "timestamp_ms" }),
});

export const playRequests = sqliteTable("play_requests", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  cabinetGameId: integer("cabinet_game_id").notNull(),
  tableName: text("table_name").notNull(),
  status: text("status", {
    enum: ["pending", "launched", "busy", "failed"],
  })
    .notNull()
    .default("pending"),
  error: text("error"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
});
