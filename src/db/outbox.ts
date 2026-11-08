import { and, asc, eq, isNull, lte, or } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { Db } from "./index.js";
import { outbox } from "./schema.js";

export type OutboxStatus = "pending" | "sent" | "failed";

/** A persistent outgoing operation waiting to be delivered or retried. */
export interface OutboxEntry {
  id: string;
  method: string;
  paramsJson: string;
  status: OutboxStatus;
  attempts: number;
  nextAttemptAt?: number;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
}

type Row = typeof outbox.$inferSelect;

function rowToEntry(row: Row): OutboxEntry {
  return {
    id: row.id,
    method: row.method,
    paramsJson: row.paramsJson,
    status: row.status as OutboxStatus,
    attempts: row.attempts,
    nextAttemptAt: row.nextAttemptAt ?? undefined,
    lastError: row.lastError ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Queue an outgoing operation. Passing a stable id (the signed event id, for
 * instance) makes retries idempotent.
 */
export function enqueueOutbox(
  db: Db,
  method: string,
  paramsJson: string,
  id: string = nanoid(),
): string {
  const now = Math.floor(Date.now() / 1000);
  db.insert(outbox)
    .values({
      id,
      method,
      paramsJson,
      status: "pending",
      attempts: 0,
      nextAttemptAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .run();
  return id;
}

/** Pending entries whose retry time has arrived, oldest first. */
export function listDueOutbox(db: Db, now = Math.floor(Date.now() / 1000), limit = 50): OutboxEntry[] {
  const max = Math.min(Math.max(Math.trunc(limit), 1), 500);
  return db
    .select()
    .from(outbox)
    .where(
      and(
        eq(outbox.status, "pending"),
        or(isNull(outbox.nextAttemptAt), lte(outbox.nextAttemptAt, now)),
      ),
    )
    .orderBy(asc(outbox.nextAttemptAt), asc(outbox.createdAt), asc(outbox.id))
    .limit(max)
    .all()
    .map(rowToEntry);
}

/** Mark an entry as delivered. */
export function markOutboxSent(db: Db, id: string): void {
  const now = Math.floor(Date.now() / 1000);
  db.update(outbox)
    .set({ status: "sent", lastError: null, nextAttemptAt: null, updatedAt: now })
    .where(eq(outbox.id, id))
    .run();
}

/** Record a failed attempt and schedule the next one. */
export function markOutboxFailed(
  db: Db,
  id: string,
  error: string,
  nextAttemptAt: number,
  attempts: number,
): void {
  const now = Math.floor(Date.now() / 1000);
  db.update(outbox)
    .set({ attempts, lastError: error.slice(0, 512), nextAttemptAt, updatedAt: now })
    .where(eq(outbox.id, id))
    .run();
}
