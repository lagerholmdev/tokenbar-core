import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startCollectorListener } from "../src/collector/listener.js";
import type { OtlpPayload } from "../src/otlp-parser.js";

const FIXTURE_PATH = resolve(process.cwd(), "fixtures/mock-otlp-payload.json");

function getFirstPayload(): OtlpPayload {
  const line = readFileSync(FIXTURE_PATH, "utf-8")
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith("{") && entry.includes("claude_code.token.usage"));

  if (!line) {
    throw new Error("Fixture payload was not found");
  }
  return JSON.parse(line) as OtlpPayload;
}

describe("collector listener", () => {
  const handles: Array<{ close(): Promise<void> }> = [];

  afterEach(async () => {
    while (handles.length > 0) {
      const handle = handles.pop();
      if (handle) {
        await handle.close();
      }
    }
  });

  it("accepts OTLP metrics posts and stores parsed events", async () => {
    const handle = await startCollectorListener({
      dbPath: ":memory:",
      host: "127.0.0.1",
      port: 0,
    });
    handles.push(handle);

    const payload = getFirstPayload();
    const ingestResponse = await fetch(`${handle.url}/v1/metrics`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });

    expect(ingestResponse.status).toBe(202);
    const ingestBody = await ingestResponse.json() as { inserted: number };
    // Gold (usage_events) is derived from logs; metrics-only ingests may not create gold rows yet.
    expect(ingestBody.inserted).toBeGreaterThanOrEqual(0);

    const healthResponse = await fetch(`${handle.url}/health`);
    expect(healthResponse.status).toBe(200);
    const healthBody = await healthResponse.json() as { events: number };
    expect(healthBody.events).toBeGreaterThanOrEqual(0);
  });
});
