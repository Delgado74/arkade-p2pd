import type { Db } from "../db/index.js";
import { listMessages, listOperations, type OperationRecord } from "../db/index.js";
import { decodeTradeEnvelope, type TradeEnvelope } from "./protocol.js";
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

  constructor(
    private db?: Db,
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
    return this.status();
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
