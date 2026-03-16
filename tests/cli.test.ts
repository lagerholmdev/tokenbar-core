import { readFileSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, afterEach } from "vitest";
import { execSync } from "node:child_process";

describe("cli configure-claude", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
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
