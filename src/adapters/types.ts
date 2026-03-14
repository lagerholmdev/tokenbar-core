import type { UsageEvent } from "../schema.js";

export type AdapterConfidence = "exact" | "derived" | "estimated";
export type AdapterHealthStatus = "healthy" | "degraded" | "unavailable";

export interface AdapterHealth {
  status: AdapterHealthStatus;
  details: string;
  last_sync_at: string | null;
}

export interface UsageAdapter {
  id: string;
  name: string;
  confidence: AdapterConfidence;
  detect(): Promise<boolean>;
  sync(since?: Date): Promise<UsageEvent[]>;
  health(): Promise<AdapterHealth>;
}
