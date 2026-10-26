import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { route } from "../src/http.ts";
import type { Env, KvLike } from "../src/types.ts";
import { createMemoryKv } from "./memory-kv.ts";

function env(kv: KvLike = createMemoryKv()): Env {
  return {
    APPSCREEN_KV: kv,
    APPSCREEN_MCP_TOKEN: "test-token",
    PAGES_ORIGIN: "https://matinrahimik.github.io",
    PAGES_PATH: "/homebooks-appscreen/",
    PUBLIC_BASE_URL: "https://homebooks-appscreen-mcp.matinrahimi.workers.dev",
    BROWSER: {},
  };
}

const PROJECT = "https://homebooks-appscreen-mcp.matinrahimi.workers.dev/api/projects/499a5563-b553-477b-aaeb-35221b7be91a?cb=1";

describe("render page preflight", () => {
  it("allows the cache-control header the render page used to send", async () => {
    const response = await route(new Request(PROJECT, {
      method: "OPTIONS",
      headers: {
        Origin: "https://matinrahimik.github.io",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "cache-control,x-edit-key",
      },
    }), env());
    assert.equal(response.status, 204);
    const allow = response.headers.get("access-control-allow-headers") || "";
    assert.match(allow, /cache-control/i);
    assert.match(allow, /x-edit-key/i);
    assert.equal(response.headers.get("access-control-allow-origin"), "https://matinrahimik.github.io");
    assert.equal(response.headers.get("access-control-max-age"), "600");
  });

  it("echoes an extra requested header and ignores a foreign origin", async () => {
    const extra = await route(new Request(PROJECT, {
      method: "OPTIONS",
      headers: {
        Origin: "http://127.0.0.1:8011",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "x-edit-key, x-extra-debug",
      },
    }), env());
    assert.match(extra.headers.get("access-control-allow-headers") || "", /x-extra-debug/i);

    const foreign = await route(new Request(PROJECT, {
      method: "OPTIONS",
      headers: {
        Origin: "https://evil.example",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "cache-control,x-edit-key",
      },
    }), env());
    assert.equal(foreign.status, 204);
    assert.equal(foreign.headers.get("access-control-allow-origin"), null);
  });
});
