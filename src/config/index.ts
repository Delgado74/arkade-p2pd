import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

export interface Config {
  daemon: { host: string; port: number; allowedOrigins: string[] };
  nostr: { relays: string[] };
  arkade: { network: string };
  wallet: { path: string };
}

const defaults: Config = {
  daemon: {
    host: "127.0.0.1",
    port: 9100,
    // Browser origins allowed to open the local signing RPC. Add the origin
    // that serves the UI (for example https://user.github.io) before deploying.
    allowedOrigins: [
      "http://localhost:5173",
      "http://127.0.0.1:5173",
      "http://localhost:4173",
      "http://127.0.0.1:4173",
      "https://delgado74.github.io",
    ],
  },
  nostr: { relays: ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.primal.net"] },
  arkade: { network: "mutinynet" },
  wallet: { path: "./data/wallet.json" },
};

function withEnv(config: Config): Config {
  const origins = process.env.DAEMON_ALLOWED_ORIGINS?.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  return {
    ...config,
    daemon: {
      ...config.daemon,
      ...(origins && origins.length > 0 ? { allowedOrigins: origins } : {}),
    },
  };
}

export function loadConfig(): Config {
  const path = resolve(process.cwd(), "settings.toml");
  if (!existsSync(path)) {
    return withEnv(defaults);
  }
  try {
    const raw = readFileSync(path, "utf8");
    // Minimal parser - replace with toml later if needed
    return withEnv({ ...defaults });
  } catch {
    return withEnv(defaults);
  }
}
