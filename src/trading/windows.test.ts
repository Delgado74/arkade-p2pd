import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { computeWindowState, TRADE_WINDOW_SECONDS, type TradeWindowEntry } from "./windows.js";

function entry(
  type: TradeWindowEntry["type"],
  createdAt: number,
  overrides: Partial<TradeWindowEntry> = {},
): TradeWindowEntry {
  return { type, outgoing: false, createdAt, payload: {}, ...overrides };
}

describe("computeWindowState", () => {
  it("expires the taker window when the maker never gets an address", () => {
    const now = 1000 + TRADE_WINDOW_SECONDS;
    const state = computeWindowState({
      entries: [entry("take", 1000)],
      role: "seller",
      isMaker: true,
      funded: false,
      now,
    });
    assert.equal(state.culprit, "taker");
    assert.equal(state.anyExpired, true);
    assert.equal(state.takeReceivedAt, 1000);
  });

  it("keeps the trade on schedule before the window closes", () => {
    const state = computeWindowState({
      entries: [entry("take", 1000)],
      role: "seller",
      isMaker: true,
      funded: false,
      now: 1000 + TRADE_WINDOW_SECONDS - 1,
    });
    assert.equal(state.culprit, null);
    assert.equal(state.anyExpired, false);
  });

  it("uses the earliest duplicate take so a replay does not reset the window", () => {
    const state = computeWindowState({
      entries: [entry("take", 5000), entry("take", 1000)],
      role: "seller",
      isMaker: true,
      funded: false,
      now: 1000 + TRADE_WINDOW_SECONDS,
    });
    assert.equal(state.takeReceivedAt, 1000);
    assert.equal(state.culprit, "taker");
  });

  it("blames the maker when a seller-maker never publishes the escrow", () => {
    const state = computeWindowState({
      entries: [entry("take", 1000), entry("taker_address", 1000)],
      role: "seller",
      isMaker: true,
      funded: false,
      now: 1000 + TRADE_WINDOW_SECONDS,
    });
    assert.equal(state.culprit, "maker");
  });

  it("blames the seller when the escrow is not funded in time", () => {
    const state = computeWindowState({
      entries: [
        entry("take", 1000),
        entry("taker_address", 1000),
        entry("escrow", 2000),
      ],
      role: "seller",
      isMaker: false,
      funded: false,
      now: 2000 + TRADE_WINDOW_SECONDS,
    });
    assert.equal(state.culprit, "taker");
  });

  it("stops applying windows once the escrow is funded", () => {
    const state = computeWindowState({
      entries: [entry("take", 1000), entry("funded", 1001)],
      role: "seller",
      isMaker: true,
      funded: true,
      now: 1000 + TRADE_WINDOW_SECONDS * 2,
    });
    assert.equal(state.anyExpired, false);
    assert.equal(state.culprit, null);
  });

  it("ignores our own outgoing taker signals", () => {
    const state = computeWindowState({
      entries: [entry("take", 1000, { outgoing: true })],
      role: "seller",
      isMaker: true,
      funded: false,
      now: 1000 + TRADE_WINDOW_SECONDS,
    });
    assert.equal(state.takeReceivedAt, null);
    assert.equal(state.culprit, null);
  });
});
