import { loadConfig } from "./config/index.js";
import { startRpc } from "./rpc/server.js";
import { Wallet } from "./wallet/index.js";
import { Nostr } from "./nostr/index.js";
import { Trading } from "./trading/index.js";
import { Recovery } from "./recovery/index.js";
import { openDb } from "./db/index.js";

async function main() {
  const config = loadConfig();
  console.log("[arkade-p2pd] starting...");
  console.log(`[arkade-p2pd] RPC: ws://${config.daemon.host}:${config.daemon.port}`);

  const db = openDb();
  const wallet = new Wallet(config.wallet.path);
  await wallet.init();

  const nostr = new Nostr(config);
  await nostr.start();

  const trading = new Trading();
  await trading.start();

  const recovery = new Recovery();
  await recovery.start();

  await startRpc(config, wallet);
  console.log("[arkade-p2pd] ready - status:", wallet.status);
}

main().catch((e) => {
  console.error("[arkade-p2pd] fatal:", e);
  process.exit(1);
});
