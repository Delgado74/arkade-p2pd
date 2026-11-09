import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "./index.js";
import { settings } from "./schema.js";

const MAX_KEY = 128;
const MAX_VALUE = 64 * 1024;

const keySchema = z.string().min(1).max(MAX_KEY);
const valueSchema = z.string().max(MAX_VALUE);

/** A persisted daemon setting (UI preferences, selected community, flags). */
export interface SettingRecord {
  key: string;
  value: string;
  updatedAt: number;
}

/** One setting value, or `null` when it is not stored. */
export function getSetting(db: Db, key: string): string | null {
  const valid = keySchema.parse(key);
  const row = db.select().from(settings).where(eq(settings.key, valid)).get();
  return row ? row.value : null;
}

/** Insert or replace one setting. */
export function setSetting(db: Db, key: string, value: string): SettingRecord {
  const validKey = keySchema.parse(key);
  const validValue = valueSchema.parse(value);
  const now = Math.floor(Date.now() / 1000);
  db.insert(settings)
    .values({ key: validKey, value: validValue, updatedAt: now })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: validValue, updatedAt: now },
    })
    .run();
  return { key: validKey, value: validValue, updatedAt: now };
}

/** Every setting ordered by key. */
export function listSettings(db: Db): SettingRecord[] {
  return db
    .select()
    .from(settings)
    .orderBy(asc(settings.key))
    .all()
    .map((row) => ({
      key: row.key,
      value: row.value,
      updatedAt: row.updatedAt,
    }));
}

/** Remove one setting. Returns whether a row was deleted. */
export function deleteSetting(db: Db, key: string): boolean {
  const valid = keySchema.parse(key);
  const result = db.delete(settings).where(eq(settings.key, valid)).run();
  return result.changes > 0;
}
