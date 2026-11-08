import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

/**
 * Local trade lifecycle tracked by the daemon for this identity.
 *
 * `orderId` is unique because the daemon belongs to a single wallet/identity;
 * `id` mirrors it so migrations from the browser keep the same key.
 */
export const operations = sqliteTable(
  "operations",
  {
    id: text("id").primaryKey(),
    orderId: text("order_id").notNull().unique(),
    role: text("role").notNull(),
    status: text("status").notNull(),
    counterparty: text("counterparty"),
    tradeSats: integer("trade_sats"),
    fiatAmount: integer("fiat_amount"),
    fiat: text("fiat"),
    refundAddress: text("refund_address"),
    buyerArkAddress: text("buyer_ark_address"),
    makerArkAddress: text("maker_ark_address"),
    maker: integer("maker", { mode: "boolean" }),
    orderType: text("order_type"),
    myRating: integer("my_rating"),
    orderEventId: text("order_event_id"),
    agreementJson: text("agreement_json"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [index("idx_operations_updated").on(table.updatedAt)],
);

/** Trade and chat DMs persisted so history survives relay windows. */
export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    orderId: text("order_id"),
    type: text("type").notNull(),
    peer: text("peer"),
    outgoing: integer("outgoing", { mode: "boolean" }).notNull(),
    createdAt: integer("created_at").notNull(),
    receivedAt: integer("received_at").notNull(),
    payloadJson: text("payload_json"),
  },
  (table) => [index("idx_messages_order").on(table.orderId, table.createdAt)],
);

/** Derived escrow state per order, including the funded VTXO outpoint. */
export const escrows = sqliteTable("escrows", {
  orderId: text("order_id").primaryKey(),
  address: text("address").notNull(),
  onchainAddress: text("onchain_address"),
  buyerPubKey: text("buyer_pub_key").notNull(),
  sellerPubKey: text("seller_pub_key").notNull(),
  arbiterPubKeysJson: text("arbiter_pub_keys_json").notNull(),
  serverPubKey: text("server_pub_key").notNull(),
  escrowVersion: integer("escrow_version").notNull(),
  refundLocktime: text("refund_locktime").notNull(),
  state: text("state").notNull().default("created"),
  vtxoTxid: text("vtxo_txid"),
  vtxoVout: integer("vtxo_vout"),
  fundedSats: integer("funded_sats"),
  agreementJson: text("agreement_json"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

/** Dispute lifecycle per order, linked to its Nostr announcement and take. */
export const disputes = sqliteTable("disputes", {
  orderId: text("order_id").primaryKey(),
  announceEventId: text("announce_event_id"),
  takeEventId: text("take_event_id"),
  resolutionEventId: text("resolution_event_id"),
  status: text("status").notNull(),
  initiator: text("initiator"),
  winner: text("winner"),
  reason: text("reason"),
  resolutionTxid: text("resolution_txid"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

/** Verified kind 38384 ratings, indexed locally for reputation aggregates. */
export const ratings = sqliteTable(
  "ratings",
  {
    eventId: text("event_id").primaryKey(),
    orderId: text("order_id").notNull(),
    author: text("author").notNull(),
    subject: text("subject").notNull(),
    score: integer("score").notNull(),
    community: text("community"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [index("idx_ratings_subject").on(table.subject, table.createdAt)],
);

/** Relay pool configuration and health, so subscriptions survive restarts. */
export const relays = sqliteTable("relays", {
  url: text("url").primaryKey(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  status: text("status").notNull().default("unknown"),
  lastConnectedAt: integer("last_connected_at"),
  lastError: text("last_error"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

/** Persistent outgoing queue with retry scheduling. */
export const outbox = sqliteTable(
  "outbox",
  {
    id: text("id").primaryKey(),
    method: text("method").notNull(),
    paramsJson: text("params_json").notNull(),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: integer("next_attempt_at"),
    lastError: text("last_error"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [index("idx_outbox_status").on(table.status, table.nextAttemptAt)],
);

/** Subscription cursors (last seen created_at/id) for replay after a restart. */
export const cursors = sqliteTable("cursors", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

/** Generic daemon settings (selected community, UI prefs, feature flags). */
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at").notNull(),
});
