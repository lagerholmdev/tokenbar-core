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

  active_time_seconds: number | null;

  terminal_type: string | null;
  repo_path: string | null;
  git_branch: string | null;
  project_name: string | null;

  raw_ref: string | null;
  redaction_state: "none" | "partial" | "full";
  imported_at: string;
}

/** Gold: VIEW over silver_metric_points (pivot by session_id, prompt_id, model, time_unix_nano). */
const CREATE_USAGE_EVENTS_VIEW = `
CREATE VIEW usage_events AS
SELECT
  session_id AS id,
  terminal_type,
  body,
  event_name,
  event_timestamp,

  prompt_id,
  prompt,
  prompt_length,
  model,

  CASE WHEN service_name = 'claude-code' THEN 'exact' ELSE 'derived' END AS source_confidence,
  CASE WHEN service_name = 'claude-code' THEN 'anthropic' ELSE NULL END AS provider,

  input_tokens,
  output_tokens,
  cache_read_tokens,
  cache_creation_tokens,
  coalesce(input_tokens, 0) + coalesce(output_tokens, 0) + coalesce(cache_read_tokens, 0) + coalesce(cache_creation_tokens, 0) AS total_tokens,
  cost_usd,
  duration_ms AS duration,
  speed,

  received_at

  FROM silver_log_records

`;

/** Bronze layer: verbatim HTTP body per request. Never filtered. */
const CREATE_BRONZE_RAW_PAYLOADS_TABLE = `
CREATE TABLE IF NOT EXISTS bronze_raw_payloads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK(kind IN ('metrics','logs','traces')),
  received_at TEXT NOT NULL,
  body TEXT NOT NULL
);
`;

/** Silver layer: one row per OTLP metric data point. */
export interface SilverMetricPoint {
  id: string;
  bronze_id: number;
  received_at: string;
  metric_name: string;
  time_unix_nano: number;
  start_time_unix_nano: number | null;
  value: number;
  service_name: string | null;
  service_version: string | null;
  scope_name: string | null;
  session_id: string | null;
  prompt_id: string | null;
  user_id: string | null;
  organization_id: string | null;
  terminal_type: string | null;
  model: string | null;
  token_type: string | null;
  extra_attributes_json: string | null;
}

const CREATE_SILVER_METRIC_POINTS_TABLE = `
CREATE TABLE IF NOT EXISTS silver_metric_points (
  id TEXT PRIMARY KEY,
  bronze_id INTEGER NOT NULL REFERENCES bronze_raw_payloads(id),
  received_at TEXT NOT NULL,
  metric_name TEXT NOT NULL,
  time_unix_nano INTEGER NOT NULL,
  start_time_unix_nano INTEGER,
  value REAL NOT NULL,
  service_name TEXT,
  service_version TEXT,
  scope_name TEXT,
  session_id TEXT,
  prompt_id TEXT,
  user_id TEXT,
  organization_id TEXT,
  terminal_type TEXT,
  model TEXT,
  token_type TEXT,
  extra_attributes_json TEXT
);
`;

/** Silver layer: one row per OTLP log record. */
export interface SilverLogRecord {
  id: string;
  bronze_id: number;
  received_at: string;
  time_unix_nano: number;
  severity_number: number | null;
  severity_text: string | null;
  body: string | null;
  trace_id: string | null;
  span_id: string | null;
  service_name: string | null;
  session_id: string | null;
  /** Promoted from attributes: user.id, organization.id, user.email, etc. */
  user_id: string | null;
  organization_id: string | null;
  user_email: string | null;
  user_account_uuid: string | null;
  user_account_id: string | null;
  terminal_type: string | null;
  event_name: string | null;
  event_timestamp: string | null;
  event_sequence: number | null;
  prompt_id: string | null;
  prompt: string | null;
  prompt_length: number | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
  cost_usd: number | null;
  duration_ms: number | null;
  speed: string | null;
  extra_attributes_json: string | null;
}

const CREATE_SILVER_LOG_RECORDS_TABLE = `
CREATE TABLE IF NOT EXISTS silver_log_records (
  id TEXT PRIMARY KEY,
  bronze_id INTEGER NOT NULL REFERENCES bronze_raw_payloads(id),
  received_at TEXT NOT NULL,
  time_unix_nano INTEGER NOT NULL,
  severity_number INTEGER,
  severity_text TEXT,
  body TEXT,
  trace_id TEXT,
  span_id TEXT,
  service_name TEXT,
  session_id TEXT,
  user_id TEXT,
  organization_id TEXT,
  user_email TEXT,
  user_account_uuid TEXT,
  user_account_id TEXT,
  terminal_type TEXT,
  event_name TEXT,
  event_timestamp TEXT,
  event_sequence INTEGER,
  prompt_id TEXT,
  prompt TEXT,
  prompt_length INTEGER,
  model TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_creation_tokens INTEGER,
  cost_usd REAL,
  duration_ms INTEGER,
  speed TEXT,
  extra_attributes_json TEXT
);
`;

