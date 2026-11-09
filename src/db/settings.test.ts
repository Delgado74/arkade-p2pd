import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { openDb } from "./index.js";
import { deleteSetting, getSetting, listSettings, setSetting } from "./settings.js";

function withDb<T>(run: (db: ReturnType<typeof openDb>["db"]) => T): T {
  const opened = openDb(":memory:");
  try {
    return run(opened.db);
  } finally {
    opened.close();
  }
}

describe("settings repository", () => {
  it("sets and reads a value", () => {
    withDb((db) => {
      assert.equal(getSetting(db, "community"), null);
      setSetting(db, "community", "cuba");
      assert.equal(getSetting(db, "community"), "cuba");
    });
  });

  it("replaces an existing value", () => {
    withDb((db) => {
      setSetting(db, "readMarks", '{"a":1}');
      setSetting(db, "readMarks", '{"a":2}');
      assert.equal(getSetting(db, "readMarks"), '{"a":2}');
      assert.equal(listSettings(db).length, 1);
    });
  });

  it("lists ordered and deletes", () => {
    withDb((db) => {
      setSetting(db, "b", "2");
      setSetting(db, "a", "1");
      assert.deepEqual(
        listSettings(db).map((entry) => entry.key),
        ["a", "b"],
      );
      assert.equal(deleteSetting(db, "a"), true);
      assert.equal(deleteSetting(db, "a"), false);
    });
  });

  it("rejects empty keys", () => {
    withDb((db) => {
      assert.throws(() => setSetting(db, "", "value"));
    });
  });
});
