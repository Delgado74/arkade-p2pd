import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from "node:crypto";

export interface EncryptedBlob {
  version: number;
  kdf: "scrypt";
  cipher: "aes-256-gcm";
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

export interface KeystoreData {
  mnemonic: string[];
  createdAt: number;
}

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 32;

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
}

export function encryptKeystore(data: KeystoreData, passphrase: string): EncryptedBlob {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveKey(passphrase, salt);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(data));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    version: 1,
    kdf: "scrypt",
    cipher: "aes-256-gcm",
    salt: salt.toString("hex"),
    iv: iv.toString("hex"),
    tag: tag.toString("hex"),
    ciphertext: ciphertext.toString("hex"),
  };
}

export function decryptKeystore(blob: EncryptedBlob, passphrase: string): KeystoreData {
  const salt = Buffer.from(blob.salt, "hex");
  const iv = Buffer.from(blob.iv, "hex");
  const tag = Buffer.from(blob.tag, "hex");
  const ciphertext = Buffer.from(blob.ciphertext, "hex");
  const key = deriveKey(passphrase, salt);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8")) as KeystoreData;
}
