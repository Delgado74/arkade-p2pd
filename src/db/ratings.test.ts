import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { openDb } from "./index.js";
import {
  deleteRating,
  getRating,
  importRatings,
  listRatings,
  recordRating,
} from "./ratings.js";

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

const rating = {
  eventId: HEX,
  orderId: "o1",
  author: HEX_B,
  subject: HEX_C,
  score: 5,
  createdAt: 100,
};

describe("ratings repository", () => {
  it("records and lists ratings by subject", () => {
    withDb((db) => {
      recordRating(db, rating);
      recordRating(db, { ...rating, eventId: HEX_B, subject: HEX_B, score: 3, createdAt: 101 });
      assert.equal(getRating(db, HEX)?.score, 5);
      assert.equal(listRatings(db).length, 2);
      assert.deepEqual(
        listRatings(db, { subject: HEX_C }).map((entry) => entry.eventId),
        [HEX],
      );
    });
  });

  it("rejects an out-of-range score", () => {
    withDb((db) => {
      assert.throws(() => recordRating(db, { ...rating, score: 6 }));
    });
  });

  it("imports idempotently and deletes", () => {
    withDb((db) => {
      recordRating(db, rating);
      const result = importRatings(db, [
        { ...rating, score: 1 },
        { ...rating, eventId: HEX_C, orderId: "o2" },
      ]);
      assert.deepEqual(result, { imported: 1, skipped: 1 });
      assert.equal(getRating(db, HEX)?.score, 5);
      assert.equal(deleteRating(db, HEX_C), true);
      assert.equal(getRating(db, HEX_C), null);
    });
  });
});
