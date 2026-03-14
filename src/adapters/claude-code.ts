import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseOtlpPayload, type OtlpPayload } from "../otlp-parser.js";
import type { UsageEvent } from "../schema.js";
import type { AdapterHealth, UsageAdapter } from "./types.js";

const DEFAULT_FIXTURE_PATH = resolve(process.cwd(), "fixtures/mock-otlp-payload.json");

export interface ClaudeCodeAdapterOptions {
  sourcePath?: string;
}

function parsePayloadLines(raw: string): OtlpPayload[] {
  const payloads: OtlpPayload[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && "resourceMetrics" in parsed) {
        payloads.push(parsed as OtlpPayload);
      }
    } catch {
      // Ignore non-JSON transport/debug lines.
    }
  }
  return payloads;
}

export class ClaudeCodeAdapter implements UsageAdapter {
  public readonly id = "claude_code";
  public readonly name = "Claude Code";
  public readonly confidence = "exact" as const;
  private readonly sourcePath: string;
  private lastSyncAt: string | null = null;
  private lastError: string | null = null;

  constructor(options: ClaudeCodeAdapterOptions = {}) {
    this.sourcePath = options.sourcePath ?? process.env.TOKENBAR_CLAUDE_OTLP_PATH ?? DEFAULT_FIXTURE_PATH;
  }

  public async detect(): Promise<boolean> {
    return existsSync(this.sourcePath);
  }

  public async sync(since?: Date): Promise<UsageEvent[]> {
    try {
      const raw = readFileSync(this.sourcePath, "utf-8");
      const payloads = parsePayloadLines(raw);

      const events = payloads.flatMap((payload) => parseOtlpPayload(payload));
      const filteredEvents = since
        ? events.filter((event) => new Date(event.timestamp).getTime() >= since.getTime())
        : events;

      this.lastSyncAt = new Date().toISOString();
      this.lastError = null;
      return filteredEvents;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : "Unknown sync error";
      throw error;
    }
  }

  public async health(): Promise<AdapterHealth> {
    if (!(await this.detect())) {
      return {
        status: "unavailable",
        details: `Source path not found: ${this.sourcePath}`,
        last_sync_at: this.lastSyncAt,
      };
    }

    if (this.lastError) {
      return {
        status: "degraded",
        details: this.lastError,
        last_sync_at: this.lastSyncAt,
      };
    }

    return {
      status: "healthy",
      details: `Ready (${this.sourcePath})`,
      last_sync_at: this.lastSyncAt,
    };
  }

  public getSourcePath(): string {
    return this.sourcePath;
  }
}

export function readFixturePayloads(sourcePath: string = DEFAULT_FIXTURE_PATH): OtlpPayload[] {
  return parsePayloadLines(readFileSync(sourcePath, "utf-8"));
}
