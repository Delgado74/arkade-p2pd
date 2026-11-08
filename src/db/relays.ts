import { desc, eq } from "drizzle-orm";
import type { Db } from "./index.js";
import { relays } from "./schema.js";

export type RelayConnectionStatus = "unknown" | "connecting" | "connected" | "error";

/** Relay configuration and last known health, persisted across restarts. */
export interface RelayRecord {
  url: string;
  enabled: boolean;
  status: RelayConnectionStatus;
  lastConnectedAt?: number;
  lastError?: string;
}

type Row = typeof relays.$inferSelect;

function rowToRelay(row: Row): RelayRecord {
  return {
    url: row.url,
    enabled: row.enabled,
    status: row.status as RelayConnectionStatus,
    lastConnectedAt: row.lastConnectedAt ?? undefined,
    lastError: row.lastError ?? undefined,
  };
}

/** Add any configured relay that is not stored yet, leaving existing rows intact. */
export function seedRelays(db: Db, urls: string[]): void {
  const now = Math.floor(Date.now() / 1000);
  for (const url of urls) {
    const value = url.trim();
    if (!value) continue;
    db.insert(relays)
      .values({ url: value, enabled: true, status: "unknown", createdAt: now, updatedAt: now })
      .onConflictDoNothing()
      .run();
  }
}

/** All relays, enabled first and then by URL. */
export function listRelays(db: Db): RelayRecord[] {
  return db
    .select()
    .from(relays)
    .orderBy(desc(relays.enabled), relays.url)
    .all()
    .map(rowToRelay);
}

/** Enabled relay URLs, ready to hand to the pool. */
export function enabledRelayUrls(db: Db): string[] {
  return listRelays(db)
    .filter((relay) => relay.enabled)
    .map((relay) => relay.url);
}

/** Persist the last connection outcome of a relay. */
export function updateRelayStatus(
  db: Db,
  url: string,
  status: RelayConnectionStatus,
  error?: string,
): void {
  const now = Math.floor(Date.now() / 1000);
  db.update(relays)
    .set({
      status,
      lastError: error ?? null,
      lastConnectedAt: status === "connected" ? now : undefined,
      updatedAt: now,
    })
    .where(eq(relays.url, url))
    .run();
}

/** Enable or disable a relay without deleting its history. */
export function setRelayEnabled(db: Db, url: string, enabled: boolean): void {
  const now = Math.floor(Date.now() / 1000);
  db.update(relays).set({ enabled, updatedAt: now }).where(eq(relays.url, url)).run();
}
