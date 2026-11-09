import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { openDb } from "./index.js";
import { deleteCursor, getCursor, listCursors, setCursor } from "./cursors.js";

function withDb<T>(run: (db: ReturnType<typeof openDb>["db"]) => T): T {
  const opened = openDb(":memory:");
  try {
    return run(opened.db);
  } finally {
    opened.close();
  }
}

describe("cursors repository", () => {
  it("sets and reads a cursor", () => {
    withDb((db) => {
      assert.equal(getCursor(db, "dm"), null);
      setCursor(db, "dm", "1700000000:abc");
      assert.equal(getCursor(db, "dm"), "1700000000:abc");
    });
  });

  it("replaces and lists cursors", () => {
    withDb((db) => {
      setCursor(db, "orders", "10");
      setCursor(db, "dm", "20");
      setCursor(db, "orders", "30");
      assert.equal(getCursor(db, "orders"), "30");
      assert.deepEqual(
        listCursors(db).map((entry) => entry.key),
        ["dm", "orders"],
      );
    });
  });

  it("deletes a cursor", () => {
    withDb((db) => {
      setCursor(db, "dm", "20");
      assert.equal(deleteCursor(db, "dm"), true);
      assert.equal(deleteCursor(db, "dm"), false);
    });
  });
});
