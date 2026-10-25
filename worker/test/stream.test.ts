import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { storeAsset } from "../src/assets.ts";
import { route } from "../src/http.ts";
import { chainChunkStreams, putBytes } from "../src/kvblob.ts";
import { publicFileKey, putStoreZip, writeRenderToken } from "../src/store.ts";
import type { Env } from "../src/types.ts";
import { crc32, storeZipStream, zipStore } from "../src/zip.ts";
import { createMemoryKv } from "./memory-kv.ts";

const ORIGIN = "https://homebooks-appscreen-mcp.matinrahimi.workers.dev";

function env(): Env {
  return { APPSCREEN_KV: createMemoryKv(), PUBLIC_BASE_URL: ORIGIN };
}

function sha(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function patterned(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i += 4096) bytes[i] = (i / 4096) & 255;
  bytes[size - 1] = 42;
  return bytes;
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    parts.push(next.value);
    size += next.value.byteLength;
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

describe("streamed assets", () => {
  it("opens chunk streams one at a time", async () => {
    const opened: number[] = [];
    const stream = chainChunkStreams(3, async (index) => {
      opened.push(index);
      return new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([index + 1, index + 2]));
          controller.close();
        },
      });
    });
    const reader = stream.getReader();
    const first = await reader.read();
    assert.deepEqual([...(first.value || [])], [1, 2]);
    assert.deepEqual(opened, [0]);
    const rest = await readAll(new ReadableStream({
      async pull(controller) {
        while (true) {
          const next = await reader.read();
          if (next.done) {
            controller.close();
            return;
          }
          controller.enqueue(next.value);
        }
      },
    }));
    assert.deepEqual([...rest], [2, 3, 3, 4]);
    assert.deepEqual(opened, [0, 1, 2]);
  });

  it("streams a multi-megabyte asset without buffering it in the isolate", async () => {
    const e = env();
    const kv = e.APPSCREEN_KV as ReturnType<typeof createMemoryKv>;
    const payload = patterned(2_500_000);
    const ref = await storeAsset(kv, payload, "image/png");
    const hash = ref.slice("asset:".length);
    await putBytes(kv, `asset:${hash}`, payload, "image/png", 8_000_000, 1_000_000);
    const meta = JSON.parse(String(await kv.get(`asset:${hash}:meta`))) as { chunks: number };
    assert.equal(meta.chunks, 3);
    const before = kv.gets.length;
    const response = await route(new Request(`${ORIGIN}/assets/${hash}`), e);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/png");
    assert.equal(response.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assert.equal(response.headers.get("content-length"), String(payload.byteLength));
    const got = new Uint8Array(await response.arrayBuffer());
    assert.equal(got.byteLength, payload.byteLength);
    assert.equal(sha(got), sha(payload));
    const during = kv.gets.slice(before);
    assert.equal(during.some((get) => get.type === "arrayBuffer"), false);
    assert.equal(during.filter((get) => get.type === "stream").length, 3);
    const missing = await route(new Request(`${ORIGIN}/assets/${"ab".repeat(32)}`), e);
    assert.equal(missing.status, 404);
    assert.equal(missing.headers.get("cache-control"), null);
  });
});

