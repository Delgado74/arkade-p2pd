export interface EscrowAgreement {
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
  if (!a.orderId) throw new Error("missing orderId");
  if (a.tradeSats <= 0) throw new Error("invalid tradeSats");
  if (!a.buyerPubKey || !a.sellerPubKey) throw new Error("missing pubkeys");
  if (!a.arbiterPubKeys?.length) throw new Error("missing arbiters");
  if (!a.serverPubKey) throw new Error("missing serverPubKey");
  if (!a.refundLocktime) throw new Error("missing refundLocktime");
  return true;
}
