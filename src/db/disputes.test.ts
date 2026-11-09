import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { openDb } from "./index.js";
import {
  deleteDispute,
  getDispute,
  importDisputes,
  listDisputes,
  recordDispute,
} from "./disputes.js";

const HEX = "a".repeat(64);
const HEX_B = "b".repeat(64);

function withDb<T>(run: (db: ReturnType<typeof openDb>["db"]) => T): T {
  const opened = openDb(":memory:");
  try {
    return run(opened.db);
  } finally {
    opened.close();
  }
}

describe("disputes repository", () => {
  it("records a dispute with its default state", () => {
    withDb((db) => {
      const created = recordDispute(db, "o1", {
        announceEventId: HEX,
        initiator: HEX,
        reason: "fiat not received",
      });
      assert.equal(created.status, "initiated");
      assert.equal(getDispute(db, "o1")?.reason, "fiat not received");
      assert.equal(listDisputes(db).length, 1);
    });
  });

  it("merges lifecycle updates", () => {
    withDb((db) => {
      recordDispute(db, "o1", { announceEventId: HEX });
      recordDispute(db, "o1", {
        status: "settled",
        takeEventId: HEX_B,
        winner: HEX_B,
        resolutionTxid: HEX,
      });
      const stored = getDispute(db, "o1");
      assert.equal(stored?.status, "settled");
      assert.equal(stored?.announceEventId, HEX);
      assert.equal(stored?.winner, HEX_B);
    });
  });

  it("rejects malformed event ids", () => {
    withDb((db) => {
      assert.throws(() => recordDispute(db, "o1", { announceEventId: "nope" }));
    });
  });

  it("imports idempotently and deletes", () => {
    withDb((db) => {
      recordDispute(db, "o1", { announceEventId: HEX });
      const result = importDisputes(db, [
        { orderId: "o1", status: "resolved", createdAt: 1, updatedAt: 1 },
        { orderId: "o2", status: "open", createdAt: 2, updatedAt: 2 },
      ]);
      assert.deepEqual(result, { imported: 1, skipped: 1 });
      assert.equal(getDispute(db, "o1")?.status, "initiated");
      assert.equal(deleteDispute(db, "o2"), true);
      assert.equal(getDispute(db, "o2"), null);
    });
  });
});
