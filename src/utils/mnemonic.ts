import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { getPublicKey as getCompressedPublicKey } from "@noble/secp256k1";
import { getPublicKey } from "nostr-tools/pure";
import { nip19 } from "nostr-tools";

export function createMnemonic(): string[] {
  return generateMnemonic(wordlist, 128).split(" ");
}

export function isValidMnemonic(mnemonic: string[]): boolean {
  return validateMnemonic(mnemonic.join(" "), wordlist);
}

export function deriveFromMnemonic(mnemonic: string[]) {
  const mnemonicStr = mnemonic.join(" ");
  if (!validateMnemonic(mnemonicStr, wordlist)) {
    throw new Error("Invalid mnemonic");
  }
  const seed = mnemonicToSeedSync(mnemonicStr);
  const sk = seed.slice(0, 32);
  const pk = getPublicKey(sk);
  const compressedPk = Buffer.from(getCompressedPublicKey(sk, true)).toString("hex");
  const nsec = nip19.nsecEncode(sk);
  const npub = nip19.npubEncode(pk);
  return {
    sk: Buffer.from(sk).toString("hex"),
    pk,
    compressedPk,
    nsec,
    npub,
  };
}
