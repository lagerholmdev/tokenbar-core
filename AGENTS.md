# TokenBar Core — Agent Guide

**Purpose:** Guardrail and guide autonomous agents working on this repo. Maximize efficiency, enable long-running runs, implement intended behavior per spec, avoid overengineering and token waste.

---

## 1. Repo identity and boundaries

- **This repo:** `tokenbar-core` — open-source TypeScript/Node layer: schema, collector runtime, adapters, CLI, local SQLite, fixtures, tests, adapter SDK docs.
- **Sibling repo:** `tokenbar-macos` — closed-source Swift 6 menu bar app; reads the DB, does UI. Do not implement app UI or distribution in this repo.
- **Single source of truth:** [`.cursor/tokenbar-spec.md`](.cursor/tokenbar-spec.md) — product thesis, architecture, data model, integrations, MVP scope. Reference it by section; do not duplicate long passages.

---

## 2. Current phase and next steps

- **Phase source:** [`.cursor/rules/AGENT_INSTRUCTIONS.md`](.cursor/rules/AGENT_INSTRUCTIONS.md) defines the current phase (e.g. Phase 0) and step-by-step plan.
- **Before big changes:** Read the phase doc. Do the next step; do not jump ahead or add scope from later phases.
- **Long-running runs:** After completing a logical step, commit. Prefer “one step → verify → commit” so progress is resumable.

---

## 3. Guardrails (do not do)

- **No cloud:** No cloud sync, external APIs, Firebase, or “dashboard backend.” Local-first only.
- **No scope creep:** No Cursor/Claude Desktop adapters until the phase doc says so. No rollups/charts/export beyond what the phase specifies.
- **No UI in core:** No Swift, no menu bar, no Sparkle/signing. That lives in `tokenbar-macos`.
- **No overengineering:** No extra frameworks, message queues, or services. SQLite + TypeScript adapter runtime is enough for MVP.
- **No duplicate docs:** Do not copy large parts of the spec into new files. Cite sections (e.g. “per spec §9”, “§19 adapter contract”).

---

## 4. Efficiency and token discipline

- **Prefer editing:** Change existing code/files rather than rewriting or creating parallel implementations.
- **Small steps:** One clear step per turn when possible; confirm it works before expanding.
- **Reference, don’t repeat:** Point to spec/phase doc by section or filename instead of pasting full content.
- **Minimal prose:** Prefer bullets, short sentences, and concrete file/function names in plans and summaries.

---

## 5. Implementation rules (from spec)

- **Schema:** Use the canonical `UsageEvent` and rollup models in spec §9. Implement in this repo’s schema layer; keep one source of truth.
- **Adapters:** Every adapter must implement the contract in spec §19 (`UsageAdapter`: `id`, `name`, `confidence`, `detect()`, `sync()`, `health()`).
- **Confidence:** Every record has `source_confidence`: `exact` | `derived` | `estimated`. Never claim “exact” unless the source is official telemetry (e.g. Claude Code OTel).
- **Privacy:** No prompt text or code in storage; only counts, cost, and metadata. Redaction layer before persistence (spec §19).
- **Local only:** All data in local SQLite; no account or cloud required for MVP.

---

## 6. Where things live (this repo)

- **Spec:** `.cursor/tokenbar-spec.md`
- **Phase / steps:** `.cursor/rules/AGENT_INSTRUCTIONS.md`
- **Rules:** `.cursor/rules/*.mdc` (e.g. backend/conventions)
- **Schema / collector / adapters:** Follow the structure in spec §17 (`packages/core/`-style) or the existing layout (e.g. `schema/`, `collector/`, `adapters/`); keep one consistent layout.
- **Fixtures:** Use `fixtures/` for sample OTel/usage data and tests.

---

## 7. When in doubt

1. Re-read the **current phase** in `.cursor/rules/AGENT_INSTRUCTIONS.md`.
2. Check **scope** in spec §16 (MVP) and §10 (integrations).
3. Prefer the **smaller, local change** that satisfies the step.
4. If an architectural decision is irreversible, **ask** before implementing.
