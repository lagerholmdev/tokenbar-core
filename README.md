# TokenBar Core

Open-source TypeScript data collector for [TokenBar](.cursor/tokenbar-spec.md): it reads local AI telemetry (e.g. Claude Code OpenTelemetry), maps it to a canonical schema, and writes to a local SQLite database. A separate macOS app (or any reader) can consume that database to show usage in the menu bar and charts.

**Open-core:** This repo is the plumbing; the menu bar UI lives in a sibling closed-source app that reads the same DB.

## Data flow

```
Claude Code (OTLP metrics)
  → HTTP POST to collector (localhost:4318/v1/metrics)
  → parseOtlpPayload() → UsageEvent[]
  → insertUsageEvents() → SQLite
  → DB at canonical path (see below)
```

- **Collector:** `listen` command runs an HTTP server that accepts OTLP JSON payloads and writes to SQLite.
- **Config:** Run `configure-claude` so Claude Code sends metrics to the collector; see [CLAUDE.md](CLAUDE.md#claude-code-otlp-configuration).

## Canonical database path

The default database path is:

- **macOS:** `~/Library/Application Support/TokenBar/tokenbar.db`

Readers (e.g. the macOS app) should open this path read-only. Override with `--db <path>` when running the CLI.

## Schema (what readers can rely on)

- **`usage_events`** — One row per request/snapshot: `id`, `source_app`, `source_confidence`, `timestamp`, `total_tokens`, `cost_usd`, `provider`, `model`, etc. No prompt or code content; only counts, cost, and metadata.
- **`daily_usage_rollups`** — Pre-aggregated by `(day, source_app, provider, model)`: `total_tokens`, `total_cost_usd`, `exact_events`, `derived_events`, `estimated_events`.
- **`session_summaries`** — Optional per-session summaries.

Query helpers exported from the package: `getTodayTokenTotal`, `getTodayCostTotal`, `getHourlyTotals`, `getDailyTotals`, `getTodayConfidenceMix`. See `src/schema.ts` and `src/index.ts`.

## Privacy

Only token counts, costs, and metadata are stored. No prompt text, code snippets, or PII beyond what the upstream telemetry exposes (e.g. session IDs). Redaction is applied before persistence.

## Install and run

### From source

```bash
pnpm install
pnpm run build:collector   # → dist/tokenbar-collector.js
node dist/tokenbar-collector.js listen
```

Requires Node and `node_modules` (for `better-sqlite3`) when running the bundle. The macOS app may bundle the JS file plus Node and a minimal `node_modules`.

### Optional: launchd (run collector in background)

A plist template is in `scripts/com.tokenbar.collector.plist` and is copied to `dist/` when you run `pnpm run build:collector`. It uses placeholders:

- **`__BINARY_PATH__`** — Full path to `tokenbar-collector.js` (e.g. `~/Library/Application Support/TokenBar/tokenbar-collector.js`).
- **`__LOG_DIR__`** — Log directory (e.g. `~/Library/Logs/TokenBar`).

Substitute these (e.g. with `sed` or in the macOS app), create the log directory, then:

```bash
# Install
cp dist/com.tokenbar.collector.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.tokenbar.collector.plist

# Uninstall
launchctl unload ~/Library/LaunchAgents/com.tokenbar.collector.plist
rm ~/Library/LaunchAgents/com.tokenbar.collector.plist
```

The plist sets `RunAtLoad: true` and `KeepAlive: true` so the collector starts on login and restarts if it exits.

## Adapter SDK

To add another telemetry source, implement the `UsageAdapter` contract in `src/adapters/types.ts`: `id`, `name`, `confidence`, `detect()`, `sync(since?)`, `health()`. Map your data to the canonical `UsageEvent` type and use `insertUsageEvents()` from `src/schema.ts`. See `src/adapters/claude-code.ts` for the reference implementation.

## Commands

| Command | Description |
|--------|-------------|
| `listen` | Start HTTP collector (default DB: canonical path; default port 4318). |
| `sync-fixture` | Load fixture OTLP file into DB (for testing). |
| `replay-fixture` | POST fixture payloads to a running listener. |
| `configure-claude` | Write OTLP env vars to `~/.claude/settings.json` so Claude Code sends metrics to the collector. |

See [CLAUDE.md](CLAUDE.md) for dev commands and constraints.
