import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { finalizeEvent } from "nostr-tools/pure";
import type { Event, EventTemplate, UnsignedEvent } from "nostr-tools/pure";
import { unwrapEvent, wrapManyEvents } from "nostr-tools/nip59";
import { decrypt as nip44Decrypt, encrypt as nip44Encrypt, getConversationKey } from "nostr-tools/nip44";
import { SingleKey, Transaction } from "@arkade-os/sdk";
import { base64 } from "@scure/base";
import { createMnemonic, deriveFromMnemonic } from "../utils/mnemonic.js";
import { encryptKeystore, decryptKeystore, type EncryptedBlob, type KeystoreData } from "../utils/keystore.js";

export type WalletStatus = "uninitialized" | "locked" | "unlocked";

export class Wallet {
  status: WalletStatus = "uninitialized";
  private identity!: ReturnType<typeof deriveFromMnemonic>;
  private keystoreData?: KeystoreData;
  private arkSigner?: SingleKey;

  constructor(private path: string) {}

  private getEncPath() {
    return this.path.replace(/\.json$/, ".enc.json");
  }

  async init() {
    mkdirSync(dirname(this.path), { recursive: true });
    const encPath = this.getEncPath();
    if (!existsSync(encPath)) {
      this.status = "uninitialized";
      console.log("[wallet] no wallet found - uninitialized");
      return;
    }
    this.status = "locked";
    console.log("[wallet] wallet locked - need unlock");
  }

  create(passphrase: string) {
    const mnemonic = createMnemonic();
    const keystoreData: KeystoreData = { mnemonic, createdAt: Date.now() };
    const blob = encryptKeystore(keystoreData, passphrase);
    writeFileSync(this.getEncPath(), JSON.stringify(blob, null, 2));
    this.keystoreData = keystoreData;
    this.identity = deriveFromMnemonic(mnemonic);
    this.arkSigner = undefined;
    this.status = "unlocked";
    console.log("[wallet] created new wallet, npub:", this.identity.npub);
    return { mnemonic, npub: this.identity.npub, pk: this.identity.pk };
  }

  import(mnemonic: string[], passphrase: string) {
    const keystoreData: KeystoreData = { mnemonic, createdAt: Date.now() };
    const blob = encryptKeystore(keystoreData, passphrase);
    writeFileSync(this.getEncPath(), JSON.stringify(blob, null, 2));
    this.keystoreData = keystoreData;
    this.identity = deriveFromMnemonic(mnemonic);
    this.arkSigner = undefined;
    this.status = "unlocked";
    console.log("[wallet] imported wallet, npub:", this.identity.npub);
    return { npub: this.identity.npub, pk: this.identity.pk };
  }

  unlock(passphrase: string) {
    const encPath = this.getEncPath();
    if (!existsSync(encPath)) throw new Error("Wallet not initialized");
    const blob = JSON.parse(readFileSync(encPath, "utf8")) as EncryptedBlob;
    const data = decryptKeystore(blob, passphrase);
    this.keystoreData = data;
    this.identity = deriveFromMnemonic(data.mnemonic);
    this.arkSigner = undefined;
    this.status = "unlocked";
    console.log("[wallet] unlocked, npub:", this.identity.npub);
    return { npub: this.identity.npub, pk: this.identity.pk };
  }

  revealMnemonic(passphrase: string) {
    const encPath = this.getEncPath();
    if (!existsSync(encPath)) throw new Error("Wallet not initialized");
    const blob = JSON.parse(readFileSync(encPath, "utf8")) as EncryptedBlob;
    const data = decryptKeystore(blob, passphrase);
    return { mnemonic: data.mnemonic };
  }

  getIdentity() {
    if (this.status !== "unlocked") throw new Error("Wallet locked");
    return {
      pk: this.identity.pk,
      compressedPk: this.identity.compressedPk,
      npub: this.identity.npub,
    };
  }

  private getArkSigner() {
    if (this.status !== "unlocked") throw new Error("Wallet locked");
    if (!this.arkSigner) {
      this.arkSigner = SingleKey.fromPrivateKey(this.getSigningKey());
    }
    return this.arkSigner;
  }

  /** Sign one base64 PSBT and return the base64 result. */
  async signPsbt(psbt: string, inputIndexes?: number[]): Promise<string> {
    const signer = this.getArkSigner();
    const tx = Transaction.fromPSBT(base64.decode(psbt));
    const signed = await signer.sign(tx, inputIndexes);
    return base64.encode(signed.toPSBT());
  }

  /** Sign several base64 PSBTs in order, preserving existing signatures. */
  async signPsbts(psbts: string[], inputIndexes?: number[][]): Promise<string[]> {
    const signer = this.getArkSigner();
    const signed = await Promise.all(
      psbts.map(async (psbt, index) => {
        const tx = Transaction.fromPSBT(base64.decode(psbt));
        const result = await signer.sign(tx, inputIndexes?.[index]);
        return base64.encode(result.toPSBT());
      }),
    );
    return signed;
  }

  async signMessage(message: string, signatureType: "schnorr" | "ecdsa" = "schnorr"): Promise<string> {
    const signature = await this.getArkSigner().signMessage(
      base64.decode(message),
      signatureType,
    );
    return base64.encode(signature);
  }

  async signSchnorrDeterministic(messageHash: string): Promise<string> {
    const signature = await this.getArkSigner().signSchnorrDeterministic(
      base64.decode(messageHash),
    );
    return base64.encode(signature);
  }

  getStatus() {
    return { status: this.status };
  }

  getSigningKey() {
    if (this.status !== "unlocked") throw new Error("Wallet locked");
    return new Uint8Array(Buffer.from(this.identity.sk, "hex"));
  }

  /** Sign a public Nostr event template without exposing the secret key. */
  signEvent(template: EventTemplate): Event {
    return finalizeEvent(template, this.getSigningKey());
  }

  /**
   * Build the NIP-17 gift wraps for a private message. The SDK also wraps a
   * copy to the sender so local history can be reloaded.
   */
  wrapDm(recipientPubKey: string, content: string): Event[] {
    const identity = this.getIdentity();
    const rumor: Partial<UnsignedEvent> = {
      kind: 14,
      content,
      tags: [
        ["p", recipientPubKey],
        ["p", identity.pk],
      ],
    };
    return wrapManyEvents(rumor, this.getSigningKey(), [recipientPubKey]);
  }

  /** Decrypt a gift wrap addressed to this identity and return its rumor. */
  unwrapDm(wrap: Event) {
    const rumor = unwrapEvent(wrap, this.getSigningKey());
    return {
      id: rumor.id,
      sender: rumor.pubkey,
      recipients: rumor.tags.filter((tag) => tag[0] === "p").map((tag) => tag[1]),
      content: rumor.content,
      createdAt: rumor.created_at,
    };
  }

  /** NIP-44 encrypt for a peer, used by the message layer if needed directly. */
  nip44Encrypt(recipientPubKey: string, plaintext: string): string {
    const key = getConversationKey(this.getSigningKey(), recipientPubKey);
    return nip44Encrypt(plaintext, key);
  }

  /** NIP-44 decrypt a payload from a peer. */
  nip44Decrypt(senderPubKey: string, payload: string): string {
    const key = getConversationKey(this.getSigningKey(), senderPubKey);
    return nip44Decrypt(payload, key);
  }
}
