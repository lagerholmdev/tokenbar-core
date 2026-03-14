import { randomUUID } from "node:crypto";
import type { UsageEvent } from "./schema.js";

interface OtlpAttribute {
  key: string;
  value: { stringValue?: string; intValue?: string; doubleValue?: number };
}

interface OtlpDataPoint {
  attributes: OtlpAttribute[];
  startTimeUnixNano: string;
  timeUnixNano: string;
  asDouble?: number;
  asInt?: number;
}

interface OtlpMetric {
  name: string;
  description: string;
  unit: string;
  sum?: {
    dataPoints: OtlpDataPoint[];
  };
}

interface OtlpScopeMetrics {
  scope: { name: string; version: string };
  metrics: OtlpMetric[];
}

interface OtlpResourceMetrics {
  resource: { attributes: OtlpAttribute[] };
  scopeMetrics: OtlpScopeMetrics[];
}

interface OtlpPayload {
  resourceMetrics: OtlpResourceMetrics[];
}

function getAttr(attrs: OtlpAttribute[], key: string): string | undefined {
  const attr = attrs.find((a) => a.key === key);
  if (!attr) return undefined;
  return attr.value.stringValue ?? attr.value.intValue ?? String(attr.value.doubleValue ?? "");
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
      const tokenMetric = sm.metrics.find((m) => m.name === "claude_code.token.usage");
      const costMetric = sm.metrics.find((m) => m.name === "claude_code.cost.usage");

      if (!tokenMetric?.sum && !costMetric?.sum) continue;

      const tokenPoints = tokenMetric?.sum?.dataPoints ?? [];
      const costPoints = costMetric?.sum?.dataPoints ?? [];

      const inputPt = tokenPoints.find((p) => getAttr(p.attributes, "type") === "input");
      const outputPt = tokenPoints.find((p) => getAttr(p.attributes, "type") === "output");
      const cacheReadPt = tokenPoints.find((p) => getAttr(p.attributes, "type") === "cacheRead");
      const cacheCreationPt = tokenPoints.find((p) => getAttr(p.attributes, "type") === "cacheCreation");
      const costPt = costPoints[0];

      const refPoint = inputPt ?? outputPt ?? costPt;
      if (!refPoint) continue;

      const attrs = refPoint.attributes;
      const sessionId = getAttr(attrs, "session.id") ?? null;
      const model = getAttr(attrs, "model") ?? null;
      const terminalType = getAttr(attrs, "terminal.type") ?? null;

      const inputTokens = inputPt?.asDouble ?? null;
      const outputTokens = outputPt?.asDouble ?? null;
      const cacheReadTokens = cacheReadPt?.asDouble ?? null;
      const cacheCreationTokens = cacheCreationPt?.asDouble ?? null;
      const totalTokens =
        inputTokens != null || outputTokens != null
          ? (inputTokens ?? 0) +
            (outputTokens ?? 0) +
            (cacheReadTokens ?? 0) +
            (cacheCreationTokens ?? 0)
          : null;
      const costUsd = costPt?.asDouble ?? null;

      const sourceApp = serviceName === "claude-code" ? "claude_code" as const : "other" as const;

      const event: UsageEvent = {
        id: randomUUID(),
        source_app: sourceApp,
        source_kind: "cli",
        source_confidence: "exact",
        event_type: "api_request",
        timestamp: nanoToIso(refPoint.timeUnixNano),
        provider: "anthropic",
        model,
        session_id: sessionId,
        prompt_id: null,
        input_tokens: inputTokens != null ? Math.round(inputTokens) : null,
        output_tokens: outputTokens != null ? Math.round(outputTokens) : null,
        cache_read_tokens: cacheReadTokens != null ? Math.round(cacheReadTokens) : null,
        cache_creation_tokens: cacheCreationTokens != null ? Math.round(cacheCreationTokens) : null,
        total_tokens: totalTokens != null ? Math.round(totalTokens) : null,
        cost_usd: costUsd,
        currency: costUsd != null ? "USD" : null,
        terminal_type: terminalType,
        repo_path: null,
        git_branch: null,
        project_name: null,
        raw_ref: null,
        redaction_state: "none",
        imported_at: now,
      };

      events.push(event);
    }
  }

  return events;
}
