import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, after } from "node:test";
import { createBackup, addScreenshot, primaryProject } from "../worker/src/project.ts";
import { sha256Hex } from "../local/disk.ts";
import { installBackup } from "../local/import-project.ts";
import { Disk } from "../local/disk.ts";
import { assertBindAllowed, startServer } from "../local/server.ts";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const servers: { close: () => Promise<void> }[] = [];
const dirs: string[] = [];

after(async () => {
  await Promise.all(servers.map((server) => server.close()));
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "appscreen-local-"));
  dirs.push(dir);
  return dir;
}

describe("local screenshot server", () => {
  it("refuses to start without a token when the bind address is not loopback", () => {
    assert.throws(() => assertBindAllowed("0.0.0.0", ""), /Refusing to start/);
    assert.doesNotThrow(() => assertBindAllowed("127.0.0.1", ""));
    assert.doesNotThrow(() => assertBindAllowed("0.0.0.0", "secret"));
  });

  it("serves the editor, MCP tools, and project sync on loopback without a token", async () => {
    const dataDir = await tempDir();
    const server = await startServer({ port: 0, host: "127.0.0.1", dataDir, token: "" });
    servers.push(server);
    const helper = await fetch(`${server.origin}/render-ready.js`);
    assert.equal(helper.status, 200);
    assert.match(await helper.text(), /AppscreenReady/);

    const listed = await rpc(server.origin, "tools/list", {});
    const tools = listed.result.tools as { name: string }[];
    const names = tools.map((tool) => tool.name);
    assert.equal(names.length, 17);
    assert.ok(names.includes("import_remote_project"));
    assert.ok(names.includes("render_preview"));
    assert.ok(names.includes("set_panoramic_background"));

    const created = await rpc(server.origin, "tools/call", {
      name: "create_project",
      arguments: { name: "HomeBooks" },
    });
    const data = JSON.parse(created.result.content[0].text);
    assert.equal(data.name, "HomeBooks");
    assert.match(data.edit_url, /api=/);

    const got = await fetch(`${server.origin}/api/projects/${data.project_id}`, {
      headers: { "X-Edit-Key": data.edit_key, Accept: "application/json" },
    });
    assert.equal(got.status, 200);
    const backup = await got.json();
    backup.projects[0].defaults.text.headlineSize = 112;
    const put = await fetch(`${server.origin}/api/projects/${data.project_id}`, {
      method: "PUT",
      headers: { "X-Edit-Key": data.edit_key, "Content-Type": "application/json" },
      body: JSON.stringify(backup),
    });
    assert.equal(put.status, 200);
    const again = await fetch(`${server.origin}/api/projects/${data.project_id}`, {
      headers: { "X-Edit-Key": data.edit_key },
    });
    const saved = await again.json();
    assert.equal(saved.projects[0].defaults.text.headlineSize, 112);

    const denied = await fetch(`${server.origin}/api/projects/${data.project_id}`);
    assert.equal(denied.status, 401);
  });

  it("requires the bearer token on /mcp when one is configured", async () => {
    const dataDir = await tempDir();
    const server = await startServer({ port: 0, host: "127.0.0.1", dataDir, token: "local-secret" });
    servers.push(server);
    const open = await fetch(`${server.origin}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(open.status, 401);
    const authed = await fetch(`${server.origin}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer local-secret" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    assert.equal(authed.status, 200);
  });

  it("imports a local backup and rejects an asset whose bytes do not match the hash", async () => {
    const dataDir = await tempDir();
    const assets = path.join(dataDir, "incoming");
    await mkdir(assets);
    const hash = sha256Hex(PNG);
    await writeFile(path.join(assets, hash), PNG);
    const id = "499a5563-b553-477b-aaeb-35221b7be91a";
    const backup = createBackup(id, "HomeBooks");
    addScreenshot(backup, { dataUrl: `asset:${hash}`, name: "screen.png" });
    const shot = primaryProject(backup).screenshots[0];
    shot.text = {
      ...shot.text,
      headlineFont: "'Rubik', sans-serif",
      headlineWeight: 600,
      headlineSize: 112,
      headlineLetterSpacing: -2,
      headlineLineHeight: 106,
      subheadlineFont: "'Rubik', sans-serif",
      subheadlineWeight: 400,
      subheadlineSize: 58,
      subheadlineColor: "#4A3C30",
      textGap: 22,
      headlineTextWrap: "balance",
      subheadlineTextWrap: "balance",
      subheadlineEnabled: true,
    };
    const before = JSON.stringify(shot.text);
    const disk = new Disk(path.join(dataDir, "store"));
    const installed = await installBackup(disk, backup, { assetsDir: assets, editKey: "k".repeat(64), id });
    const stored = await disk.get(installed.envelope.id);
    assert.ok(stored);
    assert.equal(JSON.stringify(primaryProject(stored.backup).screenshots[0].text), before);
    assert.equal(stored.backup.projects[0].screenshots[0].localizedImages.en.src, `asset:${hash}`);
    const onDisk = await readFile(disk.assetPath(hash));
    assert.equal(sha256Hex(onDisk), hash);

    const badDir = path.join(dataDir, "bad");
    await mkdir(badDir);
    await writeFile(path.join(badDir, hash), Buffer.from("not-the-png"));
    const other = new Disk(path.join(dataDir, "other"));
    await assert.rejects(() => installBackup(other, backup, { assetsDir: badDir, id }), /sha256 does not match/);
    assert.equal(await other.hasAsset(hash), false);
  });
});

async function rpc(origin: string, method: string, params: unknown): Promise<{ result: Record<string, any> }> {
  const response = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return JSON.parse(text) as { result: Record<string, any> };
}
