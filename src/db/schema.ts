import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const operations = sqliteTable("operations", {
  id: text("id").primaryKey(),
  orderId: text("order_id").notNull(),
  role: text("role").notNull(),
  status: text("status").notNull(),
  counterparty: text("counterparty"),
  tradeSats: integer("trade_sats"),
  fiatAmount: integer("fiat_amount"),
  fiat: text("fiat"),
  agreementJson: text("agreement_json"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});
