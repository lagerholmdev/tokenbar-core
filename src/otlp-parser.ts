import { randomUUID } from "node:crypto";
import type { SilverMetricPoint, SilverLogRecord, SilverSpanRecord } from "./schema.js";

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

/** OTLP logs payload (POST /v1/logs). */
interface OtlpLogsPayload {
  resourceLogs?: Array<{
    resource?: { attributes?: OtlpAttribute[] };
    scopeLogs?: Array<{
      scope?: { name?: string; version?: string };
      logRecords?: Array<{
        timeUnixNano?: string;
        severityNumber?: number;
        severityText?: string;
        body?: OtlpAnyValue;
        traceId?: string;
        spanId?: string;
        attributes?: OtlpAttribute[];
      }>;
    }>;
  }>;
}

/** OTLP traces payload (POST /v1/traces). */
interface OtlpTracesPayload {
  resourceSpans?: Array<{
    resource?: { attributes?: OtlpAttribute[] };
    scopeSpans?: Array<{
      scope?: { name?: string; version?: string };
      spans?: Array<{
        traceId?: string;
        spanId?: string;
        parentSpanId?: string;
        name?: string;
        kind?: number;
        startTimeUnixNano?: string;
        endTimeUnixNano?: string;
        status?: { code?: number };
        attributes?: OtlpAttribute[];
      }>;
    }>;
  }>;
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

function getAttrNumber(attrs: OtlpAttribute[], key: string): number | null {
  const s = getAttr(attrs, key);
  if (s == null || s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
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
  // Stable grouping key derived from session/prompt/model/timestamp when needed.
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

function nanoToNumber(nanoStr: string): number {
  return Number(BigInt(nanoStr));
}

/** Parse request body into zero or more OTLP metrics payloads (array, single object, or NDJSON). */
function parseMetricsPayloadsFromBody(body: string): OtlpPayload[] {
  const trimmed = body.trim();
  if (trimmed.length === 0) return [];
  const tryParse = (input: string): unknown => {
    try { return JSON.parse(input); } catch { return null; }
  };
  const parsed = tryParse(trimmed);
  if (parsed && typeof parsed === "object") {
    if (Array.isArray(parsed)) {
      return (parsed as unknown[]).filter(
        (item): item is OtlpPayload =>
          Boolean(item && typeof item === "object" && "resourceMetrics" in item),
      );
    }
    if ("resourceMetrics" in parsed) return [parsed as OtlpPayload];
  }
  const payloads: OtlpPayload[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    const maybe = tryParse(line.trim());
    if (maybe && typeof maybe === "object" && "resourceMetrics" in maybe) {
      payloads.push(maybe as OtlpPayload);
    }
  }
  return payloads;
}

const KNOWN_METRIC_ATTRS = new Set([
  "session.id", "session_id", "prompt.id", "prompt_id", "request.id", "request_id",
  "user.id", "user_id", "organization.id", "organization_id",
  "terminal.type", "terminal", "client.terminal.type",
  "model", "model.name", "type",
]);
function extraAttributesJson(attrs: OtlpAttribute[]): string | null {
  const extra = attrs.filter((a) => !KNOWN_METRIC_ATTRS.has(a.key));
  if (extra.length === 0) return null;
  const obj: Record<string, unknown> = {};
  for (const a of extra) {
    const v = a.value;
    if (typeof v?.stringValue === "string") obj[a.key] = v.stringValue;
    else if (typeof v?.intValue !== "undefined") obj[a.key] = v.intValue;
    else if (typeof v?.doubleValue === "number") obj[a.key] = v.doubleValue;
    else if (typeof v?.boolValue === "boolean") obj[a.key] = v.boolValue;
  }
  return JSON.stringify(obj);
}

/** Flatten OTLP metrics payloads to one row per data point. No filtering. */
export function parseToSilverMetrics(
  body: string,
  bronzeId: number,
  receivedAt: string,
): SilverMetricPoint[] {
  const payloads = parseMetricsPayloadsFromBody(body);
  const points: SilverMetricPoint[] = [];
  for (const payload of payloads) {
    for (const rm of payload.resourceMetrics ?? []) {
      const resourceAttrs = rm.resource?.attributes ?? [];
      const serviceName = getAttr(resourceAttrs, "service.name") ?? null;
      const serviceVersion = getAttr(resourceAttrs, "service.version") ?? null;
      for (const sm of rm.scopeMetrics ?? []) {
        const scopeName = sm.scope?.name ?? null;
        for (const metric of sm.metrics ?? []) {
          const dataPoints = metric.sum?.dataPoints ?? [];
          for (const dp of dataPoints) {
            const value = dataPointNumber(dp);
            const timeNano = dp.timeUnixNano ? nanoToNumber(dp.timeUnixNano) : 0;
            const startNano = dp.startTimeUnixNano ? nanoToNumber(dp.startTimeUnixNano) : null;
            points.push({
              id: randomUUID(),
              bronze_id: bronzeId,
              received_at: receivedAt,
              metric_name: metric.name,
              time_unix_nano: timeNano,
              start_time_unix_nano: startNano,
              value: value ?? 0,
              service_name: serviceName,
              service_version: serviceVersion,
              scope_name: scopeName,
              session_id: getFirstAttr(dp.attributes, "session.id", "session_id") ?? null,
              prompt_id: getFirstAttr(dp.attributes, "prompt.id", "prompt_id", "request.id", "request_id") ?? null,
              user_id: getFirstAttr(dp.attributes, "user.id", "user_id") ?? null,
              organization_id: getFirstAttr(dp.attributes, "organization.id", "organization_id") ?? null,
              terminal_type: getFirstAttr(dp.attributes, "terminal.type", "terminal", "client.terminal.type") ?? null,
              model: getFirstAttr(dp.attributes, "model", "model.name") ?? null,
              token_type: getFirstAttr(dp.attributes, "type") ?? null,
              extra_attributes_json: extraAttributesJson(dp.attributes ?? []),
            });
          }
        }
      }
    }
  }
  return points;
}

function logBodyToString(body: OtlpAnyValue | undefined): string | null {
  if (!body) return null;
  if (typeof body.stringValue === "string") return body.stringValue;
  if (typeof body.intValue !== "undefined") return String(body.intValue);
  if (typeof body.doubleValue === "number") return String(body.doubleValue);
  if (typeof body.boolValue === "boolean") return String(body.boolValue);
  return null;
}

/** Parse body into OTLP logs payloads (array, single object, or NDJSON). */
function parseLogsPayloadsFromBody(body: string): OtlpLogsPayload[] {
  const trimmed = body.trim();
  if (trimmed.length === 0) return [];
  const tryParse = (input: string): unknown => {
    try { return JSON.parse(input); } catch { return null; }
  };
  const parsed = tryParse(trimmed);
  if (parsed && typeof parsed === "object") {
    if (Array.isArray(parsed)) {
      return (parsed as unknown[]).filter(
        (item): item is OtlpLogsPayload =>
          Boolean(item && typeof item === "object" && "resourceLogs" in item),
      );
    }
    if ("resourceLogs" in parsed) return [parsed as OtlpLogsPayload];
  }
  const out: OtlpLogsPayload[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    const maybe = tryParse(line.trim());
    if (maybe && typeof maybe === "object" && "resourceLogs" in maybe) {
      out.push(maybe as OtlpLogsPayload);
    }
  }
  return out;
}

/** Attribute keys promoted to silver_log_records columns (excluded from extra_attributes_json). */
const SILVER_LOG_PROMOTED_ATTR_KEYS = new Set([
  "user.id", "organization.id", "user.email", "user.account_uuid", "user.account_id",
  "terminal.type", "event.name", "event.timestamp", "event.sequence", "prompt.id", "prompt", "prompt_length", "model",
  "input_tokens", "output_tokens", "cache_read_tokens", "cache_creation_tokens", "cost_usd", "duration_ms", "speed",
  "session.id", "session_id",
]);

/** Flatten OTLP logs payloads to one row per log record. No filtering. */
export function parseToSilverLogs(
  body: string,
  bronzeId: number,
  receivedAt: string,
): SilverLogRecord[] {
  const payloads = parseLogsPayloadsFromBody(body);
  const records: SilverLogRecord[] = [];
  for (const payload of payloads) {
    for (const rl of payload.resourceLogs ?? []) {
      const resourceAttrs = rl.resource?.attributes ?? [];
      const serviceName = getAttr(resourceAttrs, "service.name") ?? null;
      for (const sl of rl.scopeLogs ?? []) {
        for (const lr of sl.logRecords ?? []) {
          const attrs = lr.attributes ?? [];
          const timeNano = lr.timeUnixNano ? nanoToNumber(lr.timeUnixNano) : 0;
          const bodyStr = logBodyToString(lr.body);
          const extraAttrs = attrs.filter((a) => !SILVER_LOG_PROMOTED_ATTR_KEYS.has(a.key));
          const extraJson = extraAttrs.length > 0
            ? JSON.stringify(extraAttrs.reduce((acc: Record<string, unknown>, a) => {
                if (typeof a.value?.stringValue === "string") acc[a.key] = a.value.stringValue;
                else if (a.value?.intValue !== undefined) acc[a.key] = a.value.intValue;
                else if (typeof a.value?.doubleValue === "number") acc[a.key] = a.value.doubleValue;
                else if (typeof a.value?.boolValue === "boolean") acc[a.key] = a.value.boolValue;
                return acc;
              }, {}))
            : null;
          records.push({
            id: randomUUID(),
            bronze_id: bronzeId,
            received_at: receivedAt,
            time_unix_nano: timeNano,
            severity_number: lr.severityNumber ?? null,
            severity_text: lr.severityText ?? null,
            body: bodyStr,
            trace_id: lr.traceId ?? null,
            span_id: lr.spanId ?? null,
            service_name: serviceName,
            session_id: getFirstAttr(attrs, "session.id", "session_id") ?? null,
            user_id: getAttr(attrs, "user.id") ?? null,
            organization_id: getAttr(attrs, "organization.id") ?? null,
            user_email: getAttr(attrs, "user.email") ?? null,
            user_account_uuid: getAttr(attrs, "user.account_uuid") ?? null,
            user_account_id: getAttr(attrs, "user.account_id") ?? null,
            terminal_type: getAttr(attrs, "terminal.type") ?? null,
            event_name: getAttr(attrs, "event.name") ?? null,
            event_timestamp: getAttr(attrs, "event.timestamp") ?? null,
            event_sequence: getAttrNumber(attrs, "event.sequence"),
            prompt_id: getAttr(attrs, "prompt.id") ?? null,
            prompt: getAttr(attrs, "prompt") ?? null,
            prompt_length: getAttrNumber(attrs, "prompt_length"),
            model: getAttr(attrs, "model") ?? null,
            input_tokens: getAttrNumber(attrs, "input_tokens"),
            output_tokens: getAttrNumber(attrs, "output_tokens"),
            cache_read_tokens: getAttrNumber(attrs, "cache_read_tokens"),
            cache_creation_tokens: getAttrNumber(attrs, "cache_creation_tokens"),
            cost_usd: getAttrNumber(attrs, "cost_usd"),
            duration_ms: getAttrNumber(attrs, "duration_ms"),
            speed: getAttr(attrs, "speed") ?? null,
            extra_attributes_json: extraJson,
          });
        }
      }
    }
  }
  return records;
}

/** Parse body into OTLP traces payloads (array, single object, or NDJSON). */
function parseTracesPayloadsFromBody(body: string): OtlpTracesPayload[] {
  const trimmed = body.trim();
  if (trimmed.length === 0) return [];
  const tryParse = (input: string): unknown => {
    try { return JSON.parse(input); } catch { return null; }
  };
  const parsed = tryParse(trimmed);
  if (parsed && typeof parsed === "object") {
    if (Array.isArray(parsed)) {
      return (parsed as unknown[]).filter(
        (item): item is OtlpTracesPayload =>
          Boolean(item && typeof item === "object" && "resourceSpans" in item),
      );
    }
    if ("resourceSpans" in parsed) return [parsed as OtlpTracesPayload];
  }
  const out: OtlpTracesPayload[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    const maybe = tryParse(line.trim());
    if (maybe && typeof maybe === "object" && "resourceSpans" in maybe) {
      out.push(maybe as OtlpTracesPayload);
    }
  }
  return out;
}

/** Flatten OTLP traces payloads to one row per span. No filtering. */
export function parseToSilverSpans(
  body: string,
  bronzeId: number,
  receivedAt: string,
): SilverSpanRecord[] {
  const payloads = parseTracesPayloadsFromBody(body);
  const records: SilverSpanRecord[] = [];
  for (const payload of payloads) {
    for (const rs of payload.resourceSpans ?? []) {
      const resourceAttrs = rs.resource?.attributes ?? [];
      const serviceName = getAttr(resourceAttrs, "service.name") ?? null;
      for (const ss of rs.scopeSpans ?? []) {
        for (const span of ss.spans ?? []) {
          const knownKeys = new Set(["session.id", "session_id"]);
          const extraAttrs = (span.attributes ?? []).filter((a) => !knownKeys.has(a.key));
          const extraJson = extraAttrs.length > 0
            ? JSON.stringify(extraAttrs.reduce((acc: Record<string, unknown>, a) => {
                if (typeof a.value?.stringValue === "string") acc[a.key] = a.value.stringValue;
                else if (a.value?.intValue !== undefined) acc[a.key] = a.value.intValue;
                else if (typeof a.value?.doubleValue === "number") acc[a.key] = a.value.doubleValue;
                else if (typeof a.value?.boolValue === "boolean") acc[a.key] = a.value.boolValue;
                return acc;
              }, {}))
            : null;
          records.push({
            id: randomUUID(),
            bronze_id: bronzeId,
            received_at: receivedAt,
            trace_id: span.traceId ?? null,
            span_id: span.spanId ?? null,
            parent_span_id: span.parentSpanId ?? null,
            name: span.name ?? null,
            kind: span.kind ?? null,
            start_time_unix_nano: span.startTimeUnixNano ? nanoToNumber(span.startTimeUnixNano) : null,
            end_time_unix_nano: span.endTimeUnixNano ? nanoToNumber(span.endTimeUnixNano) : null,
            status_code: span.status?.code ?? null,
            service_name: serviceName,
            session_id: getFirstAttr(span.attributes ?? [], "session.id", "session_id") ?? null,
            extra_attributes_json: extraJson,
          });
        }
      }
    }
  }
  return records;
}

// parseOtlpPayload previously produced canonical UsageEvent rows directly.
// The current pipeline normalizes into silver_* tables and derives gold from SQL views instead.
