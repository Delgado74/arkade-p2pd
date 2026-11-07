import { randomBytes } from "node:crypto";
import { getPublicKey } from "nostr-tools/pure";
import { nip19 } from "nostr-tools";

export function generateSeed() {
  return Buffer.from(randomBytes(32)).toString("hex");
}

export function fromSeed(seedHex: string) {
  const sk = new Uint8Array(Buffer.from(seedHex, "hex"));
  const pk = getPublicKey(sk);
  const nsec = nip19.nsecEncode(sk);
  const npub = nip19.npubEncode(pk);
  return {
    sk: Buffer.from(sk).toString("hex"),
    pk,
    nsec,
    npub,
  };
}
