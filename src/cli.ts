import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { ClaudeCodeAdapter, readFixturePayloads } from "./adapters/claude-code.js";
import { startCollectorListener } from "./collector/listener.js";
import { syncAdapterIntoDatabase } from "./collector/runtime.js";
import { defaultDbPath, getUsageSummary, initializeDatabase } from "./schema.js";

const DEFAULT_FIXTURE_PATH = resolve(process.cwd(), "fixtures/mock-otlp-payload.json");
const DEFAULT_LISTENER_ENDPOINT = "http://127.0.0.1:4318/v1/metrics";

/** Default Claude Code settings path. Override with --settings for tests. */
export const DEFAULT_CLAUDE_SETTINGS_PATH = join(homedir(), ".claude", "settings.json");

/** Env vars Claude Code uses to send OTLP metrics to our HTTP listener (JSON). */
const OTLP_ENV = {
  CLAUDE_CODE_ENABLE_TELEMETRY: "1",
  OTEL_METRICS_EXPORTER: "otlp",
  OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
  OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "http://127.0.0.1:4318/v1/metrics",
};

function getOption(args: string[], name: string): string | undefined {
  const index = args.findIndex((arg) => arg === name);
  if (index === -1) return undefined;
  return args[index + 1];
}

function ensureParentDirectory(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
}

async function runListen(args: string[]): Promise<void> {
  const dbPath = getOption(args, "--db") ? resolve(process.cwd(), getOption(args, "--db")!) : defaultDbPath();
  const host = getOption(args, "--host") ?? "127.0.0.1";
  const port = Number(getOption(args, "--port") ?? "4318");
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error("Invalid --port value");
  }

  ensureParentDirectory(dbPath);
  const listener = await startCollectorListener({ dbPath, host, port });
  console.log(`[cli] DB: ${dbPath}`);
  console.log(`[cli] health: ${listener.url}/health`);
  console.log("[cli] listener running; press Ctrl+C to stop");

  const shutdown = async () => {
    await listener.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function runSyncFixture(args: string[]): Promise<void> {
  const dbPath = getOption(args, "--db") ? resolve(process.cwd(), getOption(args, "--db")!) : defaultDbPath();
  const fixturePath = resolve(process.cwd(), getOption(args, "--fixture") ?? DEFAULT_FIXTURE_PATH);
  ensureParentDirectory(dbPath);

  const db = initializeDatabase(dbPath);
  const adapter = new ClaudeCodeAdapter({ sourcePath: fixturePath });
  if (!(await adapter.detect())) {
    throw new Error(`Fixture file not found: ${fixturePath}`);
  }

  const result = await syncAdapterIntoDatabase(db, adapter);
  const health = await adapter.health();
  const summary = getUsageSummary(db);

  console.log(`[cli] synced adapter=${result.adapter_id} inserted=${result.inserted}`);
  console.log(`[cli] health status=${health.status} details=${health.details}`);
  console.log(`[cli] events=${summary.events} total_tokens=${summary.total_tokens} total_cost_usd=${summary.total_cost_usd.toFixed(6)}`);

  db.close();
}

async function runReplayFixture(args: string[]): Promise<void> {
  const fixturePath = resolve(process.cwd(), getOption(args, "--fixture") ?? DEFAULT_FIXTURE_PATH);
  const endpoint = getOption(args, "--endpoint") ?? DEFAULT_LISTENER_ENDPOINT;
  const payloads = readFixturePayloads(fixturePath);
  if (payloads.length === 0) {
    throw new Error(`No OTLP payloads found in ${fixturePath}`);
  }

  let inserted = 0;
  for (const payload of payloads) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      throw new Error(`Listener request failed: ${response.status} ${response.statusText}`);
    }

    const body = await response.json() as { inserted?: number };
    inserted += body.inserted ?? 0;
  }

  console.log(`[cli] replayed payloads=${payloads.length} inserted_events=${inserted}`);
}

function runConfigureClaude(args: string[]): void {
  const settingsPath = getOption(args, "--settings")
    ? resolve(process.cwd(), getOption(args, "--settings")!)
    : DEFAULT_CLAUDE_SETTINGS_PATH;

  let settings: Record<string, unknown> = {};
  try {
    const raw = readFileSync(settingsPath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      settings = parsed as Record<string, unknown>;
    }
  } catch {
    // File missing or invalid JSON — start fresh
  }

  const env = (settings.env && typeof settings.env === "object" && !Array.isArray(settings.env))
    ? (settings.env as Record<string, string>)
    : {};
  Object.assign(env, OTLP_ENV);
  settings.env = env;

  ensureParentDirectory(settingsPath);
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf8");

  console.log(`[cli] Wrote OTLP env to ${settingsPath}`);
  console.log("");
  console.log("Claude Code will send metrics to http://127.0.0.1:4318/v1/metrics when it runs.");
  console.log("1. Start the collector: tokenbar-collector listen");
  console.log("2. Restart Claude Code (or launch it with these env vars in effect)");
  console.log("3. Make a request in Claude Code; then GET http://127.0.0.1:4318/health to verify ingestion");
}

async function main(): Promise<void> {
  const [command = "help", ...args] = process.argv.slice(2);
  if (command === "listen") {
    await runListen(args);
    return;
  }
  if (command === "sync-fixture") {
    await runSyncFixture(args);
    return;
  }
  if (command === "replay-fixture") {
    await runReplayFixture(args);
    return;
  }
  if (command === "configure-claude") {
    runConfigureClaude(args);
    return;
  }

  console.log("TokenBar core CLI");
  console.log("Commands:");
  console.log("  listen [--db <path>] [--host <host>] [--port <port>]");
  console.log("  sync-fixture [--db <path>] [--fixture <path>]");
  console.log("  replay-fixture [--fixture <path>] [--endpoint <url>]");
  console.log("  configure-claude [--settings <path>]");
}

void main();
