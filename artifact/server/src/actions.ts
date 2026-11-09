// Actions for Pinball Library and Stats.
//
// Data source: Randy's pinball cabinet through the vpin bridge.
// The bridge API key lives only in the registered custom.vpin-bridge
// connector, so server actions cannot call the bridge directly.
// Every bridge read/write follows the pattern proven by the Pinball
// High Scores App: the action serves stored rows and, when they are
// stale, spawns a background agent task that runs the `vpin` CLI and
// reports back through a save action.
//
// Play: tapping Play creates a play_requests row and spawns a task
// that runs `vpin play <gameId>`. The bridge forwards that to VPin
// Studio on the cabinet (GET /api/v1/frontend/launch/<gameId>), so
// the game launches on the cabinet itself; this app only triggers
// it. The bridge refuses with 409 when a game is already playing.

import { defineAction, z, type ActionsModule, type Ctx } from "@hatch/space-sdk";
import { asc, eq } from "drizzle-orm";
import * as schema from "./schema";

const VPIN_CLI =
  "PYTHONPATH=/opt/muse/skills/custom-connector-setup/bin ~/workspace/custom-skills/local-vpin-bridge/bin/vpin";
const SYNC_STALE_MS = 30 * 1000;
const STATUS_STALE_MS = 20 * 1000;
const DETAIL_STALE_MS = 10 * 60 * 1000;

const okResponse = z.object({ ok: z.boolean() });

const syncShape = z.object({
  state: z.enum(["never", "ok", "error"]),
  lastSuccessAt: z.string().nullable(),
  lastAttemptAt: z.string().nullable(),
  lastError: z.string().nullable(),
  tableCount: z.number(),
  scoreCount: z.number(),
});

const statusShape = z.object({
  state: z.enum(["online", "offline", "unknown"]),
  gamePlaying: z.boolean(),
  playingGameId: z.number().nullable(),
  playingText: z.string().nullable(),
  checkedAt: z.string().nullable(),
});

type SyncInfo = z.infer<typeof syncShape>;
type StatusInfo = z.infer<typeof statusShape>;

async function readSyncRow(ctx: Ctx) {
  const db = ctx.db<typeof schema>();
  const rows = await db
    .select()
    .from(schema.bridgeSync)
    .where(eq(schema.bridgeSync.id, 1))
    .limit(1);
  return rows[0] ?? null;
}

function toSyncInfo(
  row: Awaited<ReturnType<typeof readSyncRow>>,
): SyncInfo {
  if (!row) {
    return {
      state: "never",
      lastSuccessAt: null,
      lastAttemptAt: null,
      lastError: null,
      tableCount: 0,
      scoreCount: 0,
    };
  }
  return {
    state: row.lastSuccessAt ? "ok" : row.lastError ? "error" : "never",
    lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
    lastAttemptAt: row.lastAttemptAt?.toISOString() ?? null,
    lastError: row.lastError,
    tableCount: row.tableCount,
    scoreCount: row.scoreCount,
  };
}

async function readStatusRow(ctx: Ctx) {
  const db = ctx.db<typeof schema>();
  const rows = await db
    .select()
    .from(schema.cabinetStatus)
    .where(eq(schema.cabinetStatus.id, 1))
    .limit(1);
  return rows[0] ?? null;
}

function toStatusInfo(
  row: Awaited<ReturnType<typeof readStatusRow>>,
): StatusInfo {
  if (!row || row.reachable === null || !row.checkedAt) {
    return {
      state: "unknown",
      gamePlaying: false,
      playingGameId: null,
      playingText: null,
      checkedAt: null,
    };
  }
  return {
    state: row.reachable === 1 ? "online" : "offline",
    gamePlaying: row.gamePlaying === 1,
    playingGameId: row.playingGameId,
    playingText: row.playingText,
    checkedAt: row.checkedAt.toISOString(),
  };
}

