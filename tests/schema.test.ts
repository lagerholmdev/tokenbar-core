import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import {
  defaultDbPath,
  getEventCount,
  getUsageSummary,
  initializeDatabase,
  insertBronzeRawPayload,
  insertRows,
  type SilverLogRecord,
  type SilverMetricPoint,
  type SilverSpanRecord,
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
  });

  it("creates usage_events view and bronze/silver tables on initialization", () => {
    const tables = db
      .prepare("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') ORDER BY name")
      .all() as { name: string; type: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain("bronze_raw_payloads");
    expect(names).toContain("silver_metric_points");
    expect(names).toContain("silver_log_records");
    expect(names).toContain("silver_span_records");
    expect(names).toContain("usage_events");
    const usageEventsRow = tables.find((t) => t.name === "usage_events");
    expect(usageEventsRow?.type).toBe("view");
  });

  it("insertBronzeRawPayload returns inserted row id", () => {
    const id = insertBronzeRawPayload(db, "metrics", '{"resourceMetrics":[]}');
    expect(id).toBe(1);
    const row = db.prepare("SELECT * FROM bronze_raw_payloads WHERE id = ?").get(1) as { kind: string; body: string };
    expect(row.kind).toBe("metrics");
    expect(row.body).toBe('{"resourceMetrics":[]}');
  });

  it("insertRows silver_metric_points round-trip", () => {
    const bronzeId = insertBronzeRawPayload(db, "metrics", "{}");
    const receivedAt = new Date().toISOString();
    const points: SilverMetricPoint[] = [
      {
        id: "silver-metric-1",
        bronze_id: bronzeId,
        received_at: receivedAt,
        metric_name: "test.metric",
        time_unix_nano: 1000,
        start_time_unix_nano: 999,
        value: 42,
        service_name: "test",
        service_version: "1.0",
        scope_name: "scope",
        session_id: "s1",
        prompt_id: "p1",
        user_id: null,
        organization_id: null,
        terminal_type: "cursor",
        model: "claude-4",
        token_type: "input",
        extra_attributes_json: null,
      },
    ];
    insertRows(db, "silver_metric_points", points);
    const row = db.prepare("SELECT * FROM silver_metric_points WHERE id = ?").get("silver-metric-1") as Record<string, unknown>;
    expect(row.metric_name).toBe("test.metric");
    expect(row.value).toBe(42);
    expect(row.session_id).toBe("s1");
  });

  it("insertRows silver_log_records round-trip", () => {
    const bronzeId = insertBronzeRawPayload(db, "logs", "{}");
    const receivedAt = new Date().toISOString();
    const records: SilverLogRecord[] = [
      {
        id: "silver-log-1",
        bronze_id: bronzeId,
        received_at: receivedAt,
        time_unix_nano: 2000,
        severity_number: 9,
        severity_text: "INFO",
        body: "hello",
        trace_id: null,
        span_id: null,
        service_name: "svc",
        session_id: "s2",
        user_id: null,
        organization_id: null,
        user_email: null,
        user_account_uuid: null,
        user_account_id: null,
        terminal_type: null,
        event_name: null,
        event_timestamp: null,
        event_sequence: null,
        prompt_id: null,
        prompt: null,
        prompt_length: null,
        model: null,
        input_tokens: null,
        output_tokens: null,
        cache_read_tokens: null,
        cache_creation_tokens: null,
        cost_usd: null,
        duration_ms: null,
        speed: null,
        extra_attributes_json: null,
      },
    ];
    insertRows(db, "silver_log_records", records);
    const row = db.prepare("SELECT * FROM silver_log_records WHERE id = ?").get("silver-log-1") as Record<string, unknown>;
    expect(row.body).toBe("hello");
    expect(row.severity_text).toBe("INFO");
  });

  it("insertRows silver_span_records round-trip", () => {
    const bronzeId = insertBronzeRawPayload(db, "traces", "{}");
    const receivedAt = new Date().toISOString();
    const records: SilverSpanRecord[] = [
      {
        id: "silver-span-1",
        bronze_id: bronzeId,
        received_at: receivedAt,
        trace_id: "trace1",
        span_id: "span1",
        parent_span_id: null,
        name: "request",
        kind: 1,
        start_time_unix_nano: 1000,
        end_time_unix_nano: 2000,
        status_code: 1,
        service_name: "svc",
        session_id: "s3",
        extra_attributes_json: null,
      },
    ];
    insertRows(db, "silver_span_records", records);
    const row = db.prepare("SELECT * FROM silver_span_records WHERE id = ?").get("silver-span-1") as Record<string, unknown>;
    expect(row.name).toBe("request");
    expect(row.trace_id).toBe("trace1");
  });

  it("usage_events view can be queried", () => {
    const rows = db.prepare("SELECT * FROM usage_events LIMIT 1").all();
    expect(Array.isArray(rows)).toBe(true);
  });

  it("gold view surfaces tokens and cost from silver_log_records", () => {
    const bronzeId = insertBronzeRawPayload(db, "logs", "{}");
    const receivedAt = new Date().toISOString();
    const record: SilverLogRecord = {
      id: "gold-log-1",
      bronze_id: bronzeId,
      received_at: receivedAt,
      time_unix_nano: 1_700_000_000_000_000_000,
      severity_number: null,
      severity_text: null,
      body: "example body",
      trace_id: null,
      span_id: null,
      service_name: "claude-code",
      session_id: "sess-1",
      user_id: null,
      organization_id: null,
      user_email: null,
      user_account_uuid: null,
      user_account_id: null,
      terminal_type: "cursor",
      event_name: "completion",
      event_timestamp: receivedAt,
      event_sequence: 1,
      prompt_id: "prompt-1",
      prompt: "example prompt",
      prompt_length: 10,
      model: "claude-sonnet-4-6",
      input_tokens: 100,
      output_tokens: 200,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      cost_usd: 0.0049,
      duration_ms: 1234,
      speed: "fast",
      extra_attributes_json: null,
    };
    insertRows(db, "silver_log_records", [record]);

    expect(getEventCount(db)).toBe(1);
    const row = db.prepare("SELECT * FROM usage_events").get() as Record<string, unknown>;
    expect(row.id).toBe("sess-1");
    expect(row.model).toBe("claude-sonnet-4-6");
    expect(row.input_tokens).toBe(100);
    expect(row.output_tokens).toBe(200);
    expect(Number(row.cost_usd)).toBeCloseTo(0.0049);
  });

  it("insertRows with empty array is a no-op", () => {
    insertRows(db, "silver_metric_points", []);
    expect(getEventCount(db)).toBe(0);
  });

  it("getUsageSummary returns aggregate stats from gold view", () => {
    const bronzeId = insertBronzeRawPayload(db, "logs", "{}");
    const receivedAt = new Date().toISOString();
    const records: SilverLogRecord[] = [
      {
        id: "sum-log-1",
        bronze_id: bronzeId,
        received_at: receivedAt,
        time_unix_nano: 1000,
        severity_number: null,
        severity_text: null,
        body: null,
        trace_id: null,
        span_id: null,
        service_name: "claude-code",
        session_id: "a",
        user_id: null,
        organization_id: null,
        user_email: null,
        user_account_uuid: null,
        user_account_id: null,
        terminal_type: null,
        event_name: null,
        event_timestamp: receivedAt,
        event_sequence: 1,
        prompt_id: "p1",
        prompt: null,
        prompt_length: null,
        model: "m",
        input_tokens: 10,
        output_tokens: 20,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        cost_usd: 0.01,
        duration_ms: null,
        speed: null,
        extra_attributes_json: null,
      },
      {
        id: "sum-log-2",
        bronze_id: bronzeId,
        received_at: receivedAt,
        time_unix_nano: 2000,
        severity_number: null,
        severity_text: null,
        body: null,
        trace_id: null,
        span_id: null,
        service_name: "claude-code",
        session_id: "c",
        user_id: null,
        organization_id: null,
        user_email: null,
        user_account_uuid: null,
        user_account_id: null,
        terminal_type: null,
        event_name: null,
        event_timestamp: receivedAt,
        event_sequence: 2,
        prompt_id: "p2",
        prompt: null,
        prompt_length: null,
        model: "m",
        input_tokens: 5,
        output_tokens: 15,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        cost_usd: 0.005,
        duration_ms: null,
        speed: null,
        extra_attributes_json: null,
      },
    ];
    insertRows(db, "silver_log_records", records);

    const summary = getUsageSummary(db);
    expect(summary.events).toBe(2);
    expect(summary.total_tokens).toBe(50);
    expect(summary.total_cost_usd).toBeCloseTo(0.015);
  });

  it("getUsageSummary returns zeros for empty DB", () => {
    const summary = getUsageSummary(db);
    expect(summary).toEqual({ events: 0, total_tokens: 0, total_cost_usd: 0 });
  });
});
