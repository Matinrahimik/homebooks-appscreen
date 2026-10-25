import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { tokensEqual } from "../src/auth.ts";
import { route } from "../src/http.ts";
import { TOOLS } from "../src/tools.ts";
import type { Env, RenderShot } from "../src/types.ts";
import { createMemoryKv } from "./memory-kv.ts";

const TOKEN = "test-token";

function env(): Env {
  return {
    APPSCREEN_KV: createMemoryKv(),
    APPSCREEN_MCP_TOKEN: TOKEN,
    PAGES_ORIGIN: "https://matinrahimik.github.io",
    PAGES_PATH: "/homebooks-appscreen/",
    PUBLIC_BASE_URL: "https://homebooks-appscreen-mcp.matinrahimi.workers.dev",
    BROWSER: {},
  };
}

function mcp(body: unknown, token = TOKEN, headers: Record<string, string> = {}): Request {
  return new Request("https://homebooks-appscreen-mcp.matinrahimi.workers.dev/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

async function rpc(e: Env, method: string, params: Record<string, unknown> = {}, id = 1, token = TOKEN) {
  const response = await route(mcp({ jsonrpc: "2.0", id, method, params }, token), e, async (_url, indices) => {
    return indices.map((index): RenderShot => ({
      index,
      png: new Uint8Array([137, 80, 78, 71, index]),
      width: 1320,
      height: 2868,
    }));
  });
  const json = await response.json() as { result?: { content?: { type: string; text?: string; data?: string }[]; isError?: boolean }; error?: { message: string } };
  return { status: response.status, json };
}

function toolData(payload: { json?: { result?: { content?: { text?: string }[]; isError?: boolean }; error?: { message?: string } }; result?: { content?: { text?: string }[]; isError?: boolean }; error?: { message?: string } }): Record<string, unknown> {
  const json = payload.json ? payload.json : payload;
  assert.equal(json.result?.isError, false, JSON.stringify(json.error || json.result || json));
  return JSON.parse(json.result?.content?.[0].text || "{}") as Record<string, unknown>;
}

describe("auth", () => {
  it("compares bearer tokens without trusting a prefix", () => {
    assert.equal(tokensEqual("secret", "secret"), true);
    assert.equal(tokensEqual("secret", "secre"), false);
    assert.equal(tokensEqual("secret", "Secret"), false);
    assert.equal(tokensEqual("", ""), true);
  });

  it("rejects MCP calls without the Worker secret", async () => {
    const e = env();
    const missing = await route(mcp({ jsonrpc: "2.0", id: 1, method: "tools/list" }, ""), e);
    assert.equal(missing.status, 401);
    const wrong = await rpc(e, "tools/list", {}, 1, "nope");
    assert.equal(wrong.status, 401);
  });
});

describe("mcp tools", () => {
  it("lists the full tool set from initialize and tools/list", async () => {
    const e = env();
    const init = await rpc(e, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "0" } });
    assert.equal(init.status, 200);
    assert.equal((init.json.result as { serverInfo: { name: string } }).serverInfo.name, "homebooks-appscreen");
    const listed = await rpc(e, "tools/list");
    const names = ((listed.json.result as { tools: { name: string }[] }).tools).map((tool) => tool.name);
    assert.deepEqual(names, TOOLS.map((tool) => tool.name));
    assert.ok(names.includes("render_preview"));
    assert.ok(names.includes("describe_options"));
    assert.ok(names.includes("get_schema"));
  });

  it("creates a project, edits the backup, and returns mocked render URLs", async () => {
    const e = env();
    const created = toolData(await rpc(e, "tools/call", { name: "create_project", arguments: { name: "HomeBooks" } }));
    const id = String(created.project_id);
    assert.match(String(created.edit_url), new RegExp(`project=${id}`));
    assert.match(String(created.edit_url), /matinrahimik\.github\.io\/homebooks-appscreen/);
    const editKey = String(created.edit_key);

    const tiny = Buffer.from([137, 80, 78, 71]).toString("base64");
    const added = toolData(await rpc(e, "tools/call", {
      name: "add_screenshot",
      arguments: { project_id: id, name: "library.png", image_base64: tiny, language: "en" },
    }));
    assert.equal(added.index, 0);

    const styled = toolData(await rpc(e, "tools/call", {
      name: "update_screenshot_settings",
      arguments: {
        project_id: id,
        index: 0,
        settings: {
          headline: "Your household library",
          headlineFont: "Fraunces",
          positionPreset: "centered",
          background: { gradientPreset: "Indigo Rush" },
        },
      },
    }));
    const summary = styled.summary as { screenshots: { headlines: { en: string }; background: { gradient: { angle: number } } }[] };
    assert.equal(summary.screenshots[0].headlines.en, "Your household library");
    assert.equal(summary.screenshots[0].background.gradient.angle, 135);

    const framed = toolData(await rpc(e, "tools/call", {
      name: "update_screenshot_settings",
      arguments: {
        project_id: id,
        index: 0,
        settings: {
          font_family: "Rubik",
          font_weight: "700",
          textGap: 36,
          textGapUnit: "px",
          headlineLetterSpacing: 2,
          subheadlineLetterSpacing: -1,
          subheadline: "Every shelf",
          screenshot: {
            use3D: true,
            scale: 150,
            x: -40,
            y: 170,
            rotation3D: { x: 12, y: -18, z: 6 },
          },
          background: {
            type: "image",
            imageSrc: "data:image/png;base64,QQ==",
            imageOffsetX: 12,
            imageOffsetY: -8,
            imageScale: 130,
          },
        },
      },
    }));
    const framedShot = (framed.summary as { screenshots: { screenshot: { scale: number; x: number; rotation3D: { z: number } }; headlineFont: string }[] }).screenshots[0];
    assert.equal(framedShot.screenshot.scale, 150);
    assert.equal(framedShot.screenshot.x, -40);
    assert.equal(framedShot.screenshot.rotation3D.z, 6);
    assert.equal(framedShot.headlineFont, "'Rubik', sans-serif");

    const pano = toolData(await rpc(e, "tools/call", {
      name: "set_panoramic_background",
      arguments: { project_id: id, image_base64: tiny, overlap: 0.25, scale: 110, offset_y: 5 },
    }));
    assert.equal((pano.panoramicBackground as { enabled: boolean }).enabled, true);
    assert.equal((pano.panoramicBackground as { overlap: number }).overlap, 0.25);

    const viewed = toolData(await rpc(e, "tools/call", { name: "get_project", arguments: { project_id: id } }));
    const viewedSummary = viewed.summary as {
      panoramicBackground: { enabled: boolean; hasImage: boolean; overlap: number; src: string };
      screenshots: {
        backgroundState: { type: string; effective: string; hasImage: boolean };
        headlineSize: number;
        headlineWeight: string;
        subheadlineEnabled: boolean;
        headlineTextWrap: string;
        subheadlineTextWrap: string;
      }[];
    };
    assert.equal(viewedSummary.panoramicBackground.enabled, true);
    assert.equal(viewedSummary.panoramicBackground.hasImage, true);
    assert.equal(viewedSummary.panoramicBackground.overlap, 0.25);
    assert.match(viewedSummary.panoramicBackground.src, /^asset:[a-f0-9]{64}$/);
    assert.equal(viewedSummary.screenshots[0].backgroundState.effective, "panorama");
    assert.equal(viewedSummary.screenshots[0].headlineWeight, "700");
    assert.equal(viewedSummary.screenshots[0].subheadlineEnabled, true);
    assert.equal(viewedSummary.screenshots[0].headlineTextWrap, "wrap");
    assert.equal(viewedSummary.screenshots[0].subheadlineTextWrap, "wrap");
    assert.equal(typeof viewedSummary.screenshots[0].headlineSize, "number");

    const sized = toolData(await rpc(e, "tools/call", {
      name: "set_output_size",
      arguments: { project_id: id, device: "iphone-6.5" },
    }));
    assert.equal(sized.width, 1284);
    assert.equal(sized.height, 2778);

    const preview = await rpc(e, "tools/call", {
      name: "render_preview",
      arguments: { project_id: id, index: 0, inline: true },
    });
    const previewData = toolData(preview.json);
    assert.match(String(previewData.url), /\/f\/[a-f0-9]+\/screenshot-1\.png$/);
    assert.equal(preview.json.result?.content?.[1].type, "image");

    const fileUrl = new URL(String(previewData.url));
    const file = await route(new Request(fileUrl), e);
    assert.equal(file.status, 200);
    assert.equal(file.headers.get("content-type"), "image/png");
    const downloaded = new Uint8Array(await file.arrayBuffer());
    assert.equal(downloaded[0], 137);

    const exported = toolData(await rpc(e, "tools/call", { name: "export_project", arguments: { project_id: id } }));
    assert.equal((exported.pngs as unknown[]).length, 1);
    assert.match(String(exported.zip_url), /screenshots\.zip$/);

    const live = await route(new Request(`https://homebooks-appscreen-mcp.matinrahimi.workers.dev/api/projects/${id}`, {
      headers: { "X-Edit-Key": editKey },
    }), e);
    assert.equal(live.status, 200);
    assert.equal(live.headers.get("cache-control"), "no-store");
    const backup = await live.json() as {
      projects: {
        panoramicBackground: { src: string; overlap: number };
        screenshots: {
          screenshot: { scale: number; y: number; rotation3D: { x: number } };
          background: { imageSrc: string; imageOffsetX: number; imageScale: number };
          text: { headlines: { en: string }; headlineFont: string; headlineWeight: string; textGap: number; headlineLetterSpacing: number; subheadlineLetterSpacing: number };
        }[];
      }[];
      meta: { key: string }[];
    };
    assert.equal(backup.projects[0].screenshots[0].text.headlines.en, "Your household library");
    assert.equal(backup.projects[0].screenshots[0].text.headlineFont, "'Rubik', sans-serif");
    assert.equal(backup.projects[0].screenshots[0].text.headlineWeight, "700");
    assert.equal(backup.projects[0].screenshots[0].text.textGap, 36);
    assert.equal(backup.projects[0].screenshots[0].text.headlineLetterSpacing, 2);
    assert.equal(backup.projects[0].screenshots[0].text.subheadlineLetterSpacing, -1);
    assert.equal(backup.projects[0].screenshots[0].screenshot.scale, 150);
    assert.equal(backup.projects[0].screenshots[0].screenshot.y, 170);
    assert.equal(backup.projects[0].screenshots[0].screenshot.rotation3D.x, 12);
    assert.match(backup.projects[0].screenshots[0].background.imageSrc, /\/assets\/[a-f0-9]{64}$/);
    assert.equal(backup.projects[0].screenshots[0].background.imageOffsetX, 12);
    assert.equal(backup.projects[0].screenshots[0].background.imageScale, 130);
    assert.equal(backup.projects[0].panoramicBackground.overlap, 0.25);
    assert.match(backup.projects[0].panoramicBackground.src, /\/assets\/[a-f0-9]{64}$/);
    const asset = await route(new Request(backup.projects[0].screenshots[0].background.imageSrc, {
      headers: { origin: "https://matinrahimik.github.io" },
    }), e);
    assert.equal(asset.status, 200);
    assert.equal(asset.headers.get("content-type"), "image/png");
    assert.equal(asset.headers.get("access-control-allow-origin"), "https://matinrahimik.github.io");
    assert.equal(new Uint8Array(await asset.arrayBuffer())[0], 65);
    assert.ok(backup.meta.some((m) => m.key === "projects"));

    const denied = await route(new Request(`https://homebooks-appscreen-mcp.matinrahimi.workers.dev/api/projects/${id}`), e);
    assert.equal(denied.status, 401);

    backup.projects[0].screenshots[0].text.headlines.en = "Edited in the app";
    const saved = await route(new Request(`https://homebooks-appscreen-mcp.matinrahimi.workers.dev/api/projects/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json", "X-Edit-Key": editKey, origin: "https://matinrahimik.github.io" },
      body: JSON.stringify(backup),
    }), e);
    assert.equal(saved.status, 200);
    assert.equal(saved.headers.get("access-control-allow-origin"), "https://matinrahimik.github.io");

    const again = toolData(await rpc(e, "tools/call", { name: "get_project", arguments: { project_id: id, include_backup: true } }));
    const roundTrip = again.backup as { projects: { screenshots: { text: { headlines: { en: string } }; background: { imageSrc: string } }[]; panoramicBackground: { src: string } }[] };
    assert.equal(roundTrip.projects[0].screenshots[0].text.headlines.en, "Edited in the app");
    assert.match(roundTrip.projects[0].screenshots[0].background.imageSrc, /^data:image\/png;base64,/);
    assert.match(roundTrip.projects[0].panoramicBackground.src, /^data:image\/png;base64,/);

    const options = toolData(await rpc(e, "tools/call", { name: "describe_options", arguments: {} }));
    assert.ok((options.positionPresets as { "tilt-left": { rotation: number } })["tilt-left"].rotation === -8);
    const optionsText = JSON.stringify(options);
    assert.match(optionsText, /108%/);
    assert.match(optionsText, /languageSettings\.<lang>\.headlineSize/);
    assert.deepEqual((options.textWrap as { headlineTextWrap: string[] }).headlineTextWrap, ["wrap", "balance"]);
    assert.match(String((options.textEnabled as { subheadlineEnabled: string }).subheadlineEnabled), /Defaults to false/);
    assert.match(String((options.textEnabled as { headlineEnabled: string }).headlineEnabled), /Defaults to true/);
    const schema = toolData(await rpc(e, "tools/call", { name: "get_schema", arguments: {} }));
    const schemaText = JSON.stringify(schema);
    assert.match(schemaText, /108%/);
    assert.match(schemaText, /headlineSize/);
    assert.match(schemaText, /headlineTextWrap/);

    const removed = toolData(await rpc(e, "tools/call", { name: "delete_project", arguments: { project_id: id } }));
    assert.equal(removed.deleted, true);
    const missing = await rpc(e, "tools/call", { name: "get_project", arguments: { project_id: id } });
    assert.equal(missing.json.result?.isError, true);
  });

  it("applies settings.text and returns an error for unknown keys", async () => {
    const e = env();
    const created = toolData(await rpc(e, "tools/call", { name: "create_project", arguments: { name: "HomeBooks" } }));
    const id = String(created.project_id);
    const tiny = Buffer.from([137, 80, 78, 71]).toString("base64");
    toolData(await rpc(e, "tools/call", {
      name: "add_screenshot",
      arguments: { project_id: id, image_base64: tiny },
    }));
    const styled = toolData(await rpc(e, "tools/call", {
      name: "update_global_settings",
      arguments: {
        project_id: id,
        settings: {
          text: {
            font_family: "Rubik",
            font_weight: "600",
            headline: "Nested headline",
            subheadline: "Nested subheadline",
          },
        },
      },
    }));
    const summary = styled.summary as {
      defaults: { screenshot: { y: number; scale: number }; text: { headlineFont: string; headlineWeight: string; subheadlines: { en: string } } };
      screenshots: { headlineFont: string; headlines: { en: string }; subheadlines: { en: string } }[];
    };
    assert.equal(summary.defaults.screenshot.y, 100);
    assert.equal(summary.defaults.screenshot.scale, 70);
    assert.equal(summary.defaults.text.headlineFont, "'Rubik', sans-serif");
    assert.equal(summary.defaults.text.headlineWeight, "600");
    assert.equal(summary.defaults.text.subheadlines.en, "Nested subheadline");
    assert.equal(summary.screenshots[0].headlineFont, "'Rubik', sans-serif");
    assert.equal(summary.screenshots[0].headlines.en, "Nested headline");
    assert.equal(summary.screenshots[0].subheadlines.en, "Nested subheadline");

    const rejected = await rpc(e, "tools/call", {
      name: "update_screenshot_settings",
      arguments: { project_id: id, index: 0, settings: { text: { font_family: "Rubik", not_a_field: true } } },
    });
    assert.equal(rejected.json.result?.isError, true);
    assert.match(rejected.json.result?.content?.[0].text || "", /Unknown setting "settings\.text\.not_a_field"/);
    const still = toolData(await rpc(e, "tools/call", { name: "get_project", arguments: { project_id: id } }));
    const after = still.summary as { screenshots: { headlineFont: string }[] };
    assert.equal(after.screenshots[0].headlineFont, "'Rubik', sans-serif");
  });

  it("ships upload metadata for the Workers script API", () => {
    const metadata = JSON.parse(readFileSync(new URL("../deploy/metadata.json", import.meta.url), "utf8"));
    assert.equal(metadata.main_module, "worker.js");
    assert.equal(metadata.compatibility_date, "2026-10-25");
    assert.deepEqual(metadata.compatibility_flags, ["nodejs_compat"]);
    const kv = metadata.bindings.find((binding: { type: string }) => binding.type === "kv_namespace");
    const browser = metadata.bindings.find((binding: { type: string }) => binding.type === "browser");
    assert.equal(kv.name, "APPSCREEN_KV");
    assert.equal(kv.namespace_id, "__KV_NAMESPACE_ID__");
    assert.equal(browser.name, "BROWSER");
    const gate = metadata.bindings.find((binding: { name: string }) => binding.name === "PROJECT_GATE");
    assert.equal(gate.type, "durable_object_namespace");
    assert.equal(gate.class_name, "ProjectGate");
    assert.equal(metadata.migrations, undefined);
  });

  it("refuses an export whose captures are identical for different images", async () => {
    const e = env();
    const created = toolData(await rpc(e, "tools/call", { name: "create_project", arguments: { name: "HomeBooks" } }));
    const id = String(created.project_id);
    const first = Buffer.from([137, 80, 78, 71, 1]).toString("base64");
    const second = Buffer.from([137, 80, 78, 71, 2]).toString("base64");
    toolData(await rpc(e, "tools/call", { name: "add_screenshot", arguments: { project_id: id, image_base64: first, name: "one.png" } }));
    toolData(await rpc(e, "tools/call", { name: "add_screenshot", arguments: { project_id: id, image_base64: second, name: "two.png" } }));
    let supplied = "";
    const response = await route(mcp({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "export_project", arguments: { project_id: id } },
    }), e, async (_url, indices, supply) => {
      supplied = supply?.projectBody || "";
      const png = new Uint8Array([137, 80, 78, 71, 9]);
      return indices.map((index) => ({ index, png, width: 10, height: 10 }));
    });
    const json = await response.json() as { result?: { isError?: boolean; content?: { text?: string }[] } };
    assert.equal(json.result?.isError, true);
    assert.match(json.result?.content?.[0].text || "", /byte-identical/);
    assert.match(supplied, /data:image\/png;base64,/);
    assert.equal(supplied.includes("/assets/"), false);
  });
});
