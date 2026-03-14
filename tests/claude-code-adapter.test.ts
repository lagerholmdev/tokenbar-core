import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code.js";

const FIXTURE_PATH = resolve(process.cwd(), "fixtures/mock-otlp-payload.json");

describe("ClaudeCodeAdapter", () => {
  it("detects fixture input and syncs exact events", async () => {
    const adapter = new ClaudeCodeAdapter({ sourcePath: FIXTURE_PATH });

    await expect(adapter.detect()).resolves.toBe(true);

    const events = await adapter.sync();
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((event) => event.source_app === "claude_code")).toBe(true);
    expect(events.every((event) => event.source_confidence === "exact")).toBe(true);

    const health = await adapter.health();
    expect(health.status).toBe("healthy");
    expect(health.last_sync_at).not.toBeNull();
  });
});
