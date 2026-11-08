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
import type { Wallet } from "../wallet/index.js";

function send(ws: WebSocket, id: unknown, result: unknown) {
  ws.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
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

export async function startRpc(config: Config, wallet?: Wallet, db?: Db) {
  const allowedOrigins = config.daemon.allowedOrigins;
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
    ws.send(JSON.stringify({ jsonrpc: "2.0", method: "hello", params: { name: "arkade-p2pd", version: "0.1.0" } }));

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

          if (!wallet) throw new Error("wallet unavailable");

          switch (msg.method) {
            case "wallet.status":
              send(ws, msg.id, wallet.getStatus());
              return;
            case "wallet.create":
              if (!msg.params?.passphrase) throw new Error("passphrase required");
              send(ws, msg.id, wallet.create(msg.params.passphrase));
              return;
            case "wallet.import":
              if (!msg.params?.mnemonic || !msg.params?.passphrase) {
                throw new Error("mnemonic and passphrase required");
              }
              send(ws, msg.id, wallet.import(msg.params.mnemonic, msg.params.passphrase));
              return;
            case "wallet.unlock":
              if (!msg.params?.passphrase) throw new Error("passphrase required");
              send(ws, msg.id, wallet.unlock(msg.params.passphrase));
              return;
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