async function spawnStatusCheck(ctx: Ctx): Promise<void> {
  const db = ctx.db<typeof schema>();
  const row = await readStatusRow(ctx);
  const now = new Date();
  if (
    row?.checkedAt &&
    now.getTime() - row.checkedAt.getTime() <= STATUS_STALE_MS
  ) {
    return;
  }
  try {
    await ctx.agent.spawnTask(
      "Check the pinball cabinet status through the vpin bridge. " +
        `Run this shell command first: ${VPIN_CLI} health ` +
        'It prints one JSON object like {"ok": true, "cabinet_reachable": true, "game_playing": false, "dry_run": false}. ' +
        `Then run: ${VPIN_CLI} status ` +
        'It prints the cabinet game status JSON, which includes a numeric "gameId" (greater than 0 while a game is running, -1 when idle) and may include a "text" field with the playing table name. ' +
        "Report the result by calling this artifact's saveCabinetStatus action exactly once: " +
        "reachable = the cabinet_reachable value from health (false if health failed or printed no JSON), " +
        "gamePlaying = true when health says game_playing or the status gameId is greater than 0, " +
        "playingGameId = the status gameId when it is greater than 0, otherwise null, " +
        "playingText = the status text field when present, otherwise null. Do nothing else.",
      { expectsAction: "saveCabinetStatus", dedupeKey: "cabinet-status" },
    );
    void db;
  } catch {
    // A failed spawn must never break the page; stored state is served.
  }
}

async function spawnBridgeSync(ctx: Ctx, force: boolean): Promise<void> {
  const db = ctx.db<typeof schema>();
  const row = await readSyncRow(ctx);
  const now = new Date();
  if (
    !force &&
    row?.lastAttemptAt &&
    now.getTime() - row.lastAttemptAt.getTime() <= SYNC_STALE_MS
  ) {
    return;
  }
  await db
    .insert(schema.bridgeSync)
    .values({ id: 1, lastAttemptAt: now })
    .onConflictDoUpdate({
      target: schema.bridgeSync.id,
      set: { lastAttemptAt: now },
    });
  try {
    await ctx.agent.spawnTask(
      "Pull the pinball cabinet library and high scores from the vpin bridge and save them into this artifact. " +
        `Step 1: run ${VPIN_CLI} list . It prints a JSON array like [{"id": 312, "name": "Goldeneye"}, ...] of every table on the cabinet. ` +
        `Step 2: run ${VPIN_CLI} games . It prints the bridge /api/games payload: normally a JSON array of VPin Studio game objects, but it may instead print an object with a "raw" text field (the plain tables export) or fail with an HTTP error when the cabinet is unreachable. ` +
        `Step 3: run ${VPIN_CLI} playlists . It prints a JSON array of playlist objects. ` +
        `Step 4: run ${VPIN_CLI} highscores . It prints one JSON object: either {"ok": true, "highscores": [{"gameId": 1, "text": "<table name>", "score": 123, "playerInitials": "SRG"}, ...]}, or {"ok": true, "raw": "<full semicolon export text>"}, or it fails with an HTTP error. ` +
        "Then call this artifact's saveBridgeSync action exactly once with: " +
        "games = one entry per distinct table, merging steps 1 and 2: gameId = the numeric id, name = gameDisplayName or the list name, maker = the manufacturer/vendor field when the game object has one (otherwise null), year = the numeric year/releaseYear field when present (otherwise null), rawJson = JSON.stringify of the full game object truncated to 3000 characters (null when step 2 gave no object for that table). Use step 1 alone when step 2 failed. " +
        "playlists = step 3 reshaped to [{playlistId: <numeric id>, name: <name>, gameIds: [<numeric game ids from the playlist's games/gameIds members, empty array when none are listed>]}] (empty array when step 3 failed). " +
        "entries = when step 4 printed ok:true with a highscores array, that array reshaped to [{gameId, score, initials: playerInitials or null, text}]; otherwise an empty array. " +
        "raw = when step 4 printed ok:true with raw text, that exact text; otherwise null. " +
        "ok = true when at least the list or highscores step succeeded; error = null then. When every step failed (for example the cabinet is unreachable), pass ok:false, games: [], playlists: [], entries: [], raw: null, and error: a short plain-language description including the HTTP status or bridge error message. Do nothing else.",
      { expectsAction: "saveBridgeSync", dedupeKey: "bridge-sync" },
    );
  } catch {
    // Stored data (or the honest never/error state) is served instead.
  }
}

