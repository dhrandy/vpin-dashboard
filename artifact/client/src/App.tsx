import { useMemo, useState } from "react";
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
    command: python3 /app/server.py
    ports:
      - "8745:8080"
    environment:
      # Set both of these in Dockhand Environment.
      # VPIN_BRIDGE_URL is your vpin-bridge address on your network.
      # VPIN_API_KEY is the same key the bridge uses (its API_KEY).
      VPIN_BRIDGE_URL: \${VPIN_BRIDGE_URL}
      VPIN_API_KEY: \${VPIN_API_KEY}
      PORT: "8080"
    volumes:
      - /DATA/AppData/vpin-dashboard/app:/app
      - /DATA/AppData/vpin-dashboard/data:/data
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
          className="flex aspect-[3/4] flex-col justify-between p-3"
          style={{
            background:
              "linear-gradient(160deg, var(--surface2) 0%, #0d1830 60%, #132341 100%)",
          }}
        >
          <div className="flex items-start justify-between gap-2">
            <span
              className="rounded px-1.5 py-0.5 text-[11px] font-bold tracking-wide"
              style={{ background: "rgba(0,0,0,0.45)", color: "var(--cyan)" }}
            >
              {table.scoreCount > 0 ? `${table.scoreCount} SCORE${table.scoreCount === 1 ? "" : "S"}` : "NO SCORES YET"}
            </span>
            {table.playlists.length > 0 && (
              <span
                className="rounded px-1.5 py-0.5 text-[11px] font-semibold"
                style={{ background: "rgba(0,0,0,0.45)", color: "var(--dim)" }}
              >
                {table.playlists[0]}
              </span>
            )}
          </div>
          <div>
            <p className="font-display text-2xl leading-tight font-semibold tracking-wide uppercase">
              {table.name}
            </p>
            <p className="mt-1 text-xs" style={{ color: "var(--dim)" }}>
              {[table.maker, table.year].filter(Boolean).join(" · ") || "Maker and year not reported by the cabinet"}
            </p>
          </div>
        </div>
      </button>
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
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

  const counts = useMemo(() => {
    const withScores = data.tables.filter((t) => t.scoreCount > 0).length;
    return { all: data.tables.length, withScores, noScores: data.tables.length - withScores };
  }, [data.tables]);

  const filtered = useMemo(() => {
    let rows = data.tables;
    if (filter === "with-scores") rows = rows.filter((t) => t.scoreCount > 0);
    else if (filter === "no-scores") rows = rows.filter((t) => t.scoreCount === 0);
    else if (filter.startsWith("maker:")) rows = rows.filter((t) => t.maker === filter.slice(6));
    else if (filter.startsWith("playlist:")) rows = rows.filter((t) => t.playlists.includes(filter.slice(9)));
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
    return sorted;
  }, [data.tables, filter, search, sort]);

  const filterBtn = (key: string, label: string, count?: number) => (
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
      <span className="truncate">{label}</span>
      {count !== undefined && <span className="ml-2 text-xs">{count}</span>}
    </button>
  );

  const sidebar = (
    <div>
      <p className="px-2.5 text-[11px] font-bold tracking-widest uppercase" style={{ color: "var(--dim)" }}>
        Library
      </p>
      <div className="mt-1 space-y-0.5">
        {filterBtn("all", "All tables", counts.all)}
        {filterBtn("with-scores", "With scores", counts.withScores)}
        {filterBtn("no-scores", "No scores yet", counts.noScores)}
      </div>
      {data.playlists.length > 0 && (
        <>
          <p className="mt-4 px-2.5 text-[11px] font-bold tracking-widest uppercase" style={{ color: "var(--dim)" }}>
            Playlists
          </p>
          <div className="mt-1 space-y-0.5">
            {data.playlists.map((p) => filterBtn(`playlist:${p.name}`, p.name, p.count))}
          </div>
        </>
      )}
      {data.makers.length > 0 && (
        <>
          <p className="mt-4 px-2.5 text-[11px] font-bold tracking-widest uppercase" style={{ color: "var(--dim)" }}>
            Browse by maker
          </p>
          <div className="mt-1 space-y-0.5">
            {data.makers.map((m) => filterBtn(`maker:${m.maker}`, m.maker, m.count))}
          </div>
        </>
      )}
    </div>
  );

  return (
    <div className="flex gap-4">
      <aside className="sticky top-24 hidden w-52 shrink-0 self-start md:block">{sidebar}</aside>
      <section className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="font-display text-3xl font-semibold tracking-wide uppercase">
            {filter === "all"
              ? "All tables"
              : filter === "with-scores"
                ? "Tables with scores"
                : filter === "no-scores"
                  ? "No scores yet"
                  : filter.replace(/^(maker|playlist):/, "")}
          </h2>
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
            className="min-w-0 flex-1 rounded-md border px-3 py-2 text-sm sm:max-w-xs"
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

        <div className="mt-3 flex gap-2 overflow-x-auto pb-1 md:hidden" aria-label="Library filters">
          {(
            [
              ["all", "All"],
              ["with-scores", "With scores"],
              ["no-scores", "No scores"],
              ...data.makers.slice(0, 6).map((m): [string, string] => [`maker:${m.maker}`, m.maker]),
            ] as [string, string][]
          ).map(([key, label]) => (
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
        This same library and stats app ships as a self-hosted package in the private GitHub repo dhrandy/vpin-dashboard
        (full source plus this Docker Compose setup). On the NAS it runs under Dockhand like your
        other apps, talks straight to your vpin bridge, and Play launches tables on the cabinet
        through VPin Studio, same as here.
      </p>
      <ol className="mt-4 list-decimal space-y-2 pl-5 text-sm leading-relaxed">
        <li>Copy the repo's <code>app/</code> files (server.py and the web UI) into <code>/DATA/AppData/vpin-dashboard/app</code> on the NAS.</li>
        <li>Create the stack in Dockhand from the compose file below.</li>
        <li>In Dockhand Environment, set <code>VPIN_BRIDGE_URL</code> to your vpin-bridge address and <code>VPIN_API_KEY</code> to the same key the bridge uses. Neither value is stored in the repo or this page.</li>
        <li>Start the stack, then open the app on port 8745.</li>
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
        CasaOS-style host paths, official Python image, no Dockerfile: Dockhand compose-only, matching how your other stacks run.
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
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="font-display text-3xl leading-tight font-semibold tracking-wide uppercase">{t.name}</h3>
                <p className="text-sm" style={{ color: "var(--dim)" }}>
                  {[t.maker, t.year].filter(Boolean).join(" · ") || "Maker and year not reported by the cabinet"}
                </p>
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

export function App() {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<"library" | "stats" | "selfhost">("library");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const { playState, setPlayState, play } = usePlayController(() => {
    void queryClient.invalidateQueries({ queryKey: ["library"] });
  });

  const library = useQuery({
    queryKey: ["library"],
    queryFn: () => api.getLibrary({}),
    refetchInterval: 15000,
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
  });

  const status = library.data?.status;
  const sync = library.data?.sync;

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
              onClick={() => syncMutation.mutate()}
              disabled={syncMutation.isPending}
              aria-label="Sync library from cabinet"
              className="rounded-md border px-3 py-1.5 text-xs font-bold disabled:opacity-50"
              style={{ borderColor: "var(--border)", background: "var(--surface)", color: "var(--text)" }}
            >
              {syncMutation.isPending ? "Syncing…" : "Sync"}
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
        {sync && sync.state !== "never" && (
          <p className="mb-3 text-xs" style={{ color: "var(--dim)" }}>
            {sync.state === "ok"
              ? `Library pulled from the cabinet ${fmtTime(sync.lastSuccessAt)} · ${sync.tableCount} tables · ${sync.scoreCount} scores`
              : `Last pull failed ${fmtTime(sync.lastAttemptAt)}: ${sync.lastError ?? "cabinet unreachable"}. Showing the last good pull.`}
          </p>
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
