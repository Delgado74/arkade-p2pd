import { WebSocketServer, type WebSocket } from "ws";
import type { Config } from "../config/index.js";
import type { Wallet } from "../wallet/index.js";

function send(ws: WebSocket, id: unknown, result: unknown) {
  ws.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
}

function fail(ws: WebSocket, id: unknown, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const code = /locked/i.test(message) ? -32001 : /not found|unknown method/i.test(message) ? -32601 : -32000;
  ws.send(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }));
}

export async function startRpc(config: Config, wallet?: Wallet) {
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
