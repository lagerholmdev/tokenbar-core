# TokenBar MVP — Issue Breakdown

Issues are grouped into epics. Resolve dependencies before starting blocked work.
Labels: `core` = tokenbar-core, `macos` = tokenbar-macos, `blocker` = blocks other issues.

---

## Epic 1: Schema & Query Layer (`tokenbar-core`)

### Issue 1.1 — Add indexes to `usage_events` table `core` `blocker`

**Context:** Every chart and pill query does a full table scan on `usage_events`. At 1000 requests/day this becomes measurable within weeks.

**Scope:**
- Add `CREATE INDEX IF NOT EXISTS idx_usage_events_timestamp ON usage_events(timestamp)` in `initializeDatabase()`
- Add `CREATE INDEX IF NOT EXISTS idx_usage_events_date ON usage_events(source_app, timestamp)` for per-source queries

**Acceptance criteria:**
- `EXPLAIN QUERY PLAN` on `WHERE date(timestamp) = '2026-03-15'` shows index usage
- Existing tests still pass

---

### Issue 1.2 — Fix `daily_usage_rollups` NULL composite PK bug `core` `blocker`

**Context:** The table's PK is `(day, source_app, provider, model)`. SQLite treats NULLs as distinct in unique constraints, so the same day+source can produce multiple rows when `provider` or `model` is NULL. Rollup accumulation breaks silently.

**Scope:**
- Change schema: replace nullable `provider`/`model` PK columns with `COALESCE(provider, '')` stored as `NOT NULL DEFAULT ''`
- Or: add a generated/computed column and use it as PK
- Update `insertUsageEvent` upsert accordingly
- Add a regression test: insert two events with `model = null` on the same day, assert single rollup row

**Acceptance criteria:**
- Two events with `model = null`, same `day` and `source_app` → exactly one rollup row
- Rollup `total_tokens` equals the sum of both events

---

### Issue 1.3 — Populate `daily_usage_rollups` on insert `core` `blocker`

**Context:** The rollup table is created but never written. The Swift chart needs pre-aggregated daily rows — summing raw events per chart render doesn't scale.

**Scope:**
- Add `upsertDailyRollup(db, event)` in `schema.ts`
- Call it inside the `insertUsageEvents` transaction, once per event
- Use `INSERT INTO ... ON CONFLICT(day, source_app, provider, model) DO UPDATE SET total_tokens = total_tokens + excluded.total_tokens, ...`
- Cover: `total_tokens`, `total_cost_usd`, `exact_events`, `derived_events`, `estimated_events`

**Acceptance criteria:**
- After `insertUsageEvents([e1, e2])` where both share a day, one rollup row exists with summed values
- Re-inserting the same event (idempotent via `INSERT OR REPLACE`) does not double-count the rollup

> **Note:** The idempotency tension between `INSERT OR REPLACE` on raw events and `+= delta` on rollups needs a clear decision. Recommended: store `imported_at` on each event and only call `upsertDailyRollup` for genuinely new rows (check insert vs replace via `changes()`).

---

### Issue 1.4 — Add query functions required by the macOS app `core` `blocker`

**Context:** `schema.ts` only exports `getTodayTokenTotal()`. The Swift app needs cost data and time-series buckets.

**Scope — add to `schema.ts`:**

```ts
// For the pill toggle
getTodayCostTotal(db): number

// For the "today" chart (hourly buckets, last 24h)
getHourlyTotals(db, date: string): { hour: number; tokens: number; cost_usd: number }[]

// For 7d / 30d charts (daily rollup rows)
getDailyTotals(db, days: number): { day: string; tokens: number; cost_usd: number }[]

// For confidence badge in UI
getTodayConfidenceMix(db): { exact: number; derived: number; estimated: number }
```

- `getHourlyTotals` queries raw `usage_events` (sufficient for today)
- `getDailyTotals` queries `daily_usage_rollups` (requires Issue 1.3)

**Acceptance criteria:**
- Each function has a test using an in-memory DB with seeded events
- `getDailyTotals(7)` returns at most 7 rows, sorted ascending by day
- All functions handle the empty-DB case (return zeros / empty array)

---

### Issue 1.5 — Pin the shared DB file path `core` `blocker`

**Context:** Both `tokenbar-core` (collector) and `tokenbar-macos` (reader) must open the same file. Currently path is ad-hoc.

**Scope:**
- Define canonical path: `~/Library/Application Support/TokenBar/tokenbar.db`
- Export `defaultDbPath()` helper from `src/schema.ts` (uses `os.homedir()`)
- Update `cli.ts listen` to use this as the default `--db` value
- Document the path in `CLAUDE.md` and `AGENTS.md` so the Swift side knows where to point its SQLite driver

**Acceptance criteria:**
- `pnpm run dev:listener` (no `--db` flag) creates/opens `~/Library/Application Support/TokenBar/tokenbar.db`
- Path helper is exported and tested

---

## Epic 2: Collector Process Management (`tokenbar-core`)