describe("render uploads", () => {
  it("streams a multi-megabyte PNG into KV and does not read it back in that request", async () => {
    const e = env();
    const kv = e.APPSCREEN_KV as ReturnType<typeof createMemoryKv>;
    const token = "cd".repeat(32);
    const payload = patterned(2_000_000);
    await writeRenderToken(kv, token, {
      projectId: "p1",
      index: 3,
      filename: "screenshot-4.png",
      uploaded: false,
    });
    const before = kv.gets.length;
    const response = await route(new Request(`${ORIGIN}/renders/${token}`, {
      method: "PUT",
      headers: {
        "content-type": "image/png",
        "content-length": String(payload.byteLength),
        "x-appscreen-crc": String(crc32(payload)),
        "x-appscreen-width": "1320",
        "x-appscreen-height": "2868",
        "x-appscreen-sha256": sha(payload),
        "x-appscreen-index": "3",
      },
      body: new Blob([payload], { type: "image/png" }),
    }), e);
    assert.equal(response.status, 200, await response.clone().text());
    const body = await response.json() as { ok: boolean; bytes: number };
    assert.equal(body.ok, true);
    assert.equal(body.bytes, payload.byteLength);
    assert.ok(kv.streamPuts.some((key) => key === `${publicFileKey(token)}:c:0`));
    assert.equal(kv.gets.slice(before).some((get) => get.type === "arrayBuffer"), false);
    const downloaded = await route(new Request(`${ORIGIN}/f/${token}/screenshot-4.png`), e);
    assert.equal(downloaded.status, 200);
    assert.equal(downloaded.headers.get("content-type"), "image/png");
    const got = new Uint8Array(await downloaded.arrayBuffer());
    assert.equal(sha(got), sha(payload));
  });

  it("rejects an oversized upload before reading the body", async () => {
    const e = env();
    const kv = e.APPSCREEN_KV as ReturnType<typeof createMemoryKv>;
    const token = "ef".repeat(32);
    await writeRenderToken(kv, token, {
      projectId: "p1",
      index: 0,
      filename: "screenshot-1.png",
      uploaded: false,
    });
    const response = await route(new Request(`${ORIGIN}/renders/${token}`, {
      method: "PUT",
      headers: {
        "content-type": "image/png",
        "content-length": String(25 * 1024 * 1024 + 1),
        "x-appscreen-crc": "1",
        "x-appscreen-width": "10",
        "x-appscreen-height": "10",
        "x-appscreen-sha256": "ab".repeat(32),
        "x-appscreen-index": "0",
      },
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array([1]));
          controller.close();
        },
      }),
      duplex: "half",
    }), e);
    assert.equal(response.status, 413);
    assert.match(await response.text(), /was not read/);
    assert.equal(kv.streamPuts.length, 0);
    assert.equal(kv.dump().has(`${publicFileKey(token)}:c:0`), false);
  });
});

describe("store zip", () => {
  it("matches an in-memory STORE zip and streams multi-megabyte entries", async () => {
    const payload = new Uint8Array([137, 80, 78, 71, 13, 10, 1, 2, 3]);
    const when = new Date("2026-01-02T03:04:05Z");
    const expected = zipStore([{ name: "screenshot-1.png", data: payload }], when);
    const streamed = await readAll(storeZipStream(
      [{ name: "screenshot-1.png", crc: crc32(payload), size: payload.byteLength }],
      async () => new ReadableStream({
        start(controller) {
          controller.enqueue(payload);
          controller.close();
        },
      }),
      when,
    ));
    assert.deepEqual([...streamed], [...expected]);

    const e = env();
    const kv = e.APPSCREEN_KV as ReturnType<typeof createMemoryKv>;
    const left = patterned(1_500_000);
    const right = patterned(1_700_000);
    right[0] = 7;
    await putBytes(kv, "file:left", left, "image/png", 8_000_000, 700_000);
    await putBytes(kv, "file:right", right, "image/png", 8_000_000, 700_000);
    const token = "12".repeat(32);
    await putStoreZip(kv, token, [
      { name: "screenshot-1.png", key: "file:left", crc: crc32(left), size: left.byteLength },
      { name: "screenshot-2.png", key: "file:right", crc: crc32(right), size: right.byteLength },
    ]);
    const before = kv.gets.length;
    const response = await route(new Request(`${ORIGIN}/f/${token}/screenshots.zip`), e);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/zip");
    const zip = new Uint8Array(await response.arrayBuffer());
    assert.equal(zip.byteLength, Number(response.headers.get("content-length")));
    assert.equal(kv.gets.slice(before).some((get) => get.type === "arrayBuffer"), false);
    assert.ok(kv.gets.slice(before).filter((get) => get.type === "stream").length >= 2);
    const entries = readZip(zip);
    assert.deepEqual(entries.map((entry) => entry.name), ["screenshot-1.png", "screenshot-2.png"]);
    assert.equal(sha(entries[0].data), sha(left));
    assert.equal(sha(entries[1].data), sha(right));
    assert.equal(entries[0].crc, crc32(left));
    assert.equal(entries[1].crc, crc32(right));
  });
});

function readZip(bytes: Uint8Array): { name: string; data: Uint8Array; crc: number }[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries: { name: string; data: Uint8Array; crc: number }[] = [];
  let offset = 0;
  while (offset + 30 <= bytes.byteLength && view.getUint32(offset, true) === 0x04034b50) {
    const crc = view.getUint32(offset + 14, true);
    const size = view.getUint32(offset + 18, true);
    const nameLen = view.getUint16(offset + 26, true);
    const name = new TextDecoder().decode(bytes.subarray(offset + 30, offset + 30 + nameLen));
    const start = offset + 30 + nameLen;
    entries.push({ name, data: bytes.slice(start, start + size), crc });
    offset = start + size;
  }
  return entries;
}
