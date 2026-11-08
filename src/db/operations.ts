import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "./index.js";
import { operations } from "./schema.js";

export type OperationStatus =
  | "in-progress"
  | "completed"
  | "canceled"
  | "arbiter-release"
  | "arbiter-refund";

export type TradeRole = "buyer" | "seller";

/** A trade the local identity has participated in, owned by the daemon. */
export interface OperationRecord {
  orderId: string;
  counterparty: string;
  role: TradeRole;
  status: OperationStatus;
  fiat?: string;
  fiatAmount?: number;
  tradeSats?: number;
  createdAt: number;
  updatedAt: number;
  refundAddress?: string;
  buyerArkAddress?: string;
  makerArkAddress?: string;
  maker?: boolean;
  orderType?: "buy" | "sell";
  myRating?: number;
  orderEventId?: string;
}

/** A partial update merged into an existing operation (or a new one). */
export type OperationPatch = Partial<Omit<OperationRecord, "orderId" | "createdAt" | "updatedAt">> & {
  createdAt?: number;
  updatedAt?: number;
};

export interface OperationImportResult {
  imported: number;
  skipped: number;
}

const MAX_ID = 256;
const MAX_TEXT = 256;
const MAX_SATS = 21_000_000_00000000;

const roleSchema = z.enum(["buyer", "seller"]);
const statusSchema = z.enum([
  "in-progress",
  "completed",
  "canceled",
  "arbiter-release",
  "arbiter-refund",
]);

const optionalText = z.string().max(MAX_TEXT).optional();
const optionalSats = z.number().int().min(0).max(MAX_SATS).optional();

const operationFields = {
  counterparty: z.string().max(MAX_TEXT).optional(),
  role: roleSchema.optional(),
  status: statusSchema.optional(),
  fiat: z.string().max(16).optional(),
  fiatAmount: z.number().finite().min(0).optional(),
  tradeSats: optionalSats,
  refundAddress: optionalText,
  buyerArkAddress: optionalText,
  makerArkAddress: optionalText,
  maker: z.boolean().optional(),
  orderType: z.enum(["buy", "sell"]).optional(),
  myRating: z.number().int().min(1).max(5).optional(),
  orderEventId: optionalText,
};

/** Validated partial update accepted by `operations.upsert`. */
export const operationPatchSchema = z.object(operationFields).strict();

/** Validated full record accepted by `operations.import`. */
export const operationImportSchema = z
  .object({
    orderId: z.string().min(1).max(MAX_ID),
    counterparty: z.string().max(MAX_TEXT).default(""),
    role: roleSchema.default("buyer"),
    status: statusSchema.default("in-progress"),
    fiat: z.string().max(16).optional(),
    fiatAmount: z.number().finite().min(0).optional(),
    tradeSats: optionalSats,
    refundAddress: optionalText,
    buyerArkAddress: optionalText,
    makerArkAddress: optionalText,
    maker: z.boolean().optional(),
    orderType: z.enum(["buy", "sell"]).optional(),
    myRating: z.number().int().min(1).max(5).optional(),
    orderEventId: optionalText,
    createdAt: z.number().int().min(0).optional(),
    updatedAt: z.number().int().min(0).optional(),
  })
  .strict();

type Row = typeof operations.$inferSelect;

function rowToRecord(row: Row): OperationRecord {
  return {
    orderId: row.orderId,
    counterparty: row.counterparty ?? "",
    role: row.role === "seller" ? "seller" : "buyer",
    status: row.status as OperationStatus,
    fiat: row.fiat ?? undefined,
    fiatAmount: row.fiatAmount ?? undefined,
    tradeSats: row.tradeSats ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    refundAddress: row.refundAddress ?? undefined,
    buyerArkAddress: row.buyerArkAddress ?? undefined,
    makerArkAddress: row.makerArkAddress ?? undefined,
    maker: row.maker ?? undefined,
    orderType: row.orderType === "buy" || row.orderType === "sell" ? row.orderType : undefined,
    myRating: row.myRating ?? undefined,
    orderEventId: row.orderEventId ?? undefined,
  };
}

