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
//
// Playfield pictures: the vpin bridge serves JSON only, never image
// bytes, so thumbnails arrive through the PC bridge that runs on
// the cabinet itself: a background task locates each table's
// PlayField media file on the cabinet, downscales it to a small
// JPEG inside the PC bridge workspace, reads it back (binary files
// return base64), and stores it through saveTableThumbs. The bytes
// live in blob storage; getLibrary hands out blob URLs. No wheel
// images are fetched or shown, per the user's call.

import { defineAction, z, type ActionsModule, type Ctx } from "@hatch/space-sdk";
import { asc, eq } from "drizzle-orm";
import * as schema from "./schema";

const VPIN_CLI =
  "PYTHONPATH=/opt/muse/skills/custom-connector-setup/bin ~/workspace/custom-skills/local-vpin-bridge/bin/vpin";
const PCBRIDGE_CLI =
  "PC_BRIDGE_URL=${PC_BRIDGE_URL} PYTHONPATH=/opt/muse/skills/custom-connector-setup/bin ~/workspace/custom-skills/local-pc-bridge/bin/pcbridge";
const SYNC_STALE_MS = 30 * 1000;
const STATUS_STALE_MS = 20 * 1000;
const DETAIL_STALE_MS = 10 * 60 * 1000;
const THUMB_STALE_MS = 10 * 60 * 1000;

const okResponse = z.object({ ok: z.boolean() });

