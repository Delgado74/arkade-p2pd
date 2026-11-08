import WS from "ws";
import type { Event, Filter } from "nostr-tools";
import type { RelayConnectionStatus } from "../db/relays.js";

export interface RelayPoolOptions {
  onEvent?: (url: string, subId: string, event: Event) => void;
  onStatus?: (url: string, status: RelayConnectionStatus, error?: string) => void;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  publishTimeoutMs?: number;
  maxSeen?: number;
}

interface PendingPublish {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface RelayState {
  url: string;
  socket: WS | null;
  connected: boolean;
  attempts: number;
  reconnectTimer: NodeJS.Timeout | null;
  subs: Map<string, Filter[]>;
  pending: Map<string, PendingPublish>;
  closed: boolean;
}

/**
 * Exponential backoff with jitter, capped at `max`.
 *
 * The jitter (50%-100% of the window) keeps many daemons from reconnecting in
 * lockstep after a relay outage.
 */
export function backoffDelay(
  attempt: number,
  base = 1000,
  max = 60_000,
  random: () => number = Math.random,
): number {
  const step = Math.min(Math.max(Math.trunc(attempt), 0), 10);
  const window = Math.min(max, base * 2 ** step);
  return Math.round(window * (0.5 + random() * 0.5));
}

function isEvent(value: unknown): value is Event {
  if (typeof value !== "object" || value === null) return false;
  const event = value as Partial<Event>;
  return (
    typeof event.id === "string" &&
    typeof event.pubkey === "string" &&
    typeof event.kind === "number" &&
    typeof event.created_at === "number" &&
    typeof event.content === "string" &&
    Array.isArray(event.tags) &&
    typeof event.sig === "string"
  );
}

/**
 * A small, dependency-light relay pool.
 *
 * Unlike `SimplePool`, this keeps one socket per relay so the daemon can track
 * health per relay, reconnect with backoff, and wait for per-relay `OK`
 * acknowledgements before considering a publish delivered.
 */
export class RelayPool {
  private relays = new Map<string, RelayState>();
  private seen = new Set<string>();
  private seenOrder: string[] = [];
  private readonly backoffBase: number;
  private readonly backoffMax: number;
  private readonly publishTimeout: number;
  private readonly maxSeen: number;
  private stopped = false;

  constructor(
    urls: string[],
    private options: RelayPoolOptions = {},
  ) {
    this.backoffBase = options.backoffBaseMs ?? 1000;
    this.backoffMax = options.backoffMaxMs ?? 60_000;
    this.publishTimeout = options.publishTimeoutMs ?? 10_000;
    this.maxSeen = options.maxSeen ?? 20_000;
    for (const url of urls) {
      const value = url.trim();
      if (value) this.relays.set(value, this.newState(value));
    }
  }

  private newState(url: string): RelayState {
    return {
      url,
      socket: null,
      connected: false,
      attempts: 0,
      reconnectTimer: null,
      subs: new Map(),
      pending: new Map(),
      closed: false,
    };
  }

  /** Open every configured relay. */
  start(): void {
    this.stopped = false;
    for (const state of this.relays.values()) this.connect(state);
  }

  /** Close every socket and cancel reconnects. */
  close(): void {
    this.stopped = true;
    for (const state of this.relays.values()) {
      state.closed = true;
      if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
      this.rejectPending(state, new Error("relay pool closed"));
      state.socket?.close();
      state.socket = null;
    }
  }

  /** Add a relay and connect it immediately. */
  add(url: string): void {
    if (this.relays.has(url)) return;
    const state = this.newState(url);
    this.relays.set(url, state);
    this.connect(state);
  }

  /** Remove a relay, closing its socket. */
  remove(url: string): void {
    const state = this.relays.get(url);
    if (!state) return;
    state.closed = true;
    if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
    this.rejectPending(state, new Error("relay removed"));
    state.socket?.close();
    this.relays.delete(url);
  }

  /**
   * Register a subscription under a stable key. Every relay receives the same
   * `REQ`, and reconnecting relays re-send it automatically.
   *
   * @returns A function that removes the subscription from every relay.
   */
  subscribe(key: string, filters: Filter[]): () => void {
    for (const state of this.relays.values()) {
      state.subs.set(key, filters);
      if (state.connected && state.socket) this.sendReq(state, key, filters);
    }
    return () => this.unsubscribe(key);
  }

  unsubscribe(key: string): void {
    for (const state of this.relays.values()) {
      if (!state.subs.delete(key)) continue;
      if (state.connected && state.socket) {
        try {
          state.socket.send(JSON.stringify(["CLOSE", key]));
        } catch {
          // Socket already gone; the reconnect will not re-add this sub.
        }
      }
    }
  }

