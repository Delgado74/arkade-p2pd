import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { backoffDelay } from "./relayPool.js";

describe("backoffDelay", () => {
  it("grows exponentially up to the cap", () => {
    assert.equal(backoffDelay(0, 1000, 60_000, () => 1), 1000);
    assert.equal(backoffDelay(1, 1000, 60_000, () => 1), 2000);
    assert.equal(backoffDelay(10, 1000, 60_000, () => 1), 60_000);
    assert.equal(backoffDelay(50, 1000, 60_000, () => 1), 60_000);
  });

  it("applies 50%-100% jitter", () => {
    assert.equal(backoffDelay(3, 1000, 60_000, () => 0), 4000);
    assert.equal(backoffDelay(3, 1000, 60_000, () => 1), 8000);
  });

  it("never exceeds the configured maximum", () => {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      assert.ok(backoffDelay(attempt, 1000, 5000) <= 5000);
    }
  });
});
