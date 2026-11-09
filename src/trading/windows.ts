import type { TradeMessageType } from "./protocol.js";

/** Window (seconds) an off-chain trade step's owner has to complete it. */
export const TRADE_WINDOW_SECONDS = 15 * 60;

/** Who failed to act in time, or `null` while the trade is on schedule. */
export type WindowCulprit = "taker" | "maker" | null;

/** The subset of a persisted trade message the window logic needs. */
export interface TradeWindowEntry {
  type: TradeMessageType;
  outgoing: boolean;
  createdAt: number;
  payload: Record<string, unknown>;
}

export interface WindowState {
  takeReceivedAt: number | null;
  takerAddressAt: number | null;
  escrowPublishedAt: number | null;
  funded: boolean;
  anyExpired: boolean;
  culprit: WindowCulprit;
}

function hasAddress(entry: TradeWindowEntry): boolean {
  const value = entry.payload.buyerArkAddress;
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Compute the chained-window state of a trade from its persisted messages.
 *
 * This mirrors the browser's `computeWindowState` so the daemon can detect a
 * stalled trade even when no tab is open. Steps are measured from the previous
 * step's relay-set timestamp:
 *
 *  1. Taker signal  — deliver the Ark address (`take` or legacy `taker_address`).
 *  2. Maker build   — a seller-maker publishes the escrow.
 *  3. Seller fund   — the seller funds the escrow.
 */
export function computeWindowState(args: {
  entries: TradeWindowEntry[];
  role: "buyer" | "seller";
  isMaker: boolean;
  funded: boolean;
  now: number;
}): WindowState {
  const { entries, role, isMaker, funded, now } = args;

  function earliest(predicate: (entry: TradeWindowEntry) => boolean): number | null {
    let found: number | null = null;
    for (const entry of entries) {
      if (!predicate(entry)) continue;
      if (found === null || entry.createdAt < found) found = entry.createdAt;
    }
    return found;
  }

  const takeReceivedAt = earliest((entry) => entry.type === "take" && !entry.outgoing);
  const takerAddressAt = earliest((entry) => {
    if (entry.outgoing) return false;
    if (entry.type === "taker_address") return true;
    return entry.type === "take" && hasAddress(entry);
  });
  const escrowPublishedAt = earliest((entry) => entry.type === "escrow");

  const takerWindowExpired =
    isMaker &&
    !funded &&
    takeReceivedAt !== null &&
    takerAddressAt === null &&
    now - takeReceivedAt >= TRADE_WINDOW_SECONDS;
  const makerBuildExpired =
    isMaker &&
    role === "seller" &&
    !funded &&
    takerAddressAt !== null &&
    escrowPublishedAt === null &&
    now - takerAddressAt >= TRADE_WINDOW_SECONDS;
  const sellerFundingExpired =
    role === "seller" &&
    !funded &&
    escrowPublishedAt !== null &&
    now - escrowPublishedAt >= TRADE_WINDOW_SECONDS;

  const culprit: WindowCulprit = takerWindowExpired
    ? "taker"
    : makerBuildExpired
      ? "maker"
      : sellerFundingExpired
        ? isMaker
          ? "maker"
          : "taker"
        : null;

  return {
    takeReceivedAt,
    takerAddressAt,
    escrowPublishedAt,
    funded,
    anyExpired: culprit !== null,
    culprit,
  };
}