function parseRawExport(
  raw: string,
): { gameId: number; score: number; initials: string | null; rank: number }[] {
  const out: {
    gameId: number;
    score: number;
    initials: string | null;
    rank: number;
  }[] = [];
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("gameId;")) continue;
    const fields = line.split(";");
    if (fields.length < 5) continue;
    const gameId = Number((fields[0] ?? "").trim());
    if (!Number.isSafeInteger(gameId)) continue;
    // Fields: gameId; name; createdAt; initials1; score1; initials2; score2; ...
    for (let slot = 0; slot < 10; slot++) {
      const initialsRaw = (fields[3 + slot * 2] ?? "").trim();
      const scoreRaw = (fields[4 + slot * 2] ?? "").trim().replace(/,/g, "");
      if (!scoreRaw) continue;
      const score = Number(scoreRaw);
      if (!Number.isSafeInteger(score) || score <= 0) continue;
      out.push({
        gameId,
        score,
        initials: initialsRaw === "" ? null : initialsRaw,
        rank: slot + 1,
      });
    }
  }
  return out;
}

function parseJsonObject(text: string | null): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const value: unknown = JSON.parse(text);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function mediaScreens(mediaJson: string | null): string[] {
  if (!mediaJson) return [];
  const found = new Set<string>();
  const known = [
    "PlayField",
    "BackGlass",
    "Wheel",
    "Topper",
    "DMD",
    "GameInfo",
    "GameHelp",
    "Loading",
    "Logo",
    "Audio",
  ];
  for (const name of known) {
    if (mediaJson.toLowerCase().includes(name.toLowerCase())) found.add(name);
  }
  return [...found];
}

function detailFields(detailsJson: string | null): { key: string; value: string }[] {
  const obj = parseJsonObject(detailsJson);
  if (!obj) return [];
  const fields: { key: string; value: string }[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined || value === "") continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      fields.push({ key, value: String(value) });
    }
  }
  return fields.slice(0, 30);
}

const tableShape = z.object({
  id: z.number(),
  cabinetGameId: z.number(),
  name: z.string(),
  maker: z.string().nullable(),
  year: z.number().nullable(),
  bestScore: z.number().nullable(),
  bestInitials: z.string().nullable(),
  scoreCount: z.number(),
  playlists: z.array(z.string()),
});

const libraryResponse = z.object({
  tables: z.array(tableShape),
  playlists: z.array(
    z.object({ id: z.number(), name: z.string(), count: z.number() }),
  ),
  makers: z.array(z.object({ maker: z.string(), count: z.number() })),
  sync: syncShape,
  status: statusShape,
});

