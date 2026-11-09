import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { parseToml } from "./toml.js";

describe("parseToml", () => {
  it("parses sections, strings, numbers, booleans and arrays", () => {
    const parsed = parseToml(`
# top comment
[daemon]
host = "127.0.0.1"
port = 9100
enabled = true
allowedOrigins = ["http://localhost:5173", "https://example.org"]

[nostr]
relays = [
  "wss://relay.damus.io",
  "wss://nos.lol",
]
`);

    assert.deepEqual(parsed, {
      daemon: {
        host: "127.0.0.1",
        port: 9100,
        enabled: true,
        allowedOrigins: ["http://localhost:5173", "https://example.org"],
      },
      nostr: { relays: ["wss://relay.damus.io", "wss://nos.lol"] },
    });
  });

  it("supports dotted sections and escapes", () => {
    const parsed = parseToml('[a.b]\npath = "C:\\\\data\\nfile.db"\n');
    assert.deepEqual(parsed, { a: { b: { path: "C:\\data\nfile.db" } } });
  });

  it("ignores comments inside strings", () => {
    const parsed = parseToml('[x]\nurl = "wss://relay.example/#fragment" # real comment\n');
    assert.deepEqual(parsed, { x: { url: "wss://relay.example/#fragment" } });
  });

  it("rejects malformed lines with their number", () => {
    assert.throws(() => parseToml("[x]\nkey 1\n"), /line 2/);
    assert.throws(() => parseToml("[x]\nkey = nope\n"), /line 2/);
    assert.throws(() => parseToml("[x\n"), /line 1/);
  });
});
