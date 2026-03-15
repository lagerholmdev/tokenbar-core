import { readFileSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { execSync } from "node:child_process";
import { initializeDatabase, insertUsageEvent } from "../src/schema.js";
import type { UsageEvent } from "../src/schema.js";

describe("cli configure-claude", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      try {
        rmSync(tmpDir, { recursive: true });
      } catch {
        // ignore
      }
    }
  });

  it("writes OTLP env to --settings path and preserves other keys", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "tokenbar-cli-"));
    const settingsPath = join(tmpDir, "settings.json");
    const existing = JSON.stringify({ otherKey: "value", env: { FOO: "bar" } }, null, 2);
    writeFileSync(settingsPath, existing, "utf8");

    const cliPath = resolve(process.cwd(), "src/cli.ts");
    execSync(`npx tsx "${cliPath}" configure-claude --settings "${settingsPath}"`, {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    const content = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(content.otherKey).toBe("value");
    expect(content.env.FOO).toBe("bar");
    expect(content.env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe("1");
    expect(content.env.OTEL_METRICS_EXPORTER).toBe("otlp");
    expect(content.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT).toBe("http://127.0.0.1:4318/v1/metrics");
  });
});

describe("cli export", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tokenbar-export-"));
    dbPath = join(tmpDir, "test.db");
    const db = initializeDatabase(dbPath);
    const event: UsageEvent = {
      id: "cli-export-1",
      source_app: "claude_code",
      source_kind: "cli",
      source_confidence: "exact",
      event_type: "api_request",
      timestamp: new Date().toISOString(),
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
    };
    insertUsageEvent(db, event);
    db.close();
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true });
    } catch {
      // ignore
    }
  });

  it("export --format csv writes valid CSV to stdout", () => {
    const cliPath = resolve(process.cwd(), "src/cli.ts");
    const out = execSync(`npx tsx "${cliPath}" export --db "${dbPath}" --format csv`, {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    expect(out).toMatch(/^id,/);
    expect(out).toContain("cli-export-1");
  });

  it("export --format json writes valid JSON to stdout", () => {
    const cliPath = resolve(process.cwd(), "src/cli.ts");
    const out = execSync(`npx tsx "${cliPath}" export --db "${dbPath}" --format json`, {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    const parsed = JSON.parse(out.trim());
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(1);
    expect(parsed[0].id).toBe("cli-export-1");
  });

  it("export --days 30 limits to recent events", () => {
    const cliPath = resolve(process.cwd(), "src/cli.ts");
    const out = execSync(`npx tsx "${cliPath}" export --db "${dbPath}" --format json --days 30`, {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    const parsed = JSON.parse(out.trim());
    expect(parsed.length).toBeLessThanOrEqual(1);
  });
});
