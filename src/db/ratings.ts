import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "./index.js";
import { ratings } from "./schema.js";

/** A verified kind 38384 rating, indexed for reputation aggregates. */
export interface RatingRecord {
  eventId: string;
  orderId: string;
  author: string;
  subject: string;
  score: number;
  community?: string;
  createdAt: number;
}

export interface RatingImportResult {
  imported: number;
  skipped: number;
}

const MAX_TEXT = 256;
const hex64 = z.string().regex(/^[0-9a-f]{64}$/i);

/** Validated rating accepted by `ratings.upsert` and `ratings.import`. */
export const ratingSchema = z
  .object({
    eventId: hex64,
    orderId: z.string().min(1).max(MAX_TEXT),
    author: hex64,
    subject: hex64,
    score: z.number().int().min(1).max(5),
    community: z.string().min(1).max(MAX_TEXT).optional(),
    createdAt: z.number().int().min(0),
  })
  .strict();

type Row = typeof ratings.$inferSelect;

function rowToRecord(row: Row): RatingRecord {
  return {
    eventId: row.eventId,
    orderId: row.orderId,
    author: row.author,
    subject: row.subject,
    score: row.score,
    community: row.community ?? undefined,
    createdAt: row.createdAt,
  };
}

function recordToValues(record: RatingRecord) {
  return {
    eventId: record.eventId,
    orderId: record.orderId,
    author: record.author,
    subject: record.subject,
    score: record.score,
    community: record.community ?? null,
    createdAt: record.createdAt,
  };
}

/**
 * Insert or replace a rating by event id.
 *
 * Ratings are immutable events, so an upsert with the same id is a no-op in
 * practice; replacing keeps a corrected import from being ignored.
 */
export function recordRating(db: Db, input: RatingRecord): RatingRecord {
  const record = ratingSchema.parse(input);
  const values = recordToValues(record);
  db.insert(ratings)
    .values(values)
    .onConflictDoUpdate({
      target: ratings.eventId,
      set: {
        orderId: values.orderId,
        author: values.author,
        subject: values.subject,
        score: values.score,
        community: values.community,
        createdAt: values.createdAt,
      },
    })
    .run();
  return record;
}

/** One rating by event id, or `null` when it is not indexed. */
export function getRating(db: Db, eventId: string): RatingRecord | null {
  const row = db.select().from(ratings).where(eq(ratings.eventId, eventId)).get();
  return row ? rowToRecord(row) : null;
}

/** Ratings newest first, optionally scoped to a subject or an order. */
export function listRatings(
  db: Db,
  options: { subject?: string; orderId?: string; limit?: number } = {},
): RatingRecord[] {
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 500), 1), 2000);
  if (options.subject) {
    return db
      .select()
      .from(ratings)
      .where(eq(ratings.subject, options.subject))
      .orderBy(desc(ratings.createdAt))
      .limit(limit)
      .all()
      .map(rowToRecord);
  }
  if (options.orderId) {
    return db
      .select()
      .from(ratings)
      .where(eq(ratings.orderId, options.orderId))
      .orderBy(desc(ratings.createdAt))
      .limit(limit)
      .all()
      .map(rowToRecord);
  }
  return db
    .select()
    .from(ratings)
    .orderBy(desc(ratings.createdAt))
    .limit(limit)
    .all()
    .map(rowToRecord);
}

/** Remove one rating. Returns whether a row was deleted. */
export function deleteRating(db: Db, eventId: string): boolean {
  const result = db.delete(ratings).where(eq(ratings.eventId, eventId)).run();
  return result.changes > 0;
}

/** Import a batch of ratings. Existing rows win, so retries are idempotent. */
export function importRatings(
  db: Db,
  records: RatingRecord[],
): RatingImportResult {
  let imported = 0;
  let skipped = 0;
  for (const record of records) {
    if (getRating(db, record.eventId)) {
      skipped += 1;
      continue;
    }
    db.insert(ratings).values(recordToValues(record)).onConflictDoNothing().run();
    imported += 1;
  }
  return { imported, skipped };
}
