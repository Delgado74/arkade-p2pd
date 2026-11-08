import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { openDb } from "./index.js";
import { enqueueOutbox, listDueOutbox, markOutboxFailed, markOutboxSent } from "./outbox.js";

function withDb<T>(run: (db: ReturnType<typeof openDb>["db"]) => T): T {
  const opened = openDb(":memory:");
  try {
    return run(opened.db);
  } finally {
    opened.close();
  }
}

describe("outbox repository", () => {
  it("enqueues idempotently and lists due entries", () => {
    withDb((db) => {
      const now = Math.floor(Date.now() / 1000);
      enqueueOutbox(db, "nostr.publish", '{"id":"e1"}', "e1");
      enqueueOutbox(db, "nostr.publish", '{"id":"e1"}', "e1");
      enqueueOutbox(db, "nostr.publish", '{"id":"e2"}', "e2");
      assert.deepEqual(
        listDueOutbox(db, now).map((entry) => entry.id),
        ["e1", "e2"],
      );
    });
  });

  it("does not return sent or not-yet-due entries", () => {
    withDb((db) => {
      const now = Math.floor(Date.now() / 1000);
      enqueueOutbox(db, "nostr.publish", "{}", "e1");
      enqueueOutbox(db, "nostr.publish", "{}", "e2");
      markOutboxSent(db, "e1");
      markOutboxFailed(db, "e2", "timeout", now + 60, 1);
      assert.deepEqual(listDueOutbox(db, now), []);
      assert.deepEqual(
        listDueOutbox(db, now + 60).map((entry) => entry.id),
        ["e2"],
      );
    });
  });
});
