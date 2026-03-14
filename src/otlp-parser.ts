import { randomUUID } from "node:crypto";
import type { UsageEvent } from "./schema.js";

interface OtlpAnyValue {
  stringValue?: string;
  intValue?: string;
  doubleValue?: number;
  boolValue?: boolean;
}

export interface OtlpAttribute {
  key: string;
  value: OtlpAnyValue;
}

export interface OtlpDataPoint {
  attributes: OtlpAttribute[];
  startTimeUnixNano: string;
  timeUnixNano: string;
  asDouble?: number;
  asInt?: number | string;
}

export interface OtlpMetric {
  name: string;
  description?: string;
  unit?: string;
  sum?: {
    dataPoints: OtlpDataPoint[];
  };
}

export interface OtlpScopeMetrics {
  scope: { name: string; version: string };
  metrics: OtlpMetric[];
}

export interface OtlpResourceMetrics {
  resource: { attributes: OtlpAttribute[] };
  scopeMetrics: OtlpScopeMetrics[];
}

export interface OtlpPayload {
  resourceMetrics: OtlpResourceMetrics[];
}

interface UsageEventBuilder {
  attributes: OtlpAttribute[];
  timeUnixNano: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  costUsd: number | null;
}

function getAttr(attrs: OtlpAttribute[], key: string): string | undefined {
  const attr = attrs.find((a) => a.key === key);
  if (!attr) return undefined;
  if (typeof attr.value.stringValue === "string") return attr.value.stringValue;
  if (typeof attr.value.intValue === "string") return attr.value.intValue;
  if (typeof attr.value.doubleValue === "number") return String(attr.value.doubleValue);
  if (typeof attr.value.boolValue === "boolean") return String(attr.value.boolValue);
  return undefined;
}

function getFirstAttr(attrs: OtlpAttribute[], ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = getAttr(attrs, key);
    if (value) return value;
  }
  return undefined;
}

