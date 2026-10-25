import { getBytes, putBytes } from "./kvblob.ts";
import { ProjectError, bytesToBase64 } from "./project.ts";
import type { KvLike } from "./types.ts";

/** New panoramic uploads above this are rejected. Migrated panoramas are kept as stored. */
export const MAX_PANORAMA_BYTES = 8 * 1024 * 1024;

const ASSET_REF = /^asset:([a-f0-9]{64})$/;
const ASSET_URL = /^(?:https?:\/\/[^/\s]+)?\/assets\/([a-f0-9]{64})$/i;

export function assertPanoramaBytes(bytes: number): void {
  if (bytes > MAX_PANORAMA_BYTES) {
    throw new ProjectError(
      "image_too_large",
      `Panorama is ${bytes} bytes, above the 8 MiB limit. Export a smaller JPEG (lower quality or a shorter width) and retry set_panoramic_background.`,
    );
  }
}

export function assetKey(hash: string): string {
  return `asset:${hash}`;
}

export function isAssetRef(value: string): boolean {
  return ASSET_REF.test(value);
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Store image bytes once, keyed by SHA-256. Returns `asset:<hash>`. */
export async function storeAsset(kv: KvLike, bytes: Uint8Array, mime: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hash = hex(digest);
  const key = assetKey(hash);
  const existing = await kv.get(`${key}:meta`, { type: "text" });
  if (typeof existing === "string" && existing) return `asset:${hash}`;
  const safeMime = /^image\/[a-zA-Z0-9.+-]+$/.test(mime) ? mime : "application/octet-stream";
  await putBytes(kv, key, bytes, safeMime);
  return `asset:${hash}`;
}

function isBase64Char(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || code === 43 || code === 47 || code === 61;
}

function isWhitespace(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13;
}

/** Decode a base64 span without building one giant binary string. `start`/`end` index the source text. */
export function decodeBase64Range(text: string, start: number, end: number): Uint8Array {
  let hasWhitespace = false;
  for (let i = start; i < end; i++) {
    if (isWhitespace(text.charCodeAt(i))) {
      hasWhitespace = true;
      break;
    }
  }
  const source = hasWhitespace ? text.slice(start, end).replace(/\s+/g, "") : text;
  const from = hasWhitespace ? 0 : start;
  const to = hasWhitespace ? source.length : end;
  const len = to - from;
  if (len === 0 || len % 4 !== 0) {
    throw new ProjectError("invalid_backup", "An embedded image had invalid base64.");
  }
  let pad = 0;
  if (source.charCodeAt(to - 1) === 61) pad++;
  if (len >= 2 && source.charCodeAt(to - 2) === 61) pad++;
  const out = new Uint8Array((len / 4) * 3 - pad);
  const stride = 4 * 256 * 1024;
  let offset = 0;
  for (let i = from; i < to; i += stride) {
    const sliceEnd = Math.min(to, i + stride);
    const binary = atob(source.slice(i, sliceEnd));
    for (let j = 0; j < binary.length; j++) out[offset++] = binary.charCodeAt(j);
  }
  return offset === out.length ? out : out.subarray(0, offset);
}

/**
 * Replace `data:image/...;base64,...` tokens in a JSON string one image at a time.
 * The caller can parse the result without ever JSON.parsing the original base64 payload.
 */
export async function replaceDataUrls(kv: KvLike, text: string): Promise<string> {
  const parts: string[] = [];
  let cursor = 0;
  let search = 0;
  const marker = "data:image/";
  while (search < text.length) {
    const at = text.indexOf(marker, search);
    if (at < 0) break;
    const headerEnd = text.indexOf(";base64,", at);
    if (headerEnd < 0 || headerEnd - at > 80) {
      search = at + marker.length;
      continue;
    }
    const mime = text.slice(at + "data:".length, headerEnd);
    if (!/^image\/[a-zA-Z0-9.+-]+$/.test(mime)) {
      search = at + marker.length;
      continue;
    }
    let b64End = headerEnd + ";base64,".length;
    while (b64End < text.length) {
      const code = text.charCodeAt(b64End);
      if (isBase64Char(code) || isWhitespace(code)) b64End++;
      else break;
    }
    if (b64End === headerEnd + 8) {
      search = at + marker.length;
      continue;
    }
    const bytes = decodeBase64Range(text, headerEnd + 8, b64End);
    const ref = await storeAsset(kv, bytes, mime);
    parts.push(text.slice(cursor, at));
    parts.push(ref);
    cursor = b64End;
    search = b64End;
  }
  parts.push(text.slice(cursor));
  return parts.join("");
}

async function externalizeString(kv: KvLike, value: string, panorama: boolean): Promise<string> {
  if (!value.startsWith("data:image/")) return value;
  const headerEnd = value.indexOf(";base64,");
  if (headerEnd < 0) return value;
  const mime = value.slice("data:".length, headerEnd);
  const bytes = decodeBase64Range(value, headerEnd + 8, value.length);
  if (panorama) assertPanoramaBytes(bytes.byteLength);
  return storeAsset(kv, bytes, mime);
}

/** Walk a parsed backup and replace any remaining data URLs with asset refs. */
export async function externalizeValue(kv: KvLike, value: unknown, path = ""): Promise<void> {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const child = value[i];
      if (typeof child === "string") {
        const next = await externalizeString(kv, child, false);
        if (next !== child) value[i] = next;
      } else {
        await externalizeValue(kv, child, `${path}[]`);
      }
    }
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const child = record[key];
    const childPath = path ? `${path}.${key}` : key;
    if (typeof child === "string") {
      const panorama = key === "src" && (path === "panoramicBackground" || path.endsWith(".panoramicBackground") || path === "panoramic" || path.endsWith(".panoramic"));
      const next = await externalizeString(kv, child, panorama);
      if (next !== child) record[key] = next;
    } else {
      await externalizeValue(kv, child, childPath);
    }
  }
}

