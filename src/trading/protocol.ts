import { z } from "zod";

/** Application tag embedded in every trade message (mirrors the client). */
export const TRADE_APP = "arkade-p2p-trade";
/** Message schema version understood by this daemon. */
export const TRADE_VERSION = 1;

/** Message types the daemon needs to reason about the trade lifecycle. */
export const TRADE_TYPES = [
  "take",
  "taker_address",
  "escrow",
  "funded",
  "fiat_sent",
  "release_request",
  "release_signed",
  "release_done",
  "cancel_request",
  "cancel_agree",
  "ark_address",
  "ark_address_request",
  "dispute",
  "dispute_taken",
  "arbiter_decision",
  "chat",
] as const;

export type TradeMessageType = (typeof TRADE_TYPES)[number];

const hex64 = z.string().regex(/^[0-9a-f]{64}$/i);
const envelopeSchema = z
  .object({
    app: z.literal(TRADE_APP),
    v: z.literal(TRADE_VERSION),
    type: z.enum(TRADE_TYPES),
    orderId: z.string().min(1).max(256),
    role: z.enum(["buyer", "seller"]),
    from: hex64,
    ts: z.number().int().min(0),
    payload: z.record(z.string(), z.unknown()).default({}),
  })
  .passthrough();

/** A validated trade envelope; unknown payload fields are preserved. */
export type TradeEnvelope = z.infer<typeof envelopeSchema>;

/**
 * Decode the plaintext of a NIP-17 DM into a trade envelope.
 *
 * Returns `null` for anything that is not a valid, known-version trade message
 * so a malformed or foreign DM never reaches the trade engine.
 */
export function decodeTradeEnvelope(content: string): TradeEnvelope | null {
  try {
    const parsed: unknown = JSON.parse(content);
    const result = envelopeSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
