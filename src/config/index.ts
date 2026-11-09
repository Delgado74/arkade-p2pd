import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseToml, type TomlTable } from "./toml.js";

export interface Config {
  daemon: { host: string; port: number; allowedOrigins: string[] };
  db: { path: string };
  nostr: { relays: string[] };
  arkade: { network: string };
  wallet: { path: string };
}

export const defaults: Config = {
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
  db: { path: "./data/daemon.db" },
  nostr: { relays: ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.primal.net"] },
  arkade: { network: "mutinynet" },
  wallet: { path: "./data/wallet.json" },
};

function tableAt(table: TomlTable | undefined, key: string): TomlTable | undefined {
  const value = table?.[key];
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function stringAt(table: TomlTable | undefined, key: string, fallback: string): string {
  const value = table?.[key];
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function numberAt(table: TomlTable | undefined, key: string, fallback: number): number {
  const value = table?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringArrayAt(
  table: TomlTable | undefined,
  key: string,
  fallback: string[],
): string[] {
  const value = table?.[key];
  if (!Array.isArray(value)) return fallback;
  const strings = value.filter((item): item is string => typeof item === "string");
  return strings.length === value.length && strings.length > 0 ? strings : fallback;
}

function fromToml(base: Config, root: TomlTable): Config {
  const daemon = tableAt(root, "daemon");
  const db = tableAt(root, "db");
  const nostr = tableAt(root, "nostr");
  const arkade = tableAt(root, "arkade");
  const wallet = tableAt(root, "wallet");
  return {
    daemon: {
      host: stringAt(daemon, "host", base.daemon.host),
      port: numberAt(daemon, "port", base.daemon.port),
      allowedOrigins: stringArrayAt(
        daemon,
        "allowedOrigins",
        base.daemon.allowedOrigins,
      ),
    },
    db: { path: stringAt(db, "path", base.db.path) },
    nostr: { relays: stringArrayAt(nostr, "relays", base.nostr.relays) },
    arkade: { network: stringAt(arkade, "network", base.arkade.network) },
    wallet: { path: stringAt(wallet, "path", base.wallet.path) },
  };
}

function splitList(raw: string | undefined): string[] | null {
  if (raw === undefined) return null;
  const items = raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : null;
}

function fromEnv(base: Config): Config {
  const origins = splitList(process.env.DAEMON_ALLOWED_ORIGINS);
  const relays = splitList(process.env.DAEMON_RELAYS);
  const portRaw = process.env.DAEMON_PORT?.trim();
  const port = portRaw ? Number(portRaw) : base.daemon.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`DAEMON_PORT must be an integer between 1 and 65535, got "${portRaw}"`);
  }
  return {
    daemon: {
      host: process.env.DAEMON_HOST?.trim() || base.daemon.host,
      port,
      allowedOrigins: origins ?? base.daemon.allowedOrigins,
    },
    db: { path: process.env.DAEMON_DB_PATH?.trim() || base.db.path },
    nostr: { relays: relays ?? base.nostr.relays },
    arkade: {
      network: process.env.ARKADE_NETWORK?.trim() || base.arkade.network,
    },
    wallet: { path: process.env.WALLET_PATH?.trim() || base.wallet.path },
  };
}

/**
 * Load the daemon configuration.
 *
 * Order: built-in defaults, then `settings.toml` (or `DAEMON_CONFIG_PATH`),
 * then environment overrides. A malformed file throws instead of silently
 * starting with defaults.
 */
export function loadConfig(
  path = resolve(process.cwd(), "settings.toml"),
): Config {
  const configPath = process.env.DAEMON_CONFIG_PATH?.trim() || path;
  const file = existsSync(configPath) ? parseToml(readFileSync(configPath, "utf8")) : {};
  return fromEnv(fromToml(defaults, file));
}
