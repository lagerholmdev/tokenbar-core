import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  parseToSilverLogs,
  parseToSilverMetrics,
  parseToSilverSpans,
} from "../otlp-parser.js";
import {
  getEventCount,
  getUsageSummary,
  initializeDatabase,
  insertBronzeRawPayload,
  insertRows,
} from "../schema.js";

const DEFAULT_BODY_LIMIT_BYTES = 5 * 1024 * 1024;

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

export interface CollectorListenerOptions {
  dbPath?: string;
  host?: string;
  port?: number;
  bodyLimitBytes?: number;
}

export interface CollectorListenerHandle {
  url: string;
  close(): Promise<void>;
}

export async function startCollectorListener(
  options: CollectorListenerOptions = {},
): Promise<CollectorListenerHandle> {
  const db = initializeDatabase(options.dbPath ?? ".tokenbar.sqlite");
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 4318;
  const bodyLimitBytes = options.bodyLimitBytes ?? DEFAULT_BODY_LIMIT_BYTES;

  const server = createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/health") {
        sendJson(res, 200, { status: "ok", ...getUsageSummary(db) });
        return;
      }

      if (req.method === "POST" && req.url === "/v1/metrics") {
        const body = await readBody(req, bodyLimitBytes);
        const receivedAt = new Date().toISOString();
        const bronzeId = insertBronzeRawPayload(db, "metrics", body);
        const silverPoints = parseToSilverMetrics(body, bronzeId, receivedAt);
        insertRows(db, "silver_metric_points", silverPoints);
        const goldCount = getEventCount(db);

        console.log(`[collector] bronze=${bronzeId} silver=${silverPoints.length} gold=${goldCount}`);
        sendJson(res, 202, {
          accepted: true,
          inserted: goldCount,
          ...getUsageSummary(db),
        });
        return;
      }

      if (req.method === "POST" && req.url === "/v1/logs") {
        const body = await readBody(req, bodyLimitBytes);
        const receivedAt = new Date().toISOString();
        const bronzeId = insertBronzeRawPayload(db, "logs", body);
        const silverLogs = parseToSilverLogs(body, bronzeId, receivedAt);
        insertRows(db, "silver_log_records", silverLogs);
        console.log(`[collector] logs bronze=${bronzeId} silver=${silverLogs.length}`);
        sendJson(res, 202, { accepted: true });
        return;
      }

      if (req.method === "POST" && req.url === "/v1/traces") {
        const body = await readBody(req, bodyLimitBytes);
        const receivedAt = new Date().toISOString();
        const bronzeId = insertBronzeRawPayload(db, "traces", body);
        const silverSpans = parseToSilverSpans(body, bronzeId, receivedAt);
        insertRows(db, "silver_span_records", silverSpans);
        console.log(`[collector] traces bronze=${bronzeId} silver=${silverSpans.length}`);
        sendJson(res, 202, { accepted: true });
        return;
      }

      sendJson(res, 404, { error: "not_found" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown ingestion error";
      console.error(`[collector] ${message}`);
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
  console.log(`[collector] listening on ${url}`);

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
