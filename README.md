# TokenBar Core

Open-source TypeScript data collector for [TokenBar](.cursor/tokenbar-spec.md): it reads local AI telemetry (e.g. Claude Code OpenTelemetry), normalizes it into bronze/silver tables, and exposes a single gold surface in SQLite. A separate macOS app (or any reader) can consume that database to show usage in the menu bar and charts.

**Open-core:** This repo is the plumbing; the menu bar UI lives in a sibling closed-source app that reads the same DB.

## Data flow (medallion)

```text
Claude Code (OTLP metrics/logs/traces)
  → HTTP POST to collector (localhost:4318/v1/metrics|logs|traces)
  → bronze_raw_payloads (raw OTLP JSON per request)
  → silver_metric_points / silver_log_records / silver_span_records (normalized rows)
  → usage_events (gold view over silver_log_records)
  → DB at canonical path (see below) read by the macOS app
```

- **Collector:** `listen` command runs an HTTP server that accepts OTLP JSON payloads and writes to SQLite (bronze + silver).
- **Config:** Run `configure-claude` so Claude Code sends metrics/logs/traces to the collector; see [CLAUDE.md](CLAUDE.md#claude-code-otlp-configuration).

## Canonical database path

The default database path is:

- **macOS:** `~/Library/Application Support/TokenBar/tokenbar.db`

Readers (e.g. the macOS app) should open this path read-only. Override with `--db <path>` when running the CLI.

## Schema (what readers can rely on)

- **`bronze_raw_payloads`** — Raw OTLP request bodies with `kind` (`metrics` / `logs` / `traces`) and `received_at`.
- **`silver_metric_points`** — One row per OTLP metric data point (no filtering).
- **`silver_log_records`** — One row per OTLP log record with promoted attributes for Claude Code (session, prompt, model, token counts, cost, etc.).
- **`silver_span_records`** — One row per OTLP span.
- **`usage_events`** — **Gold view** over `silver_log_records`. One row per log-derived usage event with:
  - identity/metadata: `id` (from `session_id`), `terminal_type`, `body`, `event_name`, `event_timestamp`, `prompt_id`, `prompt`, `prompt_length`, `model`, `source_confidence`, `provider`, `received_at`
  - usage: `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_creation_tokens`, `total_tokens`, `cost_usd`, `duration`, `speed`

Readers (including the macOS app) should treat `usage_events` as the **only gold surface** and do their own rollups/aggregations on top.

## Privacy

Only token counts, costs, and metadata are intended to be stored long term. The current log-derived `usage_events` view may expose log body/prompt fields for debugging; the macOS app can decide how much of that to surface and may filter/redact further.

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

## Commands

| Command | Description |
|--------|-------------|
| `listen` | Start HTTP collector (default DB: canonical path; default port 4318). |
| `configure-claude` | Write OTLP env vars to `~/.claude/settings.json` so Claude Code sends metrics/logs/traces to the collector. |
| `inspect` | Show bronze/silver counts and a gold (`usage_events`) summary, with optional sample rows. |

See [CLAUDE.md](CLAUDE.md) for dev commands and constraints.