function recordToValues(record: OperationRecord) {
  return {
    id: record.orderId,
    orderId: record.orderId,
    role: record.role,
    status: record.status,
    counterparty: record.counterparty || null,
    tradeSats: record.tradeSats ?? null,
    fiatAmount: record.fiatAmount ?? null,
    fiat: record.fiat ?? null,
    refundAddress: record.refundAddress ?? null,
    buyerArkAddress: record.buyerArkAddress ?? null,
    makerArkAddress: record.makerArkAddress ?? null,
    maker: record.maker ?? null,
    orderType: record.orderType ?? null,
    myRating: record.myRating ?? null,
    orderEventId: record.orderEventId ?? null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/** Every tracked operation, newest update first. */
export function listOperations(db: Db, limit = 500): OperationRecord[] {
  const max = Math.min(Math.max(Math.trunc(limit), 1), 2000);
  return db
    .select()
    .from(operations)
    .orderBy(desc(operations.updatedAt))
    .limit(max)
    .all()
    .map(rowToRecord);
}

/** One operation by order id, or `null` when it is not tracked. */
export function getOperation(db: Db, orderId: string): OperationRecord | null {
  const row = db.select().from(operations).where(eq(operations.orderId, orderId)).get();
  return row ? rowToRecord(row) : null;
}

/**
 * Merge `patch` into an operation (creating it when new) and persist it.
 *
 * This mirrors the browser's `recordOperation` so the migration is lossless:
 * untouched fields keep their previous value and `updatedAt` advances unless
 * the caller sets it explicitly (used by imports).
 */
export function recordOperation(
  db: Db,
  orderId: string,
  patch: OperationPatch,
): OperationRecord {
  const existing = getOperation(db, orderId);
  const now = Math.floor(Date.now() / 1000);
  const merged: OperationRecord = {
    orderId,
    role: patch.role ?? existing?.role ?? "buyer",
    counterparty: patch.counterparty ?? existing?.counterparty ?? "",
    status: patch.status ?? existing?.status ?? "in-progress",
    fiat: patch.fiat ?? existing?.fiat,
    fiatAmount: patch.fiatAmount ?? existing?.fiatAmount,
    tradeSats: patch.tradeSats ?? existing?.tradeSats,
    createdAt: existing?.createdAt ?? patch.createdAt ?? now,
    updatedAt: patch.updatedAt ?? now,
    refundAddress: patch.refundAddress ?? existing?.refundAddress,
    buyerArkAddress: patch.buyerArkAddress ?? existing?.buyerArkAddress,
    makerArkAddress: patch.makerArkAddress ?? existing?.makerArkAddress,
    maker: patch.maker ?? existing?.maker,
    orderType: patch.orderType ?? existing?.orderType,
    myRating: patch.myRating ?? existing?.myRating,
    orderEventId: patch.orderEventId ?? existing?.orderEventId,
  };

  put(db, merged);
  return merged;
}

function put(db: Db, record: OperationRecord): void {
  const values = recordToValues(record);
  db.insert(operations)
    .values(values)
    .onConflictDoUpdate({
      target: operations.orderId,
      set: {
        role: values.role,
        status: values.status,
        counterparty: values.counterparty,
        tradeSats: values.tradeSats,
        fiatAmount: values.fiatAmount,
        fiat: values.fiat,
        refundAddress: values.refundAddress,
        buyerArkAddress: values.buyerArkAddress,
        makerArkAddress: values.makerArkAddress,
        maker: values.maker,
        orderType: values.orderType,
        myRating: values.myRating,
        orderEventId: values.orderEventId,
        updatedAt: values.updatedAt,
      },
    })
    .run();
}

/** Remove one operation. Returns whether a row was deleted. */
export function deleteOperation(db: Db, orderId: string): boolean {
  const result = db.delete(operations).where(eq(operations.orderId, orderId)).run();
  return result.changes > 0;
}

/**
 * Import a batch of browser operations. Existing rows win, so retries and
 * re-runs of the migration never overwrite newer daemon state.
 */
export function importOperations(
  db: Db,
  records: OperationRecord[],
): OperationImportResult {
  let imported = 0;
  let skipped = 0;
  for (const record of records) {
    if (getOperation(db, record.orderId)) {
      skipped += 1;
      continue;
    }
    put(db, record);
    imported += 1;
  }
  return { imported, skipped };
}
