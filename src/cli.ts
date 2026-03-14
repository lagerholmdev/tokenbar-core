import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ClaudeCodeAdapter, readFixturePayloads } from "./adapters/claude-code.js";
import { startCollectorListener } from "./collector/listener.js";
import { syncAdapterIntoDatabase } from "./collector/runtime.js";
import { getUsageSummary, initializeDatabase } from "./schema.js";

const DEFAULT_DB_PATH = resolve(process.cwd(), ".tokenbar/tokenbar.sqlite");
const DEFAULT_FIXTURE_PATH = resolve(process.cwd(), "fixtures/mock-otlp-payload.json");
const DEFAULT_LISTENER_ENDPOINT = "http://127.0.0.1:4318/v1/metrics";

function getOption(args: string[], name: string): string | undefined {
  const index = args.findIndex((arg) => arg === name);
  if (index === -1) return undefined;
  return args[index + 1];
}

function ensureParentDirectory(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
}

async function runListen(args: string[]): Promise<void> {
  const dbPath = resolve(process.cwd(), getOption(args, "--db") ?? DEFAULT_DB_PATH);
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
  const dbPath = resolve(process.cwd(), getOption(args, "--db") ?? DEFAULT_DB_PATH);
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

  console.log("TokenBar core CLI");
  console.log("Commands:");
  console.log("  listen [--db <path>] [--host <host>] [--port <port>]");
  console.log("  sync-fixture [--db <path>] [--fixture <path>]");
  console.log("  replay-fixture [--fixture <path>] [--endpoint <url>]");
}

void main();
