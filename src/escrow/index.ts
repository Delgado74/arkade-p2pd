export const ESCROW_VERSION = 1;

export interface EscrowAgreement {
  escrowVersion: number;
  orderId: string;
  fiat: string;
  fiatAmount: number;
  tradeSats: number;
  buyerPubKey: string;
  sellerPubKey: string;
  arbiterPubKeys: string[];
  serverPubKey: string;
  refundLocktime: string;
}

export function validateAgreement(a: EscrowAgreement) {
  if (a.escrowVersion !== ESCROW_VERSION) throw new Error("unsupported escrowVersion");
  if (!a.orderId) throw new Error("missing orderId");
  if (a.tradeSats <= 0) throw new Error("invalid tradeSats");
  if (!a.buyerPubKey || !a.sellerPubKey) throw new Error("missing pubkeys");
  if (!a.arbiterPubKeys?.length) throw new Error("missing arbiters");
  if (!a.serverPubKey) throw new Error("missing serverPubKey");
  if (!a.refundLocktime || !/^\d+$/.test(a.refundLocktime)) {
    throw new Error("missing refundLocktime");
  }
  return true;
}
