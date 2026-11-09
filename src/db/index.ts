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
  const inMemory = path === ":memory:";
  const file = inMemory ? path : resolve(process.cwd(), path);
  if (!inMemory) mkdirSync(dirname(file), { recursive: true });

  const sqlite = new Database(file);
  if (!inMemory) sqlite.pragma("journal_mode = WAL");
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
export {
  listMessages,
  getMessage,
  recordMessage,
  deleteMessage,
  importMessages,
  listOrderMessages,
} from "./messages.js";
export type { StoredMessage, MessageImportResult } from "./messages.js";
export {
  seedRelays,
  listRelays,
  enabledRelayUrls,
  updateRelayStatus,
  setRelayEnabled,
} from "./relays.js";
export type { RelayRecord, RelayConnectionStatus } from "./relays.js";
export {
  enqueueOutbox,
  listDueOutbox,
  markOutboxSent,
  markOutboxFailed,
} from "./outbox.js";
export type { OutboxEntry, OutboxStatus } from "./outbox.js";
export {
  listEscrows,
  getEscrow,
  recordEscrow,
  deleteEscrow,
  importEscrows,
  escrowPatchSchema,
  escrowImportSchema,
} from "./escrows.js";
export type {
  EscrowRecord,
  EscrowState,
  EscrowImportRecord,
  EscrowImportResult,
} from "./escrows.js";
export {
  listDisputes,
  getDispute,
  recordDispute,
  deleteDispute,
  importDisputes,
  disputePatchSchema,
  disputeImportSchema,
} from "./disputes.js";
export type {
  DisputeRecord,
  DisputeState,
  DisputeImportRecord,
  DisputeImportResult,
} from "./disputes.js";
export {
  listRatings,
  getRating,
  recordRating,
  deleteRating,
  importRatings,
  ratingSchema,
} from "./ratings.js";
export type { RatingRecord, RatingImportResult } from "./ratings.js";
export {
  getSetting,
  setSetting,
  listSettings,
  deleteSetting,
} from "./settings.js";
export type { SettingRecord } from "./settings.js";
export {
  getCursor,
  setCursor,
  listCursors,
  deleteCursor,
} from "./cursors.js";
export type { CursorRecord } from "./cursors.js";
