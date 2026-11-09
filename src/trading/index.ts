import type { Db } from "../db/index.js";
import {
  getEscrow,
  listMessages,
  listOperations,
  recordMessage,
  type OperationRecord,
} from "../db/index.js";
import type { Nostr } from "../nostr/index.js";
import type { Wallet } from "../wallet/index.js";
import { decodeTradeEnvelope, TRADE_APP, TRADE_VERSION, type TradeEnvelope } from "./protocol.js";
import {
  computeWindowState,
  type TradeWindowEntry,
  type WindowCulprit,
} from "./windows.js";

/** Computed lifecycle state of one active trade, owned by the daemon. */
export interface TradeStatus {
  orderId: string;
  role: "buyer" | "seller";
  maker?: boolean;
  funded: boolean;
  anyExpired: boolean;
  culprit: WindowCulprit;
  takeReceivedAt: number | null;
  takerAddressAt: number | null;
  escrowPublishedAt: number | null;
}

const DEFAULT_INTERVAL_MS = 30_000;
const MAX_MESSAGES = 5000;

function decodeMessagePayload(payloadJson: string | undefined): TradeEnvelope | null {
  if (!payloadJson) return null;
  try {
    const parsed: unknown = JSON.parse(payloadJson);
    if (typeof parsed !== "object" || parsed === null) return null;
    const content = (parsed as Record<string, unknown>).content;
    return typeof content === "string" ? decodeTradeEnvelope(content) : null;
  } catch {
    return null;
  }
}

/**
 * Daemon-side trade monitor.
 *
 * The browser still drives the UI, but the daemon now owns the timers: it
 * recomputes the 15-minute windows from persisted messages so a stalled trade
 * is detected even with every tab closed. Sending reminders and executing the
 * state machine is the next step; this service is the foundation and the
 * single source of truth for `trading.status`.
 */
export class Trading {
  private timer: NodeJS.Timeout | null = null;
  private statuses = new Map<string, TradeStatus>();
  private loggedExpired = new Set<string>();
  private sending = false;

  constructor(
    private db?: Db,
    private nostr?: Nostr,
    private wallet?: Wallet,
    private intervalMs = DEFAULT_INTERVAL_MS,
  ) {}

