import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { startCollectorListener } from "./collector/listener.js";
import { defaultDbPath, getUsageSummary, initializeDatabase } from "./schema.js";

/** Default Claude Code settings path. Override with --settings for tests. */
export const DEFAULT_CLAUDE_SETTINGS_PATH = join(homedir(), ".claude", "settings.json");

const OTLP_ENV = {
  CLAUDE_CODE_ENABLE_TELEMETRY: "1",
  OTEL_METRICS_EXPORTER: "otlp",
  OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
  OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "http://127.0.0.1:4318/v1/metrics",
  OTEL_LOGS_EXPORTER: "otlp",
  OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://127.0.0.1:4318/v1/logs",
  OTEL_TRACES_EXPORTER: "otlp",
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://127.0.0.1:4318/v1/traces",
  OTEL_LOG_USER_PROMPTS: "1",
  OTEL_LOG_TOOL_DETAILS: "1",
};

function getOption(args: string[], name: string): string | undefined {
  const index = args.findIndex((arg) => arg === name);
  if (index === -1) return undefined;
  return args[index + 1];
}

function ensureParentDirectory(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
}

function killProcessOnPort(port: number): void {
  if (process.platform === "win32") return;
  try {
    const out = execSync(`lsof -ti :${port}`, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    const pids = out.trim().split(/\s+/).filter(Boolean);
    for (const pid of pids) {
      try {
        execSync(`kill ${pid}`, { stdio: "pipe" });
        console.log(`[cli] killed process ${pid} on port ${port}`);
      } catch { /* process may have exited */ }
    }
  } catch { /* port is free */ }
}

async function runListen(args: string[]): Promise<void> {
  const dbPath = getOption(args, "--db") ? resolve(process.cwd(), getOption(args, "--db")!) : defaultDbPath();
  const host = getOption(args, "--host") ?? "127.0.0.1";
  const port = Number(getOption(args, "--port") ?? "4318");
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error("Invalid --port value");
  }

  killProcessOnPort(port);
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

function runInspect(args: string[]): void {
  const dbPath = getOption(args, "--db") ? resolve(process.cwd(), getOption(args, "--db")!) : defaultDbPath();
  const sample = args.includes("--sample");

  if (!existsSync(dbPath)) {
    console.log(`[cli] DB not found: ${dbPath}`);
    console.log("Start the collector (listen) and use Claude Code to ingest data first.");
    return;
  }

  const db = initializeDatabase(dbPath);

  console.log(`DB: ${dbPath}\n`);

  const bronzeCount = db.prepare("SELECT kind, COUNT(*) as c FROM bronze_raw_payloads GROUP BY kind").all() as { kind: string; c: number }[];
  const bronzeTotal = bronzeCount.reduce((s, r) => s + r.c, 0);
  console.log("Bronze (bronze_raw_payloads):");
  if (bronzeTotal === 0) console.log("  (empty)");
  else {
    for (const r of bronzeCount) console.log(`  ${r.kind}: ${r.c}`);
    console.log(`  total: ${bronzeTotal}`);
  }

  const silverMetrics = (db.prepare("SELECT COUNT(*) as c FROM silver_metric_points").get() as { c: number }).c;
  const silverLogs = (db.prepare("SELECT COUNT(*) as c FROM silver_log_records").get() as { c: number }).c;
  const silverSpans = (db.prepare("SELECT COUNT(*) as c FROM silver_span_records").get() as { c: number }).c;
  console.log("\nSilver:");
  console.log(`  silver_metric_points: ${silverMetrics}`);
  console.log(`  silver_log_records:  ${silverLogs}`);
  console.log(`  silver_span_records: ${silverSpans}`);

  const gold = getUsageSummary(db);
  console.log("\nGold (usage_events):");
  console.log(`  events: ${gold.events}, total_tokens: ${gold.total_tokens}, total_cost_usd: ${gold.total_cost_usd.toFixed(6)}`);

  if (sample && (bronzeTotal > 0 || silverMetrics > 0 || silverLogs > 0 || silverSpans > 0 || gold.events > 0)) {
    console.log("\n--- Sample rows (last 2 per table) ---");
    if (bronzeTotal > 0) {
      const rows = db.prepare("SELECT id, kind, received_at, length(body) as body_len FROM bronze_raw_payloads ORDER BY id DESC LIMIT 2").all();
      console.log("\nbronze_raw_payloads:", JSON.stringify(rows, null, 2));
    }
    if (silverMetrics > 0) {
      const rows = db.prepare("SELECT id, bronze_id, metric_name, session_id, model, token_type, value FROM silver_metric_points ORDER BY time_unix_nano DESC LIMIT 2").all();
      console.log("\nsilver_metric_points:", JSON.stringify(rows, null, 2));
    }
    if (gold.events > 0) {
      const rows = db.prepare("SELECT id, timestamp, model, input_tokens, output_tokens, cost_usd FROM usage_events ORDER BY timestamp DESC LIMIT 2").all();
      console.log("\nusage_events:", JSON.stringify(rows, null, 2));
    }
  }

  db.close();
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
  } catch { /* file missing or invalid JSON — start fresh */ }

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
  if (command === "configure-claude") {
    runConfigureClaude(args);
    return;
  }
  if (command === "inspect") {
    runInspect(args);
    return;
  }

  console.log("TokenBar core CLI");
  console.log("Commands:");
  console.log("  listen [--db <path>] [--host <host>] [--port <port>]");
  console.log("  configure-claude [--settings <path>]");
  console.log("  inspect [--db <path>] [--sample]   Inspect bronze/silver/gold row counts (optional sample rows)");
}

void main();
