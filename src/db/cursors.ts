import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "./index.js";
import { cursors } from "./schema.js";

const MAX_KEY = 128;
const MAX_VALUE = 1024;

const keySchema = z.string().min(1).max(MAX_KEY);
const valueSchema = z.string().max(MAX_VALUE);

/** Last-seen cursor for one subscription feed (created_at/id pair, etc.). */
export interface CursorRecord {
  key: string;
  value: string;
  updatedAt: number;
}

/** One cursor value, or `null` when the feed has not been read yet. */
export function getCursor(db: Db, key: string): string | null {
  const valid = keySchema.parse(key);
  const row = db.select().from(cursors).where(eq(cursors.key, valid)).get();
  return row ? row.value : null;
}

/** Insert or replace one cursor. */
export function setCursor(db: Db, key: string, value: string): CursorRecord {
  const validKey = keySchema.parse(key);
  const validValue = valueSchema.parse(value);
  const now = Math.floor(Date.now() / 1000);
  db.insert(cursors)
    .values({ key: validKey, value: validValue, updatedAt: now })
    .onConflictDoUpdate({
      target: cursors.key,
      set: { value: validValue, updatedAt: now },
    })
    .run();
  return { key: validKey, value: validValue, updatedAt: now };
}

/** Every cursor ordered by key. */
export function listCursors(db: Db): CursorRecord[] {
  return db
    .select()
    .from(cursors)
    .orderBy(asc(cursors.key))
    .all()
    .map((row) => ({
      key: row.key,
      value: row.value,
      updatedAt: row.updatedAt,
    }));
}

/** Remove one cursor. Returns whether a row was deleted. */
export function deleteCursor(db: Db, key: string): boolean {
  const valid = keySchema.parse(key);
  const result = db.delete(cursors).where(eq(cursors.key, valid)).run();
  return result.changes > 0;
}
