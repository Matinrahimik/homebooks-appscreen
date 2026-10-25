import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertPanoramaBytes, MAX_PANORAMA_BYTES } from "../src/assets.ts";
import { route } from "../src/http.ts";
import { getText, putText } from "../src/kvblob.ts";
import { addScreenshot, createBackup } from "../src/project.ts";
import type { Env, KvLike } from "../src/types.ts";
import { createMemoryKv } from "./memory-kv.ts";

const TOKEN = "test-token";

function env(kv: KvLike = createMemoryKv()): Env {
  return {
    APPSCREEN_KV: kv,
    APPSCREEN_MCP_TOKEN: TOKEN,
    PAGES_ORIGIN: "https://matinrahimik.github.io",
    PAGES_PATH: "/homebooks-appscreen/",
    PUBLIC_BASE_URL: "https://homebooks-appscreen-mcp.matinrahimi.workers.dev",
    BROWSER: {},
  };
}

async function rpc(e: Env, name: string, args: Record<string, unknown> = {}) {
  const response = await route(new Request("https://homebooks-appscreen-mcp.matinrahimi.workers.dev/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  }), e);
  const json = await response.json() as { result?: { content?: { text?: string }[]; isError?: boolean } };
  return json;
}

function toolData(json: { result?: { content?: { text?: string }[]; isError?: boolean } }): Record<string, unknown> {
  assert.equal(json.result?.isError, false, json.result?.content?.[0]?.text);
  return JSON.parse(json.result?.content?.[0]?.text || "{}") as Record<string, unknown>;
}

describe("image assets and project writes", () => {
  it("splits a legacy backup into asset blobs and then edits settings without reading image bytes", async () => {
    const kv = createMemoryKv();
    const e = env(kv);
    const id = "499a5563-b553-477b-aaeb-35221b7be91a";
    const shot = `data:image/png;base64,${Buffer.from([9, 8, 7, 6]).toString("base64")}`;
    const pano = `data:image/jpeg;base64,${Buffer.from([1, 2, 3, 4, 5]).toString("base64")}`;
    const dump = createBackup(id, "Stuck");
    addScreenshot(dump, { dataUrl: shot, name: "library.png" });
    dump.projects[0].panoramicBackground = { enabled: true, src: pano, overlap: 0.1, scale: 100, offsetY: 0 };
    const stamp = "2026-10-25T00:00:00.000Z";
    await putText(kv, `proj:${id}:backup`, JSON.stringify(dump));
    await kv.put(`proj:${id}:envelope`, JSON.stringify({
      id,
      name: "Stuck",
      editKey: "edit-key",
      createdAt: stamp,
      updatedAt: stamp,
      screenshotCount: 1,
      fileTokens: [],
    }));

    const gets: string[] = [];
    const originalGet = kv.get.bind(kv);
    kv.get = async (key: string, options?: { type?: "text" | "json" | "arrayBuffer" }) => {
      gets.push(key);
      return originalGet(key, options);
    };

    const moved = toolData(await rpc(e, "update_screenshot_settings", {
      project_id: id,
      index: 0,
      settings: { screenshot: { y: 92 } },
    }));
    const movedShot = (moved.summary as { screenshots: { screenshot: { y: number } }[] }).screenshots[0];
    assert.equal(movedShot.screenshot.y, 92);
    assert.equal(await getText(kv, `proj:${id}:backup`), null);

    const stored = String(await kv.get(`proj:${id}:doc`));
    assert.match(stored, /asset:[a-f0-9]{64}/);
    assert.equal(stored.includes("base64"), false);
    assert.ok(stored.length < 20000);

    gets.length = 0;
    const again = toolData(await rpc(e, "update_screenshot_settings", {
      project_id: id,
      index: 0,
      settings: { screenshot: { y: 93 } },
    }));
    assert.equal((again.summary as { screenshots: { screenshot: { y: number } }[] }).screenshots[0].screenshot.y, 93);
    assert.equal(gets.some((key) => key.startsWith("asset:")), false);

    const live = await route(new Request(`https://homebooks-appscreen-mcp.matinrahimi.workers.dev/api/projects/${id}`, {
      headers: { "X-Edit-Key": "edit-key", origin: "http://localhost:8000" },
    }), e);
    assert.equal(live.status, 200);
    const body = await live.json() as { projects: { screenshots: { src: string }[]; panoramicBackground: { src: string } }[] };
    assert.match(body.projects[0].screenshots[0].src, /^https:\/\/homebooks-appscreen-mcp\.matinrahimi\.workers\.dev\/assets\/[a-f0-9]{64}$/);
    assert.match(body.projects[0].panoramicBackground.src, /\/assets\/[a-f0-9]{64}$/);
    assert.equal(live.headers.get("access-control-allow-origin"), "http://localhost:8000");

    const full = toolData(await rpc(e, "get_project", { project_id: id, include_backup: true }));
    const backup = full.backup as { projects: { screenshots: { src: string }[]; panoramicBackground: { src: string } }[] };
    assert.match(backup.projects[0].screenshots[0].src, /^data:image\/png;base64,/);
    assert.match(backup.projects[0].panoramicBackground.src, /^data:image\/jpeg;base64,/);
  });

  it("keeps every parallel add_screenshot", async () => {
    const e = env();
    const created = toolData(await rpc(e, "create_project", { name: "Parallel" }));
    const id = String(created.project_id);
    await Promise.all([0, 1, 2, 3, 4, 5].map((n) => rpc(e, "add_screenshot", {
      project_id: id,
      name: `shot-${n}.png`,
      image_base64: Buffer.from([n, n + 1, n + 2]).toString("base64"),
    })));
    const loaded = toolData(await rpc(e, "get_project", { project_id: id, include_backup: true }));
    const shots = (loaded.backup as { projects: { screenshots: { name: string }[] }[] }).projects[0].screenshots;
    assert.equal(shots.length, 6);
    const names = shots.map((shot) => shot.name).sort();
    assert.deepEqual(names, [0, 1, 2, 3, 4, 5].map((n) => `shot-${n}.png`));
  });

  it("rejects a new panorama above 8 MiB and says how to retry", async () => {
    assert.throws(
      () => assertPanoramaBytes(MAX_PANORAMA_BYTES + 1),
      /8 MiB/,
    );
    const e = env();
    const created = toolData(await rpc(e, "create_project", { name: "Pano" }));
    const id = String(created.project_id);
    const tooBig = Buffer.alloc(MAX_PANORAMA_BYTES + 1, 7).toString("base64");
    const rejected = await rpc(e, "set_panoramic_background", { project_id: id, image_base64: tooBig });
    assert.equal(rejected.result?.isError, true);
    const message = rejected.result?.content?.[0]?.text || "";
    assert.match(message, /8 MiB/);
    assert.match(message, /JPEG/);
    assert.match(message, /set_panoramic_background/);

    const ok = toolData(await rpc(e, "set_panoramic_background", {
      project_id: id,
      image_base64: Buffer.from([1, 2, 3]).toString("base64"),
    }));
    assert.equal((ok.panoramicBackground as { enabled: boolean }).enabled, true);
  });
});
