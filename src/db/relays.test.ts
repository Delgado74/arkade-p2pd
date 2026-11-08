import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { openDb } from "./index.js";
import {
  enabledRelayUrls,
  listRelays,
  seedRelays,
  setRelayEnabled,
  updateRelayStatus,
} from "./relays.js";

function withDb<T>(run: (db: ReturnType<typeof openDb>["db"]) => T): T {
  const opened = openDb(":memory:");
  try {
    return run(opened.db);
  } finally {
    opened.close();
  }
}

describe("relays repository", () => {
  it("seeds relays idempotently", () => {
    withDb((db) => {
      seedRelays(db, ["wss://a", "wss://b", "wss://a", " "]);
      seedRelays(db, ["wss://b", "wss://c"]);
      assert.deepEqual(
        listRelays(db).map((relay) => relay.url),
        ["wss://a", "wss://b", "wss://c"],
      );
    });
  });

  it("tracks health and enabled state", () => {
    withDb((db) => {
      seedRelays(db, ["wss://a", "wss://b"]);
      updateRelayStatus(db, "wss://a", "connected");
      updateRelayStatus(db, "wss://b", "error", "boom");
      const relays = listRelays(db);
      const a = relays.find((relay) => relay.url === "wss://a");
      const b = relays.find((relay) => relay.url === "wss://b");
      assert.equal(a?.status, "connected");
      assert.ok(a?.lastConnectedAt);
      assert.equal(b?.status, "error");
      assert.equal(b?.lastError, "boom");

      setRelayEnabled(db, "wss://b", false);
      assert.deepEqual(enabledRelayUrls(db), ["wss://a"]);
    });
  });
});
