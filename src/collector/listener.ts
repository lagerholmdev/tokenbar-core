import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { parseOtlpPayload, type OtlpPayload } from "../otlp-parser.js";
import {
  getUsageSummary,
  initializeDatabase,
  insertUsageEvents,
  type UsageEvent,
} from "../schema.js";

interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

const DEFAULT_BODY_LIMIT_BYTES = 5 * 1024 * 1024;

function defaultLogger(): Logger {
  return {
    info: (message: string) => console.log(message),
    warn: (message: string) => console.warn(message),
    error: (message: string) => console.error(message),
  };
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  let total = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const asBuffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += asBuffer.length;
    if (total > maxBytes) {
      throw new Error(`Request body too large (> ${maxBytes} bytes)`);
    }
    chunks.push(asBuffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parsePayloadsFromBody(body: string): OtlpPayload[] {
  const trimmed = body.trim();
  if (trimmed.length === 0) {
    return [];
  }

  const tryParse = (input: string): unknown => {
    try {
      return JSON.parse(input);
    } catch {
      return null;
    }
  };

  const parsed = tryParse(trimmed);
  if (parsed && typeof parsed === "object") {
    if (Array.isArray(parsed)) {
      return parsed.filter((item): item is OtlpPayload => {
        return Boolean(item && typeof item === "object" && "resourceMetrics" in item);
      });
    }
    if ("resourceMetrics" in parsed) {
      return [parsed as OtlpPayload];
    }
  }

  const payloads: OtlpPayload[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    const maybePayload = tryParse(line.trim());
    if (maybePayload && typeof maybePayload === "object" && "resourceMetrics" in maybePayload) {
      payloads.push(maybePayload as OtlpPayload);
    }
  }
  return payloads;
}

export interface CollectorListenerOptions {
  dbPath?: string;
  host?: string;
  port?: number;
  bodyLimitBytes?: number;
  logger?: Logger;
}

export interface CollectorListenerHandle {
  url: string;
  close(): Promise<void>;
}

function payloadsToEvents(payloads: OtlpPayload[]): UsageEvent[] {
  return payloads.flatMap((payload) => parseOtlpPayload(payload));
}

export async function startCollectorListener(
  options: CollectorListenerOptions = {},
): Promise<CollectorListenerHandle> {
  const db = initializeDatabase(options.dbPath ?? ".tokenbar.sqlite");
  const logger = options.logger ?? defaultLogger();
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 4318;
  const bodyLimitBytes = options.bodyLimitBytes ?? DEFAULT_BODY_LIMIT_BYTES;

  const server = createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/health") {
        sendJson(res, 200, {
          status: "ok",
          ...getUsageSummary(db),
        });
        return;
      }

      if (req.method === "POST" && req.url === "/v1/metrics") {
        const body = await readBody(req, bodyLimitBytes);
        const payloads = parsePayloadsFromBody(body);
        const events = payloadsToEvents(payloads);
        insertUsageEvents(db, events);

        logger.info(`[collector] ingested payloads=${payloads.length} events=${events.length}`);
        sendJson(res, 202, {
          accepted: payloads.length,
          inserted: events.length,
          ...getUsageSummary(db),
        });
        return;
      }

      sendJson(res, 404, { error: "not_found" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown ingestion error";
      logger.error(`[collector] ${message}`);
      sendJson(res, 400, { error: "bad_request", message });
    }
  });

  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(port, host, () => resolvePromise());
  });

  const serverAddress = server.address();
  if (!serverAddress || typeof serverAddress === "string") {
    throw new Error("Unable to determine listener address");
  }

  const address = serverAddress as AddressInfo;
  const url = `http://${host}:${address.port}`;
  logger.info(`[collector] listening on ${url}`);

  return {
    url,
    close: async () => {
      await new Promise<void>((resolvePromise, rejectPromise) => {
        server.close((err) => (err ? rejectPromise(err) : resolvePromise()));
      });
      db.close();
    },
  };
}
