import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import * as schema from "./schema.js";
import { migrate } from "./migrations.js";

export type Db = BetterSQLite3Database<typeof schema>;

export interface OpenedDb {
  db: Db;
  sqlite: Database.Database;
  /** Absolute path of the SQLite file, for logs that must not leak secrets. */
  path: string;
  close: () => void;
}

/**
 * Open (creating if needed) the daemon database and apply pending migrations.
 *
 * Relative paths resolve against the process working directory so `npm start`
 * and `npm run dev` use the same file.
 */
export function openDb(path = "./data/daemon.db"): OpenedDb {
  const file = resolve(process.cwd(), path);
  mkdirSync(dirname(file), { recursive: true });

  const sqlite = new Database(file);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");

  migrate(sqlite);
  const db = drizzle(sqlite, { schema });

  return {
    db,
    sqlite,
    path: file,
    close: () => sqlite.close(),
  };
}

export { schema };
export { SCHEMA_VERSION } from "./migrations.js";
export { listOperations, getOperation, recordOperation, deleteOperation, importOperations } from "./operations.js";
export type { OperationRecord, OperationPatch, OperationImportResult } from "./operations.js";