export const Actions = {
  getLibrary: defineAction({
    description:
      "Returns the cabinet table library with each table's best score, playlist memberships, maker counts, sync state, and cabinet status. Quietly starts a fresh bridge pull when the stored one is stale.",
    request: z.object({}),
    response: libraryResponse,
    async handler(ctx): Promise<z.infer<typeof libraryResponse>> {
      await spawnBridgeSync(ctx, false);
      await spawnStatusCheck(ctx);
      const db = ctx.db<typeof schema>();
      const [tableRows, scoreRows, playlistRows, syncRow, statusRow] =
        await Promise.all([
          db.select().from(schema.tables).orderBy(asc(schema.tables.name)),
          db.select().from(schema.scores).orderBy(asc(schema.scores.rank)),
          db.select().from(schema.playlists).orderBy(asc(schema.playlists.name)),
          readSyncRow(ctx),
          readStatusRow(ctx),
        ]);
      const bestByTable = new Map<
        number,
        { score: number; initials: string | null; count: number }
      >();
      for (const s of scoreRows) {
        const cur = bestByTable.get(s.tableId);
        if (!cur) {
          bestByTable.set(s.tableId, {
            score: s.score,
            initials: s.initials,
            count: 1,
          });
        } else {
          cur.count += 1;
          if (s.score > cur.score) {
            cur.score = s.score;
            cur.initials = s.initials;
          }
        }
      }
      const membership = new Map<number, string[]>();
      const playlistInfos: { id: number; name: string; count: number }[] = [];
      for (const p of playlistRows) {
        let ids: number[] = [];
        try {
          const parsed: unknown = JSON.parse(p.gameIdsJson);
          if (Array.isArray(parsed)) {
            ids = parsed.filter(
              (v): v is number => typeof v === "number",
            );
          }
        } catch {
          ids = [];
        }
        playlistInfos.push({ id: p.id, name: p.name, count: ids.length });
        for (const gid of ids) {
          const arr = membership.get(gid) ?? [];
          arr.push(p.name);
          membership.set(gid, arr);
        }
      }
      const makerCounts = new Map<string, number>();
      for (const t of tableRows) {
        if (t.maker) makerCounts.set(t.maker, (makerCounts.get(t.maker) ?? 0) + 1);
      }
      return {
        tables: tableRows.map((t) => {
          const best = bestByTable.get(t.id);
          return {
            id: t.id,
            cabinetGameId: t.cabinetGameId,
            name: t.name,
            maker: t.maker,
            year: t.year,
            bestScore: best?.score ?? null,
            bestInitials: best?.initials ?? null,
            scoreCount: best?.count ?? 0,
            playlists: membership.get(t.cabinetGameId) ?? [],
          };
        }),
        playlists: playlistInfos,
        makers: [...makerCounts.entries()]
          .map(([maker, count]) => ({ maker, count }))
          .sort((a, b) => b.count - a.count),
        sync: toSyncInfo(syncRow),
        status: toStatusInfo(statusRow),
      };
    },
  }),

  getTableDetail: defineAction({
    description:
      "Returns one table's scores, cabinet detail fields, and media screens. Fetches details and media from the bridge in the background when they are missing or stale.",
    request: z.object({ cabinetGameId: z.number().int() }),
    response: z.object({
      found: z.boolean(),
      table: tableShape.nullable(),
      scores: z.array(
        z.object({
          score: z.number(),
          initials: z.string().nullable(),
          rank: z.number(),
        }),
      ),
      detailFields: z.array(
        z.object({ key: z.string(), value: z.string() }),
      ),
      mediaScreens: z.array(z.string()),
      hasDetails: z.boolean(),
      sync: syncShape,
      status: statusShape,
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.tables)
        .where(eq(schema.tables.cabinetGameId, args.cabinetGameId))
        .limit(1);
      const table = rows[0];
      const [syncRow, statusRow] = await Promise.all([
        readSyncRow(ctx),
        readStatusRow(ctx),
      ]);
      if (!table) {
        return {
          found: false,
          table: null,
          scores: [],
          detailFields: [],
          mediaScreens: [],
          hasDetails: false,
          sync: toSyncInfo(syncRow),
          status: toStatusInfo(statusRow),
        };
      }
      const stale =
        !table.detailFetchedAt ||
        Date.now() - table.detailFetchedAt.getTime() > DETAIL_STALE_MS;
      if (stale) {
        try {
          await ctx.agent.spawnTask(
            `Fetch the cabinet details and frontend media for one pinball table through the vpin bridge. The table's game id is ${args.cabinetGameId}. ` +
              `Run: ${VPIN_CLI} details ${args.cabinetGameId} . It prints a JSON object with the table's metadata, or fails when the cabinet is unreachable. ` +
              `Then run: ${VPIN_CLI} media ${args.cabinetGameId} . It prints a JSON value describing the table's frontend media, or fails. ` +
              "Then call this artifact's saveTableDetail action exactly once with: gameId = " +
              `${args.cabinetGameId}, detailsJson = JSON.stringify of the details output truncated to 12000 characters (null when the command failed), mediaJson = JSON.stringify of the media output truncated to 12000 characters (null when the command failed). Do nothing else.`,
            {
              expectsAction: "saveTableDetail",
              dedupeKey: `table-detail-${args.cabinetGameId}`,
            },
          );
        } catch {
          // Detail stays absent; the page shows scores and basics.
        }
      }
      const scoreRows = await db
        .select()
        .from(schema.scores)
        .where(eq(schema.scores.tableId, table.id))
        .orderBy(asc(schema.scores.rank));
      const playlistRows = await db.select().from(schema.playlists);
      const names: string[] = [];
      for (const p of playlistRows) {
        try {
          const parsed: unknown = JSON.parse(p.gameIdsJson);
          if (Array.isArray(parsed) && parsed.includes(args.cabinetGameId)) {
            names.push(p.name);
          }
        } catch {
          // ignore malformed membership
        }
      }
      const best = scoreRows.reduce<{ score: number; initials: string | null } | null>(
        (acc, s) =>
          acc === null || s.score > acc.score
            ? { score: s.score, initials: s.initials }
            : acc,
        null,
      );
      return {
        found: true,
        table: {
          id: table.id,
          cabinetGameId: table.cabinetGameId,
          name: table.name,
          maker: table.maker,
          year: table.year,
          bestScore: best?.score ?? null,
          bestInitials: best?.initials ?? null,
          scoreCount: scoreRows.length,
          playlists: names,
        },
        scores: scoreRows.map((s) => ({
          score: s.score,
          initials: s.initials,
          rank: s.rank,
        })),
        detailFields: detailFields(table.detailsJson),
        mediaScreens: mediaScreens(table.mediaJson),
        hasDetails: table.detailsJson !== null || table.mediaJson !== null,
        sync: toSyncInfo(syncRow),
        status: toStatusInfo(statusRow),
      };
    },
  }),

  saveTableDetail: defineAction({
    description:
      "Stores one table's details and media payloads from the bridge (called by the background detail task).",
    request: z.object({
      gameId: z.number().int(),
      detailsJson: z.string().max(20000).nullable(),
      mediaJson: z.string().max(20000).nullable(),
    }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select({ id: schema.tables.id })
        .from(schema.tables)
        .where(eq(schema.tables.cabinetGameId, args.gameId))
        .limit(1);
      const row = rows[0];
      if (row) {
        await db
          .update(schema.tables)
          .set({
            detailsJson: args.detailsJson,
            mediaJson: args.mediaJson,
            detailFetchedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(schema.tables.id, row.id));
        ctx.invalidateQueries();
      }
      return { ok: true };
    },
  }),

  getStats: defineAction({
    description:
      "Returns library statistics computed from the stored cabinet pull: totals, tables by maker and decade, highest scores, player leaderboard, and score coverage.",
    request: z.object({}),
    response: z.object({
      totalTables: z.number(),
      tablesWithScores: z.number(),
      totalScoreEntries: z.number(),
      highestScore: z.number().nullable(),
      distinctMakers: z.number(),
      playlistCount: z.number(),
      byMaker: z.array(z.object({ maker: z.string(), count: z.number() })),
      byDecade: z.array(z.object({ decade: z.string(), count: z.number() })),
      topTables: z.array(
        z.object({
          cabinetGameId: z.number(),
          name: z.string(),
          maker: z.string().nullable(),
          year: z.number().nullable(),
          bestScore: z.number(),
          bestInitials: z.string().nullable(),
        }),
      ),
      players: z.array(
        z.object({
          initials: z.string(),
          tablesTopped: z.number(),
          topScoreSum: z.number(),
          bestScore: z.number(),
        }),
      ),
      sync: syncShape,
      status: statusShape,
    }),
    async handler(ctx) {
      await spawnBridgeSync(ctx, false);
      await spawnStatusCheck(ctx);
      const db = ctx.db<typeof schema>();
      const [tableRows, scoreRows, playlistRows, syncRow, statusRow] =
        await Promise.all([
          db.select().from(schema.tables),
          db.select().from(schema.scores),
          db.select().from(schema.playlists),
          readSyncRow(ctx),
          readStatusRow(ctx),
        ]);
      const tableById = new Map(tableRows.map((t) => [t.id, t]));
      const bestByTable = new Map<number, { score: number; initials: string | null }>();
      for (const s of scoreRows) {
        const cur = bestByTable.get(s.tableId);
        if (!cur || s.score > cur.score) {
          bestByTable.set(s.tableId, { score: s.score, initials: s.initials });
        }
      }
      const byMakerMap = new Map<string, number>();
      const byDecadeMap = new Map<string, number>();
      for (const t of tableRows) {
        if (t.maker) byMakerMap.set(t.maker, (byMakerMap.get(t.maker) ?? 0) + 1);
        if (t.year) {
          const decade = `${Math.floor(t.year / 10) * 10}s`;
          byDecadeMap.set(decade, (byDecadeMap.get(decade) ?? 0) + 1);
        }
      }
      const topTables = [...bestByTable.entries()]
        .map(([tableId, best]) => {
          const t = tableById.get(tableId);
          if (!t) return null;
          return {
            cabinetGameId: t.cabinetGameId,
            name: t.name,
            maker: t.maker,
            year: t.year,
            bestScore: best.score,
            bestInitials: best.initials,
          };
        })
        .filter((v): v is NonNullable<typeof v> => v !== null)
        .sort((a, b) => b.bestScore - a.bestScore)
        .slice(0, 10);
      const playerMap = new Map<
        string,
        { tablesTopped: number; topScoreSum: number; bestScore: number }
      >();
      for (const [, best] of bestByTable) {
        if (!best.initials) continue;
        const cur = playerMap.get(best.initials) ?? {
          tablesTopped: 0,
          topScoreSum: 0,
          bestScore: 0,
        };
        cur.tablesTopped += 1;
        cur.topScoreSum += best.score;
        cur.bestScore = Math.max(cur.bestScore, best.score);
        playerMap.set(best.initials, cur);
      }
      const highest = topTables[0]?.bestScore ?? null;
      return {
        totalTables: tableRows.length,
        tablesWithScores: bestByTable.size,
        totalScoreEntries: scoreRows.length,
        highestScore: highest,
        distinctMakers: byMakerMap.size,
        playlistCount: playlistRows.length,
        byMaker: [...byMakerMap.entries()]
          .map(([maker, count]) => ({ maker, count }))
          .sort((a, b) => b.count - a.count)
          .slice(0, 12),
        byDecade: [...byDecadeMap.entries()]
          .map(([decade, count]) => ({ decade, count }))
          .sort((a, b) => a.decade.localeCompare(b.decade)),
        topTables,
        players: [...playerMap.entries()]
          .map(([initials, v]) => ({ initials, ...v }))
          .sort((a, b) => b.tablesTopped - a.tablesTopped || b.topScoreSum - a.topScoreSum)
          .slice(0, 10),
        sync: toSyncInfo(syncRow),
        status: toStatusInfo(statusRow),
      };
    },
  }),

  requestSync: defineAction({
    description:
      "Starts a fresh library and high-score pull from the vpin bridge right away.",
    request: z.object({}),
    response: okResponse,
    async handler(ctx): Promise<z.infer<typeof okResponse>> {
      await spawnBridgeSync(ctx, true);
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  saveBridgeSync: defineAction({
    description:
      "Stores one library pull from the vpin bridge (called by the background sync task). Replaces the stored tables, playlists, and cabinet scores with the pulled set.",
    request: z.object({
      ok: z.boolean(),
      games: z
        .array(
          z.object({
            gameId: z.number().int(),
            name: z.string().min(1).max(300),
            maker: z.string().max(120).nullable(),
            year: z.number().int().min(1900).max(2100).nullable(),
            rawJson: z.string().max(4000).nullable(),
          }),
        )
        .max(2000),
      playlists: z
        .array(
          z.object({
            playlistId: z.number().int(),
            name: z.string().min(1).max(200),
            gameIds: z.array(z.number().int()).max(2000),
          }),
        )
        .max(100),
      entries: z
        .array(
          z.object({
            gameId: z.number().int().nullable(),
            score: z.number().int().min(0).max(999_999_999_999),
            initials: z.string().max(12).nullable(),
            text: z.string().max(500),
          }),
        )
        .max(5000),
      raw: z.string().max(300000).nullable(),
      error: z.string().max(500).nullable(),
    }),
    response: z.object({ ok: z.boolean(), storedTables: z.number(), storedScores: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const now = new Date();
      if (!args.ok) {
        await db
          .insert(schema.bridgeSync)
          .values({
            id: 1,
            lastAttemptAt: now,
            lastError: args.error ?? "The bridge pull failed.",
          })
          .onConflictDoUpdate({
            target: schema.bridgeSync.id,
            set: {
              lastAttemptAt: now,
              lastError: args.error ?? "The bridge pull failed.",
            },
          });
        ctx.invalidateQueries();
        return { ok: false, storedTables: 0, storedScores: 0 };
      }

      // Merge score sources: parsed entries (top score per table)
      // plus every slot parsed from the raw semicolon export.
      type Entry = { gameId: number; score: number; initials: string | null; rank: number };
      const merged = new Map<string, Entry>();
      for (const e of args.entries) {
        if (e.gameId === null) continue;
        merged.set(`${e.gameId}:1`, {
          gameId: e.gameId,
          score: e.score,
          initials: e.initials,
          rank: 1,
        });
      }
      if (args.raw) {
        for (const e of parseRawExport(args.raw)) {
          merged.set(`${e.gameId}:${e.rank}`, e);
        }
      }
      const entries = [...merged.values()];

      // Upsert tables, preserving fetched details/media.
      const existing = await db.select().from(schema.tables);
      const existingByGame = new Map(existing.map((t) => [t.cabinetGameId, t]));
      const seenGames = new Set<number>();
      for (const g of args.games) {
        if (seenGames.has(g.gameId)) continue;
        seenGames.add(g.gameId);
        const cur = existingByGame.get(g.gameId);
        if (cur) {
          await db
            .update(schema.tables)
            .set({
              name: g.name,
              maker: g.maker ?? cur.maker,
              year: g.year ?? cur.year,
              rawJson: g.rawJson ?? cur.rawJson,
              updatedAt: now,
            })
            .where(eq(schema.tables.id, cur.id));
        } else {
          await db.insert(schema.tables).values({
            cabinetGameId: g.gameId,
            name: g.name,
            maker: g.maker,
            year: g.year,
            rawJson: g.rawJson,
            createdAt: now,
            updatedAt: now,
          });
        }
      }
      // Tables the cabinet no longer reports are removed with their scores.
      for (const t of existing) {
        if (args.games.length > 0 && !seenGames.has(t.cabinetGameId)) {
          await db.delete(schema.scores).where(eq(schema.scores.tableId, t.id));
          await db.delete(schema.tables).where(eq(schema.tables.id, t.id));
        }
      }

      // Replace playlists wholesale.
      await db.delete(schema.playlists);
      for (const p of args.playlists) {
        await db.insert(schema.playlists).values({
          id: p.playlistId,
          name: p.name,
          gameIdsJson: JSON.stringify(p.gameIds),
        });
      }

      // Replace scores wholesale from the pull, for known tables only.
      const fresh = await db.select().from(schema.tables);
      const tableIdByGame = new Map(fresh.map((t) => [t.cabinetGameId, t.id]));
      await db.delete(schema.scores);
      let storedScores = 0;
      for (const e of entries) {
        const tableId = tableIdByGame.get(e.gameId);
        if (tableId === undefined) continue;
        await db.insert(schema.scores).values({
          tableId,
          cabinetGameId: e.gameId,
          score: e.score,
          initials: e.initials,
          rank: e.rank,
          createdAt: now,
        });
        storedScores += 1;
      }

      await db
        .insert(schema.bridgeSync)
        .values({
          id: 1,
          lastAttemptAt: now,
          lastSuccessAt: now,
          lastError: null,
          tableCount: seenGames.size,
          scoreCount: storedScores,
        })
        .onConflictDoUpdate({
          target: schema.bridgeSync.id,
          set: {
            lastAttemptAt: now,
            lastSuccessAt: now,
            lastError: null,
            tableCount: seenGames.size,
            scoreCount: storedScores,
          },
        });
      ctx.invalidateQueries();
      return { ok: true, storedTables: seenGames.size, storedScores };
    },
  }),

  saveCabinetStatus: defineAction({
    description:
      "Stores one cabinet status reading from the vpin bridge check (called by the background status task).",
    request: z.object({
      reachable: z.boolean(),
      gamePlaying: z.boolean(),
      playingGameId: z.number().int().nullable(),
      playingText: z.string().max(300).nullable(),
    }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const db = ctx.db<typeof schema>();
      const values = {
        id: 1,
        reachable: args.reachable ? 1 : 0,
        gamePlaying: args.gamePlaying ? 1 : 0,
        playingGameId: args.playingGameId,
        playingText: args.playingText,
        checkedAt: new Date(),
      };
      await db
        .insert(schema.cabinetStatus)
        .values(values)
        .onConflictDoUpdate({
          target: schema.cabinetStatus.id,
          set: {
            reachable: values.reachable,
            gamePlaying: values.gamePlaying,
            playingGameId: values.playingGameId,
            playingText: values.playingText,
            checkedAt: values.checkedAt,
          },
        });
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  playTable: defineAction({
    description:
      "Launches a table on the arcade cabinet through VPin Studio via the vpin bridge. Creates a play request and starts the launch in the background; poll getPlayRequest for the outcome.",
    request: z.object({ cabinetGameId: z.number().int() }),
    response: z.object({
      ok: z.boolean(),
      requestId: z.number().nullable(),
      error: z.string().nullable(),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.tables)
        .where(eq(schema.tables.cabinetGameId, args.cabinetGameId))
        .limit(1);
      const table = rows[0];
      if (!table) {
        return {
          ok: false,
          requestId: null,
          error: "That table is not in the cabinet library yet. Sync first.",
        };
      }
      const status = await readStatusRow(ctx);
      if (status && status.reachable === 0) {
        return {
          ok: false,
          requestId: null,
          error: "The cabinet looks offline, so nothing was launched. Turn the cabinet on and try again.",
        };
      }
      if (status && status.gamePlaying === 1) {
        return {
          ok: false,
          requestId: null,
          error: "A game is already running on the cabinet. Finish that game first.",
        };
      }
      const inserted = await db
        .insert(schema.playRequests)
        .values({
          cabinetGameId: args.cabinetGameId,
          tableName: table.name,
          status: "pending",
          createdAt: new Date(),
        })
        .returning({ id: schema.playRequests.id });
      const requestId = inserted[0]?.id;
      if (requestId === undefined) {
        return { ok: false, requestId: null, error: "Could not start the launch." };
      }
      try {
        await ctx.agent.spawnTask(
          `Launch one pinball table on the arcade cabinet through VPin Studio, using the vpin bridge. The table is "${table.name}" with game id ${args.cabinetGameId}. ` +
            `Run exactly this shell command: ${VPIN_CLI} play ${args.cabinetGameId} ` +
            'It prints a JSON object: {"ok": true, ...} when VPin Studio launched the table on the cabinet, or an error such as HTTP 409 when a game is already playing, or HTTP 500 / 502 when the cabinet is unreachable. ' +
            `Then call this artifact's savePlayResult action exactly once with requestId = ${requestId} and: ` +
            'status "launched" and error null when the command printed ok:true; ' +
            'status "busy" and a short error message when the failure says a game is already playing (HTTP 409); ' +
            'status "failed" and a short plain-language error (including the HTTP status or bridge message) for every other failure. Do nothing else.',
          {
            expectsAction: "savePlayResult",
            dedupeKey: `play-request-${requestId}`,
          },
        );
      } catch {
        await db
          .update(schema.playRequests)
          .set({
            status: "failed",
            error: "The launch task could not be started.",
            finishedAt: new Date(),
          })
          .where(eq(schema.playRequests.id, requestId));
        return { ok: false, requestId, error: "The launch task could not be started." };
      }
      ctx.invalidateQueries();
      return { ok: true, requestId, error: null };
    },
  }),

  getPlayRequest: defineAction({
    description: "Returns the current state of one table launch request.",
    request: z.object({ requestId: z.number().int() }),
    response: z.object({
      found: z.boolean(),
      status: z.enum(["pending", "launched", "busy", "failed"]).nullable(),
      tableName: z.string().nullable(),
      error: z.string().nullable(),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.playRequests)
        .where(eq(schema.playRequests.id, args.requestId))
        .limit(1);
      const row = rows[0];
      if (!row) {
        return { found: false, status: null, tableName: null, error: null };
      }
      // A request left pending for over 3 minutes means the launch
      // task never reported back; surface it as failed instead of
      // spinning forever.
      if (
        row.status === "pending" &&
        Date.now() - row.createdAt.getTime() > 3 * 60 * 1000
      ) {
        return {
          found: true,
          status: "failed" as const,
          tableName: row.tableName,
          error: "The launch never reported back. Check the cabinet and try again.",
        };
      }
      return {
        found: true,
        status: row.status,
        tableName: row.tableName,
        error: row.error,
      };
    },
  }),

  savePlayResult: defineAction({
    description:
      "Stores the outcome of one cabinet table launch (called by the background play task).",
    request: z.object({
      requestId: z.number().int(),
      status: z.enum(["launched", "busy", "failed"]),
      error: z.string().max(500).nullable(),
    }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const db = ctx.db<typeof schema>();
      await db
        .update(schema.playRequests)
        .set({ status: args.status, error: args.error, finishedAt: new Date() })
        .where(eq(schema.playRequests.id, args.requestId));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),
} satisfies ActionsModule;
