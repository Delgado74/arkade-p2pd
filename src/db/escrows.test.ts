import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { openDb } from "./index.js";
import {
  deleteEscrow,
  getEscrow,
  importEscrows,
  listEscrows,
  recordEscrow,
} from "./escrows.js";

const HEX = "a".repeat(64);
const HEX_B = "b".repeat(64);
const HEX_C = "c".repeat(64);

function withDb<T>(run: (db: ReturnType<typeof openDb>["db"]) => T): T {
  const opened = openDb(":memory:");
  try {
    return run(opened.db);
  } finally {
    opened.close();
  }
}

const base = {
  address: "ark1qescrow",
  buyerPubKey: HEX,
  sellerPubKey: HEX_B,
  arbiterPubKeys: [HEX_C],
  serverPubKey: HEX_C,
  escrowVersion: 1,
  refundLocktime: "1700000000",
};

describe("escrows repository", () => {
  it("creates an escrow and reads it back", () => {
    withDb((db) => {
      const created = recordEscrow(db, "o1", base);
      assert.equal(created.state, "created");
      const stored = getEscrow(db, "o1");
      assert.equal(stored?.address, "ark1qescrow");
      assert.deepEqual(stored?.arbiterPubKeys, [HEX_C]);
      assert.equal(listEscrows(db).length, 1);
    });
  });

  it("requires the full agreement when creating", () => {
    withDb((db) => {
      assert.throws(() => recordEscrow(db, "o1", { state: "pending" }), /address required/);
      assert.throws(
        () => recordEscrow(db, "o1", { ...base, arbiterPubKeys: [] }),
        /arbiterPubKeys/,
      );
    });
  });

  it("merges later state updates without dropping the agreement", () => {
    withDb((db) => {
      recordEscrow(db, "o1", base);
      recordEscrow(db, "o1", {
        state: "spendable",
        vtxoTxid: HEX,
        vtxoVout: 0,
        fundedSats: 10_000,
      });
      const stored = getEscrow(db, "o1");
      assert.equal(stored?.state, "spendable");
      assert.equal(stored?.fundedSats, 10_000);
      assert.equal(stored?.buyerPubKey, HEX);
    });
  });

  it("imports idempotently and keeps existing rows", () => {
    withDb((db) => {
      recordEscrow(db, "o1", base);
      const result = importEscrows(db, [
        { orderId: "o1", ...base, state: "swept", createdAt: 1, updatedAt: 1 },
        { orderId: "o2", ...base, state: "created", createdAt: 2, updatedAt: 2 },
      ]);
      assert.deepEqual(result, { imported: 1, skipped: 1 });
      assert.equal(getEscrow(db, "o1")?.state, "created");
      assert.equal(getEscrow(db, "o2")?.orderId, "o2");
    });
  });

  it("deletes an escrow", () => {
    withDb((db) => {
      recordEscrow(db, "o1", base);
      assert.equal(deleteEscrow(db, "o1"), true);
      assert.equal(deleteEscrow(db, "o1"), false);
      assert.equal(getEscrow(db, "o1"), null);
    });
  });
});
