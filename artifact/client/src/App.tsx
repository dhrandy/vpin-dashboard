import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
Bar,
BarChart,
CartesianGrid,
Cell,
Pie,
PieChart,
ResponsiveContainer,
Tooltip,
XAxis,
YAxis,
} from "recharts";
import { api, type ApiResponse } from "./api";

type Library = ApiResponse<typeof api, "getLibrary">;
type LibraryTable = Library["tables"][number];
type Stats = ApiResponse<typeof api, "getStats">;
type Detail = ApiResponse<typeof api, "getTableDetail">;

const COMPOSE_YAML = `services:
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
      # The app files come from the public dhrandy/vpin-dashboard
      # repo, which clones with no token or sign-in.
      VPIN_BRIDGE_URL: \${VPIN_BRIDGE_URL}
      VPIN_API_KEY: \${VPIN_API_KEY}
      GIT_REPO: \${GIT_REPO:-https://github.com/dhrandy/vpin-dashboard.git}
      GIT_BRANCH: \${GIT_BRANCH:-main}
      PORT: "8080"
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
            echo "vpin-dashboard: could not pull the files from GitHub. Check that the NAS can reach GitHub, then restart the stack." >&2
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
`;

function fmtScore(n: number | null): string {
  return n === null ? "—" : n.toLocaleString("en-US");
}

function fmtTime(iso: string | null): string {
  if (!iso) return "never";
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function SyncGlyph({ spinning }: { spinning: boolean }) {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={spinning ? "animate-spin" : undefined}
      style={spinning ? { animationDuration: "0.9s" } : undefined}
    >
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v6h-6" />
    </svg>
  );
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function PlayGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M6 4.5v15c0 .8.9 1.3 1.6.9l12-7.5c.6-.4.6-1.4 0-1.8l-12-7.5C6.9 3.2 6 3.7 6 4.5z" />
    </svg>
  );
}

function StatusPill({ status }: { status: Library["status"] }) {
  const color =
    status.state === "online"
      ? "var(--green)"
      : status.state === "offline"
        ? "var(--red)"
        : "var(--dim)";
  const label =
    status.state === "online"
      ? "Cabinet online"
      : status.state === "offline"
        ? "Cabinet offline"
        : "Cabinet status unknown";
  return (
    <span
      className="inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold"
      style={{ borderColor: "var(--border)", background: "var(--surface)" }}
    >
      <span
        className="inline-block h-2 w-2 rounded-full"
        style={{ background: color }}
      />
      {label}
    </span>
  );
}

type PlayState =
  | { kind: "idle" }
  | { kind: "pending"; requestId: number; tableName: string }
  | { kind: "done"; ok: boolean; message: string };

function usePlayController(onLaunched: () => void) {
  const [playState, setPlayState] = useState<PlayState>({ kind: "idle" });
  const playMutation = useMutation({
    mutationFn: (cabinetGameId: number) => api.playTable({ cabinetGameId }),
    onSuccess: (res, gameId) => {
      void gameId;
      if (!res.ok || res.requestId === null) {
        setPlayState({
          kind: "done",
          ok: false,
          message: res.error ?? "The launch could not be started.",
        });
        return;
      }
      setPlayState({
        kind: "pending",
        requestId: res.requestId,
        tableName: "",
      });
    },
    onError: (err) => {
      setPlayState({
        kind: "done",
        ok: false,
        message: err instanceof Error ? err.message : "The launch failed.",
      });
    },
  });
  const requestId =
    playState.kind === "pending" ? playState.requestId : null;
  const poll = useQuery({
    queryKey: ["play-request", requestId],
    queryFn: () => api.getPlayRequest({ requestId: requestId ?? -1 }),
    enabled: requestId !== null,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data || data.status === "pending" || !data.found) return 2000;
      return false;
    },
  });
  const pollData = poll.data;
  if (
    playState.kind === "pending" &&
    pollData &&
    pollData.found &&
    pollData.status !== null &&
    pollData.status !== "pending"
  ) {
    // Settle on the next render pass via effect-free state sync:
    // schedule through queueMicrotask to avoid setState during render warnings.
    queueMicrotask(() => {
      setPlayState((cur) => {
        if (cur.kind !== "pending") return cur;
        if (pollData.status === "launched") {
          onLaunched();
          return {
            kind: "done",
            ok: true,
            message: `${pollData.tableName ?? "Table"} is launching on the cabinet.`,
          };
        }
        return {
          kind: "done",
          ok: false,
          message:
            pollData.error ??
            (pollData.status === "busy"
              ? "A game is already running on the cabinet."
              : "The launch failed."),
        };
      });
    });
  }
  return { playState, setPlayState, play: playMutation.mutate, launching: playMutation.isPending };
}

function PlayBanner({
  playState,
  onDismiss,
}: {
  playState: PlayState;
  onDismiss: () => void;
}) {
  if (playState.kind === "idle") return null;
  const pending = playState.kind === "pending";
  const ok = playState.kind === "done" && playState.ok;
  return (
    <div
      role="status"
      className="mb-3 flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm"
      style={{
        borderColor: pending ? "var(--border)" : ok ? "var(--green)" : "var(--red)",
        background: "var(--surface)",
      }}
    >
      <span>
        {pending
          ? "Asking VPin Studio to launch the table on the cabinet…"
          : playState.kind === "done"
            ? playState.message
            : ""}
      </span>
      {!pending && (
        <button
          type="button"
          aria-label="Dismiss play message"
          onClick={onDismiss}
          className="shrink-0 rounded px-2 py-1 text-xs font-semibold"
          style={{ background: "var(--surface2)" }}
        >
          Dismiss
        </button>
      )}
    </div>
  );
}

function BadgeRow({ badges }: { badges: string[] }) {
  if (badges.length === 0) return null;
  return (
    <div className="mt-1.5 flex flex-wrap gap-1">
      {badges.map((b) => (
        <span
          key={b}
          className="rounded px-1.5 py-0.5 text-[11px] font-bold tracking-wide"
          style={{ background: "var(--surface2)", color: "var(--cyan)" }}
        >
          {b}
        </span>
      ))}
    </div>
  );
}