/** Silver layer: one row per OTLP span. */
export interface SilverSpanRecord {
  id: string;
  bronze_id: number;
  received_at: string;
  trace_id: string | null;
  span_id: string | null;
  parent_span_id: string | null;
  name: string | null;
  kind: number | null;
  start_time_unix_nano: number | null;
  end_time_unix_nano: number | null;
  status_code: number | null;
  service_name: string | null;
  session_id: string | null;
  extra_attributes_json: string | null;
}

const CREATE_SILVER_SPAN_RECORDS_TABLE = `
CREATE TABLE IF NOT EXISTS silver_span_records (
  id TEXT PRIMARY KEY,
  bronze_id INTEGER NOT NULL REFERENCES bronze_raw_payloads(id),
  received_at TEXT NOT NULL,
  trace_id TEXT,
  span_id TEXT,
  parent_span_id TEXT,
  name TEXT,
  kind INTEGER,
  start_time_unix_nano INTEGER,
  end_time_unix_nano INTEGER,
  status_code INTEGER,
  service_name TEXT,
  session_id TEXT,
  extra_attributes_json TEXT
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
  db.exec(CREATE_BRONZE_RAW_PAYLOADS_TABLE);
  db.exec(CREATE_SILVER_METRIC_POINTS_TABLE);
  db.exec(CREATE_SILVER_LOG_RECORDS_TABLE);
  db.exec(CREATE_SILVER_SPAN_RECORDS_TABLE);

  if (dbPath !== ":memory:") {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='raw_payloads'").all() as { name: string }[];
    if (tables.length > 0) {
      db.exec("INSERT INTO bronze_raw_payloads (kind, received_at, body) SELECT kind, received_at, body FROM raw_payloads");
      db.exec("DROP TABLE raw_payloads");
    }
    const silverLogInfo = db.prepare("PRAGMA table_info(silver_log_records)").all() as { name: string }[];
    const silverLogCols = new Set(silverLogInfo.map((c) => c.name));
    const logColumnsToAdd = [
      "user_id", "organization_id", "user_email", "user_account_uuid", "user_account_id",
      "terminal_type", "event_name", "event_timestamp", "event_sequence", "prompt_id", "prompt", "prompt_length", "model",
      "input_tokens", "output_tokens", "cache_read_tokens", "cache_creation_tokens", "cost_usd", "duration_ms", "speed",
    ];
    for (const col of logColumnsToAdd) {
      if (!silverLogCols.has(col)) {
        const sqlType = col === "event_sequence" || col === "input_tokens" || col === "output_tokens" || col === "cache_read_tokens" || col === "cache_creation_tokens" || col === "duration_ms" || col === "prompt_length"
          ? "INTEGER"
          : col === "cost_usd"
            ? "REAL"
            : "TEXT";
        db.exec(`ALTER TABLE silver_log_records ADD COLUMN ${col} ${sqlType}`);
      }
    }
  }
  db.exec("DROP VIEW IF EXISTS usage_events");
  db.exec(CREATE_USAGE_EVENTS_VIEW);

  db.exec("CREATE INDEX IF NOT EXISTS idx_bronze_raw_payloads_kind ON bronze_raw_payloads(kind, received_at)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_silver_metric_points_session_time ON silver_metric_points(session_id, time_unix_nano)");
  return db;
}

/** Generic insert: one row per object. Columns from first row's keys; uses INSERT OR REPLACE. */
export function insertRows(
  db: Database.Database,
  tableName: string,
  rows: unknown[],
): void {
  if (rows.length === 0) return;
  const first = rows[0];
  if (first == null || typeof first !== "object" || Array.isArray(first)) return;
  const keys = Object.keys(first as Record<string, unknown>);
  const cols = keys.join(", ");
  const placeholders = keys.map((k) => `@${k}`).join(", ");
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO ${tableName} (${cols}) VALUES (${placeholders})`,
  );
  const runMany = db.transaction((batch: unknown[]) => {
    for (const row of batch) {
      if (row != null && typeof row === "object" && !Array.isArray(row)) stmt.run(row as Record<string, unknown>);
    }
  });
  runMany(rows);
}

export function getEventCount(db: Database.Database): number {
  const row = db.prepare("SELECT COUNT(*) as count FROM usage_events").get() as { count: number };
  return row.count;
}

/** Inserts a raw payload into bronze layer. Returns the inserted row id for silver FK. */
export function insertBronzeRawPayload(
  db: Database.Database,
  kind: "metrics" | "logs" | "traces",
  body: string,
): number {
  const result = db.prepare(
    "INSERT INTO bronze_raw_payloads (kind, received_at, body) VALUES (?, ?, ?)",
  ).run(kind, new Date().toISOString(), body);
  return result.lastInsertRowid as number;
}

export function getUsageSummary(db: Database.Database): {
  events: number;
  total_tokens: number;
  total_cost_usd: number;
} {
  return db
    .prepare(
      "SELECT COUNT(*) as events, COALESCE(SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)), 0) as total_tokens, COALESCE(SUM(cost_usd), 0) as total_cost_usd FROM usage_events",
    )
    .get() as {
    events: number;
    total_tokens: number;
    total_cost_usd: number;
  };
}
