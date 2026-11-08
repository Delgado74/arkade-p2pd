import type Database from "better-sqlite3";

type Sqlite = Database.Database;

interface Migration {
  version: number;
  name: string;
  statements: string[];
}

/**
 * Append-only list of schema migrations.
 *
 * Never edit a released migration: add a new version instead. Each migration
 * runs inside a transaction and is recorded in `schema_migrations`, so opening
 * the database repeatedly is idempotent.
 */
const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "initial schema",
    statements: [
      `CREATE TABLE IF NOT EXISTS operations (
        id TEXT PRIMARY KEY NOT NULL,
        order_id TEXT NOT NULL UNIQUE,
        role TEXT NOT NULL,
        status TEXT NOT NULL,
        counterparty TEXT,
        trade_sats INTEGER,
        fiat_amount INTEGER,
        fiat TEXT,
        refund_address TEXT,
        buyer_ark_address TEXT,
        maker_ark_address TEXT,
        maker INTEGER,
        order_type TEXT,
        my_rating INTEGER,
        order_event_id TEXT,
        agreement_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_operations_updated ON operations (updated_at)`,
      `CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY NOT NULL,
        order_id TEXT,
        type TEXT NOT NULL,
        peer TEXT,
        outgoing INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        received_at INTEGER NOT NULL,
        payload_json TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS idx_messages_order ON messages (order_id, created_at)`,
      `CREATE TABLE IF NOT EXISTS escrows (
        order_id TEXT PRIMARY KEY NOT NULL,
        address TEXT NOT NULL,
        onchain_address TEXT,
        buyer_pub_key TEXT NOT NULL,
        seller_pub_key TEXT NOT NULL,
        arbiter_pub_keys_json TEXT NOT NULL,
        server_pub_key TEXT NOT NULL,
        escrow_version INTEGER NOT NULL,
        refund_locktime TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'created',
        vtxo_txid TEXT,
        vtxo_vout INTEGER,
        funded_sats INTEGER,
        agreement_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS disputes (
        order_id TEXT PRIMARY KEY NOT NULL,
        announce_event_id TEXT,
        take_event_id TEXT,
        resolution_event_id TEXT,
        status TEXT NOT NULL,
        initiator TEXT,
        winner TEXT,
        reason TEXT,
        resolution_txid TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS ratings (
        event_id TEXT PRIMARY KEY NOT NULL,
        order_id TEXT NOT NULL,
        author TEXT NOT NULL,
        subject TEXT NOT NULL,
        score INTEGER NOT NULL,
        community TEXT,
        created_at INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_ratings_subject ON ratings (subject, created_at)`,
      `CREATE TABLE IF NOT EXISTS relays (
        url TEXT PRIMARY KEY NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'unknown',
        last_connected_at INTEGER,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS outbox (
        id TEXT PRIMARY KEY NOT NULL,
        method TEXT NOT NULL,
        params_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox (status, next_attempt_at)`,
      `CREATE TABLE IF NOT EXISTS cursors (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
    ],
  },
];

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;

/** Apply every pending migration, in order, and return the new schema version. */
export function migrate(sqlite: Sqlite): number {
  sqlite.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    )`,
  );

  const applied = new Set<number>(
    sqlite
      .prepare("SELECT version FROM schema_migrations")
      .all()
      .map((row) => Number((row as { version: number }).version)),
  );

  const record = sqlite.prepare(
    "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
  );

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    const apply = sqlite.transaction(() => {
      for (const statement of migration.statements) sqlite.exec(statement);
      record.run(migration.version, migration.name, Math.floor(Date.now() / 1000));
    });
    apply();
  }

  return SCHEMA_VERSION;
}
