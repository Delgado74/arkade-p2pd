import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "./index.js";
import { escrows } from "./schema.js";

export type EscrowState =
  | "created"
  | "pending"
  | "spendable"
  | "recoverable"
  | "swept"
  | "released"
  | "refunded";

/** Derived escrow state for one order, owned by the daemon. */
export interface EscrowRecord {
  orderId: string;
  address: string;
  onchainAddress?: string;
  buyerPubKey: string;
  sellerPubKey: string;
  arbiterPubKeys: string[];
  serverPubKey: string;
  escrowVersion: number;
  refundLocktime: string;
  state: EscrowState;
  vtxoTxid?: string;
  vtxoVout?: number;
  fundedSats?: number;
  agreementJson?: string;
  createdAt: number;
  updatedAt: number;
}

export interface EscrowImportResult {
  imported: number;
  skipped: number;
}

/** A full escrow as sent by a client; state and timestamps get safe defaults. */
export interface EscrowImportRecord extends Omit<EscrowRecord, "state" | "createdAt" | "updatedAt"> {
  state?: EscrowState;
  createdAt?: number;
  updatedAt?: number;
}

const MAX_TEXT = 512;
const MAX_PAYLOAD = 256 * 1024;
const MAX_SATS = 21_000_000_00000000;

const hex64 = z.string().regex(/^[0-9a-f]{64}$/i);
const absoluteLocktime = z.string().regex(/^\d+$/);
const escrowStateSchema = z.enum([
  "created",
  "pending",
  "spendable",
  "recoverable",
  "swept",
  "released",
  "refunded",
]);

const escrowOptionalFields = {
  onchainAddress: z.string().min(1).max(MAX_TEXT).optional(),
  state: escrowStateSchema.optional(),
  vtxoTxid: hex64.optional(),
  vtxoVout: z.number().int().min(0).max(0xffffffff).optional(),
  fundedSats: z.number().int().min(0).max(MAX_SATS).optional(),
  agreementJson: z.string().max(MAX_PAYLOAD).optional(),
  createdAt: z.number().int().min(0).optional(),
  updatedAt: z.number().int().min(0).optional(),
};

/** Validated partial record accepted by `escrows.upsert`. */
export const escrowPatchSchema = z
  .object({
    address: z.string().min(1).max(MAX_TEXT).optional(),
    buyerPubKey: hex64.optional(),
    sellerPubKey: hex64.optional(),
    arbiterPubKeys: z.array(hex64).min(1).max(32).optional(),
    serverPubKey: hex64.optional(),
    escrowVersion: z.number().int().min(1).max(1000).optional(),
    refundLocktime: absoluteLocktime.optional(),
    ...escrowOptionalFields,
  })
  .strict();

/** Validated full record accepted by `escrows.import`. */
export const escrowImportSchema = z
  .object({
    orderId: z.string().min(1).max(256),
    address: z.string().min(1).max(MAX_TEXT),
    buyerPubKey: hex64,
    sellerPubKey: hex64,
    arbiterPubKeys: z.array(hex64).min(1).max(32),
    serverPubKey: hex64,
    escrowVersion: z.number().int().min(1).max(1000),
    refundLocktime: absoluteLocktime,
    ...escrowOptionalFields,
  })
  .strict();

type Row = typeof escrows.$inferSelect;

