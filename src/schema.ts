import { homedir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

export interface UsageEvent {
  id: string;
  source_app: "claude_code" | "cursor" | "claude_desktop" | "other";
  source_kind: "cli" | "ide" | "desktop" | "web" | "api";
  source_confidence: "exact" | "derived" | "estimated";
  event_type:
    | "api_request"
    | "session_rollup"
    | "usage_snapshot"
    | "tool_result";
  timestamp: string;

  provider: string | null;
  model: string | null;

  session_id: string | null;
  prompt_id: string | null;

  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
  total_tokens: number | null;

  cost_usd: number | null;
  currency: string | null;

  terminal_type: string | null;
  repo_path: string | null;
  git_branch: string | null;
  project_name: string | null;

  raw_ref: string | null;
  redaction_state: "none" | "partial" | "full";
  imported_at: string;
}

const CREATE_USAGE_EVENTS_TABLE = `
CREATE TABLE IF NOT EXISTS usage_events (
  id TEXT PRIMARY KEY,
  source_app TEXT NOT NULL CHECK(source_app IN ('claude_code','cursor','claude_desktop','other')),
  source_kind TEXT NOT NULL CHECK(source_kind IN ('cli','ide','desktop','web','api')),
  source_confidence TEXT NOT NULL CHECK(source_confidence IN ('exact','derived','estimated')),
  event_type TEXT NOT NULL CHECK(event_type IN ('api_request','session_rollup','usage_snapshot','tool_result')),
  timestamp TEXT NOT NULL,

  provider TEXT,
  model TEXT,

  session_id TEXT,
  prompt_id TEXT,

  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_creation_tokens INTEGER,
  total_tokens INTEGER,

  cost_usd REAL,
  currency TEXT,

  terminal_type TEXT,
  repo_path TEXT,
  git_branch TEXT,
  project_name TEXT,

  raw_ref TEXT,
  redaction_state TEXT NOT NULL DEFAULT 'none' CHECK(redaction_state IN ('none','partial','full')),
  imported_at TEXT NOT NULL
);
`;

const CREATE_DAILY_ROLLUP_TABLE = `
CREATE TABLE IF NOT EXISTS daily_usage_rollups (
  day TEXT NOT NULL,
  source_app TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  total_tokens INTEGER NOT NULL DEFAULT 0,
  total_cost_usd REAL NOT NULL DEFAULT 0,
  exact_events INTEGER NOT NULL DEFAULT 0,
  derived_events INTEGER NOT NULL DEFAULT 0,
  estimated_events INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, source_app, provider, model)
);
`;

const CREATE_SESSION_SUMMARY_TABLE = `
CREATE TABLE IF NOT EXISTS session_summaries (
  session_id TEXT PRIMARY KEY,
  source_app TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT,
  repo_path TEXT,
  git_branch TEXT,
  total_tokens INTEGER,
  total_cost_usd REAL,
  confidence TEXT NOT NULL CHECK(confidence IN ('exact','derived','estimated'))
);
`;

/** Canonical DB path for TokenBar. Used by the collector and by readers (e.g. macOS app). */
export function defaultDbPath(): string {
  return join(homedir(), "Library", "Application Support", "TokenBar", "tokenbar.db");
}

export function initializeDatabase(dbPath: string = ":memory:"): Database.Database {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(CREATE_USAGE_EVENTS_TABLE);
  db.exec(CREATE_DAILY_ROLLUP_TABLE);
  db.exec(CREATE_SESSION_SUMMARY_TABLE);

  // Migrate daily_usage_rollups from nullable PK columns to NOT NULL DEFAULT '' (Issue 1.2)
  if (dbPath !== ":memory:") {
    const info = db.prepare("PRAGMA table_info(daily_usage_rollups)").all() as { name: string; notnull: number }[];
    const modelCol = info.find((c) => c.name === "model");
    if (modelCol?.notnull === 0) {
      db.exec("DROP TABLE IF EXISTS daily_usage_rollups");
      db.exec(CREATE_DAILY_ROLLUP_TABLE);
    }
  }

  db.exec("CREATE INDEX IF NOT EXISTS idx_usage_events_timestamp ON usage_events(timestamp)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_usage_events_source_date ON usage_events(source_app, timestamp)");
  return db;
}

export function insertUsageEvent(
  db: Database.Database,
  event: UsageEvent,
): void {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO usage_events (
      id, source_app, source_kind, source_confidence, event_type, timestamp,
      provider, model, session_id, prompt_id,
      input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, total_tokens,
      cost_usd, currency,
      terminal_type, repo_path, git_branch, project_name,
      raw_ref, redaction_state, imported_at
    ) VALUES (
      @id, @source_app, @source_kind, @source_confidence, @event_type, @timestamp,
      @provider, @model, @session_id, @prompt_id,
      @input_tokens, @output_tokens, @cache_read_tokens, @cache_creation_tokens, @total_tokens,
      @cost_usd, @currency,
      @terminal_type, @repo_path, @git_branch, @project_name,
      @raw_ref, @redaction_state, @imported_at
    )
  `);
  stmt.run(event);
}

/** Normalize provider/model for rollup PK (NULL → ''). */
function rollupKey(s: string | null): string {
  return s ?? "";
}

/** Upsert one event's contribution into daily_usage_rollups. Idempotent when called once per new event. */
export function upsertDailyRollup(db: Database.Database, event: UsageEvent): void {
  const day = event.timestamp.slice(0, 10);
  const provider = rollupKey(event.provider);
  const model = rollupKey(event.model);
  const totalTokens = event.total_tokens ?? 0;
  const costUsd = event.cost_usd ?? 0;
  const exact = event.source_confidence === "exact" ? 1 : 0;
  const derived = event.source_confidence === "derived" ? 1 : 0;
  const estimated = event.source_confidence === "estimated" ? 1 : 0;

  db.prepare(`
    INSERT INTO daily_usage_rollups (day, source_app, provider, model, total_tokens, total_cost_usd, exact_events, derived_events, estimated_events)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(day, source_app, provider, model) DO UPDATE SET
      total_tokens = total_tokens + excluded.total_tokens,
      total_cost_usd = total_cost_usd + excluded.total_cost_usd,
      exact_events = exact_events + excluded.exact_events,
      derived_events = derived_events + excluded.derived_events,
      estimated_events = estimated_events + excluded.estimated_events
  `).run(day, event.source_app, provider, model, totalTokens, costUsd, exact, derived, estimated);
}

export function insertUsageEvents(
  db: Database.Database,
  events: UsageEvent[],
): void {
  if (events.length === 0) {
    return;
  }

  const exists = db.prepare("SELECT 1 FROM usage_events WHERE id = ?").pluck();
  const insert = db.transaction((batch: UsageEvent[]) => {
    for (const event of batch) {
      const isNew = exists.get(event.id) === undefined;
      insertUsageEvent(db, event);
      if (isNew) {
        upsertDailyRollup(db, event);
      }
    }
  });
  insert(events);
}

export function getEventCount(db: Database.Database): number {
  const row = db.prepare("SELECT COUNT(*) as count FROM usage_events").get() as { count: number };
  return row.count;
}

export function getTodayTokenTotal(db: Database.Database): number {
  const today = new Date().toISOString().slice(0, 10);
  const row = db.prepare(
    "SELECT COALESCE(SUM(total_tokens), 0) as total FROM usage_events WHERE date(timestamp) = ?",
  ).get(today) as { total: number };
  return row.total;
}

export function getTodayCostTotal(db: Database.Database): number {
  const today = new Date().toISOString().slice(0, 10);
  const row = db.prepare(
    "SELECT COALESCE(SUM(cost_usd), 0) as total FROM usage_events WHERE date(timestamp) = ?",
  ).get(today) as { total: number };
  return row.total;
}

export interface HourlyTotal {
  hour: number;
  tokens: number;
  cost_usd: number;
}

/** Hourly buckets for the given date (YYYY-MM-DD). Returns 24 rows (hour 0–23); missing hours have tokens/cost 0. */
export function getHourlyTotals(db: Database.Database, date: string): HourlyTotal[] {
  const dayStart = date + "T00:00:00.000Z";
  const dayEnd = date + "T23:59:59.999Z";
  const rows = db
    .prepare(
      `SELECT CAST(strftime('%H', timestamp) AS INTEGER) as hour,
              COALESCE(SUM(total_tokens), 0) as tokens,
              COALESCE(SUM(cost_usd), 0) as cost_usd
       FROM usage_events
       WHERE timestamp >= ? AND timestamp <= ?
       GROUP BY strftime('%H', timestamp)
       ORDER BY hour`,
    )
    .all(dayStart, dayEnd) as { hour: number; tokens: number; cost_usd: number }[];

  const byHour = new Map<number, HourlyTotal>();
  for (let h = 0; h < 24; h++) {
    byHour.set(h, { hour: h, tokens: 0, cost_usd: 0 });
  }
  for (const r of rows) {
    byHour.set(r.hour, { hour: r.hour, tokens: r.tokens, cost_usd: r.cost_usd });
  }
  return Array.from(byHour.values()).sort((a, b) => a.hour - b.hour);
}

export interface DailyTotal {
  day: string;
  tokens: number;
  cost_usd: number;
}

/** Daily totals for the last `days` days including today. At most `days` rows, sorted ascending by day. */
export function getDailyTotals(db: Database.Database, days: number): DailyTotal[] {
  const today = new Date().toISOString().slice(0, 10);
  const start = new Date(today + "T00:00:00Z");
  start.setUTCDate(start.getUTCDate() - (days - 1));
  const startDay = start.toISOString().slice(0, 10);
  const rows = db
    .prepare(
      `SELECT day, SUM(total_tokens) as tokens, SUM(total_cost_usd) as cost_usd
       FROM daily_usage_rollups
       WHERE day >= ? AND day <= ?
       GROUP BY day
       ORDER BY day ASC`,
    )
    .all(startDay, today) as { day: string; tokens: number; cost_usd: number }[];
  return rows.map((r) => ({ day: r.day, tokens: r.tokens ?? 0, cost_usd: r.cost_usd ?? 0 }));
}

export function getTodayConfidenceMix(db: Database.Database): {
  exact: number;
  derived: number;
  estimated: number;
} {
  const today = new Date().toISOString().slice(0, 10);
  const row = db
    .prepare(
      `SELECT
         SUM(CASE WHEN source_confidence = 'exact' THEN 1 ELSE 0 END) as exact,
         SUM(CASE WHEN source_confidence = 'derived' THEN 1 ELSE 0 END) as derived,
         SUM(CASE WHEN source_confidence = 'estimated' THEN 1 ELSE 0 END) as estimated
       FROM usage_events WHERE date(timestamp) = ?`,
    )
    .get(today) as { exact: number; derived: number; estimated: number };
  return {
    exact: row?.exact ?? 0,
    derived: row?.derived ?? 0,
    estimated: row?.estimated ?? 0,
  };
}

export function getUsageSummary(db: Database.Database): {
  events: number;
  total_tokens: number;
  total_cost_usd: number;
} {
  return db
    .prepare(
      "SELECT COUNT(*) as events, COALESCE(SUM(total_tokens), 0) as total_tokens, COALESCE(SUM(cost_usd), 0) as total_cost_usd FROM usage_events",
    )
    .get() as {
    events: number;
    total_tokens: number;
    total_cost_usd: number;
  };
}