### Issue 2.1 — Build a self-contained CLI binary for the collector `core`

**Context:** The Swift app needs to launch and manage the collector as a subprocess. Currently `tsx src/cli.ts` requires a local Node + pnpm environment. The macOS app must bundle a standalone binary.

**Scope:**
- Add a build step using `esbuild` to bundle `src/cli.ts` → `dist/tokenbar-collector` (single JS file)
- Add a `pkg` or `ncc`-style step, or document that the app bundles Node.js separately
- Decide and document: **bundled Node approach** (simpler) vs **compiled binary** (cleaner for distribution)
- Add `pnpm run build:collector` script

**Acceptance criteria:**
- `dist/tokenbar-collector listen` starts the HTTP server without a local `node_modules`
- Document the chosen approach in `AGENTS.md`

---

### Issue 2.2 — Define the launchd plist for the collector agent `core`

**Context:** On macOS, background helper processes are managed via launchd. The macOS app installs a plist to start the collector on login and keep it alive.

**Scope:**
- Create `dist/com.tokenbar.collector.plist` template with:
  - `ProgramArguments`: path to bundled binary + `listen`
  - `RunAtLoad: true`
  - `KeepAlive: true`
  - `StandardErrorPath` / `StandardOutPath` to `~/Library/Logs/TokenBar/collector.log`
