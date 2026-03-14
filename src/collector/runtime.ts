import type Database from "better-sqlite3";
import { insertUsageEvents } from "../schema.js";
import type { UsageAdapter } from "../adapters/types.js";

export interface SyncResult {
  adapter_id: string;
  inserted: number;
}

export async function syncAdapterIntoDatabase(
  db: Database.Database,
  adapter: UsageAdapter,
  since?: Date,
): Promise<SyncResult> {
  const events = await adapter.sync(since);
  insertUsageEvents(db, events);
  return {
    adapter_id: adapter.id,
    inserted: events.length,
  };
}
