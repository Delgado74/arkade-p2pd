import { SimplePool } from "nostr-tools/pool";
import type { Config } from "../config/index.js";

export class Nostr {
  pool = new SimplePool();
  constructor(private config: Config) {}
  async start() {
    console.log("[nostr] connecting to relays:", this.config.nostr.relays.join(", "));
  }
}
