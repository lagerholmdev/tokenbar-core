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
  provider TEXT,
  model TEXT,
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

export function initializeDatabase(dbPath: string = ":memory:"): Database.Database {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(CREATE_USAGE_EVENTS_TABLE);
  db.exec(CREATE_DAILY_ROLLUP_TABLE);
  db.exec(CREATE_SESSION_SUMMARY_TABLE);
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
