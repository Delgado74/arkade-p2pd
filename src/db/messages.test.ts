import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { openDb } from "./index.js";
import {
  deleteMessage,
  getMessage,
  importMessages,
  listMessages,
  listOrderMessages,
  recordMessage,
} from "./messages.js";

function withDb<T>(run: (db: ReturnType<typeof openDb>["db"]) => T): T {
  const opened = openDb(":memory:");
  try {
    return run(opened.db);
  } finally {
    opened.close();
  }
}

describe("messages repository", () => {
  it("records and reads a message", () => {
    withDb((db) => {
      recordMessage(db, "m1", {
        orderId: "o1",
        type: "chat",
        peer: "p".repeat(64),
        outgoing: true,
        createdAt: 10,
        receivedAt: 11,
        payloadJson: '{"text":"hola"}',
      });
      const stored = getMessage(db, "m1");
      assert.equal(stored?.orderId, "o1");
      assert.equal(stored?.outgoing, true);
      assert.equal(listMessages(db).length, 1);
    });
  });

  it("merges a patch into an existing message", () => {
    withDb((db) => {
      recordMessage(db, "m1", { type: "chat", outgoing: false, createdAt: 10, receivedAt: 10 });
      recordMessage(db, "m1", { orderId: "o1", payloadJson: '{"text":"later"}' });
      const stored = getMessage(db, "m1");
      assert.equal(stored?.orderId, "o1");
      assert.equal(stored?.type, "chat");
      assert.equal(stored?.payloadJson, '{"text":"later"}');
    });
  });

  it("imports idempotently and keeps existing rows", () => {
    withDb((db) => {
      recordMessage(db, "m1", { type: "chat", outgoing: true, createdAt: 10, receivedAt: 10 });
      const result = importMessages(db, [
        { id: "m1", type: "ignored", outgoing: false, createdAt: 99, receivedAt: 99 },
        { id: "m2", type: "take", orderId: "o1", outgoing: false, createdAt: 5, receivedAt: 6 },
      ]);
      assert.deepEqual(result, { imported: 1, skipped: 1 });
      assert.equal(getMessage(db, "m1")?.type, "chat");
      assert.equal(getMessage(db, "m2")?.orderId, "o1");
    });
  });

  it("lists one order oldest first and filters by limit", () => {
    withDb((db) => {
      recordMessage(db, "a", { orderId: "o1", type: "chat", outgoing: true, createdAt: 2, receivedAt: 2 });
      recordMessage(db, "b", { orderId: "o1", type: "chat", outgoing: true, createdAt: 1, receivedAt: 1 });
      recordMessage(db, "c", { orderId: "o2", type: "chat", outgoing: true, createdAt: 3, receivedAt: 3 });
      assert.deepEqual(
        listOrderMessages(db, "o1").map((m) => m.id),
        ["b", "a"],
      );
      assert.equal(listMessages(db, { limit: 1 }).length, 1);
      assert.equal(listMessages(db, { orderId: "o2" })[0].id, "c");
    });
  });

  it("deletes a message", () => {
    withDb((db) => {
      recordMessage(db, "m1", { type: "chat", outgoing: true, createdAt: 1, receivedAt: 1 });
      assert.equal(deleteMessage(db, "m1"), true);
      assert.equal(deleteMessage(db, "m1"), false);
      assert.equal(getMessage(db, "m1"), null);
    });
  });
});
