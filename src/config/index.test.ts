import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { defaults, loadConfig } from "./index.js";

const dir = mkdtempSync(join(tmpdir(), "arkade-config-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const ENV_KEYS = [
  "DAEMON_CONFIG_PATH",
  "DAEMON_HOST",
  "DAEMON_PORT",
  "DAEMON_ALLOWED_ORIGINS",
  "DAEMON_DB_PATH",
  "DAEMON_RELAYS",
  "ARKADE_NETWORK",
  "WALLET_PATH",
];

function withEnv(overrides: Record<string, string>, run: () => void): void {
  const saved = new Map<string, string | undefined>();
  for (const key of ENV_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(overrides)) process.env[key] = value;
  try {
    run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function writeSettings(content: string): string {
  const path = join(dir, "settings.toml");
  writeFileSync(path, content);
  return path;
}

describe("loadConfig", () => {
  it("merges the settings file over the defaults", () => {
    const path = writeSettings(`
[daemon]
host = "0.0.0.0"
port = 9200
allowedOrigins = ["https://ui.example"]

[db]
path = "./data/custom.db"

[nostr]
relays = ["wss://a.example", "wss://b.example"]

[arkade]
network = "regtest"

[wallet]
path = "./data/wallet-custom.json"
`);

    withEnv({}, () => {
      assert.deepEqual(loadConfig(path), {
        daemon: {
          host: "0.0.0.0",
          port: 9200,
          allowedOrigins: ["https://ui.example"],
        },
        db: { path: "./data/custom.db" },
        nostr: { relays: ["wss://a.example", "wss://b.example"] },
        arkade: { network: "regtest" },
        wallet: { path: "./data/wallet-custom.json" },
      });
    });
  });

  it("lets environment variables override the file", () => {
    const path = writeSettings('[daemon]\nport = 9200\n[nostr]\nrelays = ["wss://file.example"]\n');
    withEnv(
      {
        DAEMON_HOST: "10.0.0.1",
        DAEMON_PORT: "9300",
        DAEMON_ALLOWED_ORIGINS: "https://a.example, https://b.example",
        DAEMON_DB_PATH: "./env.db",
        DAEMON_RELAYS: "wss://env1.example,wss://env2.example",
        ARKADE_NETWORK: "signet",
        WALLET_PATH: "./env-wallet.json",
      },
      () => {
        assert.deepEqual(loadConfig(path), {
          daemon: {
            host: "10.0.0.1",
            port: 9300,
            allowedOrigins: ["https://a.example", "https://b.example"],
          },
          db: { path: "./env.db" },
          nostr: { relays: ["wss://env1.example", "wss://env2.example"] },
          arkade: { network: "signet" },
          wallet: { path: "./env-wallet.json" },
        });
      },
    );
  });

  it("honours DAEMON_CONFIG_PATH and falls back to defaults without a file", () => {
    const path = writeSettings('[arkade]\nnetwork = "regtest"\n');
    withEnv({ DAEMON_CONFIG_PATH: path }, () => {
      assert.equal(loadConfig(join(dir, "missing.toml")).arkade.network, "regtest");
    });
    withEnv({}, () => {
      assert.deepEqual(loadConfig(join(dir, "missing.toml")), defaults);
    });
  });

  it("rejects an invalid port", () => {
    withEnv({ DAEMON_PORT: "70000" }, () => {
      assert.throws(() => loadConfig(join(dir, "missing.toml")), /DAEMON_PORT/);
    });
  });
});
