import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { initializeDatabase, insertUsageEvent, getEventCount } from "./schema.js";
import { parseOtlpPayload } from "./otlp-parser.js";

const FIXTURE_PATH = resolve(import.meta.dirname ?? ".", "../fixtures/mock-otlp-payload.json");

function main() {
  console.log("=== TokenBar Core — Hello World Demo ===\n");

  const db = initializeDatabase(":memory:");
  console.log("[1] SQLite in-memory database initialized with schema");

  const raw = readFileSync(FIXTURE_PATH, "utf-8");
  const lines = raw.trim().split("\n");
  console.log(`[2] Loaded fixture: ${lines.length} lines from mock-otlp-payload.json`);

  let totalParsed = 0;
  for (const line of lines) {
    if (line.startsWith("{")) {
      try {
        const payload = JSON.parse(line);
        if (payload.resourceMetrics) {
          const events = parseOtlpPayload(payload);
          for (const event of events) {
            insertUsageEvent(db, event);
          }
          totalParsed += events.length;
        }
      } catch {
        // skip non-JSON lines (HTTP logs)
      }
    }
  }

  console.log(`[3] Parsed and inserted ${totalParsed} usage events`);
  console.log(`[4] Total events in DB: ${getEventCount(db)}`);

  const rows = db
    .prepare(
      "SELECT model, SUM(input_tokens) as input, SUM(output_tokens) as output, SUM(cache_read_tokens) as cache_read, SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)) as total, SUM(cost_usd) as cost FROM usage_events GROUP BY model",
    )
    .all() as Array<{
    model: string;
    input: number;
    output: number;
    cache_read: number;
    total: number;
    cost: number;
  }>;

  console.log("\n[5] Usage summary by model:");
  for (const row of rows) {
    console.log(`    Model: ${row.model}`);
    console.log(`      Input tokens:      ${row.input}`);
    console.log(`      Output tokens:     ${row.output}`);
    console.log(`      Cache read tokens: ${row.cache_read}`);
    console.log(`      Total tokens:      ${row.total}`);
    console.log(`      Cost (USD):        $${row.cost?.toFixed(6) ?? "N/A"}`);
  }

  const sessions = db
    .prepare("SELECT DISTINCT session_id FROM usage_events WHERE session_id IS NOT NULL")
    .all() as Array<{ session_id: string }>;
  console.log(`\n[6] Unique sessions: ${sessions.length}`);

  db.close();
  console.log("\n=== Demo complete — dev environment is working! ===");
}

main();
