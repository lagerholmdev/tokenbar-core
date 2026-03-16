# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm install          # Install deps (better-sqlite3 requires native compilation)
pnpm run typecheck    # TypeScript type checking
pnpm run lint         # ESLint
pnpm run test         # Run all tests once
pnpm run test:watch   # Watch mode
pnpm run build        # Compile to dist/

# Dev workflows
pnpm run dev                  # Watch mode (src/index.ts)
pnpm run dev:listener         # Start HTTP collector on 127.0.0.1:4318
pnpm run dev:demo             # Pipeline debug: shows data at each stage
npx tsx src/demo.ts           # Same as dev:demo

# Run a single test file
pnpm run test -- tests/schema.test.ts
```

## Architecture

`tokenbar-core` is the open-source TypeScript data collector layer for TokenBar. It receives OTLP JSON from Claude Code, extracts token/cost metrics, and writes to a local SQLite database. A sibling closed-source Swift 6 app (`tokenbar-macos`) reads the DB to render the macOS menu bar UI — **do not implement UI here**.

**Data flow (bronze → silver → gold):**
```
POST /v1/metrics|logs|traces → bronze_raw_payloads (raw body)
  → silver_metric_points / silver_log_records / silver_span_records (normalized rows)
  → usage_events (gold; view over silver_log_records) → macOS app reads this
```

**Key modules:**
- `src/schema.ts` — SQLite schema (bronze/silver tables + `usage_events` gold view) and insert/query helpers
- `src/otlp-parser.ts` — parses Claude Code OpenTelemetry payloads into silver rows (`silver_metric_points`, `silver_log_records`, `silver_span_records`)
- `src/collector/listener.ts` — HTTP server (`POST /v1/metrics`, `GET /health`)
- `src/cli.ts` — CLI entry: `listen`, `configure-claude`, `inspect`
- `src/demo.ts` — pipeline debug script (shows raw → parsed → DB at each stage)
- `src/index.ts` — barrel export

**Fixture data:** `fixtures/mock-otlp-payload.json` contains real Claude Code OTLP metrics. Use this for tests instead of accessing live `~/.claude` paths.

## Claude Code OTLP configuration

Claude Code sends metrics to the collector only when configured. Use the CLI:

```bash
npx tsx src/cli.ts configure-claude   # writes to ~/.claude/settings.json
```

This sets `env` in the settings file so Claude Code exports OTLP to `http://127.0.0.1:4318/v1/metrics`. After running, start the collector (`listen`) and restart Claude Code. Verify with `GET http://127.0.0.1:4318/health` after making a Claude Code request.

## Querying the pipeline (testing / after running Claude)

**CLI — row counts and optional samples:**

```bash
npx tsx src/cli.ts inspect              # Bronze/silver/gold row counts
npx tsx src/cli.ts inspect --sample     # Counts + last 2 rows from each table
npx tsx src/cli.ts inspect --db ./my.db # Use a specific DB (e.g. test DB)
```

**Direct SQLite** (DB path: `~/Library/Application Support/TokenBar/tokenbar.db` on macOS):

```bash
# Open DB (macOS)
sqlite3 "$HOME/Library/Application Support/TokenBar/tokenbar.db"

# Bronze: raw payloads by kind
SELECT kind, COUNT(*), MAX(received_at) FROM bronze_raw_payloads GROUP BY kind;

# Silver: metric points (one per OTLP data point)
SELECT metric_name, session_id, model, token_type, value FROM silver_metric_points ORDER BY time_unix_nano DESC LIMIT 10;

# Silver: logs and spans (if any)
SELECT * FROM silver_log_records LIMIT 5;
SELECT * FROM silver_span_records LIMIT 5;

# Gold: what the macOS app reads
SELECT id, event_timestamp, model, input_tokens, output_tokens, cost_usd
FROM usage_events
ORDER BY received_at DESC
LIMIT 10;
```

In tests, use an in-memory DB (`:memory:`) or a temp file; the same tables exist, so the same queries apply.

## Key Constraints

- **ESM only** (`"type": "module"`). All TypeScript imports must use `.js` extensions (e.g. `import { foo } from "./bar.js"`).
- **Confidence labels required** on every record: `exact` | `derived` | `estimated`. Only Claude Code OTel qualifies as `"exact"`.
- **Privacy:** Store only token counts, costs, and metadata — no prompt text or code snippets.
- **Local-first:** No cloud sync, no external APIs, no Firebase. SQLite only.
- **`better-sqlite3`** is a native addon — `pnpm.onlyBuiltDependencies` allowlist handles build scripts; do not use `pnpm approve-builds` interactively.

## Spec & Phase Docs

- **Product spec:** `.cursor/tokenbar-spec.md` — canonical data model, adapter contract, MVP scope
- **Current phase:** `.cursor/rules/AGENT_INSTRUCTIONS.md` — step-by-step execution plan
- **Backend rules:** `.cursor/rules/core-backend.mdc`

Before making architectural changes, re-read the current phase doc and prefer the smallest local change that satisfies the step.
