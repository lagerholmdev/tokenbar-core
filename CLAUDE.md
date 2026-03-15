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

# Dev / fixture workflows
pnpm run dev                  # Watch mode (src/index.ts)
pnpm run dev:listener         # Start HTTP collector on 127.0.0.1:4318
pnpm run dev:sync-fixture     # Load fixture data into DB
pnpm run dev:replay-fixture   # POST fixture payloads to running listener
npx tsx src/demo.ts           # Quick end-to-end demo

# Run a single test file
pnpm run test -- tests/schema.test.ts
```

## Architecture

`tokenbar-core` is the open-source TypeScript data collector layer for TokenBar. It reads local AI telemetry, maps it to a canonical schema, and writes to a local SQLite database. A sibling closed-source Swift 6 app (`tokenbar-macos`) reads the DB to render the macOS menu bar UI — **do not implement UI here**.

**Data flow:**
```
Claude Code OTLP metrics (local file or HTTP POST)
  → ClaudeCodeAdapter / CollectorListener
  → parseOtlpPayload() → UsageEvent[]
  → insertUsageEvents() → SQLite (usage_events table)
  → macOS app reads DB
```

**Key modules:**
- `src/schema.ts` — canonical `UsageEvent` type + SQLite table setup + query helpers
- `src/otlp-parser.ts` — parses Claude Code OpenTelemetry payloads into `UsageEvent[]`
- `src/adapters/` — pluggable `UsageAdapter` interface; `claude-code.ts` is the first impl
- `src/collector/listener.ts` — HTTP server (`POST /v1/metrics`, `GET /health`) that accepts live OTLP payloads
- `src/collector/runtime.ts` — `syncAdapterIntoDatabase()` for batch sync
- `src/cli.ts` — CLI entry: `listen`, `sync-fixture`, `replay-fixture`, `configure-claude`
- `src/index.ts` — barrel export

**Fixture data:** `fixtures/mock-otlp-payload.json` contains real Claude Code OTLP metrics. Use this for tests instead of accessing live `~/.claude` paths.

## Claude Code OTLP configuration

Claude Code sends metrics to the collector only when configured. Use the CLI:

```bash
npx tsx src/cli.ts configure-claude   # writes to ~/.claude/settings.json
```

This sets `env` in the settings file so Claude Code exports OTLP to `http://127.0.0.1:4318/v1/metrics`. Keys: `CLAUDE_CODE_ENABLE_TELEMETRY=1`, `OTEL_METRICS_EXPORTER=otlp`, `OTEL_EXPORTER_OTLP_PROTOCOL=http/json`, `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=http://127.0.0.1:4318/v1/metrics`. After running, start the collector (`listen`) and restart Claude Code. Verify with `GET http://127.0.0.1:4318/health` after making a Claude Code request.

## Key Constraints

- **ESM only** (`"type": "module"`). All TypeScript imports must use `.js` extensions (e.g. `import { foo } from "./bar.js"`).
- **Confidence labels required** on every record: `exact` | `derived` | `estimated`. Only Claude Code OTel qualifies as `"exact"`.
- **Privacy:** Store only token counts, costs, and metadata — no prompt text or code snippets.
- **Local-first:** No cloud sync, no external APIs, no Firebase. SQLite only.
- **No scope creep:** Do not add Cursor/Claude Desktop adapters or rollup aggregations until the phase doc (`.cursor/rules/AGENT_INSTRUCTIONS.md`) says so.
- **`better-sqlite3`** is a native addon — `pnpm.onlyBuiltDependencies` allowlist handles build scripts; do not use `pnpm approve-builds` interactively.

## Spec & Phase Docs

- **Product spec:** `.cursor/tokenbar-spec.md` — canonical data model, adapter contract, MVP scope
- **Current phase:** `.cursor/rules/AGENT_INSTRUCTIONS.md` — step-by-step execution plan
- **Backend rules:** `.cursor/rules/core-backend.mdc`

Before making architectural changes, re-read the current phase doc and prefer the smallest local change that satisfies the step.
