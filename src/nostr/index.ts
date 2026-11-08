import type { Event, Filter } from "nostr-tools";
import type { Config } from "../config/index.js";
import type { Db } from "../db/index.js";
import {
  enabledRelayUrls,
  listRelays,
  seedRelays,
  updateRelayStatus,
  type RelayRecord,
} from "../db/relays.js";
import {
  enqueueOutbox,
  listDueOutbox,
  markOutboxFailed,
  markOutboxSent,
} from "../db/outbox.js";
import { recordMessage } from "../db/messages.js";
import type { Wallet } from "../wallet/index.js";
import { RelayPool, backoffDelay } from "./relayPool.js";

const OUTBOX_INTERVAL_MS = 15_000;
const OUTBOX_RETRY_BASE_MS = 5_000;
const OUTBOX_RETRY_MAX_MS = 300_000;
const GIFT_WRAP_KIND = 1059;
const DM_REPLAY_SECONDS = 30 * 24 * 60 * 60;

/**
 * Relay pool owned by the daemon.
 *
 * The daemon is the only process that needs to stay online, so it owns the
 * relay connections, the subscriptions and a persistent outbox. The client
 * becomes a view: it asks the daemon to publish and reads persisted state
 * instead of keeping its own sockets.
 */
export class Nostr {
  private pool: RelayPool | null = null;
  private flushTimer: NodeJS.Timeout | null = null;
  private flushing = false;
  private handlers = new Map<string, (event: Event) => void>();
  private inFlight = new Set<string>();
  private dmUnsubscribe: (() => void) | null = null;
  private dmIdentity: string | null = null;

  constructor(
    private config: Config,
    private db?: Db,
  ) {}

  async start() {
    let urls = this.config.nostr.relays;
    if (this.db) {
      seedRelays(this.db, this.config.nostr.relays);
      urls = enabledRelayUrls(this.db);
    }
    this.pool = new RelayPool(urls, {
      onStatus: (url, status, error) => {
        if (this.db) updateRelayStatus(this.db, url, status, error);
      },
      onEvent: (_url, subId, event) => {
        this.handlers.get(subId)?.(event);
      },
    });
    this.pool.start();
    this.flushTimer = setInterval(() => void this.flushOutbox(), OUTBOX_INTERVAL_MS);
    console.log(`[nostr] pool started with ${urls.length} relays`);
  }

  /**
   * Register a long-lived subscription. The key is the stable subscription id
   * re-sent after every reconnect.
   */
  subscribe(key: string, filters: Filter[], onEvent: (event: Event) => void): () => void {
    if (!this.pool) throw new Error("nostr not started");
    this.handlers.set(key, onEvent);
    const unsubscribe = this.pool.subscribe(key, filters);
    return () => {
      this.handlers.delete(key);
      unsubscribe();
    };
  }

  /**
   * Start persisting the identity's NIP-17 DMs. Called after the wallet is
   * unlocked; replacing the subscription when the identity changes keeps a
   * single long-lived feed owned by the daemon.
   */
  startForIdentity(wallet: Wallet): void {
    if (!this.pool) return;
    try {
      const identity = wallet.getIdentity();
      if (this.dmIdentity === identity.pk) return;
      this.dmUnsubscribe?.();
      this.dmIdentity = identity.pk;
      this.dmUnsubscribe = this.subscribe(
        `dm:${identity.pk}`,
        [
          {
            kinds: [GIFT_WRAP_KIND],
            "#p": [identity.pk],
            since: Math.floor(Date.now() / 1000) - DM_REPLAY_SECONDS,
          },
        ],
        (wrap) => {
          if (!this.db) return;
          try {
            const rumor = wallet.unwrapDm(wrap);
            recordMessage(this.db, rumor.id, {
              type: "dm",
              peer: rumor.sender,
              outgoing: rumor.sender === identity.pk,
              createdAt: rumor.createdAt,
              receivedAt: Math.floor(Date.now() / 1000),
              payloadJson: JSON.stringify({
                sender: rumor.sender,
                recipients: rumor.recipients,
                content: rumor.content,
                createdAt: rumor.createdAt,
              }),
            });
          } catch {
            // Not addressed to us, or a malformed wrap: ignore it.
          }
        },
      );
      console.log(`[nostr] DM subscription started for ${identity.npub}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn("[nostr] DM subscription not started:", message);
    }
  }

  /** Publish a signed event through the pool, persisting it in the outbox first
   * so a crash or relay outage never loses it. Rejects when no relay accepted
   * it now; the outbox retries in the background.
   */
  async publish(event: Event): Promise<void> {
    if (!this.pool) throw new Error("nostr not started");
    if (this.db) enqueueOutbox(this.db, "nostr.publish", JSON.stringify(event), event.id);
    this.inFlight.add(event.id);
    try {
      await this.pool.publish(event);
      if (this.db) markOutboxSent(this.db, event.id);
    } finally {
      this.inFlight.delete(event.id);
    }
  }

  /** Last known relay health, from the database when available. */
  status(): RelayRecord[] {
    return this.db ? listRelays(this.db) : [];
  }

  /** True when at least one relay is connected. */
  get connected(): boolean {
    return this.pool?.connected ?? false;
  }

  stop(): void {
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = null;
    this.dmUnsubscribe?.();
    this.dmUnsubscribe = null;
    this.dmIdentity = null;
    this.pool?.close();
    this.pool = null;
    this.handlers.clear();
  }

  /** Retry due outbox entries. Exposed for tests and manual flushes. */
  async flushOutbox(now = Math.floor(Date.now() / 1000)): Promise<void> {
    if (!this.db || !this.pool || this.flushing) return;
    this.flushing = true;
    try {
      for (const entry of listDueOutbox(this.db, now)) {
        if (this.inFlight.has(entry.id)) continue;
        if (entry.method !== "nostr.publish") {
          markOutboxFailed(this.db, entry.id, "unsupported method", now + 3600, entry.attempts + 1);
          continue;
        }
        let event: Event;
        try {
          event = JSON.parse(entry.paramsJson) as Event;
        } catch {
          markOutboxFailed(this.db, entry.id, "invalid event payload", now + 3600, entry.attempts + 1);
          continue;
        }
        this.inFlight.add(entry.id);
        try {
          await this.pool.publish(event);
          markOutboxSent(this.db, entry.id);
        } catch (error) {
          const attempts = entry.attempts + 1;
          const delaySeconds = Math.round(
            backoffDelay(attempts, OUTBOX_RETRY_BASE_MS, OUTBOX_RETRY_MAX_MS) / 1000,
          );
          const message = error instanceof Error ? error.message : String(error);
          markOutboxFailed(this.db, entry.id, message, now + delaySeconds, attempts);
        } finally {
          this.inFlight.delete(entry.id);
        }
      }
    } finally {
      this.flushing = false;
    }
  }
}
