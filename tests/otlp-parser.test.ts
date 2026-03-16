import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseToSilverMetrics, type OtlpPayload } from "../src/otlp-parser.js";
import { initializeDatabase, insertBronzeRawPayload, insertRows } from "../src/schema.js";

const FIXTURE_PATH = resolve(process.cwd(), "fixtures/mock-otlp-payload.json");

function readFixtureBody(): string {
  return readFileSync(FIXTURE_PATH, "utf-8");
}

function readFixturePayloads(): OtlpPayload[] {
  return readFixtureBody()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as OtlpPayload)
    .filter((payload) => Array.isArray(payload.resourceMetrics));
}

describe("parseToSilverMetrics", () => {
  it("produces one row per data point without filtering", () => {
    const body = readFixtureBody();
    const receivedAt = new Date().toISOString();
    const points = parseToSilverMetrics(body, 1, receivedAt);
    expect(points.length).toBeGreaterThanOrEqual(7);
    expect(points.every((p) => p.bronze_id === 1 && p.received_at === receivedAt)).toBe(true);
    expect(points.some((p) => p.metric_name === "claude_code.token.usage" && p.token_type === "input")).toBe(true);
    expect(points.some((p) => p.metric_name === "claude_code.cost.usage")).toBe(true);
    expect(points.some((p) => p.metric_name === "claude_code.active_time.total")).toBe(true);
  });
});

// Gold view behavior is covered in schema tests; this file focuses on silver parsing.