export function presentAssetRefs(value: unknown, origin: string): unknown {
  if (typeof value === "string") {
    const match = ASSET_REF.exec(value);
    if (match) return `${origin}/assets/${match[1]}`;
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => presentAssetRefs(item, origin));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) out[key] = presentAssetRefs(child, origin);
    return out;
  }
  return value;
}

/** Turn `/assets/<hash>` and absolute asset URLs back into refs. Does not fetch. */
export function foldAssetUrls(value: unknown): void {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const child = value[i];
      if (typeof child === "string") {
        const folded = foldAssetString(child);
        if (folded !== child) value[i] = folded;
      } else {
        foldAssetUrls(child);
      }
    }
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const child = record[key];
    if (typeof child === "string") {
      const folded = foldAssetString(child);
      if (folded !== child) record[key] = folded;
    } else {
      foldAssetUrls(child);
    }
  }
}

function foldAssetString(value: string): string {
  const match = ASSET_URL.exec(value);
  if (!match) return value;
  return `asset:${match[1].toLowerCase()}`;
}

export async function inlineAssetRefs(kv: KvLike, value: unknown, cache = new Map<string, string>()): Promise<unknown> {
  if (typeof value === "string") {
    const match = ASSET_REF.exec(value);
    if (!match) return value;
    const hash = match[1];
    const cached = cache.get(hash);
    if (cached) return cached;
    const blob = await getBytes(kv, assetKey(hash));
    if (!blob) {
      throw new ProjectError("missing_asset", `Image asset ${hash} is missing.`);
    }
    const dataUrl = `data:${blob.contentType};base64,${bytesToBase64(blob.bytes)}`;
    cache.set(hash, dataUrl);
    return dataUrl;
  }
  if (Array.isArray(value)) {
    const out = [];
    for (const item of value) out.push(await inlineAssetRefs(kv, item, cache));
    return out;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) out[key] = await inlineAssetRefs(kv, child, cache);
    return out;
  }
  return value;
}

export function collectAssetHashes(value: unknown, out = new Set<string>()): Set<string> {
  if (typeof value === "string") {
    const match = ASSET_REF.exec(value);
    if (match) out.add(match[1]);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectAssetHashes(item, out);
    return out;
  }
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) collectAssetHashes(child, out);
  }
  return out;
}

/**
 * Confirm each asset has metadata. This reads the tiny meta key only.
 * Image bytes stay in KV until the browser fetches GET /assets/<hash>.
 */
export async function assertAssetsPresent(kv: KvLike, backup: unknown): Promise<void> {
  for (const hash of collectAssetHashes(backup)) {
    const raw = await kv.get(`${assetKey(hash)}:meta`, { type: "text" });
    if (typeof raw !== "string" || !raw) {
      throw new ProjectError("missing_asset", `Image asset ${hash} is missing. The render was not started.`);
    }
  }
}
