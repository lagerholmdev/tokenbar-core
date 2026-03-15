import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import {
  defaultDbPath,
  getDailyTotals,
  getHourlyTotals,
  getTodayConfidenceMix,
  getTodayCostTotal,
  getTodayTokenTotal,
  initializeDatabase,
  insertUsageEvent,
  insertUsageEvents,
  getEventCount,
  getEventsForExport,
  exportEvents,
  exportEventsAsCsv,
  exportEventsAsJson,
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

  it("defaultDbPath returns TokenBar app support path", () => {
    const path = defaultDbPath();
    expect(path).toContain("TokenBar");
    expect(path).toContain("tokenbar.db");
    expect(path).toMatch(/\.db$/);
  });

  it("EXPLAIN QUERY PLAN uses index for timestamp range (date-equivalent)", () => {
    const plan = db.prepare(
      "EXPLAIN QUERY PLAN SELECT * FROM usage_events WHERE timestamp >= '2026-03-15' AND timestamp < '2026-03-16'",
    ).all() as { detail: string }[];
    const detail = plan.map((p) => p.detail).join(" ");
    expect(detail).toMatch(/idx_usage_events/);
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

  it("rollup: token totals are derived from input/output (not stored total_tokens)", () => {
    const day = "2026-03-15";
    const base: Omit<UsageEvent, "id" | "timestamp" | "total_tokens" | "cost_usd" | "imported_at"> = {
      source_app: "claude_code",
      source_kind: "ide",
      source_confidence: "exact",
      event_type: "api_request",
      provider: null,
      model: null,
      session_id: null,
      prompt_id: null,
      input_tokens: 10,
      output_tokens: 20,
      cache_read_tokens: null,
      cache_creation_tokens: null,
      cost_usd: null,
      currency: null,
      terminal_type: null,
      repo_path: null,
      git_branch: null,
      project_name: null,
      raw_ref: null,
      redaction_state: "none",
    };
    const e1: UsageEvent = {
      ...base,
      id: "rollup-test-1",
      timestamp: `${day}T10:00:00.000Z`,
      total_tokens: 1000,
      cost_usd: 0.001,
      imported_at: new Date().toISOString(),
    };
    const e2: UsageEvent = {
      ...base,
      id: "rollup-test-2",
      timestamp: `${day}T14:00:00.000Z`,
      total_tokens: 2000,
      cost_usd: 0.002,
      imported_at: new Date().toISOString(),
    };
    insertUsageEvents(db, [e1, e2]);
    const rows = db.prepare("SELECT * FROM daily_usage_rollups WHERE day = ?").all(day) as { day: string; total_tokens: number; total_cost_usd: number }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].total_tokens).toBe(60);
    expect(rows[0].total_cost_usd).toBeCloseTo(0.003);
  });

  it("rollup: re-inserting same event does not double-count", () => {
    const day = "2026-03-16";
    const event: UsageEvent = {
      id: "idempotent-1",
      source_app: "claude_code",
      source_kind: "ide",
      source_confidence: "exact",
      event_type: "api_request",
      timestamp: `${day}T12:00:00.000Z`,
      provider: "anthropic",
      model: "claude-3",
      session_id: null,
      prompt_id: null,
      input_tokens: 5,
      output_tokens: 15,
      cache_read_tokens: null,
      cache_creation_tokens: null,
      total_tokens: 9999,
      cost_usd: 0.0005,
      currency: "USD",
      terminal_type: null,
      repo_path: null,
      git_branch: null,
      project_name: null,
      raw_ref: null,
      redaction_state: "none",
      imported_at: new Date().toISOString(),
    };
    insertUsageEvents(db, [event]);
    insertUsageEvents(db, [event]);
    const row = db.prepare("SELECT total_tokens, total_cost_usd FROM daily_usage_rollups WHERE day = ?").get(day) as { total_tokens: number; total_cost_usd: number };
    expect(row.total_tokens).toBe(20);
    expect(row.total_cost_usd).toBeCloseTo(0.0005);
  });

  it("getTodayTokenTotal derives tokens from input/output columns", () => {
    const today = new Date().toISOString().slice(0, 10);
    insertUsageEvents(db, [
      {
        id: "tokens-derive-1",
        source_app: "claude_code",
        source_kind: "ide",
        source_confidence: "exact",
        event_type: "api_request",
        timestamp: `${today}T12:00:00.000Z`,
        provider: null,
        model: null,
        session_id: null,
        prompt_id: null,
        input_tokens: 3,
        output_tokens: 7,
        cache_read_tokens: null,
        cache_creation_tokens: null,
        total_tokens: 1000,
        cost_usd: 0,
        currency: "USD",
        terminal_type: null,
        repo_path: null,
        git_branch: null,
        project_name: null,
        raw_ref: null,
        redaction_state: "none",
        imported_at: new Date().toISOString(),
      },
      {
        id: "tokens-derive-2",
        source_app: "claude_code",
        source_kind: "ide",
        source_confidence: "exact",
        event_type: "api_request",
        timestamp: `${today}T13:00:00.000Z`,
        provider: null,
        model: null,
        session_id: null,
        prompt_id: null,
        input_tokens: 2,
        output_tokens: 8,
        cache_read_tokens: null,
        cache_creation_tokens: null,
        total_tokens: 2000,
        cost_usd: 0,
        currency: "USD",
        terminal_type: null,
        repo_path: null,
        git_branch: null,
        project_name: null,
        raw_ref: null,
        redaction_state: "none",
        imported_at: new Date().toISOString(),
      },
    ]);
    expect(getTodayTokenTotal(db)).toBe(20);
  });

  it("getTodayCostTotal returns sum of cost_usd for today", () => {
    const today = new Date().toISOString().slice(0, 10);
    insertUsageEvents(db, [
      {
        id: "cost-1",
        source_app: "claude_code",
        source_kind: "ide",
        source_confidence: "exact",
        event_type: "api_request",
        timestamp: `${today}T12:00:00.000Z`,
        provider: null,
        model: null,
        session_id: null,
        prompt_id: null,
        input_tokens: 1,
        output_tokens: 2,
        cache_read_tokens: null,
        cache_creation_tokens: null,
        total_tokens: 3,
        cost_usd: 0.01,
        currency: "USD",
        terminal_type: null,
        repo_path: null,
        git_branch: null,
        project_name: null,
        raw_ref: null,
        redaction_state: "none",
        imported_at: new Date().toISOString(),
      },
      {
        id: "cost-2",
        source_app: "claude_code",
        source_kind: "ide",
        source_confidence: "exact",
        event_type: "api_request",
        timestamp: `${today}T14:00:00.000Z`,
        provider: null,
        model: null,
        session_id: null,
        prompt_id: null,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: null,
        cache_creation_tokens: null,
        total_tokens: 0,
        cost_usd: 0.005,
        currency: "USD",
        terminal_type: null,
        repo_path: null,
        git_branch: null,
        project_name: null,
        raw_ref: null,
        redaction_state: "none",
        imported_at: new Date().toISOString(),
      },
    ]);
    expect(getTodayCostTotal(db)).toBeCloseTo(0.015);
  });

  it("getTodayCostTotal returns 0 for empty DB", () => {
    expect(getTodayCostTotal(db)).toBe(0);
  });

  it("getHourlyTotals returns 24 buckets for date; empty hours are 0", () => {
    const day = "2026-03-20";
    insertUsageEvents(db, [
      {
        id: "h1",
        source_app: "claude_code",
        source_kind: "ide",
        source_confidence: "exact",
        event_type: "api_request",
        timestamp: `${day}T10:00:00.000Z`,
        provider: null,
        model: null,
        session_id: null,
        prompt_id: null,
        input_tokens: 10,
        output_tokens: 20,
        cache_read_tokens: null,
        cache_creation_tokens: null,
        total_tokens: 30,
        cost_usd: 0.001,
        currency: "USD",
        terminal_type: null,
        repo_path: null,
        git_branch: null,
        project_name: null,
        raw_ref: null,
        redaction_state: "none",
        imported_at: new Date().toISOString(),
      },
      {
        id: "h2",
        source_app: "claude_code",
        source_kind: "ide",
        source_confidence: "exact",
        event_type: "api_request",
        timestamp: `${day}T10:30:00.000Z`,
        provider: null,
        model: null,
        session_id: null,
        prompt_id: null,
        input_tokens: 5,
        output_tokens: 5,
        cache_read_tokens: null,
        cache_creation_tokens: null,
        total_tokens: 10,
        cost_usd: 0.0005,
        currency: "USD",
        terminal_type: null,
        repo_path: null,
        git_branch: null,
        project_name: null,
        raw_ref: null,
        redaction_state: "none",
        imported_at: new Date().toISOString(),
      },
    ]);
    const hourly = getHourlyTotals(db, day);
    expect(hourly).toHaveLength(24);
    const hour10 = hourly.find((r) => r.hour === 10);
    expect(hour10?.tokens).toBe(40);
    expect(hour10?.cost_usd).toBeCloseTo(0.0015);
    const hour0 = hourly.find((r) => r.hour === 0);
    expect(hour0?.tokens).toBe(0);
    expect(hour0?.cost_usd).toBe(0);
  });

  it("getHourlyTotals returns 24 zero buckets for date with no events", () => {
    const hourly = getHourlyTotals(db, "2026-03-21");
    expect(hourly).toHaveLength(24);
    expect(hourly.every((r) => r.tokens === 0 && r.cost_usd === 0)).toBe(true);
  });

  it("getDailyTotals returns at most days rows sorted ascending", () => {
    const today = new Date().toISOString().slice(0, 10);
    insertUsageEvents(db, [
      {
        id: "d1",
        source_app: "claude_code",
        source_kind: "ide",
        source_confidence: "exact",
        event_type: "api_request",
        timestamp: `${today}T12:00:00.000Z`,
        provider: null,
        model: null,
        session_id: null,
        prompt_id: null,
        input_tokens: 100,
        output_tokens: 200,
        cache_read_tokens: null,
        cache_creation_tokens: null,
        total_tokens: 300,
        cost_usd: 0.01,
        currency: "USD",
        terminal_type: null,
        repo_path: null,
        git_branch: null,
        project_name: null,
        raw_ref: null,
        redaction_state: "none",
        imported_at: new Date().toISOString(),
      },
    ]);
    const daily = getDailyTotals(db, 7);
    expect(daily.length).toBeLessThanOrEqual(7);
    const sorted = [...daily].sort((a, b) => a.day.localeCompare(b.day));
    expect(daily.map((r) => r.day)).toEqual(sorted.map((r) => r.day));
    const row = daily.find((r) => r.day === today);
    expect(row).toBeDefined();
    expect(row!.tokens).toBe(300);
    expect(row!.cost_usd).toBeCloseTo(0.01);
  });

  it("getDailyTotals returns empty array for empty DB", () => {
    expect(getDailyTotals(db, 7)).toEqual([]);
  });

  it("getTodayConfidenceMix returns counts by confidence for today", () => {
    const today = new Date().toISOString().slice(0, 10);
    insertUsageEvents(db, [
      {
        id: "c1",
        source_app: "claude_code",
        source_kind: "ide",
        source_confidence: "exact",
        event_type: "api_request",
        timestamp: `${today}T12:00:00.000Z`,
        provider: null,
        model: null,
        session_id: null,
        prompt_id: null,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: null,
        cache_creation_tokens: null,
        total_tokens: 0,
        cost_usd: 0,
        currency: null,
        terminal_type: null,
        repo_path: null,
        git_branch: null,
        project_name: null,
        raw_ref: null,
        redaction_state: "none",
        imported_at: new Date().toISOString(),
      },
      {
        id: "c2",
        source_app: "claude_code",
        source_kind: "ide",
        source_confidence: "exact",
        event_type: "api_request",
        timestamp: `${today}T13:00:00.000Z`,
        provider: null,
        model: null,
        session_id: null,
        prompt_id: null,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: null,
        cache_creation_tokens: null,
        total_tokens: 0,
        cost_usd: 0,
        currency: null,
        terminal_type: null,
        repo_path: null,
        git_branch: null,
        project_name: null,
        raw_ref: null,
        redaction_state: "none",
        imported_at: new Date().toISOString(),
      },
      {
        id: "c3",
        source_app: "cursor",
        source_kind: "ide",
        source_confidence: "derived",
        event_type: "api_request",
        timestamp: `${today}T14:00:00.000Z`,
        provider: null,
        model: null,
        session_id: null,
        prompt_id: null,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: null,
        cache_creation_tokens: null,
        total_tokens: 0,
        cost_usd: 0,
        currency: null,
        terminal_type: null,
        repo_path: null,
        git_branch: null,
        project_name: null,
        raw_ref: null,
        redaction_state: "none",
        imported_at: new Date().toISOString(),
      },
    ]);
    const mix = getTodayConfidenceMix(db);
    expect(mix.exact).toBe(2);
    expect(mix.derived).toBe(1);
    expect(mix.estimated).toBe(0);
  });

  it("getTodayConfidenceMix returns zeros for empty DB", () => {
    expect(getTodayConfidenceMix(db)).toEqual({ exact: 0, derived: 0, estimated: 0 });
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

  it("getEventsForExport returns all events without days filter", () => {
    const event: UsageEvent = {
      id: "export-1",
      source_app: "claude_code",
      source_kind: "cli",
      source_confidence: "exact",
      event_type: "api_request",
      timestamp: "2026-03-10T12:00:00.000Z",
      provider: "anthropic",
      model: "claude-3",
      session_id: null,
      prompt_id: null,
      input_tokens: 10,
      output_tokens: 20,
      cache_read_tokens: null,
      cache_creation_tokens: null,
      total_tokens: 30,
      cost_usd: 0.001,
      currency: "USD",
      terminal_type: null,
      repo_path: null,
      git_branch: null,
      project_name: null,
      raw_ref: null,
      redaction_state: "none",
      imported_at: new Date().toISOString(),
    };
    insertUsageEvent(db, event);
    const events = getEventsForExport(db);
    expect(events).toHaveLength(1);
    expect(events[0].id).toBe("export-1");
    expect(events[0].total_tokens).toBe(30);
  });

  it("getEventsForExport with days filters by date", () => {
    const today = new Date().toISOString().slice(0, 10);
    insertUsageEvents(db, [
      {
        id: "recent",
        source_app: "claude_code",
        source_kind: "cli",
        source_confidence: "exact",
        event_type: "api_request",
        timestamp: `${today}T12:00:00.000Z`,
        provider: null,
        model: null,
        session_id: null,
        prompt_id: null,
        input_tokens: 1,
        output_tokens: 2,
        cache_read_tokens: null,
        cache_creation_tokens: null,
        total_tokens: 3,
        cost_usd: 0,
        currency: null,
        terminal_type: null,
        repo_path: null,
        git_branch: null,
        project_name: null,
        raw_ref: null,
        redaction_state: "none",
        imported_at: new Date().toISOString(),
      },
      {
        id: "old",
        source_app: "claude_code",
        source_kind: "cli",
        source_confidence: "exact",
        event_type: "api_request",
        timestamp: "2020-01-01T12:00:00.000Z",
        provider: null,
        model: null,
        session_id: null,
        prompt_id: null,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: null,
        cache_creation_tokens: null,
        total_tokens: 0,
        cost_usd: 0,
        currency: null,
        terminal_type: null,
        repo_path: null,
        git_branch: null,
        project_name: null,
        raw_ref: null,
        redaction_state: "none",
        imported_at: new Date().toISOString(),
      },
    ]);
    const events = getEventsForExport(db, 30);
    expect(events.length).toBeLessThanOrEqual(2);
    const ids = events.map((e) => e.id);
    expect(ids).toContain("recent");
  });

  it("exportEventsAsCsv produces valid CSV with header", () => {
    const events: UsageEvent[] = [
      {
        id: "csv-1",
        source_app: "claude_code",
        source_kind: "cli",
        source_confidence: "exact",
        event_type: "api_request",
        timestamp: "2026-03-15T10:00:00.000Z",
        provider: null,
        model: null,
        session_id: null,
        prompt_id: null,
        input_tokens: 1,
        output_tokens: 2,
        cache_read_tokens: null,
        cache_creation_tokens: null,
        total_tokens: 3,
        cost_usd: 0.001,
        currency: null,
        terminal_type: null,
        repo_path: null,
        git_branch: null,
        project_name: null,
        raw_ref: null,
        redaction_state: "none",
        imported_at: "2026-03-15T10:00:00.000Z",
      },
    ];
    const csv = exportEventsAsCsv(events);
    expect(csv).toContain("id,");
    expect(csv).toContain("csv-1");
    expect(csv).toContain("claude_code");
    const lines = csv.split("\n");
    expect(lines.length).toBe(2);
  });

  it("exportEventsAsJson produces valid JSON array", () => {
    const events: UsageEvent[] = [];
    expect(exportEventsAsJson(events)).toBe("[]");
    const one: UsageEvent = {
      id: "j1",
      source_app: "claude_code",
      source_kind: "cli",
      source_confidence: "exact",
      event_type: "api_request",
      timestamp: "2026-03-15T10:00:00.000Z",
      provider: null,
      model: null,
      session_id: null,
      prompt_id: null,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: null,
      cache_creation_tokens: null,
      total_tokens: 0,
      cost_usd: 0,
      currency: null,
      terminal_type: null,
      repo_path: null,
      git_branch: null,
      project_name: null,
      raw_ref: null,
      redaction_state: "none",
      imported_at: "2026-03-15T10:00:00.000Z",
    };
    const json = exportEventsAsJson([one]);
    const parsed = JSON.parse(json);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe("j1");
  });

  it("exportEvents returns CSV or JSON string", () => {
    const csv = exportEvents(db, "csv");
    expect(csv).toMatch(/^id,/);
    const json = exportEvents(db, "json");
    expect(json).toBe("[]");
  });
});
