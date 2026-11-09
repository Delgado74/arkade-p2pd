import type { Db } from "../db/index.js";
import { listDisputes, listEscrows, listOperations } from "../db/index.js";

/** Snapshot the daemon can hand to the client after a restart. */
export interface RecoveryStatus {
  activeOperations: number;
  activeOrders: string[];
  escrows: number;
  disputes: number;
  recoveredAt: number;
}

/**
 * Session recovery service.
 *
 * On startup it lists the state that must survive a restart (active operations,
 * escrows and disputes) so the daemon logs what it is resuming and exposes the
 * snapshot over RPC. The trade monitor (`Trading`) re-arms its timers from the
 * same rows, so recovery never depends on a browser tab being open.
 */
export class Recovery {
  private status: RecoveryStatus | null = null;

  constructor(private db?: Db) {}

  async start(): Promise<void> {
    this.status = this.snapshot();
    if (!this.status) {
      console.log("[recovery] database unavailable; session recovery disabled");
      return;
    }
    console.log(
      `[recovery] resuming ${this.status.activeOperations} active operation(s), ` +
        `${this.status.escrows} escrow(s), ${this.status.disputes} dispute(s)`,
    );
  }

  /** Latest snapshot, or `null` when the database is unavailable. */
  current(): RecoveryStatus | null {
    return this.status;
  }

  /** Recompute the snapshot from the database. */
  snapshot(now = Math.floor(Date.now() / 1000)): RecoveryStatus | null {
    if (!this.db) return null;
    const operations = listOperations(this.db, 2000);
    const active = operations.filter((operation) => operation.status === "in-progress");
    this.status = {
      activeOperations: active.length,
      activeOrders: active.map((operation) => operation.orderId),
      escrows: listEscrows(this.db, 2000).length,
      disputes: listDisputes(this.db, 2000).length,
      recoveredAt: now,
    };
    return this.status;
  }
}
