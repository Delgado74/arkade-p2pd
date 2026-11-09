import { WebSocketServer, type WebSocket } from "ws";
import { z } from "zod";
import type { Config } from "../config/index.js";
import type { Db } from "../db/index.js";
import {
  deleteOperation,
  getOperation,
  importOperations,
  listOperations,
  operationImportSchema,
  operationPatchSchema,
  recordOperation,
} from "../db/operations.js";
import {
  deleteMessage,
  importMessages,
  listMessages,
  messageImportSchema,
  messagePatchSchema,
  recordMessage,
} from "../db/messages.js";
import { listRelays } from "../db/relays.js";
import {
  deleteEscrow,
  escrowImportSchema,
  escrowPatchSchema,
  getEscrow,
  importEscrows,
  listEscrows,
  recordEscrow,
} from "../db/escrows.js";
import {
  deleteDispute,
  disputeImportSchema,
  disputePatchSchema,
  getDispute,
  importDisputes,
  listDisputes,
  recordDispute,
} from "../db/disputes.js";
import {
  deleteRating,
  getRating,
  importRatings,
  listRatings,
  ratingSchema,
  recordRating,
} from "../db/ratings.js";
import { deleteSetting, getSetting, listSettings, setSetting } from "../db/settings.js";
import { deleteCursor, getCursor, listCursors, setCursor } from "../db/cursors.js";
import type { Nostr } from "../nostr/index.js";
import type { Wallet } from "../wallet/index.js";
import type { Trading } from "../trading/index.js";
import type { Recovery } from "../recovery/index.js";

const hex64 = z.string().regex(/^[0-9a-f]{64}$/i);
const eventSchema = z
  .object({
    id: hex64,
    pubkey: hex64,
    created_at: z.number().int().min(0),
    kind: z.number().int().min(0).max(65535),
    tags: z.array(z.array(z.string())),
    content: z.string(),
    sig: z.string().regex(/^[0-9a-f]{128}$/i),
  })
  .strict();

function send(ws: WebSocket, id: unknown, result: unknown) {
  ws.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
}

function notify(ws: WebSocket, method: string, params: unknown) {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
}

function fail(ws: WebSocket, id: unknown, error: unknown) {
  const message =
    error instanceof z.ZodError
      ? error.issues
          .map((issue) => `${issue.path.join(".") || "params"}: ${issue.message}`)
          .join("; ")
      : error instanceof Error
        ? error.message
        : String(error);
  const code = /locked/i.test(message) ? -32001 : /not found|unknown method/i.test(message) ? -32601 : -32000;
  ws.send(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }));
}