  async start(): Promise<void> {
    if (!this.db) {
      console.log("[trading] database unavailable; monitor disabled");
      return;
    }
    this.tick();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    console.log(`[trading] monitor ready (every ${Math.round(this.intervalMs / 1000)}s)`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Latest computed status of every active trade. */
  status(): TradeStatus[] {
    return [...this.statuses.values()].sort((a, b) => a.orderId.localeCompare(b.orderId));
  }

  /** Recompute windows from the database. Exposed for tests and manual ticks. */
  tick(now = Math.floor(Date.now() / 1000)): TradeStatus[] {
    if (!this.db) return [];
    const operations = listOperations(this.db, 2000).filter(
      (operation) => operation.status === "in-progress",
    );
    const entriesByOrder = this.entriesByOrder();
    const next = new Map<string, TradeStatus>();

    for (const operation of operations) {
      const entries = entriesByOrder.get(operation.orderId) ?? [];
      const funded = entries.some((entry) => entry.type === "funded");
      const window = computeWindowState({
        entries,
        role: operation.role,
        isMaker: operation.maker === true,
        funded,
        now,
      });
      const status: TradeStatus = {
        orderId: operation.orderId,
        role: operation.role,
        maker: operation.maker,
        funded: window.funded,
        anyExpired: window.anyExpired,
        culprit: window.culprit,
        takeReceivedAt: window.takeReceivedAt,
        takerAddressAt: window.takerAddressAt,
        escrowPublishedAt: window.escrowPublishedAt,
      };
      next.set(operation.orderId, status);
      this.logTransition(status);
    }

    // Drop orders that finished or disappeared from the active set.
    for (const orderId of Array.from(this.loggedExpired)) {
      if (!next.has(orderId)) this.loggedExpired.delete(orderId);
    }
    this.statuses = next;
    void this.resume(operations, entriesByOrder, now);
    return this.status();
  }

  /**
   * Resume the one daemon-owned step that needs no new signatures: when this
   * identity is the seller and the escrow is funded but no `funded` message is
   * persisted, re-announce it to the buyer. This makes a reload or a closed
   * browser recover the trade without the UI.
   */
  private async resume(
    operations: OperationRecord[],
    entriesByOrder: Map<string, TradeWindowEntry[]>,
    now: number,
  ): Promise<void> {
    if (!this.db || !this.nostr || !this.wallet || this.sending) return;
    const db = this.db;
    const nostr = this.nostr;
    const wallet = this.wallet;
    this.sending = true;
    try {
      let identity: { pk: string };
      try {
        identity = wallet.getIdentity();
      } catch {
        // Wallet locked: nothing to resume until the user unlocks it.
        return;
      }

      for (const operation of operations) {
        if (operation.role !== "seller") continue;
        const entries = entriesByOrder.get(operation.orderId) ?? [];
        if (entries.some((entry) => entry.type === "funded")) continue;

        const escrow = getEscrow(db, operation.orderId);
        if (
          !escrow ||
          !escrow.vtxoTxid ||
          escrow.vtxoVout === undefined ||
          !escrow.fundedSats ||
          (escrow.state !== "pending" && escrow.state !== "spendable")
        ) {
          continue;
        }
        const recipient = operation.counterparty;
        if (!recipient) continue;

        const content = JSON.stringify({
          app: TRADE_APP,
          v: TRADE_VERSION,
          type: "funded",
          orderId: operation.orderId,
          role: "seller",
          from: identity.pk,
          ts: now,
          payload: {
            txid: escrow.vtxoTxid,
            vout: escrow.vtxoVout,
            amount: escrow.fundedSats,
          },
        });

        try {
          const wraps = wallet.wrapDm(recipient, content);
          await Promise.all(wraps.map((wrap) => nostr.publish(wrap)));
          const id = wraps[wraps.length - 1]?.id;
          if (id) {
            recordMessage(db, id, {
              type: "dm",
              orderId: operation.orderId,
              peer: recipient,
              outgoing: true,
              createdAt: now,
              receivedAt: now,
              payloadJson: JSON.stringify({
                sender: identity.pk,
                recipients: [recipient],
                content,
                createdAt: now,
              }),
            });
          }
          console.log(`[trading] resumed funded announcement for ${operation.orderId}`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.warn(`[trading] could not resume ${operation.orderId}:`, message);
        }
      }
    } finally {
      this.sending = false;
    }
  }

  private logTransition(status: TradeStatus): void {
    if (status.anyExpired && !this.loggedExpired.has(status.orderId)) {
      this.loggedExpired.add(status.orderId);
      console.log(
        `[trading] order ${status.orderId} stalled: culprit=${status.culprit} role=${status.role}`,
      );
      return;
    }
    if (!status.anyExpired && this.loggedExpired.has(status.orderId)) {
      this.loggedExpired.delete(status.orderId);
    }
  }

  private entriesByOrder(): Map<string, TradeWindowEntry[]> {
    const map = new Map<string, TradeWindowEntry[]>();
    if (!this.db) return map;
    for (const message of listMessages(this.db, { limit: MAX_MESSAGES })) {
      const envelope = decodeMessagePayload(message.payloadJson);
      if (!envelope) continue;
      const entry: TradeWindowEntry = {
        type: envelope.type,
        outgoing: message.outgoing,
        createdAt: message.createdAt,
        payload: envelope.payload,
      };
      const list = map.get(envelope.orderId) ?? [];
      list.push(entry);
      map.set(envelope.orderId, list);
    }
    return map;
  }
}

/** Operations the daemon should resume after a restart. */
export function activeOperations(db: Db): OperationRecord[] {
  return listOperations(db, 2000).filter((operation) => operation.status === "in-progress");
}
