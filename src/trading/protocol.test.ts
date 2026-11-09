import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { decodeTradeEnvelope, TRADE_APP, TRADE_VERSION } from "./protocol.js";

const HEX = "a".repeat(64);

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    app: TRADE_APP,
    v: TRADE_VERSION,
    type: "chat",
    orderId: "o1",
    role: "buyer",
    from: HEX,
    ts: 100,
    payload: { text: "hola" },
    ...overrides,
  };
}

describe("decodeTradeEnvelope", () => {
  it("accepts a valid envelope", () => {
    const decoded = decodeTradeEnvelope(JSON.stringify(envelope()));
    assert.equal(decoded?.type, "chat");
    assert.equal(decoded?.orderId, "o1");
    assert.deepEqual(decoded?.payload, { text: "hola" });
  });

  it("rejects a wrong app, version, type or author", () => {
    assert.equal(decodeTradeEnvelope(JSON.stringify(envelope({ app: "other" }))), null);
    assert.equal(decodeTradeEnvelope(JSON.stringify(envelope({ v: 2 }))), null);
    assert.equal(decodeTradeEnvelope(JSON.stringify(envelope({ type: "unknown" }))), null);
    assert.equal(decodeTradeEnvelope(JSON.stringify(envelope({ from: "nope" }))), null);
  });

  it("rejects malformed JSON and non-object payloads", () => {
    assert.equal(decodeTradeEnvelope("{"), null);
    assert.equal(decodeTradeEnvelope(JSON.stringify(envelope({ payload: "text" }))), null);
  });
});