  /** True when at least one relay is connected. */
  get connected(): boolean {
    for (const state of this.relays.values()) if (state.connected) return true;
    return false;
  }

  /**
   * Publish an event to every connected relay and resolve as soon as one
   * acknowledges it. Rejects when none does.
   */
  async publish(event: Event): Promise<void> {
    const targets = [...this.relays.values()].filter((state) => state.connected && state.socket);
    if (targets.length === 0) throw new Error("no connected relays");
    const results = await Promise.allSettled(targets.map((state) => this.publishTo(state, event)));
    if (results.some((result) => result.status === "fulfilled")) return;
    const reasons = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => (result.reason instanceof Error ? result.reason.message : String(result.reason)));
    throw new Error(reasons[0] ?? "publish failed");
  }

  private publishTo(state: RelayState, event: Event): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!state.socket || !state.connected) {
        reject(new Error(`relay not connected: ${state.url}`));
        return;
      }
      const key = `${state.url}|${event.id}`;
      const timer = setTimeout(() => {
        state.pending.delete(key);
        reject(new Error(`timeout waiting for OK from ${state.url}`));
      }, this.publishTimeout);
      state.pending.set(key, { resolve, reject, timer });
      try {
        state.socket.send(JSON.stringify(["EVENT", event]));
      } catch (error) {
        clearTimeout(timer);
        state.pending.delete(key);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private connect(state: RelayState): void {
    if (this.stopped || state.closed) return;
    this.options.onStatus?.(state.url, "connecting");
    let socket: WS;
    try {
      socket = new WS(state.url);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.onStatus?.(state.url, "error", message);
      this.scheduleReconnect(state);
      return;
    }
    state.socket = socket;

    socket.on("open", () => {
      if (state.closed) {
        socket.close();
        return;
      }
      state.connected = true;
      state.attempts = 0;
      this.options.onStatus?.(state.url, "connected");
      for (const [key, filters] of state.subs) this.sendReq(state, key, filters);
    });

    socket.on("message", (data) => this.handleMessage(state, data.toString()));

    socket.on("error", (error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.options.onStatus?.(state.url, "error", message);
    });

    socket.on("close", () => {
      state.connected = false;
      state.socket = null;
      this.rejectPending(state, new Error(`relay closed: ${state.url}`));
      if (!state.closed && !this.stopped) this.scheduleReconnect(state);
    });
  }

  private scheduleReconnect(state: RelayState): void {
    if (state.closed || this.stopped || state.reconnectTimer) return;
    const delay = backoffDelay(state.attempts, this.backoffBase, this.backoffMax);
    state.attempts += 1;
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null;
      this.connect(state);
    }, delay);
  }

  private sendReq(state: RelayState, key: string, filters: Filter[]): void {
    if (!state.socket) return;
    try {
      state.socket.send(JSON.stringify(["REQ", key, ...filters]));
    } catch {
      // The close handler will schedule a reconnect and resend the sub.
    }
  }

  private handleMessage(state: RelayState, raw: string): void {
    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (!Array.isArray(message) || typeof message[0] !== "string") return;
    const [type] = message;
    if (type === "EVENT") {
      const subId = message[1];
      const event = message[2];
      if (typeof subId !== "string" || !isEvent(event)) return;
      if (!this.markSeen(event.id)) return;
      this.options.onEvent?.(state.url, subId, event);
      return;
    }
    if (type === "OK") {
      const eventId = message[1];
      const ok = message[2] === true;
      const detail = typeof message[3] === "string" ? message[3] : undefined;
      if (typeof eventId !== "string") return;
      const key = `${state.url}|${eventId}`;
      const pending = state.pending.get(key);
      if (!pending) return;
      state.pending.delete(key);
      clearTimeout(pending.timer);
      if (ok) pending.resolve();
      else pending.reject(new Error(detail ?? `relay rejected event: ${state.url}`));
      return;
    }
    if (type === "NOTICE" && typeof message[1] === "string") {
      console.warn(`[relay] ${state.url}: ${message[1]}`);
    }
  }

  private markSeen(id: string): boolean {
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    this.seenOrder.push(id);
    if (this.seenOrder.length > this.maxSeen) {
      const oldest = this.seenOrder.shift();
      if (oldest) this.seen.delete(oldest);
    }
    return true;
  }

  private rejectPending(state: RelayState, error: Error): void {
    for (const pending of state.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    state.pending.clear();
  }
}
