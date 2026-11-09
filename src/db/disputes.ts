import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "./index.js";
import { disputes } from "./schema.js";

export type DisputeState =
  | "initiated"
  | "in-progress"
  | "settled"
  | "refunded"
  | "canceled"
  | "open"
  | "taken"
  | "resolved";

/** Dispute lifecycle for one order, owned by the daemon. */
export interface DisputeRecord {
  orderId: string;
  announceEventId?: string;
  takeEventId?: string;
  resolutionEventId?: string;
  status: DisputeState;
  initiator?: string;
  winner?: string;
  reason?: string;
  resolutionTxid?: string;
  createdAt: number;
  updatedAt: number;
}

export interface DisputeImportResult {
  imported: number;
  skipped: number;
}

/** A full dispute as sent by a client; timestamps get safe defaults. */
export interface DisputeImportRecord extends Omit<DisputeRecord, "createdAt" | "updatedAt"> {
  createdAt?: number;
  updatedAt?: number;
}

const MAX_TEXT = 512;
const hex64 = z.string().regex(/^[0-9a-f]{64}$/i);
const disputeStateSchema = z.enum([
  "initiated",
  "in-progress",
  "settled",
  "refunded",
  "canceled",
  "open",
  "taken",
  "resolved",
]);

const optionalEventId = hex64.optional();
const optionalText = z.string().min(1).max(MAX_TEXT).optional();

const disputeFields = {
  announceEventId: optionalEventId,
  takeEventId: optionalEventId,
  resolutionEventId: optionalEventId,
  status: disputeStateSchema.optional(),
  initiator: hex64.optional(),
  winner: hex64.optional(),
  reason: optionalText,
  resolutionTxid: optionalText,
  createdAt: z.number().int().min(0).optional(),
  updatedAt: z.number().int().min(0).optional(),
};

/** Validated partial record accepted by `disputes.upsert`. */
export const disputePatchSchema = z.object(disputeFields).strict();

/** Validated full record accepted by `disputes.import`. */
export const disputeImportSchema = z
  .object({
    ...disputeFields,
    orderId: z.string().min(1).max(256),
    status: disputeStateSchema,
  })
  .strict();

type Row = typeof disputes.$inferSelect;

function rowToRecord(row: Row): DisputeRecord {
  return {
    orderId: row.orderId,
    announceEventId: row.announceEventId ?? undefined,
    takeEventId: row.takeEventId ?? undefined,
    resolutionEventId: row.resolutionEventId ?? undefined,
    status: row.status as DisputeState,
    initiator: row.initiator ?? undefined,
    winner: row.winner ?? undefined,
    reason: row.reason ?? undefined,
    resolutionTxid: row.resolutionTxid ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function recordToValues(record: DisputeRecord) {
  return {
    orderId: record.orderId,
    announceEventId: record.announceEventId ?? null,
    takeEventId: record.takeEventId ?? null,
    resolutionEventId: record.resolutionEventId ?? null,
    status: record.status,
    initiator: record.initiator ?? null,
    winner: record.winner ?? null,
    reason: record.reason ?? null,
    resolutionTxid: record.resolutionTxid ?? null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/** Every tracked dispute, newest update first. */
export function listDisputes(db: Db, limit = 500): DisputeRecord[] {
  const max = Math.min(Math.max(Math.trunc(limit), 1), 2000);
  return db
    .select()
    .from(disputes)
    .orderBy(desc(disputes.updatedAt))
    .limit(max)
    .all()
    .map(rowToRecord);
}

/** One dispute by order id, or `null` when it is not tracked. */
export function getDispute(db: Db, orderId: string): DisputeRecord | null {
  const row = db.select().from(disputes).where(eq(disputes.orderId, orderId)).get();
  return row ? rowToRecord(row) : null;
}

/** Merge `patch` into a dispute (creating it when new) and persist it. */
export function recordDispute(
  db: Db,
  orderId: string,
  input: z.infer<typeof disputePatchSchema>,
): DisputeRecord {
  const patch = disputePatchSchema.parse(input);
  const existing = getDispute(db, orderId);
  const now = Math.floor(Date.now() / 1000);
  const merged: DisputeRecord = {
    orderId,
    announceEventId: patch.announceEventId ?? existing?.announceEventId,
    takeEventId: patch.takeEventId ?? existing?.takeEventId,
    resolutionEventId: patch.resolutionEventId ?? existing?.resolutionEventId,
    status: patch.status ?? existing?.status ?? "initiated",
    initiator: patch.initiator ?? existing?.initiator,
    winner: patch.winner ?? existing?.winner,
    reason: patch.reason ?? existing?.reason,
    resolutionTxid: patch.resolutionTxid ?? existing?.resolutionTxid,
    createdAt: existing?.createdAt ?? patch.createdAt ?? now,
    updatedAt: patch.updatedAt ?? now,
  };
  put(db, merged);
  return merged;
}

function put(db: Db, record: DisputeRecord): void {
  const values = recordToValues(record);
  db.insert(disputes)
    .values(values)
    .onConflictDoUpdate({
      target: disputes.orderId,
      set: {
        announceEventId: values.announceEventId,
        takeEventId: values.takeEventId,
        resolutionEventId: values.resolutionEventId,
        status: values.status,
        initiator: values.initiator,
        winner: values.winner,
        reason: values.reason,
        resolutionTxid: values.resolutionTxid,
        updatedAt: values.updatedAt,
      },
    })
    .run();
}

/** Remove one dispute. Returns whether a row was deleted. */
export function deleteDispute(db: Db, orderId: string): boolean {
  const result = db.delete(disputes).where(eq(disputes.orderId, orderId)).run();
  return result.changes > 0;
}

/** Import a batch of disputes. Existing rows win, so retries are idempotent. */
export function importDisputes(
  db: Db,
  records: DisputeImportRecord[],
): DisputeImportResult {
  let imported = 0;
  let skipped = 0;
  const now = Math.floor(Date.now() / 1000);
  for (const record of records) {
    if (getDispute(db, record.orderId)) {
      skipped += 1;
      continue;
    }
    put(db, {
      ...record,
      createdAt: record.createdAt ?? now,
      updatedAt: record.updatedAt ?? record.createdAt ?? now,
    });
    imported += 1;
  }
  return { imported, skipped };
}
