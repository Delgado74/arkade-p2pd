import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "./index.js";
import { messages } from "./schema.js";

/** A trade or chat message persisted so history survives relay windows. */
export interface StoredMessage {
  id: string;
  orderId?: string;
  type: string;
  peer?: string;
  outgoing: boolean;
  createdAt: number;
  receivedAt: number;
  payloadJson?: string;
}

export interface MessageImportResult {
  imported: number;
  skipped: number;
}

const MAX_TEXT = 256;
const MAX_PAYLOAD = 256 * 1024;

const messageFields = {
  orderId: z.string().max(MAX_TEXT).optional(),
  type: z.string().min(1).max(64),
  peer: z.string().max(MAX_TEXT).optional(),
  outgoing: z.boolean(),
  createdAt: z.number().int().min(0),
  receivedAt: z.number().int().min(0),
  payloadJson: z.string().max(MAX_PAYLOAD).optional(),
};

/** Validated partial record accepted by `messages.upsert`. */
export const messagePatchSchema = z
  .object({
    orderId: messageFields.orderId,
    type: messageFields.type.optional(),
    peer: messageFields.peer,
    outgoing: messageFields.outgoing.optional(),
    createdAt: messageFields.createdAt.optional(),
    receivedAt: messageFields.receivedAt.optional(),
    payloadJson: messageFields.payloadJson,
  })
  .strict();

/** Validated full record accepted by `messages.import`. */
export const messageImportSchema = z
  .object({
    id: z.string().min(1).max(MAX_TEXT),
    ...messageFields,
  })
  .strict();

type Row = typeof messages.$inferSelect;

function rowToMessage(row: Row): StoredMessage {
  return {
    id: row.id,
    orderId: row.orderId ?? undefined,
    type: row.type,
    peer: row.peer ?? undefined,
    outgoing: row.outgoing,
    createdAt: row.createdAt,
    receivedAt: row.receivedAt,
    payloadJson: row.payloadJson ?? undefined,
  };
}

function messageToValues(message: StoredMessage) {
  return {
    id: message.id,
    orderId: message.orderId ?? null,
    type: message.type,
    peer: message.peer ?? null,
    outgoing: message.outgoing,
    createdAt: message.createdAt,
    receivedAt: message.receivedAt,
    payloadJson: message.payloadJson ?? null,
  };
}

/** Messages newest first, optionally scoped to one order. */
export function listMessages(
  db: Db,
  options: { orderId?: string; limit?: number } = {},
): StoredMessage[] {
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 500), 1), 2000);
  const query = db.select().from(messages);
  const rows = options.orderId
    ? query.where(eq(messages.orderId, options.orderId)).orderBy(desc(messages.createdAt)).limit(limit).all()
    : query.orderBy(desc(messages.createdAt)).limit(limit).all();
  return rows.map(rowToMessage);
}

/** One message by id, or `null` when it is not stored. */
export function getMessage(db: Db, id: string): StoredMessage | null {
  const row = db.select().from(messages).where(eq(messages.id, id)).get();
  return row ? rowToMessage(row) : null;
}

/**
 * Insert a message, merging `patch` into an existing row when it is already
 * stored. Message ids are stable (gift-wrap/rumor ids), so retries are safe.
 */
export function recordMessage(db: Db, id: string, patch: z.infer<typeof messagePatchSchema>): StoredMessage {
  const existing = getMessage(db, id);
  const now = Math.floor(Date.now() / 1000);
  const merged: StoredMessage = {
    id,
    orderId: patch.orderId ?? existing?.orderId,
    type: patch.type ?? existing?.type ?? "unknown",
    peer: patch.peer ?? existing?.peer,
    outgoing: patch.outgoing ?? existing?.outgoing ?? false,
    createdAt: patch.createdAt ?? existing?.createdAt ?? now,
    receivedAt: patch.receivedAt ?? existing?.receivedAt ?? now,
    payloadJson: patch.payloadJson ?? existing?.payloadJson,
  };
  const values = messageToValues(merged);
  db.insert(messages)
    .values(values)
    .onConflictDoUpdate({
      target: messages.id,
      set: {
        orderId: values.orderId,
        type: values.type,
        peer: values.peer,
        outgoing: values.outgoing,
        createdAt: values.createdAt,
        receivedAt: values.receivedAt,
        payloadJson: values.payloadJson,
      },
    })
    .run();
  return merged;
}

/** Delete one message. Returns whether a row was removed. */
export function deleteMessage(db: Db, id: string): boolean {
  const result = db.delete(messages).where(eq(messages.id, id)).run();
  return result.changes > 0;
}

/** Import a batch of messages. Existing rows win, so retries are idempotent. */
export function importMessages(db: Db, records: StoredMessage[]): MessageImportResult {
  let imported = 0;
  let skipped = 0;
  for (const record of records) {
    if (getMessage(db, record.id)) {
      skipped += 1;
      continue;
    }
    db.insert(messages).values(messageToValues(record)).onConflictDoNothing().run();
    imported += 1;
  }
  return { imported, skipped };
}

/** Every message of an order, oldest first (for rebuilding a chat). */
export function listOrderMessages(db: Db, orderId: string): StoredMessage[] {
  return db
    .select()
    .from(messages)
    .where(eq(messages.orderId, orderId))
    .orderBy(messages.createdAt)
    .all()
    .map(rowToMessage);
}