export async function startRpc(
  config: Config,
  wallet?: Wallet,
  db?: Db,
  nostr?: Nostr,
  trading?: Trading,
  recovery?: Recovery,
) {
  const allowedOrigins = config.daemon.allowedOrigins;
  let connectionSeq = 0;
  const wss = new WebSocketServer({
    host: config.daemon.host,
    port: config.daemon.port,
    verifyClient: (info, done) => {
      const origin = info.origin;
      if (origin && (allowedOrigins.includes("*") || allowedOrigins.includes(origin))) {
        done(true);
        return;
      }
      console.warn("[arkade-p2pd] rejected RPC origin:", origin ?? "(none)");
      done(false, 403, "origin not allowed");
    },
  });

  wss.on("connection", (ws) => {
    const connectionId = ++connectionSeq;
    const subscriptions = new Map<string, () => void>();

    ws.send(JSON.stringify({ jsonrpc: "2.0", method: "hello", params: { name: "arkade-p2pd", version: "0.1.0" } }));

    ws.on("close", () => {
      for (const off of subscriptions.values()) off();
      subscriptions.clear();
    });

    ws.on("message", (data) => {
      void (async () => {
        let msg: any;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          fail(ws, null, new Error("parse error"));
          return;
        }

        try {
          if (msg.method?.startsWith("operations.")) {
            if (!db) throw new Error("database unavailable");
            switch (msg.method) {
              case "operations.list": {
                const limit = msg.params?.limit;
                if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
                  throw new Error("limit must be a positive integer");
                }
                send(ws, msg.id, listOperations(db, limit));
                return;
              }
              case "operations.get": {
                if (typeof msg.params?.orderId !== "string") {
                  throw new Error("orderId required");
                }
                send(ws, msg.id, getOperation(db, msg.params.orderId));
                return;
              }
              case "operations.upsert": {
                if (typeof msg.params?.orderId !== "string" || msg.params.orderId.length === 0) {
                  throw new Error("orderId required");
                }
                const patch = operationPatchSchema.parse(msg.params?.patch ?? {});
                send(ws, msg.id, recordOperation(db, msg.params.orderId, patch));
                return;
              }
              case "operations.delete": {
                if (typeof msg.params?.orderId !== "string") {
                  throw new Error("orderId required");
                }
                send(ws, msg.id, { deleted: deleteOperation(db, msg.params.orderId) });
                return;
              }
              case "operations.import": {
                if (!Array.isArray(msg.params?.operations)) {
                  throw new Error("operations array required");
                }
                const now = Math.floor(Date.now() / 1000);
                const records = z
                  .array(operationImportSchema)
                  .parse(msg.params.operations)
                  .map((record) => ({
                    ...record,
                    createdAt: record.createdAt ?? now,
                    updatedAt: record.updatedAt ?? record.createdAt ?? now,
                  }));
                send(ws, msg.id, importOperations(db, records));
                return;
              }
              default:
                throw new Error(`unknown method: ${msg.method}`);
            }
          }

          if (msg.method?.startsWith("messages.")) {
            if (!db) throw new Error("database unavailable");
            switch (msg.method) {
              case "messages.list": {
                const orderId = msg.params?.orderId;
                if (orderId !== undefined && typeof orderId !== "string") {
                  throw new Error("orderId must be a string");
                }
                const limit = msg.params?.limit;
                if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
                  throw new Error("limit must be a positive integer");
                }
                send(ws, msg.id, listMessages(db, { orderId, limit }));
                return;
              }
              case "messages.upsert": {
                if (typeof msg.params?.id !== "string" || msg.params.id.length === 0) {
                  throw new Error("id required");
                }
                const patch = messagePatchSchema.parse(msg.params?.patch ?? {});
                send(ws, msg.id, recordMessage(db, msg.params.id, patch));
                return;
              }
              case "messages.delete": {
                if (typeof msg.params?.id !== "string") throw new Error("id required");
                send(ws, msg.id, { deleted: deleteMessage(db, msg.params.id) });
                return;
              }
              case "messages.import": {
                if (!Array.isArray(msg.params?.messages)) {
                  throw new Error("messages array required");
                }
                const records = z.array(messageImportSchema).parse(msg.params.messages);
                send(ws, msg.id, importMessages(db, records));
                return;
              }
              default:
                throw new Error(`unknown method: ${msg.method}`);
            }
          }

          if (msg.method?.startsWith("escrows.")) {
            if (!db) throw new Error("database unavailable");
            switch (msg.method) {
              case "escrows.list": {
                const limit = msg.params?.limit;
                if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
                  throw new Error("limit must be a positive integer");
                }
                send(ws, msg.id, listEscrows(db, limit));
                return;
              }
              case "escrows.get": {
                if (typeof msg.params?.orderId !== "string") {
                  throw new Error("orderId required");
                }
                send(ws, msg.id, getEscrow(db, msg.params.orderId));
                return;
              }
              case "escrows.upsert": {
                if (typeof msg.params?.orderId !== "string" || msg.params.orderId.length === 0) {
                  throw new Error("orderId required");
                }
                const patch = escrowPatchSchema.parse(msg.params?.patch ?? {});
                send(ws, msg.id, recordEscrow(db, msg.params.orderId, patch));
                return;
              }
              case "escrows.delete": {
                if (typeof msg.params?.orderId !== "string") {
                  throw new Error("orderId required");
                }
                send(ws, msg.id, { deleted: deleteEscrow(db, msg.params.orderId) });
                return;
              }
              case "escrows.import": {
                if (!Array.isArray(msg.params?.escrows)) {
                  throw new Error("escrows array required");
                }
                const records = z.array(escrowImportSchema).parse(msg.params.escrows);
                send(ws, msg.id, importEscrows(db, records));
                return;
              }
              default:
                throw new Error(`unknown method: ${msg.method}`);
            }
          }

          if (msg.method?.startsWith("disputes.")) {
            if (!db) throw new Error("database unavailable");
            switch (msg.method) {
              case "disputes.list": {
                const limit = msg.params?.limit;
                if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
                  throw new Error("limit must be a positive integer");
                }
                send(ws, msg.id, listDisputes(db, limit));
                return;
              }
              case "disputes.get": {
                if (typeof msg.params?.orderId !== "string") {
                  throw new Error("orderId required");
                }
                send(ws, msg.id, getDispute(db, msg.params.orderId));
                return;
              }
              case "disputes.upsert": {
                if (typeof msg.params?.orderId !== "string" || msg.params.orderId.length === 0) {
                  throw new Error("orderId required");
                }
                const patch = disputePatchSchema.parse(msg.params?.patch ?? {});
                send(ws, msg.id, recordDispute(db, msg.params.orderId, patch));
                return;
              }
              case "disputes.delete": {
                if (typeof msg.params?.orderId !== "string") {
                  throw new Error("orderId required");
                }
                send(ws, msg.id, { deleted: deleteDispute(db, msg.params.orderId) });
                return;
              }
              case "disputes.import": {
                if (!Array.isArray(msg.params?.disputes)) {
                  throw new Error("disputes array required");
                }
                const records = z.array(disputeImportSchema).parse(msg.params.disputes);
                send(ws, msg.id, importDisputes(db, records));
                return;
              }
              default:
                throw new Error(`unknown method: ${msg.method}`);
            }
          }

          if (msg.method?.startsWith("ratings.")) {
            if (!db) throw new Error("database unavailable");
            switch (msg.method) {
              case "ratings.list": {
                const { subject, orderId, limit } = msg.params ?? {};
                if (subject !== undefined && typeof subject !== "string") {
                  throw new Error("subject must be a string");
                }
                if (orderId !== undefined && typeof orderId !== "string") {
                  throw new Error("orderId must be a string");
                }
                if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
                  throw new Error("limit must be a positive integer");
                }
                send(ws, msg.id, listRatings(db, { subject, orderId, limit }));
                return;
              }
              case "ratings.get": {
                if (typeof msg.params?.eventId !== "string") {
                  throw new Error("eventId required");
                }
                send(ws, msg.id, getRating(db, msg.params.eventId));
                return;
              }
              case "ratings.upsert": {
                const rating = ratingSchema.parse(msg.params?.rating);
                send(ws, msg.id, recordRating(db, rating));
                return;
              }
              case "ratings.delete": {
                if (typeof msg.params?.eventId !== "string") {
                  throw new Error("eventId required");
                }
                send(ws, msg.id, { deleted: deleteRating(db, msg.params.eventId) });
                return;
              }
              case "ratings.import": {
                if (!Array.isArray(msg.params?.ratings)) {
                  throw new Error("ratings array required");
                }
                const records = z.array(ratingSchema).parse(msg.params.ratings);
                send(ws, msg.id, importRatings(db, records));
                return;
              }
              default:
                throw new Error(`unknown method: ${msg.method}`);
            }
          }

          if (msg.method?.startsWith("settings.")) {
            if (!db) throw new Error("database unavailable");
            switch (msg.method) {
              case "settings.get": {
                if (typeof msg.params?.key !== "string") throw new Error("key required");
                send(ws, msg.id, getSetting(db, msg.params.key));
                return;
              }
              case "settings.set": {
                if (typeof msg.params?.key !== "string" || typeof msg.params?.value !== "string") {
                  throw new Error("key and value required");
                }
                send(ws, msg.id, setSetting(db, msg.params.key, msg.params.value));
                return;
              }
              case "settings.list":
                send(ws, msg.id, listSettings(db));
                return;
              case "settings.delete": {
                if (typeof msg.params?.key !== "string") throw new Error("key required");
                send(ws, msg.id, { deleted: deleteSetting(db, msg.params.key) });
                return;
              }
              default:
                throw new Error(`unknown method: ${msg.method}`);
            }
          }

          if (msg.method?.startsWith("cursors.")) {
            if (!db) throw new Error("database unavailable");
            switch (msg.method) {
              case "cursors.get": {
                if (typeof msg.params?.key !== "string") throw new Error("key required");
                send(ws, msg.id, getCursor(db, msg.params.key));
                return;
              }
              case "cursors.set": {
                if (typeof msg.params?.key !== "string" || typeof msg.params?.value !== "string") {
                  throw new Error("key and value required");
                }
                send(ws, msg.id, setCursor(db, msg.params.key, msg.params.value));
                return;
              }
              case "cursors.list":
                send(ws, msg.id, listCursors(db));
                return;
              case "cursors.delete": {
                if (typeof msg.params?.key !== "string") throw new Error("key required");
                send(ws, msg.id, { deleted: deleteCursor(db, msg.params.key) });
                return;
              }
              default:
                throw new Error(`unknown method: ${msg.method}`);
            }
          }

          if (msg.method === "relays.list") {
            send(ws, msg.id, db ? listRelays(db) : (nostr?.status() ?? []));
            return;
          }

          if (msg.method === "nostr.publish") {
            if (!nostr) throw new Error("nostr unavailable");
            const event = eventSchema.parse(msg.params?.event);
            await nostr.publish(event);
            send(ws, msg.id, { id: event.id });
            return;
          }

          if (msg.method === "nostr.query") {
            if (!nostr) throw new Error("nostr unavailable");
            if (!Array.isArray(msg.params?.filters) || msg.params.filters.length === 0) {
              throw new Error("filters array required");
            }
            const timeoutMs = msg.params?.timeoutMs;
            if (
              timeoutMs !== undefined &&
              (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000)
            ) {
              throw new Error("timeoutMs must be an integer between 1 and 60000");
            }
            send(ws, msg.id, await nostr.query(msg.params.filters, timeoutMs));
            return;
          }

          if (msg.method === "nostr.subscribe") {
            if (!nostr) throw new Error("nostr unavailable");
            if (!Array.isArray(msg.params?.filters) || msg.params.filters.length === 0) {
              throw new Error("filters array required");
            }
            const subscriptionId =
              typeof msg.params?.subscriptionId === "string" && msg.params.subscriptionId
                ? msg.params.subscriptionId
                : `sub:${Math.random().toString(36).slice(2)}`;
            if (subscriptions.has(subscriptionId)) {
              throw new Error(`subscription already exists: ${subscriptionId}`);
            }
            const key = `rpc:${connectionId}:${subscriptionId}`;
            const off = nostr.subscribe(key, msg.params.filters, (event) => {
              notify(ws, "nostr.event", { subscriptionId, event });
            });
            subscriptions.set(subscriptionId, off);
            send(ws, msg.id, { subscriptionId });
            return;
          }

          if (msg.method === "nostr.unsubscribe") {
            if (typeof msg.params?.subscriptionId !== "string") {
              throw new Error("subscriptionId required");
            }
            const off = subscriptions.get(msg.params.subscriptionId);
            if (off) {
              subscriptions.delete(msg.params.subscriptionId);
              off();
            }
            send(ws, msg.id, { closed: Boolean(off) });
            return;
          }

          if (msg.method === "trading.status") {
            send(ws, msg.id, trading?.status() ?? []);
            return;
          }

          if (msg.method === "recovery.status") {
            send(ws, msg.id, recovery?.current() ?? null);
            return;
          }

          if (msg.method === "session.state") {
            send(ws, msg.id, {
              wallet: wallet?.getStatus() ?? null,
              relays: db ? listRelays(db) : (nostr?.status() ?? []),
              operations: db ? listOperations(db, 2000) : [],
              escrows: db ? listEscrows(db, 2000) : [],
              disputes: db ? listDisputes(db, 2000) : [],
              trading: trading?.status() ?? [],
              recovery: recovery?.current() ?? null,
            });
            return;
          }

          if (!wallet) throw new Error("wallet unavailable");

          switch (msg.method) {
            case "wallet.status":
              send(ws, msg.id, wallet.getStatus());
              return;
            case "wallet.create": {
              if (!msg.params?.passphrase) throw new Error("passphrase required");
              const result = wallet.create(msg.params.passphrase);
              nostr?.startForIdentity(wallet);
              send(ws, msg.id, result);
              return;
            }
            case "wallet.import": {
              if (!msg.params?.mnemonic || !msg.params?.passphrase) {
                throw new Error("mnemonic and passphrase required");
              }
              const result = wallet.import(msg.params.mnemonic, msg.params.passphrase);
              nostr?.startForIdentity(wallet);
              send(ws, msg.id, result);
              return;
            }
            case "wallet.unlock": {
              if (!msg.params?.passphrase) throw new Error("passphrase required");
              const result = wallet.unlock(msg.params.passphrase);
              nostr?.startForIdentity(wallet);
              send(ws, msg.id, result);
              return;
            }
            case "wallet.getIdentity":
            case "nostr.getIdentity":
              send(ws, msg.id, wallet.getIdentity());
              return;
            case "nostr.signEvent":
              if (!msg.params?.template || typeof msg.params.template !== "object") {
                throw new Error("template required");
              }
              send(ws, msg.id, wallet.signEvent(msg.params.template));
              return;
            case "nostr.wrapDm":
              if (typeof msg.params?.recipient !== "string" || typeof msg.params?.content !== "string") {
                throw new Error("recipient and content required");
              }
              send(ws, msg.id, wallet.wrapDm(msg.params.recipient, msg.params.content));
              return;
            case "nostr.unwrapDm":
              if (!msg.params?.wrap || typeof msg.params.wrap !== "object") {
                throw new Error("wrap required");
              }
              send(ws, msg.id, wallet.unwrapDm(msg.params.wrap));
              return;
            case "nostr.nip44Encrypt":
              if (typeof msg.params?.recipient !== "string" || typeof msg.params?.plaintext !== "string") {
                throw new Error("recipient and plaintext required");
              }
              send(ws, msg.id, wallet.nip44Encrypt(msg.params.recipient, msg.params.plaintext));
              return;
            case "nostr.nip44Decrypt":
              if (typeof msg.params?.sender !== "string" || typeof msg.params?.payload !== "string") {
                throw new Error("sender and payload required");
              }
              send(ws, msg.id, wallet.nip44Decrypt(msg.params.sender, msg.params.payload));
              return;
            case "ark.getPublicKey":
              send(ws, msg.id, wallet.getIdentity());
              return;
            case "ark.signPsbt":
              if (typeof msg.params?.psbt !== "string") throw new Error("psbt required");
              send(ws, msg.id, await wallet.signPsbt(msg.params.psbt, msg.params.inputIndexes));
              return;
            case "ark.signPsbts":
              if (!Array.isArray(msg.params?.psbts)) throw new Error("psbts required");
              send(ws, msg.id, await wallet.signPsbts(msg.params.psbts, msg.params.inputIndexes));
              return;
            case "ark.signMessage":
              if (typeof msg.params?.message !== "string") throw new Error("message required");
              send(
                ws,
                msg.id,
                await wallet.signMessage(msg.params.message, msg.params.signatureType),
              );
              return;
            case "ark.signSchnorrDeterministic":
              if (typeof msg.params?.messageHash !== "string") throw new Error("messageHash required");
              send(ws, msg.id, await wallet.signSchnorrDeterministic(msg.params.messageHash));
              return;
            default:
              throw new Error(`unknown method: ${msg.method}`);
          }
        } catch (e) {
          fail(ws, msg.id, e);
        }
      })();
    });
  });

  console.log("[arkade-p2pd] RPC ready");
}