const syncShape = z.object({
  state: z.enum(["never", "ok", "error"]),
  lastSuccessAt: z.string().nullable(),
  lastAttemptAt: z.string().nullable(),
  lastError: z.string().nullable(),
  tableCount: z.number(),
  scoreCount: z.number(),
  lastAddedTables: z.number(),
  lastAddedScores: z.number(),
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
      lastAddedTables: 0,
      lastAddedScores: 0,
    };
  }
  return {
    state: row.lastSuccessAt ? "ok" : row.lastError ? "error" : "never",
    lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
    lastAttemptAt: row.lastAttemptAt?.toISOString() ?? null,
    lastError: row.lastError,
    tableCount: row.tableCount,
    scoreCount: row.scoreCount,
    lastAddedTables: row.lastAddedTables,
    lastAddedScores: row.lastAddedScores,
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
        "games = one entry per distinct table, merging steps 1 and 2: gameId = the numeric id, name = gameDisplayName or the list name, maker = the manufacturer/vendor field when the game object has one (otherwise null), year = the numeric year/releaseYear field when present (otherwise null), rawJson = JSON.stringify of the full game object truncated to 3000 characters (null when step 2 gave no object for that table), lastPlayedAt = the game object's last-played date/time field (names vary: lastPlayed, lastPlayedDate, playedAt) as an ISO string when present (otherwise null), addedAt = the game object's date-added field (names vary: dateAdded, addedAt, createdAt, modified) as an ISO string when present (otherwise null), features = an object {b2s, rom, colorDmd, pup} of booleans derived ONLY from signals actually present in that table's game object: b2s = a directb2s/backglass file or flag is present, rom = a ROM name (romName, rom, gameRom) is non-empty, colorDmd = altcolor / color DMD files or flags are present, pup = a PuP pack is present; when the game object carries none of these signals, pass features = null rather than guessing. Use step 1 alone when step 2 failed (features, lastPlayedAt and addedAt all null then). " +
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
  // Wheel is intentionally not listed: the user does not want
  // wheel pictures or wheel callouts anywhere in this app.
  const known = [
    "PlayField",
    "BackGlass",
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

type TableFeatures = {
  b2s: boolean;
  rom: boolean;
  colorDmd: boolean;
  pup: boolean;
};

const featuresShape = z.object({
  b2s: z.boolean(),
  rom: z.boolean(),
  colorDmd: z.boolean(),
  pup: z.boolean(),
});

function parseFeatures(json: string | null): TableFeatures | null {
  const obj = parseJsonObject(json);
  if (!obj) return null;
  return {
    b2s: obj.b2s === true,
    rom: obj.rom === true,
    colorDmd: obj.colorDmd === true,
    pup: obj.pup === true,
  };
}

// A feature once confirmed by any cabinet payload stays confirmed;
// later payloads can only add flags, never clear them.
function mergeFeatures(
  currentJson: string | null,
  incoming: TableFeatures | null,
): string | null {
  if (!incoming) return currentJson;
  const cur = parseFeatures(currentJson) ?? {
    b2s: false,
    rom: false,
    colorDmd: false,
    pup: false,
  };
  const merged: TableFeatures = {
    b2s: cur.b2s || incoming.b2s,
    rom: cur.rom || incoming.rom,
    colorDmd: cur.colorDmd || incoming.colorDmd,
    pup: cur.pup || incoming.pup,
  };
  return JSON.stringify(merged);
}

function badgesFor(features: TableFeatures | null): string[] {
  if (!features) return [];
  const badges: string[] = [];
  if (features.b2s) badges.push("B2S");
  if (features.rom) badges.push("ROM");
  if (features.pup) badges.push("PUP");
  if (features.colorDmd) badges.push("Color");
  return badges;
}

// Needs attention = the cabinet data on hand shows a gap: media is
// known and the playfield image is missing, or the backglass is
// known to be missing (features say no B2S, or known media has no
// BackGlass screen). Unknown data never counts as a gap.
function needsAttentionFor(row: {
  featuresJson: string | null;
  mediaJson: string | null;
}): boolean {
  const features = parseFeatures(row.featuresJson);
  const screens = row.mediaJson ? mediaScreens(row.mediaJson) : null;
  if (screens && !screens.includes("PlayField")) return true;
  if (features && !features.b2s) return true;
  if (screens && !screens.includes("BackGlass")) return true;
  return false;
}

function parseDateValue(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
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
  badges: z.array(z.string()),
  thumbUrl: z.string().nullable(),
  lastPlayedAt: z.string().nullable(),
  addedAt: z.string().nullable(),
  needsAttention: z.boolean(),
});

type TableRow = typeof schema.tables.$inferSelect;

async function toTableShape(
  ctx: Ctx,
  t: TableRow,
  best: { score: number; initials: string | null } | null,
  scoreCount: number,
  playlistNames: string[],
): Promise<z.infer<typeof tableShape>> {
  let thumbUrl: string | null = null;
  if (t.thumbBlobKey) {
    try {
      thumbUrl = await ctx.blobs.getUrl(t.thumbBlobKey);
    } catch {
      thumbUrl = null;
    }
  }
  return {
    id: t.id,
    cabinetGameId: t.cabinetGameId,
    name: t.name,
    maker: t.maker,
    year: t.year,
    bestScore: best?.score ?? null,
    bestInitials: best?.initials ?? null,
    scoreCount,
    playlists: playlistNames,
    badges: badgesFor(parseFeatures(t.featuresJson)),
    thumbUrl,
    lastPlayedAt: t.lastPlayedAt?.toISOString() ?? null,
    addedAt: t.addedAt?.toISOString() ?? null,
    needsAttention: needsAttentionFor(t),
  };
}

// Spawns the background thumbnail pull when some tables still
// have no playfield picture and the last attempt is stale. The
// task works through the PC bridge on the cabinet itself, because
// the vpin bridge serves JSON only, never image bytes.
async function spawnThumbSync(ctx: Ctx, force: boolean): Promise<void> {
  const db = ctx.db<typeof schema>();
  const syncRow = await readSyncRow(ctx);
  if (!syncRow?.lastSuccessAt) return;
  const now = new Date();
  if (
    !force &&
    syncRow.thumbAttemptAt &&
    now.getTime() - syncRow.thumbAttemptAt.getTime() <= THUMB_STALE_MS
  ) {
    return;
  }
  const rows = await db.select().from(schema.tables);
  const missingRows = rows
    .filter((t) => !t.thumbBlobKey)
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 40);
  if (missingRows.length === 0) return;
  await db
    .update(schema.bridgeSync)
    .set({ thumbAttemptAt: now })
    .where(eq(schema.bridgeSync.id, 1));
  const list = missingRows
    .map((t) => `${t.cabinetGameId} = ${t.name}`)
    .join("; ");
  try {
    await ctx.agent.spawnTask(
      "Fetch small playfield pictures for pinball tables from the cabinet and save them into this artifact. Work through this list of tables that still have no picture (gameId = name): " +
        list +
        ". For EACH table, follow these steps exactly: " +
        `Step 1: run ${VPIN_CLI} media <gameId> . It prints a JSON description of the table's frontend media. Find the PlayField entry and note its file name (a .png or .jpg file name). If there is no PlayField entry or the command fails, skip this table. Do NOT look for or use any wheel image. ` +
        `Step 2: check the cabinet PC bridge with: ${PCBRIDGE_CLI} health . If it fails or reports the bridge is down, stop the whole task immediately and call saveTableThumbs once with an empty items array. ` +
        `Step 3: use ${PCBRIDGE_CLI} exec with the powershell shell to locate that PlayField file on the cabinet: search the PinUP System media folders (POPMedia) and the VPin Studio media folders recursively for the exact file name. Then, still in PowerShell with System.Drawing, load the image, scale it so its width is at most 480 pixels (keep the aspect ratio), and save it as a JPEG (quality 80) into the PC bridge workspace as thumbs/<gameId>.jpg (create the thumbs folder first). If the file cannot be found or converted, skip this table. ` +
        `Step 4: run ${PCBRIDGE_CLI} read thumbs/<gameId>.jpg . It prints JSON whose content field holds the file base64-encoded. ` +
        "Step 5: collect the successful tables into batches of at most 20 and call this artifact's saveTableThumbs action once per batch with items = [{gameId, dataBase64: <the base64 content>, contentType: \"image/jpeg\"}]. Call it at least once even when every table failed (items = []). Do nothing else.",
      { expectsAction: "saveTableThumbs", dedupeKey: "thumb-sync" },
    );
  } catch {
    // Thumbnails are best-effort; the grid shows placeholders meanwhile.
  }
}

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
      await spawnThumbSync(ctx, false);
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
      const tables = await Promise.all(
        tableRows.map((t) => {
          const best = bestByTable.get(t.id);
          return toTableShape(
            ctx,
            t,
            best ? { score: best.score, initials: best.initials } : null,
            best?.count ?? 0,
            membership.get(t.cabinetGameId) ?? [],
          );
        }),
      );
      return {
        tables,
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
              `${args.cabinetGameId}, detailsJson = JSON.stringify of the details output truncated to 12000 characters (null when the command failed), mediaJson = JSON.stringify of the media output truncated to 12000 characters (null when the command failed), features = an object {b2s, rom, colorDmd, pup} of booleans derived ONLY from signals actually present in those two outputs: b2s = a directb2s/backglass file is listed, rom = a ROM name is non-empty, colorDmd = altcolor / color DMD files are listed, pup = a PuP pack is listed; pass features = null when neither output carries any of these signals. Do nothing else.`,
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
        table: await toTableShape(ctx, table, best, scoreRows.length, names),
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
      features: featuresShape.nullable().optional(),
    }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
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
            featuresJson: mergeFeatures(row.featuresJson, args.features ?? null),
            detailFetchedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(schema.tables.id, row.id));
        ctx.invalidateQueries();
      }
      return { ok: true };
    },
  }),

  saveTableThumbs: defineAction({
    description:
      "Stores playfield thumbnails pulled from the cabinet through the PC bridge (called by the background thumbnail task). Each item's bytes are saved to blob storage as that table's card picture.",
    request: z.object({
      items: z
        .array(
          z.object({
            gameId: z.number().int(),
            dataBase64: z.string().min(1).max(1_400_000),
            contentType: z.enum(["image/jpeg", "image/png"]),
          }),
        )
        .max(20),
    }),
    response: z.object({ ok: z.boolean(), stored: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      let stored = 0;
      for (const item of args.items) {
        const rows = await db
          .select({ id: schema.tables.id })
          .from(schema.tables)
          .where(eq(schema.tables.cabinetGameId, item.gameId))
          .limit(1);
        const row = rows[0];
        if (!row) continue;
        const key = `playfield-thumbs/${item.gameId}.jpg`;
        let bytes: Uint8Array;
        try {
          bytes = base64ToBytes(item.dataBase64);
        } catch {
          continue;
        }
        if (bytes.length === 0) continue;
        await ctx.blobs.put(key, bytes, { contentType: item.contentType });
        await db
          .update(schema.tables)
          .set({
            thumbBlobKey: key,
            thumbFetchedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(schema.tables.id, row.id));
        stored += 1;
      }
      if (stored > 0) ctx.invalidateQueries();
      return { ok: true, stored };
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
      "Starts a sync with the pinball cabinet right away: pulls the library, playlists, and high scores from the vpin bridge and saves only what the server does not already have (new or missing tables, scores, and playfield thumbnails).",
    request: z.object({}),
    response: okResponse,
    async handler(ctx): Promise<z.infer<typeof okResponse>> {
      await spawnBridgeSync(ctx, true);
      await spawnThumbSync(ctx, true);
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  saveBridgeSync: defineAction({
    description:
      "Stores one library pull from the vpin bridge (called by the background sync task). The save is incremental: it adds tables, playlists, and scores the server does not already have and refreshes changed entries in place; stored rows are never wiped or re-downloaded.",
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
            lastPlayedAt: z.string().max(64).nullable().optional(),
            addedAt: z.string().max(64).nullable().optional(),
            features: featuresShape.nullable().optional(),
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
    response: z.object({
      ok: z.boolean(),
      storedTables: z.number(),
      storedScores: z.number(),
      addedTables: z.number(),
      addedScores: z.number(),
      addedPlaylists: z.number(),
    }),
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
        return {
          ok: false,
          storedTables: 0,
          storedScores: 0,
          addedTables: 0,
          addedScores: 0,
          addedPlaylists: 0,
        };
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
        const featuresJson = mergeFeatures(
          cur?.featuresJson ?? null,
          g.features ?? null,
        );
        if (cur) {
          await db
            .update(schema.tables)
            .set({
              name: g.name,
              maker: g.maker ?? cur.maker,
              year: g.year ?? cur.year,
              rawJson: g.rawJson ?? cur.rawJson,
              featuresJson,
              lastPlayedAt:
                parseDateValue(g.lastPlayedAt) ?? cur.lastPlayedAt,
              addedAt: parseDateValue(g.addedAt) ?? cur.addedAt,
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
            featuresJson,
            lastPlayedAt: parseDateValue(g.lastPlayedAt),
            addedAt: parseDateValue(g.addedAt),
            createdAt: now,
            updatedAt: now,
          });
        }
      }
      // Incremental save: a sync only adds what the server does
      // not already have. Tables the cabinet no longer reports are
      // kept with their scores and pictures; nothing already saved
      // is deleted or re-downloaded.
      const addedTables = [...seenGames].filter(
        (id) => !existingByGame.has(id),
      ).length;

      // Playlists upsert by cabinet playlist id: new ones are
      // added, existing ones pick up the cabinet's current
      // membership, and saved playlists are never deleted.
      const existingPlaylists = await db.select().from(schema.playlists);
      const existingPlaylistIds = new Set(
        existingPlaylists.map((p) => p.id),
      );
      let addedPlaylists = 0;
      for (const p of args.playlists) {
        if (!existingPlaylistIds.has(p.playlistId)) addedPlaylists += 1;
        await db
          .insert(schema.playlists)
          .values({
            id: p.playlistId,
            name: p.name,
            gameIdsJson: JSON.stringify(p.gameIds),
          })
          .onConflictDoUpdate({
            target: schema.playlists.id,
            set: {
              name: p.name,
              gameIdsJson: JSON.stringify(p.gameIds),
            },
          });
      }

      // Scores merge incrementally, keyed by table + rank slot:
      // a slot already holding the same score and initials is
      // left untouched, a slot whose score changed on the cabinet
      // is updated in place (that change is the new info), and a
      // slot the server does not have yet is inserted. Scores for
      // tables outside this pull are never touched.
      const fresh = await db.select().from(schema.tables);
      const tableIdByGame = new Map(fresh.map((t) => [t.cabinetGameId, t.id]));
      const existingScores = await db.select().from(schema.scores);
      const scoreBySlot = new Map(
        existingScores.map((s) => [`${s.tableId}:${s.rank}`, s]),
      );
      let insertedScores = 0;
      let changedScores = 0;
      for (const e of entries) {
        const tableId = tableIdByGame.get(e.gameId);
        if (tableId === undefined) continue;
        const cur = scoreBySlot.get(`${tableId}:${e.rank}`);
        if (cur) {
          if (cur.score === e.score && (cur.initials ?? null) === e.initials) {
            continue;
          }
          await db
            .update(schema.scores)
            .set({ score: e.score, initials: e.initials })
            .where(eq(schema.scores.id, cur.id));
          changedScores += 1;
        } else {
          await db.insert(schema.scores).values({
            tableId,
            cabinetGameId: e.gameId,
            score: e.score,
            initials: e.initials,
            rank: e.rank,
            createdAt: now,
          });
          insertedScores += 1;
        }
      }
      const addedScores = insertedScores + changedScores;
      const totalTables = existing.length + addedTables;
      const totalScores = existingScores.length + insertedScores;

      await db
        .insert(schema.bridgeSync)
        .values({
          id: 1,
          lastAttemptAt: now,
          lastSuccessAt: now,
          lastError: null,
          tableCount: totalTables,
          scoreCount: totalScores,
          lastAddedTables: addedTables,
          lastAddedScores: addedScores,
        })
        .onConflictDoUpdate({
          target: schema.bridgeSync.id,
          set: {
            lastAttemptAt: now,
            lastSuccessAt: now,
            lastError: null,
            tableCount: totalTables,
            scoreCount: totalScores,
            lastAddedTables: addedTables,
            lastAddedScores: addedScores,
          },
        });
      ctx.invalidateQueries();
      return {
        ok: true,
        storedTables: totalTables,
        storedScores: totalScores,
        addedTables,
        addedScores,
        addedPlaylists,
      };
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
