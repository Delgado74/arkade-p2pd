import { loadConfig } from "./config/index.js";
import { startRpc } from "./rpc/server.js";
import { Wallet } from "./wallet/index.js";
import { Nostr } from "./nostr/index.js";
import { Trading } from "./trading/index.js";
import { Recovery } from "./recovery/index.js";
import { openDb, SCHEMA_VERSION } from "./db/index.js";

async function main() {
  const config = loadConfig();
  console.log("[arkade-p2pd] starting...");
  console.log(`[arkade-p2pd] RPC: ws://${config.daemon.host}:${config.daemon.port}`);

  const { db, path, close } = openDb(config.db.path);
  console.log(`[arkade-p2pd] db: ${path} (schema v${SCHEMA_VERSION})`);

  const wallet = new Wallet(config.wallet.path);
  await wallet.init();

  const nostr = new Nostr(config, db);
  await nostr.start();

  const shutdown = () => {
    nostr.stop();
    close();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  const trading = new Trading(db);
  await trading.start();

  const recovery = new Recovery(db);
  await recovery.start();

  await startRpc(config, wallet, db, nostr, trading, recovery);
  console.log("[arkade-p2pd] ready - status:", wallet.status);
}

main().catch((e) => {
  console.error("[arkade-p2pd] fatal:", e);
  process.exit(1);
});
