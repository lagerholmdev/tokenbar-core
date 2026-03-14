import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseOtlpPayload, type OtlpPayload } from "../src/otlp-parser.js";

const FIXTURE_PATH = resolve(process.cwd(), "fixtures/mock-otlp-payload.json");

function readFixturePayloads(): OtlpPayload[] {
  return readFileSync(FIXTURE_PATH, "utf-8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as OtlpPayload)
    .filter((payload) => Array.isArray(payload.resourceMetrics));
}

describe("parseOtlpPayload", () => {
  it("parses Claude Code usage metrics into canonical events", () => {
    const payloads = readFixturePayloads();
    const events = payloads.flatMap((payload) => parseOtlpPayload(payload));

    expect(events.length).toBeGreaterThan(0);
    expect(events.every((event) => event.source_app === "claude_code")).toBe(true);
    expect(events.every((event) => event.source_confidence === "exact")).toBe(true);
    expect(events.some((event) => typeof event.session_id === "string" && event.session_id.length > 0)).toBe(true);
    expect(events.some((event) => (event.total_tokens ?? 0) > 0)).toBe(true);
    expect(events.some((event) => (event.cost_usd ?? 0) > 0)).toBe(true);
  });
});
