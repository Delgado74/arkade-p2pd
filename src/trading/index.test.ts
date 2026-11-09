import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { Event } from "nostr-tools";
import { openDb, recordEscrow, recordMessage, recordOperation } from "../db/index.js";
import type { Nostr } from "../nostr/index.js";
import type { Wallet } from "../wallet/index.js";
import { Trading } from "./index.js";

const HEX_A = "a".repeat(64);
const HEX_B = "b".repeat(64);
const HEX_C = "c".repeat(64);
const HEX_D = "d".repeat(64);

const escrow = {
  address: "ark1escrow",
  buyerPubKey: HEX_B,
  sellerPubKey: HEX_A,
  arbiterPubKeys: [HEX_C],
  serverPubKey: HEX_C,
  escrowVersion: 1,
  refundLocktime: "1700000000",
};

function fundedEnvelope(orderId: string): string {
  return JSON.stringify({
    app: "arkade-p2p-trade",
    v: 1,
    type: "funded",
    orderId,
    role: "seller",
    from: HEX_A,
    ts: 100,
    payload: { txid: HEX_D, vout: 0, amount: 1000 },
  });
}

function setup(options: { locked?: boolean; existingFunded?: boolean } = {}) {
  const opened = openDb(":memory:");
  const db = opened.db;
  recordOperation(db, "o1", {
    counterparty: HEX_B,
    role: "seller",
    status: "in-progress",
    maker: false,
  });
  recordEscrow(db, "o1", {
    ...escrow,
    state: "spendable",
    vtxoTxid: HEX_D,
    vtxoVout: 0,
    fundedSats: 1000,
  });
  if (options.existingFunded) {
    recordMessage(db, "m1", {
      type: "dm",
      orderId: "o1",
      outgoing: true,
      createdAt: 100,
      receivedAt: 100,
      payloadJson: JSON.stringify({
        sender: HEX_A,
        recipients: [HEX_B],
        content: fundedEnvelope("o1"),
        createdAt: 100,
      }),
    });
  }

  const published: Event[] = [];
  const wraps: { recipient: string; content: string }[] = [];
  const nostr = {
    publish: async (event: Event) => {
      published.push(event);
    },
  } as unknown as Nostr;
  const wallet = {
    getIdentity: () => {
      if (options.locked) throw new Error("Wallet locked");
      return { pk: HEX_A };
    },
    wrapDm: (recipient: string, content: string) => {
      wraps.push({ recipient, content });
      return [{ id: `w${wraps.length}` } as Event];
    },
  } as unknown as Wallet;

  return { opened, db, nostr, wallet, published, wraps };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("Trading resume", () => {
  it("re-announces funded when the escrow is funded and no message exists", async () => {
    const ctx = setup();
    try {
      const trading = new Trading(ctx.db, ctx.nostr, ctx.wallet);
      trading.tick(200);
      await settle();

      assert.equal(ctx.published.length, 1);
      assert.equal(ctx.wraps[0].recipient, HEX_B);
      const content = JSON.parse(ctx.wraps[0].content);
      assert.equal(content.type, "funded");
      assert.deepEqual(content.payload, { txid: HEX_D, vout: 0, amount: 1000 });
    } finally {
      ctx.opened.close();
    }
  });

  it("does not duplicate an already persisted funded message", async () => {
    const ctx = setup({ existingFunded: true });
    try {
      const trading = new Trading(ctx.db, ctx.nostr, ctx.wallet);
      trading.tick(200);
      await settle();
      assert.equal(ctx.published.length, 0);
    } finally {
      ctx.opened.close();
    }
  });

  it("stays idle while the wallet is locked", async () => {
    const ctx = setup({ locked: true });
    try {
      const trading = new Trading(ctx.db, ctx.nostr, ctx.wallet);
      trading.tick(200);
      await settle();
      assert.equal(ctx.published.length, 0);
    } finally {
      ctx.opened.close();
    }
  });
});