function TableCard({
  table,
  onOpen,
  onPlay,
  cabinetOnline,
  gamePlaying,
}: {
  table: LibraryTable;
  onOpen: () => void;
  onPlay: () => void;
  cabinetOnline: boolean;
  gamePlaying: boolean;
}) {
  const playDisabled = !cabinetOnline || gamePlaying;
  return (
    <article
      className="flex flex-col overflow-hidden rounded-lg border"
      style={{ borderColor: "var(--border)", background: "var(--surface)" }}
    >
      <button
        type="button"
        onClick={onOpen}
        aria-label={`View details for ${table.name}`}
        className="block text-left"
      >
        <div
          className="relative aspect-[3/4] overflow-hidden"
          style={{
            background:
              "linear-gradient(160deg, var(--surface2) 0%, #0d1830 60%, #132341 100%)",
          }}
        >
          {table.thumbUrl ? (
            <img
              src={table.thumbUrl}
              alt={`Playfield of ${table.name}`}
              className="absolute inset-0 h-full w-full object-cover"
              loading="lazy"
            />
          ) : (
            <div className="flex h-full flex-col justify-between p-3">
              <span
                className="self-start rounded px-1.5 py-0.5 text-[11px] font-bold tracking-wide"
                style={{ background: "rgba(0,0,0,0.45)", color: "var(--cyan)" }}
              >
                {table.scoreCount > 0 ? `${table.scoreCount} SCORE${table.scoreCount === 1 ? "" : "S"}` : "NO SCORES YET"}
              </span>
              <p className="font-display text-2xl leading-tight font-semibold tracking-wide uppercase">
                {table.name}
              </p>
            </div>
          )}
          {table.thumbUrl && table.needsAttention && (
            <span
              className="absolute top-2 right-2 rounded px-1.5 py-0.5 text-[11px] font-bold"
              style={{ background: "rgba(0,0,0,0.6)", color: "var(--red)" }}
              title="This table is missing something, like media or a backglass"
            >
              Needs attention
            </span>
          )}
        </div>
        <div className="px-3 pt-2">
          <p className="font-display truncate text-xl leading-tight font-semibold tracking-wide uppercase">
            {table.name}
          </p>
          <p className="mt-0.5 truncate text-xs" style={{ color: "var(--dim)" }}>
            {[table.maker, table.year].filter(Boolean).join(" · ") || "Maker and year not reported by the cabinet"}
          </p>
          <BadgeRow badges={table.badges} />
        </div>
      </button>
      <div className="mt-auto flex flex-wrap items-center justify-between gap-2 px-3 py-2">
        <div className="min-w-0">
          <p className="text-[11px] tracking-wide uppercase" style={{ color: "var(--dim)" }}>
            Top score{table.bestInitials ? ` · ${table.bestInitials}` : ""}
          </p>
          <p className="font-display text-lg leading-tight font-semibold whitespace-nowrap" style={{ color: "var(--accent)" }}>
            {fmtScore(table.bestScore)}
          </p>
        </div>
        <button
          type="button"
          onClick={onPlay}
          disabled={playDisabled}
          aria-label={`Play ${table.name} on the cabinet`}
          title={
            !cabinetOnline
              ? "Cabinet is offline"
              : gamePlaying
                ? "A game is already running"
                : `Launch ${table.name} on the cabinet`
          }
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-3 py-2 text-sm font-bold disabled:opacity-40"
          style={{ background: "var(--accent)", color: "var(--accent-ink)" }}
        >
          <PlayGlyph /> Play
        </button>
      </div>
    </article>
  );
}

const RECENT_MS = 30 * 24 * 60 * 60 * 1000;

function isFavourite(t: LibraryTable): boolean {
  return t.playlists.some((p) => /favourites|favorites/i.test(p));
}

function withinRecent(iso: string | null): boolean {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  return !Number.isNaN(t) && Date.now() - t <= RECENT_MS;
}

// Smart playlists are computed from the cabinet data itself:
// author/maker tags, originals, decades, and the mod tags that
// appear in the cabinet's own table names (Hybrid, nFozzy, Fleep,
// SSF). A list with no matching tables shows a real count of 0.
type SmartList = { key: string; label: string; test: (t: LibraryTable) => boolean };

const nameTag = (re: RegExp) => (t: LibraryTable) =>
  re.test(t.name) || re.test(t.maker ?? "");

const SMART_LISTS: SmartList[] = [
  {
    key: "smart:vpw",
    label: "VPin Workshop's",
    test: nameTag(/vpw|vpin workshop/i),
  },
  {
    key: "smart:originals",
    label: "Originals",
    test: (t) => !t.maker || t.maker.trim().toLowerCase() === "original",
  },
  ...[1970, 1980, 1990, 2000, 2010, 2020].map(
    (decade): SmartList => ({
      key: `smart:decade-${decade}`,
      label: `The ${decade}s`,
      test: (t) => t.year !== null && t.year >= decade && t.year < decade + 10,
    }),
  ),
  { key: "smart:hybrid", label: "Hybrid", test: nameTag(/hybrid/i) },
  { key: "smart:nfozzy", label: "nFozzy", test: nameTag(/nfozzy/i) },
  { key: "smart:fleep", label: "Fleep", test: nameTag(/fleep/i) },
  { key: "smart:ssf", label: "SSF", test: nameTag(/\bssf\b/i) },
];

const BADGE_FILTERS = ["B2S", "ROM", "PUP", "Color"] as const;

