import type { KvLike } from "./types.ts";

/** Stay under the Workers KV 25 MiB value limit with room for metadata. */
export const KV_VALUE_LIMIT = 25 * 1024 * 1024;
export const CHUNK_BYTES = 8 * 1024 * 1024;
/** Hard cap for one logical object (project JSON or exported ZIP), across chunks. */
export const MAX_OBJECT_BYTES = 80 * 1024 * 1024;
/** Worst-case UTF-8 is 4 bytes per code unit. 4_000_000 chars ≤ 16 MiB. */
export const CHUNK_CHARS = 4_000_000;

export class KvLimitError extends Error {
  readonly code = "kv_limit";
  constructor(message: string) {
    super(message);
    this.name = "KvLimitError";
  }
}

export function assertObjectSize(bytes: number, what: string, max = MAX_OBJECT_BYTES): void {
  if (bytes > max) {
    throw new KvLimitError(
      `${what} is ${bytes} bytes, above the ${max} byte limit. ` +
        `Workers KV rejects values over ${KV_VALUE_LIMIT} bytes (25 MiB); ` +
        `this Worker stores larger objects as ${CHUNK_BYTES}-byte chunks but refuses ` +
        `payloads that would not fit safely in Worker memory. Use fewer or smaller images.`,
    );
  }
  if (bytes < 0 || !Number.isFinite(bytes)) {
    throw new KvLimitError(`${what} has an invalid size.`);
  }
}

export function chunkBytes(bytes: Uint8Array, chunkSize = CHUNK_BYTES): Uint8Array[] {
  if (chunkSize > KV_VALUE_LIMIT - 1024) {
    throw new KvLimitError(`Chunk size ${chunkSize} would exceed the 25 MiB KV value limit.`);
  }
  if (bytes.byteLength === 0) return [new Uint8Array(0)];
  const out: Uint8Array[] = [];
  for (let i = 0; i < bytes.byteLength; i += chunkSize) {
    const slice = bytes.subarray(i, Math.min(bytes.byteLength, i + chunkSize));
    out.push(new Uint8Array(slice));
  }
  return out;
}

export function chunkString(value: string, maxChars = CHUNK_CHARS): string[] {
  if (value.length === 0) return [""];
  const out: string[] = [];
  for (let i = 0; i < value.length; i += maxChars) {
    out.push(value.slice(i, i + maxChars));
  }
  return out;
}

interface BlobMeta {
  chunks: number;
  size: number;
  encoding: "bytes" | "text";
  contentType?: string;
}

function metaKey(key: string): string {
  return `${key}:meta`;
}

async function existingChunkCount(kv: KvLike, key: string): Promise<number> {
  const raw = await kv.get(metaKey(key), { type: "text" });
  if (typeof raw !== "string" || !raw) return 0;
  try {
    return Number((JSON.parse(raw) as BlobMeta).chunks) || 0;
  } catch {
    return 0;
  }
}
function chunkKey(key: string, index: number): string {
  return `${key}:c:${index}`;
}

export async function putText(
  kv: KvLike,
  key: string,
  value: string,
  maxBytes = MAX_OBJECT_BYTES,
  maxChars = CHUNK_CHARS,
): Promise<void> {
  const size = new TextEncoder().encode(value).byteLength;
  assertObjectSize(size, `Text value "${key}"`, maxBytes);
  const parts = chunkString(value, maxChars);
  for (const part of parts) {
    if (new TextEncoder().encode(part).byteLength >= KV_VALUE_LIMIT) {
      throw new KvLimitError(`A text chunk of "${key}" still exceeds the 25 MiB KV value limit.`);
    }
  }
  const previous = await existingChunkCount(kv, key);
  // Chunks land before the meta pointer so a reader never sees a count for chunks that are not written yet.
  for (let i = 0; i < parts.length; i++) {
    await kv.put(chunkKey(key, i), parts[i]);
  }
  const meta: BlobMeta = { chunks: parts.length, size, encoding: "text" };
  await kv.put(metaKey(key), JSON.stringify(meta));
  for (let i = parts.length; i < previous; i++) await kv.delete(chunkKey(key, i));
}

export async function getText(kv: KvLike, key: string): Promise<string | null> {
  const raw = await kv.get(metaKey(key), { type: "text" });
  if (typeof raw !== "string" || !raw) return null;
  const meta = JSON.parse(raw) as BlobMeta;
  if (meta.encoding !== "text") {
    throw new KvLimitError(`Value "${key}" is not stored as text.`);
  }
  let out = "";
  for (let i = 0; i < meta.chunks; i++) {
    const part = await kv.get(chunkKey(key, i), { type: "text" });
    if (typeof part !== "string") {
      throw new KvLimitError(`Missing chunk ${i} for "${key}".`);
    }
    out += part;
  }
  return out;
}

export async function putBytes(
  kv: KvLike,
  key: string,
  bytes: Uint8Array,
  contentType: string,
  maxBytes = MAX_OBJECT_BYTES,
  chunkSize = CHUNK_BYTES,
): Promise<void> {
  assertObjectSize(bytes.byteLength, `Binary value "${key}"`, maxBytes);
  const parts = chunkBytes(bytes, chunkSize);
  const previous = await existingChunkCount(kv, key);
  for (let i = 0; i < parts.length; i++) {
    await kv.put(chunkKey(key, i), parts[i]);
  }
  const meta: BlobMeta = {
    chunks: parts.length,
    size: bytes.byteLength,
    encoding: "bytes",
    contentType,
  };
  await kv.put(metaKey(key), JSON.stringify(meta));
  for (let i = parts.length; i < previous; i++) await kv.delete(chunkKey(key, i));
}

export async function getBytes(kv: KvLike, key: string): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  const raw = await kv.get(metaKey(key), { type: "text" });
  if (typeof raw !== "string" || !raw) return null;
  const meta = JSON.parse(raw) as BlobMeta;
  if (meta.encoding !== "bytes") {
    throw new KvLimitError(`Value "${key}" is not stored as bytes.`);
  }
  const parts: Uint8Array[] = [];
  let size = 0;
  for (let i = 0; i < meta.chunks; i++) {
    const part = await kv.get(chunkKey(key, i), { type: "arrayBuffer" });
    if (!(part instanceof ArrayBuffer) && !ArrayBuffer.isView(part)) {
      throw new KvLimitError(`Missing binary chunk ${i} for "${key}".`);
    }
    const bytes = part instanceof ArrayBuffer ? new Uint8Array(part) : new Uint8Array(part.buffer, part.byteOffset, part.byteLength);
    parts.push(bytes);
    size += bytes.byteLength;
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return { bytes: out, contentType: meta.contentType || "application/octet-stream" };
}

export async function deleteBlob(kv: KvLike, key: string): Promise<void> {
  const raw = await kv.get(metaKey(key), { type: "text" });
  let chunks = 0;
  if (typeof raw === "string" && raw) {
    try {
      chunks = (JSON.parse(raw) as BlobMeta).chunks || 0;
    } catch {
      chunks = 0;
    }
  }
  await kv.delete(metaKey(key));
  for (let i = 0; i < chunks; i++) await kv.delete(chunkKey(key, i));
}