function dataPointNumber(point: OtlpDataPoint): number | null {
  if (typeof point.asDouble === "number") return point.asDouble;
  if (typeof point.asInt === "number") return point.asInt;
  if (typeof point.asInt === "string") {
    const parsed = Number(point.asInt);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function builderKey(point: OtlpDataPoint, fallbackIndex: number): string {
  const sessionId = getFirstAttr(point.attributes, "session.id", "session_id") ?? "session:unknown";
  const promptId = getFirstAttr(point.attributes, "prompt.id", "prompt_id", "request.id", "request_id") ?? "prompt:unknown";
  const model = getFirstAttr(point.attributes, "model", "model.name") ?? "model:unknown";
  const stableKey = `${sessionId}|${promptId}|${model}|${point.timeUnixNano}`;
  const hasIdentity = sessionId !== "session:unknown"
    || promptId !== "prompt:unknown"
    || model !== "model:unknown";
  if (!hasIdentity) {
    return `${stableKey}|${fallbackIndex}`;
  }
  return stableKey;
}

function nanoToIso(nanoStr: string): string {
  const ms = Number(BigInt(nanoStr) / BigInt(1_000_000));
  return new Date(ms).toISOString();
}

export function parseOtlpPayload(payload: OtlpPayload): UsageEvent[] {
  const events: UsageEvent[] = [];
  const now = new Date().toISOString();

  for (const rm of payload.resourceMetrics) {
    const resourceAttrs = rm.resource.attributes;
    const serviceName = getAttr(resourceAttrs, "service.name") ?? "unknown";

    for (const sm of rm.scopeMetrics) {
      const tokenMetric = sm.metrics.filter((m) => m.name === "claude_code.token.usage");
      const costMetric = sm.metrics.filter((m) => m.name === "claude_code.cost.usage");

      if (tokenMetric.length === 0 && costMetric.length === 0) continue;

      const grouped = new Map<string, UsageEventBuilder>();

      let pointIndex = 0;
      for (const metric of tokenMetric) {
        for (const point of metric.sum?.dataPoints ?? []) {
          const key = builderKey(point, pointIndex);
          pointIndex += 1;

          const current = grouped.get(key) ?? {
            attributes: point.attributes,
            timeUnixNano: point.timeUnixNano,
            inputTokens: null,
            outputTokens: null,
            cacheReadTokens: null,
            cacheCreationTokens: null,
            costUsd: null,
          };

          const tokenType = getFirstAttr(point.attributes, "type");
          const value = dataPointNumber(point);
          if (value != null) {
            if (tokenType === "input") current.inputTokens = value;
            if (tokenType === "output") current.outputTokens = value;
            if (tokenType === "cacheRead") current.cacheReadTokens = value;
            if (tokenType === "cacheCreation") current.cacheCreationTokens = value;
          }

          grouped.set(key, current);
        }
      }

      for (const metric of costMetric) {
        for (const point of metric.sum?.dataPoints ?? []) {
          const key = builderKey(point, pointIndex);
          pointIndex += 1;

          const current = grouped.get(key) ?? {
            attributes: point.attributes,
            timeUnixNano: point.timeUnixNano,
            inputTokens: null,
            outputTokens: null,
            cacheReadTokens: null,
            cacheCreationTokens: null,
            costUsd: null,
          };

          const value = dataPointNumber(point);
          if (value != null) {
            current.costUsd = value;
          }

          grouped.set(key, current);
        }
      }

      for (const builder of grouped.values()) {
        const attrs = builder.attributes;
        const sessionId = getFirstAttr(attrs, "session.id", "session_id") ?? null;
        const promptId = getFirstAttr(attrs, "prompt.id", "prompt_id", "request.id", "request_id") ?? null;
        const model = getFirstAttr(attrs, "model", "model.name") ?? null;
        const terminalType = getFirstAttr(attrs, "terminal.type", "terminal", "client.terminal.type") ?? null;
        const repoPath = getFirstAttr(attrs, "repo.path", "repository.path", "project.path", "cwd") ?? null;
        const gitBranch = getFirstAttr(attrs, "git.branch", "branch", "vcs.branch") ?? null;
        const projectName = getFirstAttr(attrs, "project.name", "project") ?? null;

        const hasTokenData =
          builder.inputTokens != null
          || builder.outputTokens != null
          || builder.cacheReadTokens != null
          || builder.cacheCreationTokens != null;

        const totalTokens = hasTokenData
          ? (builder.inputTokens ?? 0)
            + (builder.outputTokens ?? 0)
            + (builder.cacheReadTokens ?? 0)
            + (builder.cacheCreationTokens ?? 0)
          : null;

        const sourceApp = serviceName === "claude-code" ? "claude_code" as const : "other" as const;
        const sourceConfidence = sourceApp === "claude_code" ? "exact" as const : "derived" as const;
        const provider = getFirstAttr(attrs, "provider", "llm.provider") ?? (sourceApp === "claude_code" ? "anthropic" : null);

        const event: UsageEvent = {
          id: randomUUID(),
          source_app: sourceApp,
          source_kind: "cli",
          source_confidence: sourceConfidence,
          event_type: "api_request",
          timestamp: nanoToIso(builder.timeUnixNano),
          provider,
          model,
          session_id: sessionId,
          prompt_id: promptId,
          input_tokens: builder.inputTokens != null ? Math.round(builder.inputTokens) : null,
          output_tokens: builder.outputTokens != null ? Math.round(builder.outputTokens) : null,
          cache_read_tokens: builder.cacheReadTokens != null ? Math.round(builder.cacheReadTokens) : null,
          cache_creation_tokens: builder.cacheCreationTokens != null ? Math.round(builder.cacheCreationTokens) : null,
          total_tokens: totalTokens != null ? Math.round(totalTokens) : null,
          cost_usd: builder.costUsd,
          currency: builder.costUsd != null ? "USD" : null,
          terminal_type: terminalType,
          repo_path: repoPath,
          git_branch: gitBranch,
          project_name: projectName,
          raw_ref: null,
          redaction_state: "none",
          imported_at: now,
        };

        events.push(event);
      }
    }
  }

  return events;
}