- Document the install/uninstall steps (used by the macOS app's onboarding and settings)

**Acceptance criteria:**
- `launchctl load <plist>` starts the collector; `launchctl unload` stops it
- Collector restarts automatically if it crashes (KeepAlive)

---

## Epic 3: Claude Code Integration (`tokenbar-core`)

### Issue 3.1 — Document and automate Claude Code OTLP configuration `core`

**Context:** Claude Code sends metrics to `localhost:4318` only when configured. Onboarding in the macOS app must write this config. The exact mechanism (env var vs `~/.claude/settings.json`) needs to be confirmed and documented.

**Scope:**
- Confirm the correct config key (check Claude Code docs / `~/.claude/settings.json` schema)
- Document in `AGENTS.md`: exact key name, expected value, how to verify it's working
- Add a `cli.ts configure-claude` subcommand that writes/updates the setting and prints instructions
- Add a health-check that verifies the OTLP endpoint is reachable

**Acceptance criteria:**
- After running `tokenbar-collector configure-claude`, Claude Code sends metrics to the listener
- `GET /health` reflects successful ingestion within one Claude Code request

---

## Epic 4: macOS App — Menu Bar Pill (`tokenbar-macos`)

> Issues 1.1–1.5 and 2.1–2.2 must be complete before starting this epic.

### Issue 4.0 — Scaffold `tokenbar-macos` Xcode project `macos` `blocker`

**Context:** The `tokenbar-macos` repo is empty (no Xcode project, no Swift files). All Epic 4 work depends on a buildable macOS app skeleton.

**Scope:**
- Create a macOS App Xcode project (or `Package.swift`) targeting macOS 14+
- Add GRDB.swift via Swift Package Manager
- Add an `App` entry point with `MenuBarExtra` shell (no-op pill as placeholder)
- Commit project skeleton to `tokenbar-macos`

**Acceptance criteria:**
- Project builds cleanly in Xcode
- A menu bar icon appears (even with static text)
- GRDB import resolves

---

### Issue 4.1 — DB reader layer in Swift

**Context:** The macOS app needs a thin SQLite read layer. It should not modify the DB — read-only access only.

**Scope:**
- Add SQLite.swift or GRDB as a dependency
- Open the DB at the canonical path from Issue 1.5 in read-only mode
- Implement Swift equivalents of: `getTodayTokenTotal`, `getTodayCostTotal`, `getHourlyTotals`, `getDailyTotals`
- Handle DB-not-found gracefully (collector not running yet)

**Acceptance criteria:**
- Queries return correct values against a DB seeded by `pnpm run dev:sync-fixture`
- App does not crash when DB file does not exist

---

### Issue 4.2 — Menu bar pill with token/cost toggle

**Scope:**
- `MenuBarExtra` displaying today's total: `184k` (tokens) or `$6.42` (cost)
- Polls DB every 5 seconds; updates label
- Option-click toggles between tokens and cost; persists toggle state to `UserDefaults`
- Single-click opens the popover (Issue 4.3)

**Acceptance criteria:**
- Pill updates within 5s of a new event being inserted
- Toggle state survives app restart
- Displays `—` when DB is unavailable (collector not running)

---

### Issue 4.3 — Popover with today's chart, 7d mini chart, and confidence badge

**Scope:**
- Popover opens on pill click
- Shows: today's total (tokens or cost, matching pill toggle), hourly bar/line chart for today (24 buckets)
- 7d mini chart (daily bars, last 7 days) — uses `getDailyTotals(7)`
- Confidence badge from `getTodayConfidenceMix` (e.g. "Exact" for Claude Code data)
- "Open details" placeholder button (no-op for MVP)

**Acceptance criteria:**
- Today chart renders correctly with 0–24 hourly data points
- 7d mini chart shows up to 7 daily bars with real data
- Chart y-axis unit matches current toggle (tokens vs USD)
- Badge shows confidence from `getTodayConfidenceMix`

---

## Epic 5: End-to-End Validation

### Issue 5.1 — Live end-to-end smoke test

**Context:** Validate the full path: Claude Code request → OTLP → collector → DB → pill update.

**Scope:**
- Start collector (`pnpm run dev:listener`)
- Configure Claude Code to point at `localhost:4318` (Issue 3.1)
- Make a real Claude Code request
- Verify: pill updates, chart shows a data point, confidence badge shows "Exact"
- Document any timing/latency observations (e.g., polling lag)

**Acceptance criteria:**
- End-to-end works without manual DB manipulation
- Collector log shows successful ingestion
- Pill reflects correct token count within 10 seconds

---

### Issue 5.2 — CSV/JSON export `core` `macos`

**Context:** Spec §16 lists "CSV/JSON export" as a required MVP feature. Not covered by any existing issue.

**Scope:**
- Add `exportEvents(db, format: 'csv'|'json', days?: number)` to `schema.ts` (tokenbar-core)
- Add `tokenbar-collector export --format csv --days 30` CLI command
- Wire an "Export" button in the popover quick-actions area (macOS app: write to `~/Downloads` or use `NSSharingServicePicker`)
- Redact any fields violating privacy rules (no prompt text — already enforced by schema)

**Acceptance criteria:**
- `tokenbar-collector export --format csv` writes a valid CSV to stdout
- macOS app "Export" action saves a file to `~/Downloads/tokenbar-export-<date>.json` (or user-chosen path)

---

### Issue 5.3 — 30d detail view `macos`

**Context:** Spec §16 "Today / 7d / 30d charts" and §11.3 detail window are required MVP. The popover covers today + 7d. A detail window provides the 30d view.

**Scope:**
- A SwiftUI `Window` or sheet opened from "Open details" in the popover
- Tab or segmented control: Today / 7d / 30d
- `getDailyTotals(30)` drives the 30d chart; `getHourlyTotals` drives today
- Tokens/cost toggle matching pill state
- Source breakdown row (just Claude Code for MVP)

**Acceptance criteria:**
- Detail window opens from popover "Open details" button
- Switching tabs renders correct chart with real DB data
- Empty state handled gracefully

---

## Epic 6: Release & Settings (`tokenbar-macos`)

> Completes spec §16 MVP: Settings + privacy controls, signed/notarized download, Sparkle auto-updates, onboarding. Do after Sprints 4–5.

### Issue 6.1 — Settings panel `macos`

**Scope:**
- Integrations toggle (enable/disable Claude Code collection)
- Privacy controls (data wipe, retention period)
- Launch at login (using `SMAppService`)
- Units (tokens / cost default for pill)

**Acceptance criteria:**
- Settings accessible from menu or popover
- Launch at login persists across restarts
- Data wipe clears local DB or prompts before wipe

---

### Issue 6.2 — App signing and notarization `macos`

**Scope:**
- Code sign with Developer ID
- Notarize via `notarytool`
- Staple ticket to `.app` bundle
- Create `.dmg` for direct download

**Acceptance criteria:**
- Signed app runs on clean Mac without Gatekeeper block
- Notarization ticket stapled; `spctl --assess` succeeds

---

### Issue 6.3 — Sparkle auto-updates `macos`

**Scope:**
- Add Sparkle 2 via SPM
- Host an `appcast.xml` (e.g. GitHub Releases or S3)
- Wire the "Check for updates" menu item

**Acceptance criteria:**
- App can fetch and install updates from appcast
- User can trigger "Check for updates" from menu

---

### Issue 6.4 — Onboarding flow `macos`

**Scope:**
- First-launch sheet: install launchd plist, run `configure-claude` (or equivalent), verify collector `/health`
- Guide user from zero to first data point without using CLI manually

**Acceptance criteria:**
- New user sees onboarding on first launch
- After completing steps, collector is running and Claude Code is configured
- Pill shows data (or clear "no data yet" state) within one Claude Code request

---

## Dependency Graph

```
1.1 ──┐
1.2 ──┤
1.3 ──┼──► 1.4 ──► 4.0 ──► 4.1 ──► 4.2 ──► 4.3 ──► 5.1
1.5 ──┘              │                      └──► 5.3
                     └──► 2.1 ──► 2.2
3.1 ─────────────────────────────────────────► 5.1
5.2 (core part) ─────────────────────────────► 5.1
```

## Suggested order

| Sprint | Issues |
|--------|--------|
| 1 | 1.1, 1.2, 1.3, 1.5 |
| 2 | 1.4, 3.1 |
| 3 | 2.1, 2.2, 4.0, 4.1 |
| 4 | 4.2, 4.3 |
| 5 | 5.1, 5.2, 5.3 |
| 6 | 6.1, 6.2, 6.3, 6.4 |