function rowToRecord(row: Row): EscrowRecord {
  let arbiters: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.arbiterPubKeysJson);
    if (Array.isArray(parsed)) {
      arbiters = parsed.filter((value): value is string => typeof value === "string");
    }
  } catch {
    arbiters = [];
  }
  return {
    orderId: row.orderId,
    address: row.address,
    onchainAddress: row.onchainAddress ?? undefined,
    buyerPubKey: row.buyerPubKey,
    sellerPubKey: row.sellerPubKey,
    arbiterPubKeys: arbiters,
    serverPubKey: row.serverPubKey,
    escrowVersion: row.escrowVersion,
    refundLocktime: row.refundLocktime,
    state: row.state as EscrowState,
    vtxoTxid: row.vtxoTxid ?? undefined,
    vtxoVout: row.vtxoVout ?? undefined,
    fundedSats: row.fundedSats ?? undefined,
    agreementJson: row.agreementJson ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function recordToValues(record: EscrowRecord) {
  return {
    orderId: record.orderId,
    address: record.address,
    onchainAddress: record.onchainAddress ?? null,
    buyerPubKey: record.buyerPubKey,
    sellerPubKey: record.sellerPubKey,
    arbiterPubKeysJson: JSON.stringify(record.arbiterPubKeys),
    serverPubKey: record.serverPubKey,
    escrowVersion: record.escrowVersion,
    refundLocktime: record.refundLocktime,
    state: record.state,
    vtxoTxid: record.vtxoTxid ?? null,
    vtxoVout: record.vtxoVout ?? null,
    fundedSats: record.fundedSats ?? null,
    agreementJson: record.agreementJson ?? null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/** Every tracked escrow, newest update first. */
export function listEscrows(db: Db, limit = 500): EscrowRecord[] {
  const max = Math.min(Math.max(Math.trunc(limit), 1), 2000);
  return db
    .select()
    .from(escrows)
    .orderBy(desc(escrows.updatedAt))
    .limit(max)
    .all()
    .map(rowToRecord);
}

/** One escrow by order id, or `null` when it is not tracked. */
export function getEscrow(db: Db, orderId: string): EscrowRecord | null {
  const row = db.select().from(escrows).where(eq(escrows.orderId, orderId)).get();
  return row ? rowToRecord(row) : null;
}

/**
 * Merge `patch` into an escrow (creating it when new) and persist it.
 *
 * A new escrow must carry the full agreement: address, both parties, solver
 * set, ASP key, escrow version and absolute locktime. Later updates only need
 * the fields that changed (state, VTXO outpoint, funded amount).
 */
export function recordEscrow(
  db: Db,
  orderId: string,
  input: z.infer<typeof escrowPatchSchema>,
): EscrowRecord {
  const patch = escrowPatchSchema.parse(input);
  const existing = getEscrow(db, orderId);
  const now = Math.floor(Date.now() / 1000);
  const merged: EscrowRecord = {
    orderId,
    address: patch.address ?? existing?.address ?? "",
    onchainAddress: patch.onchainAddress ?? existing?.onchainAddress,
    buyerPubKey: patch.buyerPubKey ?? existing?.buyerPubKey ?? "",
    sellerPubKey: patch.sellerPubKey ?? existing?.sellerPubKey ?? "",
    arbiterPubKeys: patch.arbiterPubKeys ?? existing?.arbiterPubKeys ?? [],
    serverPubKey: patch.serverPubKey ?? existing?.serverPubKey ?? "",
    escrowVersion: patch.escrowVersion ?? existing?.escrowVersion ?? 0,
    refundLocktime: patch.refundLocktime ?? existing?.refundLocktime ?? "",
    state: patch.state ?? existing?.state ?? "created",
    vtxoTxid: patch.vtxoTxid ?? existing?.vtxoTxid,
    vtxoVout: patch.vtxoVout ?? existing?.vtxoVout,
    fundedSats: patch.fundedSats ?? existing?.fundedSats,
    agreementJson: patch.agreementJson ?? existing?.agreementJson,
    createdAt: existing?.createdAt ?? patch.createdAt ?? now,
    updatedAt: patch.updatedAt ?? now,
  };

  if (!existing) {
    if (!merged.address) throw new Error("address required for a new escrow");
    if (!merged.buyerPubKey || !merged.sellerPubKey) {
      throw new Error("buyerPubKey and sellerPubKey required for a new escrow");
    }
    if (merged.arbiterPubKeys.length === 0) {
      throw new Error("arbiterPubKeys required for a new escrow");
    }
    if (!merged.serverPubKey) throw new Error("serverPubKey required for a new escrow");
    if (!merged.escrowVersion) throw new Error("escrowVersion required for a new escrow");
    if (!merged.refundLocktime) throw new Error("refundLocktime required for a new escrow");
  }

  put(db, merged);
  return merged;
}

function put(db: Db, record: EscrowRecord): void {
  const values = recordToValues(record);
  db.insert(escrows)
    .values(values)
    .onConflictDoUpdate({
      target: escrows.orderId,
      set: {
        address: values.address,
        onchainAddress: values.onchainAddress,
        buyerPubKey: values.buyerPubKey,
        sellerPubKey: values.sellerPubKey,
        arbiterPubKeysJson: values.arbiterPubKeysJson,
        serverPubKey: values.serverPubKey,
        escrowVersion: values.escrowVersion,
        refundLocktime: values.refundLocktime,
        state: values.state,
        vtxoTxid: values.vtxoTxid,
        vtxoVout: values.vtxoVout,
        fundedSats: values.fundedSats,
        agreementJson: values.agreementJson,
        updatedAt: values.updatedAt,
      },
    })
    .run();
}

/** Remove one escrow. Returns whether a row was deleted. */
export function deleteEscrow(db: Db, orderId: string): boolean {
  const result = db.delete(escrows).where(eq(escrows.orderId, orderId)).run();
  return result.changes > 0;
}

/** Import a batch of escrows. Existing rows win, so retries are idempotent. */
export function importEscrows(
  db: Db,
  records: EscrowImportRecord[],
): EscrowImportResult {
  let imported = 0;
  let skipped = 0;
  const now = Math.floor(Date.now() / 1000);
  for (const record of records) {
    if (getEscrow(db, record.orderId)) {
      skipped += 1;
      continue;
    }
    put(db, {
      ...record,
      state: record.state ?? "created",
      createdAt: record.createdAt ?? now,
      updatedAt: record.updatedAt ?? record.createdAt ?? now,
    });
    imported += 1;
  }
  return { imported, skipped };
}
