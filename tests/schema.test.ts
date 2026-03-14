import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import {
  initializeDatabase,
  insertUsageEvent,
  getEventCount,
  type UsageEvent,
} from "../src/schema.js";

describe("schema", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initializeDatabase(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("creates tables on initialization", () => {
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      )
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain("usage_events");
    expect(names).toContain("daily_usage_rollups");
    expect(names).toContain("session_summaries");
  });

  it("inserts and retrieves a usage event", () => {
    const event: UsageEvent = {
      id: "test-001",
      source_app: "claude_code",
      source_kind: "cli",
      source_confidence: "exact",
      event_type: "api_request",
      timestamp: new Date().toISOString(),
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      session_id: "sess-001",
      prompt_id: null,
      input_tokens: 100,
      output_tokens: 200,
      cache_read_tokens: 5000,
      cache_creation_tokens: 50,
      total_tokens: 5350,
      cost_usd: 0.0049,
      currency: "USD",
      terminal_type: "cursor",
      repo_path: null,
      git_branch: null,
      project_name: null,
      raw_ref: null,
      redaction_state: "none",
      imported_at: new Date().toISOString(),
    };

    insertUsageEvent(db, event);
    expect(getEventCount(db)).toBe(1);

    const row = db
      .prepare("SELECT * FROM usage_events WHERE id = ?")
      .get("test-001") as Record<string, unknown>;
    expect(row.source_app).toBe("claude_code");
    expect(row.model).toBe("claude-sonnet-4-6");
    expect(row.input_tokens).toBe(100);
    expect(row.cost_usd).toBeCloseTo(0.0049);
  });

  it("enforces source_confidence constraint", () => {
    const badEvent: UsageEvent = {
      id: "test-bad",
      source_app: "claude_code",
      source_kind: "cli",
      source_confidence: "invalid" as UsageEvent["source_confidence"],
      event_type: "api_request",
      timestamp: new Date().toISOString(),
      provider: null,
      model: null,
      session_id: null,
      prompt_id: null,
      input_tokens: null,
      output_tokens: null,
      cache_read_tokens: null,
      cache_creation_tokens: null,
      total_tokens: null,
      cost_usd: null,
      currency: null,
      terminal_type: null,
      repo_path: null,
      git_branch: null,
      project_name: null,
      raw_ref: null,
      redaction_state: "none",
      imported_at: new Date().toISOString(),
    };

    expect(() => insertUsageEvent(db, badEvent)).toThrow();
  });
});