function LibraryView({
  data,
  onOpen,
  onPlay,
}: {
  data: Library;
  onOpen: (t: LibraryTable) => void;
  onPlay: (t: LibraryTable) => void;
}) {
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("name");
  const [filter, setFilter] = useState<string>("all");
  const [view, setView] = useState<"grid" | "list">("grid");
  const [browseBy, setBrowseBy] = useState<"maker" | "decade">("maker");

  const derived = useMemo(() => {
    const tables = data.tables;
    const topRatedIds = new Set(
      [...tables]
        .filter((t) => t.bestScore !== null)
        .sort((a, b) => (b.bestScore ?? 0) - (a.bestScore ?? 0))
        .slice(0, 10)
        .map((t) => t.cabinetGameId),
    );
    const match = (t: LibraryTable, key: string): boolean => {
      if (key === "all") return true;
      if (key === "with-scores") return t.scoreCount > 0;
      if (key === "no-scores") return t.scoreCount === 0;
      if (key === "cat:favourites") return isFavourite(t);
      if (key === "cat:top-rated") return topRatedIds.has(t.cabinetGameId);
      if (key === "cat:recently-played") return withinRecent(t.lastPlayedAt);
      if (key === "cat:recently-added") return withinRecent(t.addedAt);
      if (key === "cat:needs-attention") return t.needsAttention;
      if (key.startsWith("maker:")) return t.maker === key.slice(6);
      if (key.startsWith("decade:")) {
        const d = Number(key.slice(7));
        return t.year !== null && t.year >= d && t.year < d + 10;
      }
      if (key.startsWith("playlist:")) return t.playlists.includes(key.slice(9));
      if (key.startsWith("badge:")) return t.badges.includes(key.slice(6));
      if (key.startsWith("smart:")) {
        const list = SMART_LISTS.find((s) => s.key === key);
        return list ? list.test(t) : true;
      }
      return true;
    };
    const countFor = (key: string) => tables.filter((t) => match(t, key)).length;
    const decades = new Map<number, number>();
    for (const t of tables) {
      if (t.year) {
        const d = Math.floor(t.year / 10) * 10;
        decades.set(d, (decades.get(d) ?? 0) + 1);
      }
    }
    return { match, countFor, topRatedIds, decades };
  }, [data.tables]);

  const filtered = useMemo(() => {
    let rows = data.tables.filter((t) => derived.match(t, filter));
    const q = search.trim().toLowerCase();
    if (q) {
      rows = rows.filter(
        (t) =>
          t.name.toLowerCase().includes(q) ||
          (t.maker ?? "").toLowerCase().includes(q) ||
          String(t.year ?? "").includes(q),
      );
    }
    const sorted = [...rows];
    if (sort === "name") sorted.sort((a, b) => a.name.localeCompare(b.name));
    else if (sort === "score") sorted.sort((a, b) => (b.bestScore ?? -1) - (a.bestScore ?? -1));
    else if (sort === "year-desc") sorted.sort((a, b) => (b.year ?? -1) - (a.year ?? -1));
    else if (sort === "year-asc") sorted.sort((a, b) => (a.year ?? 99999) - (b.year ?? 99999));
    else if (sort === "maker") sorted.sort((a, b) => (a.maker ?? "~").localeCompare(b.maker ?? "~") || a.name.localeCompare(b.name));
    else if (sort === "played") sorted.sort((a, b) => (b.lastPlayedAt ?? "").localeCompare(a.lastPlayedAt ?? ""));
    else if (sort === "added") sorted.sort((a, b) => (b.addedAt ?? "").localeCompare(a.addedAt ?? ""));
    return sorted;
  }, [data.tables, filter, search, sort, derived]);

  const heading = useMemo(() => {
    if (filter === "all") return "All tables";
    if (filter === "with-scores") return "Tables with scores";
    if (filter === "no-scores") return "No scores yet";
    if (filter === "cat:favourites") return "Favourites";
    if (filter === "cat:top-rated") return "Top rated";
    if (filter === "cat:recently-played") return "Recently played";
    if (filter === "cat:recently-added") return "Recently added";
    if (filter === "cat:needs-attention") return "Needs attention";
    if (filter.startsWith("smart:")) return SMART_LISTS.find((s) => s.key === filter)?.label ?? "Smart playlist";
    if (filter.startsWith("badge:")) return `Has ${filter.slice(6)}`;
    if (filter.startsWith("decade:")) return `The ${filter.slice(7)}s`;
    return filter.replace(/^(maker|playlist):/, "");
  }, [filter]);

  const filterBtn = (key: string, label: string, count?: number, letter?: string) => (
    <button
      key={key}
      type="button"
      onClick={() => setFilter(key)}
      aria-pressed={filter === key}
      className="flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left text-sm"
      style={{
        background: filter === key ? "var(--surface2)" : "transparent",
        color: filter === key ? "var(--text)" : "var(--dim)",
        fontWeight: filter === key ? 600 : 400,
      }}
    >
      <span className="flex min-w-0 items-center gap-2">
        {letter !== undefined && (
          <span
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-[11px] font-bold"
            style={{ background: "var(--surface2)", color: "var(--cyan)" }}
            aria-hidden="true"
          >
            {letter}
          </span>
        )}
        <span className="truncate">{label}</span>
      </span>
      {count !== undefined && <span className="ml-2 text-xs">{count}</span>}
    </button>
  );

  const sectionTitle = (text: string) => (
    <p className="mt-4 px-2.5 text-[11px] font-bold tracking-widest uppercase first:mt-0" style={{ color: "var(--dim)" }}>
      {text}
    </p>
  );

  const smartWithCounts = SMART_LISTS.map((s) => ({ ...s, count: derived.countFor(s.key) }));

  const sidebar = (
    <div>
      {sectionTitle("Library")}
      <div className="mt-1 space-y-0.5">
        {filterBtn("all", "All tables", derived.countFor("all"))}
        {filterBtn("cat:favourites", "Favourites", derived.countFor("cat:favourites"))}
        {filterBtn("cat:top-rated", "Top rated", derived.countFor("cat:top-rated"))}
        {filterBtn("cat:recently-played", "Recently played", derived.countFor("cat:recently-played"))}
        {filterBtn("cat:recently-added", "Recently added", derived.countFor("cat:recently-added"))}
        {filterBtn("cat:needs-attention", "Needs attention", derived.countFor("cat:needs-attention"))}
        {filterBtn("with-scores", "With scores", derived.countFor("with-scores"))}
        {filterBtn("no-scores", "No scores yet", derived.countFor("no-scores"))}
      </div>

      <>
        {sectionTitle("Smart playlists")}
        <div className="mt-1 space-y-0.5">
          {smartWithCounts.map((s) => filterBtn(s.key, s.label, s.count))}
        </div>
      </>

      {data.playlists.length > 0 && (
        <>
          {sectionTitle("Your playlists")}
          <div className="mt-1 space-y-0.5">
            {data.playlists.map((p) => filterBtn(`playlist:${p.name}`, p.name, p.count))}
          </div>
        </>
      )}

      {(data.makers.length > 0 || derived.decades.size > 0) && (
        <>
          <div className="mt-4 flex items-center justify-between px-2.5">
            <p className="text-[11px] font-bold tracking-widest uppercase" style={{ color: "var(--dim)" }}>
              Browse by
            </p>
            <label className="sr-only" htmlFor="browse-by">Browse tables by</label>
            <select
              id="browse-by"
              value={browseBy}
              onChange={(e) => setBrowseBy(e.target.value as "maker" | "decade")}
              className="rounded-md border px-2 py-1 text-xs font-semibold"
              style={{ borderColor: "var(--border)", background: "var(--surface)", color: "var(--text)" }}
            >
              <option value="maker">Maker</option>
              <option value="decade">Decade</option>
            </select>
          </div>
          <div className="mt-1 space-y-0.5">
            {browseBy === "maker"
              ? data.makers.map((m) => filterBtn(`maker:${m.maker}`, m.maker, m.count, m.maker.charAt(0).toUpperCase()))
              : [...derived.decades.entries()]
                  .sort((a, b) => a[0] - b[0])
                  .map(([d, count]) => filterBtn(`decade:${d}`, `The ${d}s`, count, String(d).slice(2, 3)))}
          </div>
        </>
      )}
    </div>
  );

  const mobileChips: [string, string][] = [
    ["all", "All"],
    ["cat:favourites", "Favourites"],
    ["cat:top-rated", "Top rated"],
    ["cat:recently-played", "Recently played"],
    ["cat:recently-added", "Recently added"],
    ["cat:needs-attention", "Needs attention"],
    ["with-scores", "With scores"],
    ["no-scores", "No scores"],
    ...data.makers.slice(0, 6).map((m): [string, string] => [`maker:${m.maker}`, m.maker]),
  ];

  return (
    <div className="flex gap-4">
      <aside className="sticky top-24 hidden max-h-[calc(100vh-7rem)] w-52 shrink-0 self-start overflow-y-auto pr-1 md:block">{sidebar}</aside>
      <section className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="font-display text-3xl font-semibold tracking-wide uppercase">{heading}</h2>
          <span className="text-sm" style={{ color: "var(--dim)" }}>
            {filtered.length} of {data.tables.length} tables
          </span>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor="table-search">Search tables</label>
          <input
            id="table-search"
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search tables, makers, years"
            className="min-w-0 flex-1 basis-full rounded-md border px-3 py-2 text-sm sm:basis-auto sm:max-w-xs"
            style={{ borderColor: "var(--border)", background: "var(--surface)", color: "var(--text)" }}
          />
          <label className="sr-only" htmlFor="table-sort">Sort tables</label>
          <select
            id="table-sort"
            value={sort}
            onChange={(e) => setSort(e.target.value)}
            className="rounded-md border px-2 py-2 text-sm"
            style={{ borderColor: "var(--border)", background: "var(--surface)", color: "var(--text)" }}
          >
            <option value="name">Sort: Name</option>
            <option value="score">Sort: Highest score</option>
            <option value="played">Sort: Recently played</option>
            <option value="added">Sort: Recently added</option>
            <option value="maker">Sort: Maker</option>
            <option value="year-desc">Sort: Year, newest</option>
            <option value="year-asc">Sort: Year, oldest</option>
          </select>
          <div className="inline-flex overflow-hidden rounded-md border" style={{ borderColor: "var(--border)" }}>
            <button
              type="button"
              aria-label="Grid view"
              aria-pressed={view === "grid"}
              onClick={() => setView("grid")}
              className="px-3 py-2 text-sm font-semibold"
              style={{ background: view === "grid" ? "var(--surface2)" : "var(--surface)" }}
            >
              Grid
            </button>
            <button
              type="button"
              aria-label="List view"
              aria-pressed={view === "list"}
              onClick={() => setView("list")}
              className="px-3 py-2 text-sm font-semibold"
              style={{ background: view === "list" ? "var(--surface2)" : "var(--surface)" }}
            >
              List
            </button>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2" aria-label="Filter by feature">
          <span className="text-[11px] font-bold tracking-widest uppercase" style={{ color: "var(--dim)" }}>Has</span>
          {BADGE_FILTERS.map((b) => (
            <button
              key={b}
              type="button"
              onClick={() => setFilter(filter === `badge:${b}` ? "all" : `badge:${b}`)}
              aria-pressed={filter === `badge:${b}`}
              className="rounded-full border px-3 py-1 text-xs font-bold"
              style={{
                borderColor: "var(--border)",
                background: filter === `badge:${b}` ? "var(--surface2)" : "var(--surface)",
                color: filter === `badge:${b}` ? "var(--text)" : "var(--dim)",
              }}
            >
              {b}
            </button>
          ))}
        </div>

        <div className="mt-3 flex gap-2 overflow-x-auto pb-1 md:hidden" aria-label="Library filters">
          {mobileChips.map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setFilter(key)}
              aria-pressed={filter === key}
              className="shrink-0 rounded-full border px-3 py-1.5 text-xs font-semibold whitespace-nowrap"
              style={{
                borderColor: "var(--border)",
                background: filter === key ? "var(--surface2)" : "var(--surface)",
                color: filter === key ? "var(--text)" : "var(--dim)",
              }}
            >
              {label}
            </button>
          ))}
        </div>

        {data.tables.length === 0 ? (
          <div
            className="mt-6 rounded-lg border px-4 py-10 text-center"
            style={{ borderColor: "var(--border)", background: "var(--surface)" }}
          >
            <p className="font-display text-2xl font-semibold tracking-wide uppercase">No tables loaded yet</p>
            <p className="mx-auto mt-2 max-w-md text-sm" style={{ color: "var(--dim)" }}>
              {data.sync.state === "error"
                ? `The last pull from the cabinet failed: ${data.sync.lastError ?? "cabinet unreachable"}. Turn the cabinet on and tap Sync.`
                : data.sync.state === "never"
                  ? "The first pull from your cabinet is on its way. If the cabinet is off, turn it on and tap Sync."
                  : "The cabinet reported no tables on the last pull."}
            </p>
            <p className="mt-2 text-xs" style={{ color: "var(--dim)" }}>
              Last pull attempt: {fmtTime(data.sync.lastAttemptAt)}
            </p>
          </div>
        ) : filtered.length === 0 ? (
          <p className="mt-8 text-center text-sm" style={{ color: "var(--dim)" }}>
            No tables match that search and filter.
          </p>
        ) : view === "grid" ? (
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {filtered.map((t) => (
              <TableCard
                key={t.cabinetGameId}
                table={t}
                onOpen={() => onOpen(t)}
                onPlay={() => onPlay(t)}
                cabinetOnline={data.status.state === "online"}
                gamePlaying={data.status.gamePlaying}
              />
            ))}
          </div>
        ) : (
          <ul className="mt-4 divide-y rounded-lg border" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
            {filtered.map((t) => (
              <li key={t.cabinetGameId} className="flex items-center gap-3 px-3 py-2.5" style={{ borderColor: "var(--border)" }}>
                {t.thumbUrl && (
                  <img
                    src={t.thumbUrl}
                    alt=""
                    className="h-14 w-10 shrink-0 rounded object-cover"
                    loading="lazy"
                  />
                )}
                <button
                  type="button"
                  onClick={() => onOpen(t)}
                  aria-label={`View details for ${t.name}`}
                  className="min-w-0 flex-1 text-left"
                >
                  <span className="font-display block truncate text-lg leading-tight font-semibold tracking-wide uppercase">{t.name}</span>
                  <span className="block text-xs" style={{ color: "var(--dim)" }}>
                    {[t.maker, t.year].filter(Boolean).join(" · ")}
                    {t.bestScore !== null ? ` · Top ${fmtScore(t.bestScore)}${t.bestInitials ? ` (${t.bestInitials})` : ""}` : " · No scores yet"}
                  </span>
                  <BadgeRow badges={t.badges} />
                </button>
                <button
                  type="button"
                  onClick={() => onPlay(t)}
                  disabled={data.status.state !== "online" || data.status.gamePlaying}
                  aria-label={`Play ${t.name} on the cabinet`}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-3 py-2 text-sm font-bold disabled:opacity-40"
                  style={{ background: "var(--accent)", color: "var(--accent-ink)" }}
                >
                  <PlayGlyph /> Play
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function StatTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border px-4 py-3" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
      <p className="text-[11px] font-bold tracking-widest uppercase" style={{ color: "var(--dim)" }}>{label}</p>
      <p className="font-display mt-1 text-3xl leading-none font-semibold" style={{ color: "var(--accent)" }}>{value}</p>
      {sub && <p className="mt-1 text-xs" style={{ color: "var(--dim)" }}>{sub}</p>}
    </div>
  );
}

const chartTooltipStyle = {
  background: "#16233a",
  border: "1px solid #1f2f47",
  borderRadius: 8,
  color: "#e6edf7",
  fontSize: 12,
};

function StatsView({ stats, onOpen }: { stats: Stats; onOpen: (cabinetGameId: number, name: string) => void }) {
  if (stats.totalTables === 0) {
    return (
      <div className="rounded-lg border px-4 py-10 text-center" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
        <p className="font-display text-2xl font-semibold tracking-wide uppercase">No stats yet</p>
        <p className="mx-auto mt-2 max-w-md text-sm" style={{ color: "var(--dim)" }}>
          Stats are computed from your cabinet library and scores. Once a pull lands from the cabinet, this page fills in on its own.
        </p>
      </div>
    );
  }
  const coverage = [
    { name: "With scores", value: stats.tablesWithScores },
    { name: "No scores yet", value: stats.totalTables - stats.tablesWithScores },
  ];
  const maxTop = stats.topTables[0]?.bestScore ?? 1;
  return (
    <div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Tables on cabinet" value={String(stats.totalTables)} sub={`${stats.distinctMakers} makers`} />
        <StatTile label="Tables with scores" value={String(stats.tablesWithScores)} sub={`${stats.totalScoreEntries} score entries`} />
        <StatTile label="Highest score" value={fmtScore(stats.highestScore)} sub={stats.topTables[0] ? `on ${stats.topTables[0].name}` : undefined} />
        <StatTile label="Playlists" value={String(stats.playlistCount)} sub="from the cabinet" />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <section className="rounded-lg border p-4" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
          <h3 className="font-display text-xl font-semibold tracking-wide uppercase">Top tables by best score</h3>
          <ol className="mt-3 space-y-2">
            {stats.topTables.map((t, i) => (
              <li key={t.cabinetGameId}>
                <button
                  type="button"
                  onClick={() => onOpen(t.cabinetGameId, t.name)}
                  aria-label={`View details for ${t.name}`}
                  className="block w-full text-left"
                >
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="min-w-0 truncate text-sm font-semibold">
                      <span style={{ color: "var(--dim)" }}>{i + 1}. </span>
                      {t.name}
                      {t.bestInitials ? <span style={{ color: "var(--dim)" }}> · {t.bestInitials}</span> : null}
                    </span>
                    <span className="font-display shrink-0 text-lg font-semibold" style={{ color: "var(--accent)" }}>
                      {fmtScore(t.bestScore)}
                    </span>
                  </span>
                  <span className="mt-1 block h-1.5 overflow-hidden rounded-full" style={{ background: "var(--surface2)" }}>
                    <span className="block h-full rounded-full" style={{ width: `${Math.max(4, (t.bestScore / maxTop) * 100)}%`, background: "var(--accent)" }} />
                  </span>
                </button>
              </li>
            ))}
            {stats.topTables.length === 0 && (
              <li className="text-sm" style={{ color: "var(--dim)" }}>No scores pulled from the cabinet yet.</li>
            )}
          </ol>
        </section>

        <section className="rounded-lg border p-4" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
          <h3 className="font-display text-xl font-semibold tracking-wide uppercase">Player leaderboard</h3>
          <p className="text-xs" style={{ color: "var(--dim)" }}>By tables topped, from the cabinet score export.</p>
          <ol className="mt-3 space-y-2">
            {stats.players.map((p, i) => (
              <li key={p.initials} className="flex items-baseline justify-between gap-2 text-sm">
                <span className="font-semibold">
                  <span style={{ color: "var(--dim)" }}>{i + 1}. </span>
                  {p.initials}
                </span>
                <span style={{ color: "var(--dim)" }}>
                  {p.tablesTopped} table{p.tablesTopped === 1 ? "" : "s"} topped · best {fmtScore(p.bestScore)}
                </span>
              </li>
            ))}
            {stats.players.length === 0 && (
              <li className="text-sm" style={{ color: "var(--dim)" }}>No player initials in the cabinet scores yet.</li>
            )}
          </ol>

          <h3 className="font-display mt-6 text-xl font-semibold tracking-wide uppercase">Score coverage</h3>
          <div className="h-44">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={coverage} dataKey="value" nameKey="name" innerRadius={45} outerRadius={70} paddingAngle={2}>
                  <Cell fill="#f5b81d" />
                  <Cell fill="#2b3d5c" />
                </Pie>
                <Tooltip contentStyle={chartTooltipStyle} />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <p className="text-center text-xs" style={{ color: "var(--dim)" }}>
            {stats.tablesWithScores} of {stats.totalTables} tables have a recorded score
          </p>
        </section>

        <section className="rounded-lg border p-4" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
          <h3 className="font-display text-xl font-semibold tracking-wide uppercase">Tables by maker</h3>
          {stats.byMaker.length === 0 ? (
            <p className="mt-2 text-sm" style={{ color: "var(--dim)" }}>The cabinet did not report maker names on the last pull.</p>
          ) : (
            <div className="mt-2 h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={stats.byMaker} layout="vertical" margin={{ left: 8, right: 12 }}>
                  <CartesianGrid stroke="#1f2f47" horizontal={false} />
                  <XAxis type="number" tick={{ fill: "#8fa3bd", fontSize: 11 }} allowDecimals={false} />
                  <YAxis type="category" dataKey="maker" width={90} tick={{ fill: "#e6edf7", fontSize: 11 }} />
                  <Tooltip contentStyle={chartTooltipStyle} cursor={{ fill: "rgba(255,255,255,0.04)" }} />
                  <Bar dataKey="count" name="Tables" fill="#22d3ee" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </section>

        <section className="rounded-lg border p-4" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
          <h3 className="font-display text-xl font-semibold tracking-wide uppercase">Tables by decade</h3>
          {stats.byDecade.length === 0 ? (
            <p className="mt-2 text-sm" style={{ color: "var(--dim)" }}>The cabinet did not report table years on the last pull.</p>
          ) : (
            <div className="mt-2 h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={stats.byDecade} margin={{ left: 0, right: 12 }}>
                  <CartesianGrid stroke="#1f2f47" vertical={false} />
                  <XAxis dataKey="decade" tick={{ fill: "#e6edf7", fontSize: 11 }} />
                  <YAxis tick={{ fill: "#8fa3bd", fontSize: 11 }} allowDecimals={false} />
                  <Tooltip contentStyle={chartTooltipStyle} cursor={{ fill: "rgba(255,255,255,0.04)" }} />
                  <Bar dataKey="count" name="Tables" fill="#f5b81d" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function SelfHostView() {
  const [copied, setCopied] = useState(false);
  const copyCompose = async () => {
    try {
      await navigator.clipboard.writeText(COMPOSE_YAML);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };
  const downloadCompose = () => {
    const blob = new Blob([COMPOSE_YAML], { type: "text/yaml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "docker-compose.yml";
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="mx-auto max-w-3xl">
      <h2 className="font-display text-3xl font-semibold tracking-wide uppercase">Run it on your NAS</h2>
      <p className="mt-2 text-sm leading-relaxed" style={{ color: "var(--dim)" }}>
        This same library and stats app ships as a self-hosted package in the GitHub repo dhrandy/vpin-dashboard.
        The Docker stack pulls all the files itself: on first start the container clones the repo, and on every
        restart it pulls the latest files before the server starts, so nothing is ever copied to the NAS by hand.
        On the NAS it runs under Dockhand like your other apps, talks straight to your vpin bridge, and Play
        launches tables on the cabinet through VPin Studio, same as here.
      </p>
      <ol className="mt-4 list-decimal space-y-2 pl-5 text-sm leading-relaxed">
        <li>Create the stack in Dockhand from the compose file below. That is the only file you handle.</li>
        <li>In Dockhand Environment, set <code>VPIN_BRIDGE_URL</code> to your vpin-bridge address and <code>VPIN_API_KEY</code> to the same key the bridge uses.</li>
        <li>The repo is public, so the container pulls the app files itself with no GitHub token or sign-in. None of the values above are stored in the repo or this page.</li>
        <li>Start the stack. The container pulls the app files from GitHub on its own, then open the app on port 8746.</li>
        <li>To update later, just restart the stack: it pulls the newest files first, no rebuild and no copying. An older manual install keeps running as-is; empty the <code>app</code> folder and restart once to switch it to automatic pulls.</li>
      </ol>
      <div className="mt-5 overflow-hidden rounded-lg border" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
        <div className="flex items-center justify-between border-b px-3 py-2" style={{ borderColor: "var(--border)" }}>
          <span className="text-xs font-bold tracking-widest uppercase" style={{ color: "var(--dim)" }}>docker-compose.yml</span>
          <span className="flex gap-2">
            <button
              type="button"
              onClick={copyCompose}
              aria-label="Copy docker compose file"
              className="rounded-md px-3 py-1.5 text-xs font-bold"
              style={{ background: "var(--surface2)", color: "var(--text)" }}
            >
              {copied ? "Copied" : "Copy"}
            </button>
            <button
              type="button"
              onClick={downloadCompose}
              aria-label="Download docker compose file"
              className="rounded-md px-3 py-1.5 text-xs font-bold"
              style={{ background: "var(--accent)", color: "var(--accent-ink)" }}
            >
              Download
            </button>
          </span>
        </div>
        <pre className="overflow-x-auto p-3 text-xs leading-relaxed">{COMPOSE_YAML}</pre>
      </div>
      <p className="mt-3 text-xs" style={{ color: "var(--dim)" }}>
        CasaOS-style host paths, official Python image, no Dockerfile: Dockhand compose-only, matching how your other stacks run. The container installs git on first start only so it can pull the repo; after that, restarts just pull and start.
      </p>
    </div>
  );
}

function DetailOverlay({
  detail,
  onClose,
  onPlay,
}: {
  detail: Detail;
  onClose: () => void;
  onPlay: (t: LibraryTable) => void;
}) {
  const t = detail.table;
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center sm:items-center" role="dialog" aria-modal="true" aria-label={t ? `${t.name} details` : "Table details"}>
      <button type="button" aria-label="Close table details" onClick={onClose} className="absolute inset-0" style={{ background: "rgba(3,6,12,0.75)" }} />
      <div
        className="relative max-h-[88vh] w-full max-w-lg overflow-y-auto rounded-t-2xl border p-4 sm:rounded-2xl"
        style={{ borderColor: "var(--border)", background: "var(--surface)" }}
      >
        {!detail.found || !t ? (
          <>
            <p className="font-display text-2xl font-semibold uppercase">Table not loaded yet</p>
            <p className="mt-2 text-sm" style={{ color: "var(--dim)" }}>This table has not arrived from the cabinet pull yet.</p>
          </>
        ) : (
          <>
            {t.thumbUrl && (
              <div
                className="mb-3 h-72 overflow-hidden rounded-lg"
                style={{ background: "#060a14" }}
              >
                <img
                  src={t.thumbUrl}
                  alt={`Playfield of ${t.name}`}
                  className="h-full w-full object-contain"
                />
              </div>
            )}
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="font-display text-3xl leading-tight font-semibold tracking-wide uppercase">{t.name}</h3>
                <p className="text-sm" style={{ color: "var(--dim)" }}>
                  {[t.maker, t.year].filter(Boolean).join(" · ") || "Maker and year not reported by the cabinet"}
                </p>
                <BadgeRow badges={t.badges} />
                {(t.lastPlayedAt || t.addedAt) && (
                  <p className="mt-1.5 text-xs" style={{ color: "var(--dim)" }}>
                    {t.lastPlayedAt ? `Last played ${fmtTime(t.lastPlayedAt)}` : ""}
                    {t.lastPlayedAt && t.addedAt ? " · " : ""}
                    {t.addedAt ? `Added ${fmtTime(t.addedAt)}` : ""}
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="shrink-0 rounded-md px-3 py-1.5 text-sm font-bold"
                style={{ background: "var(--surface2)" }}
              >
                Close
              </button>
            </div>

            {(t.playlists.length > 0 || detail.mediaScreens.length > 0) && (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {t.playlists.map((p) => (
                  <span key={p} className="rounded-full border px-2.5 py-1 text-[11px] font-semibold" style={{ borderColor: "var(--border)", color: "var(--cyan)" }}>{p}</span>
                ))}
                {detail.mediaScreens.map((s) => (
                  <span key={s} className="rounded-full border px-2.5 py-1 text-[11px] font-semibold" style={{ borderColor: "var(--border)", color: "var(--dim)" }}>{s}</span>
                ))}
              </div>
            )}

            <div className="mt-4">
              <h4 className="text-[11px] font-bold tracking-widest uppercase" style={{ color: "var(--dim)" }}>
                Scores on this table{detail.sync.lastSuccessAt ? ` · pulled ${fmtTime(detail.sync.lastSuccessAt)}` : ""}
              </h4>
              {detail.scores.length === 0 ? (
                <p className="mt-2 text-sm" style={{ color: "var(--dim)" }}>No scores recorded on this table in the cabinet export.</p>
              ) : (
                <ol className="mt-2 space-y-1.5">
                  {detail.scores.map((s) => (
                    <li
                      key={`${s.rank}-${s.score}`}
                      className="flex items-center justify-between rounded-md px-3 py-2"
                      style={{ background: s.rank === 1 ? "rgba(245,184,29,0.10)" : "var(--surface2)" }}
                    >
                      <span className="text-sm font-semibold">
                        <span style={{ color: "var(--dim)" }}>#{s.rank} </span>
                        {s.initials ?? "—"}
                        {s.rank === 1 && <span className="ml-2 text-[11px] font-bold tracking-wide" style={{ color: "var(--accent)" }}>TOP SCORE</span>}
                      </span>
                      <span className="font-display text-xl font-semibold" style={{ color: s.rank === 1 ? "var(--accent)" : "var(--text)" }}>
                        {fmtScore(s.score)}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </div>

            {detail.detailFields.length > 0 ? (
              <div className="mt-4">
                <h4 className="text-[11px] font-bold tracking-widest uppercase" style={{ color: "var(--dim)" }}>Cabinet details</h4>
                <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
                  {detail.detailFields.map((f) => (
                    <div key={f.key} className="min-w-0">
                      <dt className="truncate text-[11px] uppercase" style={{ color: "var(--dim)" }}>{f.key}</dt>
                      <dd className="truncate font-medium">{f.value}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            ) : (
              <p className="mt-4 text-xs" style={{ color: "var(--dim)" }}>
                {detail.hasDetails
                  ? "The cabinet reported no extra detail fields for this table."
                  : "Cabinet details are being fetched in the background. Reopen this table in a few seconds to see them."}
              </p>
            )}

            <button
              type="button"
              onClick={() => onPlay(t)}
              disabled={detail.status.state !== "online" || detail.status.gamePlaying}
              aria-label={`Play ${t.name} on the cabinet`}
              className="mt-5 flex w-full items-center justify-center gap-2 rounded-lg px-4 py-3 text-base font-bold disabled:opacity-40"
              style={{ background: "var(--accent)", color: "var(--accent-ink)" }}
            >
              <PlayGlyph />
              {detail.status.state !== "online"
                ? "Cabinet offline"
                : detail.status.gamePlaying
                  ? "A game is already running"
                  : "Play on the cabinet"}
            </button>
            <p className="mt-2 text-center text-xs" style={{ color: "var(--dim)" }}>
              Launches through VPin Studio on the cabinet. The game runs on the cabinet, this app just starts it.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

type SyncRun = {
  startedAt: number;
  prevSuccessAt: string | null;
  prevAttemptAt: string | null;
  spawnAttemptAt: string | null;
};

export function App() {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<"library" | "stats" | "selfhost">("library");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [syncRun, setSyncRun] = useState<SyncRun | null>(null);
  const [syncNote, setSyncNote] = useState<{ ok: boolean; text: string } | null>(null);
  const { playState, setPlayState, play } = usePlayController(() => {
    void queryClient.invalidateQueries({ queryKey: ["library"] });
  });

  const library = useQuery({
    queryKey: ["library"],
    queryFn: () => api.getLibrary({}),
    refetchInterval: syncRun ? 3000 : 15000,
  });
  const stats = useQuery({
    queryKey: ["stats"],
    queryFn: () => api.getStats({}),
    enabled: tab === "stats",
    refetchInterval: 15000,
  });
  const detail = useQuery({
    queryKey: ["table-detail", selectedId],
    queryFn: () => api.getTableDetail({ cabinetGameId: selectedId ?? -1 }),
    enabled: selectedId !== null,
    refetchInterval: 5000,
  });
  const syncMutation = useMutation({
    mutationFn: () => api.requestSync({}),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["library"] });
      void queryClient.invalidateQueries({ queryKey: ["stats"] });
    },
    onError: (err) => {
      setSyncRun(null);
      setSyncNote({
        ok: false,
        text: err instanceof Error ? err.message : "The sync could not be started.",
      });
    },
  });

  const status = library.data?.status;
  const sync = library.data?.sync;

  // Watch a manual sync until the pull lands: success when the
  // stored lastSuccessAt advances past the click, failure when a
  // completed attempt (a second, later attempt stamp) carries an
  // error. The first new attempt stamp is just the sync starting.
  useEffect(() => {
    if (!syncRun || !sync) return;
    if (sync.lastSuccessAt !== null && sync.lastSuccessAt !== syncRun.prevSuccessAt) {
      const added = sync.lastAddedTables + sync.lastAddedScores;
      setSyncNote({
        ok: true,
        text:
          added === 0
            ? "Sync complete. Everything on the cabinet was already saved here."
            : `Sync complete. Added ${plural(sync.lastAddedTables, "new table")} and ${plural(sync.lastAddedScores, "new score")}.`,
      });
      setSyncRun(null);
      void queryClient.invalidateQueries({ queryKey: ["stats"] });
      return;
    }
    if (sync.lastAttemptAt !== null && sync.lastAttemptAt !== syncRun.prevAttemptAt) {
      if (syncRun.spawnAttemptAt === null) {
        setSyncRun({ ...syncRun, spawnAttemptAt: sync.lastAttemptAt });
      } else if (sync.lastAttemptAt !== syncRun.spawnAttemptAt && sync.lastError) {
        setSyncNote({ ok: false, text: `Sync failed: ${sync.lastError}` });
        setSyncRun(null);
      }
    }
  }, [syncRun, sync, queryClient]);

  // A sync that takes too long keeps running in the background;
  // stop blocking the button and say so.
  useEffect(() => {
    if (!syncRun) return;
    const t = setTimeout(() => {
      setSyncRun(null);
      setSyncNote({
        ok: true,
        text: "Sync is taking a while. It keeps running in the background and the page updates when it lands.",
      });
    }, 120000);
    return () => clearTimeout(t);
  }, [syncRun]);

  const startSync = () => {
    setSyncNote(null);
    setSyncRun({
      startedAt: Date.now(),
      prevSuccessAt: sync?.lastSuccessAt ?? null,
      prevAttemptAt: sync?.lastAttemptAt ?? null,
      spawnAttemptAt: null,
    });
    syncMutation.mutate();
  };
  const syncing = syncRun !== null || syncMutation.isPending;

  return (
    <div className="min-h-screen" style={{ background: "var(--bg)", color: "var(--text)" }}>
      <header
        className="sticky top-0 z-30 border-b pt-safe"
        style={{ borderColor: "var(--border)", background: "rgba(11,18,32,0.96)" }}
      >
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-2 px-3 py-2.5 sm:px-4">
          <nav className="flex gap-1" aria-label="Pages">
            {(
              [
                ["library", "Library"],
                ["stats", "Stats"],
                ["selfhost", "Self-host"],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setTab(key)}
                aria-pressed={tab === key}
                className="rounded-md px-3 py-1.5 text-sm font-semibold"
                style={{
                  background: tab === key ? "var(--surface2)" : "transparent",
                  color: tab === key ? "var(--text)" : "var(--dim)",
                }}
              >
                {label}
              </button>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            {status && <StatusPill status={status} />}
            <button
              type="button"
              onClick={startSync}
              disabled={syncing}
              aria-label="Sync with the pinball cabinet"
              className="flex items-center gap-1.5 rounded-md px-3.5 py-1.5 text-sm font-bold disabled:opacity-60"
              style={{ background: "var(--accent)", color: "var(--accent-ink)" }}
            >
              <SyncGlyph spinning={syncing} />
              {syncing ? "Syncing…" : "Sync"}
            </button>
          </div>
        </div>
        {status?.gamePlaying && (
          <div
            className="border-t px-3 py-1.5 text-center text-xs font-bold tracking-widest uppercase sm:px-4"
            style={{ borderColor: "var(--border)", background: "rgba(34,211,238,0.10)", color: "var(--cyan)" }}
            role="status"
          >
            Now playing{status.playingText ? `: ${status.playingText}` : " on the cabinet"}
          </div>
        )}
      </header>

      <main className="mx-auto max-w-7xl px-3 pt-4 pb-10 sm:px-4">
        <PlayBanner playState={playState} onDismiss={() => setPlayState({ kind: "idle" })} />
        {syncing ? (
          <p className="mb-3 text-xs font-semibold" role="status" style={{ color: "var(--cyan)" }}>
            Syncing with the cabinet… adding anything new or missing, then the page shows everything the cabinet has.
          </p>
        ) : syncNote ? (
          <div
            className="mb-3 flex items-center justify-between gap-3 text-xs font-semibold"
            role="status"
            style={{ color: syncNote.ok ? "var(--green)" : "var(--red)" }}
          >
            <span>{syncNote.text}</span>
            <button
              type="button"
              onClick={() => setSyncNote(null)}
              aria-label="Dismiss sync message"
              className="px-1 text-sm leading-none"
              style={{ color: "var(--dim)" }}
            >
              ×
            </button>
          </div>
        ) : (
          sync &&
          sync.state !== "never" && (
            <p className="mb-3 text-xs" style={{ color: "var(--dim)" }}>
              {sync.state === "ok"
                ? `Library pulled from the cabinet ${fmtTime(sync.lastSuccessAt)} · ${sync.tableCount} tables · ${sync.scoreCount} scores${
                    sync.lastAddedTables + sync.lastAddedScores > 0
                      ? ` · last sync added ${plural(sync.lastAddedTables, "table")} and ${plural(sync.lastAddedScores, "score")}`
                      : ""
                  }`
                : `Last pull failed ${fmtTime(sync.lastAttemptAt)}: ${sync.lastError ?? "cabinet unreachable"}. Showing the last good pull.`}
            </p>
          )
        )}

        {tab === "library" &&
          (library.isPending ? (
            <p className="py-16 text-center text-sm" style={{ color: "var(--dim)" }}>Loading your cabinet library…</p>
          ) : library.error || !library.data ? (
            <div className="py-16 text-center">
              <p className="text-sm">The library could not be loaded.</p>
              <button
                type="button"
                onClick={() => void library.refetch()}
                aria-label="Retry loading library"
                className="mt-3 rounded-md px-4 py-2 text-sm font-bold"
                style={{ background: "var(--accent)", color: "var(--accent-ink)" }}
              >
                Retry
              </button>
            </div>
          ) : (
            <LibraryView
              data={library.data}
              onOpen={(t) => setSelectedId(t.cabinetGameId)}
              onPlay={(t) => play(t.cabinetGameId)}
            />
          ))}

        {tab === "stats" &&
          (stats.isPending ? (
            <p className="py-16 text-center text-sm" style={{ color: "var(--dim)" }}>Loading stats…</p>
          ) : stats.error || !stats.data ? (
            <div className="py-16 text-center">
              <p className="text-sm">Stats could not be loaded.</p>
              <button
                type="button"
                onClick={() => void stats.refetch()}
                aria-label="Retry loading stats"
                className="mt-3 rounded-md px-4 py-2 text-sm font-bold"
                style={{ background: "var(--accent)", color: "var(--accent-ink)" }}
              >
                Retry
              </button>
            </div>
          ) : (
            <StatsView
              stats={stats.data}
              onOpen={(cabinetGameId) => {
                setTab("library");
                setSelectedId(cabinetGameId);
              }}
            />
          ))}

        {tab === "selfhost" && <SelfHostView />}
      </main>

      {selectedId !== null && detail.data && (
        <DetailOverlay
          detail={detail.data}
          onClose={() => setSelectedId(null)}
          onPlay={(t) => play(t.cabinetGameId)}
        />
      )}
      {selectedId !== null && detail.isPending && (
        <div className="fixed inset-0 z-40 flex items-center justify-center" role="status" style={{ background: "rgba(3,6,12,0.75)" }}>
          <p className="text-sm" style={{ color: "var(--dim)" }}>Loading table…</p>
        </div>
      )}
    </div>
  );
}
