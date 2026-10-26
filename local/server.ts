import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bearerToken, editKeyFromRequest, tokensEqual } from "../worker/src/auth.ts";
import { crc32 } from "../worker/src/zip.ts";
import { Disk, sha256Hex } from "./disk.ts";
import { handleLocalMcp, mcpHttpBody } from "./mcp.ts";
import { presentBackup, saveEditorBackup } from "./tools.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PAGES_ORIGIN = "https://matinrahimik.github.io";
const BASE_CORS_HEADERS = [
  "Authorization",
  "Content-Type",
  "X-Edit-Key",
  "Accept",
  "Cache-Control",
  "X-Appscreen-Crc",
  "X-Appscreen-Width",
  "X-Appscreen-Height",
  "X-Appscreen-Sha256",
  "X-Appscreen-Index",
];

const STATIC_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".glb": "model/gltf-binary",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
};

export interface ServerOptions {
  port: number;
  host: string;
  dataDir: string;
  token?: string;
}

export function isLoopback(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, "").toLowerCase();
  return bare === "127.0.0.1" || bare === "localhost" || bare === "::1";
}

export function assertBindAllowed(host: string, token: string | undefined): void {
  if (!token && !isLoopback(host)) {
    throw new Error(
      "APPSCREEN_MCP_TOKEN is unset and the server is not bound to loopback. Refusing to start.",
    );
  }
}

export async function startServer(options: ServerOptions): Promise<{ port: number; origin: string; close: () => Promise<void> }> {
  assertBindAllowed(options.host, options.token);
  const disk = new Disk(options.dataDir);
  await disk.ensure();
  const token = options.token || "";
  const server = createServer((req, res) => {
    void handle(req, res, disk, token, options.host).catch((error) => {
      const message = error instanceof Error ? error.message : "Internal error";
      sendJson(res, req, 500, { error: "internal", message });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  const origin = `http://${options.host === "0.0.0.0" ? "127.0.0.1" : options.host}:${port}`;
  return {
    port,
    origin,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

function allowHeaders(req: IncomingMessage): string {
  const seen = new Set<string>();
  const names: string[] = [];
  const add = (name: string) => {
    const trimmed = name.trim();
    const key = trimmed.toLowerCase();
    if (!/^[a-z0-9-]+$/.test(key) || seen.has(key)) return;
    seen.add(key);
    names.push(trimmed);
  };
  for (const name of BASE_CORS_HEADERS) add(name);
  for (const part of String(req.headers["access-control-request-headers"] || "").split(",")) add(part);
  return names.join(", ");
}

function applyCors(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  if (!origin || Array.isArray(origin)) return;
  const allowed = origin === PAGES_ORIGIN || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  if (!allowed) return;
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", allowHeaders(req));
  res.setHeader("Access-Control-Max-Age", "600");
}

function sendJson(res: ServerResponse, req: IncomingMessage, status: number, body: unknown, extra?: Record<string, string>): void {
  const payload = JSON.stringify(body);
  applyCors(req, res);
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  for (const [key, value] of Object.entries(extra || {})) res.setHeader(key, value);
  res.end(payload);
}

function sendEmpty(res: ServerResponse, req: IncomingMessage, status: number): void {
  applyCors(req, res);
  res.statusCode = status;
  res.end();
}

function publicOrigin(req: IncomingMessage, fallback: string): string {
  const host = req.headers.host;
  if (!host || Array.isArray(host)) return fallback;
  return `http://${host}`;
}

function mcpAuthorized(req: IncomingMessage, token: string, bindHost: string): boolean {
  if (!token) return isLoopback(bindHost);
  return tokensEqual(bearerToken(asRequest(req)), token);
}

function projectAuthorized(req: IncomingMessage, editKey: string, token: string): boolean {
  const presented = editKeyFromRequest(asRequest(req));
  if (editKey && presented && tokensEqual(presented, editKey)) return true;
  const bearer = bearerToken(asRequest(req));
  return Boolean(token && bearer && tokensEqual(bearer, token));
}

/** Adapt Node's incoming message far enough for the Worker's header helpers. */
function asRequest(req: IncomingMessage): Request {
  const host = req.headers.host || "127.0.0.1";
  const url = new URL(req.url || "/", `http://${host}`);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers.set(key, value);
    else if (Array.isArray(value)) headers.set(key, value.join(", "));
  }
  return new Request(url, { method: req.method, headers });
}

async function readBody(req: IncomingMessage, limit: number): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > limit) throw new Error(`Request body exceeds ${limit} bytes.`);
    chunks.push(buf);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

async function handle(req: IncomingMessage, res: ServerResponse, disk: Disk, token: string, bindHost: string): Promise<void> {
  const host = req.headers.host || `${bindHost}`;
  const url = new URL(req.url || "/", `http://${host}`);
  const origin = publicOrigin(req, `http://${bindHost}`);
  if (req.method === "OPTIONS") {
    applyCors(req, res);
    res.statusCode = 204;
    res.end();
    return;
  }

  if (url.pathname === "/health") {
    sendJson(res, req, 200, {
      name: "homebooks-appscreen-local",
      mcp: "/mcp",
      editor: origin,
      cloudflare: "not used",
    });
    return;
  }

  if (url.pathname === "/mcp") {
    if (req.method === "GET" || req.method === "DELETE") {
      sendJson(res, req, 405, { jsonrpc: "2.0", id: null, error: { code: -32000, message: "This MCP endpoint is stateless. POST JSON-RPC to /mcp." } });
      return;
    }
    if (req.method !== "POST") {
      sendJson(res, req, 405, { error: "method_not_allowed" });
      return;
    }
    if (!mcpAuthorized(req, token, bindHost)) {
      sendJson(res, req, 401, { error: "unauthorized", message: "Authorization: Bearer <APPSCREEN_MCP_TOKEN> is required." });
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(new TextDecoder().decode(await readBody(req, 80 * 1024 * 1024)));
    } catch {
      sendJson(res, req, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }
    const rpc = await handleLocalMcp(disk, origin, message);
    const encoded = mcpHttpBody(req.headers.accept || null, rpc);
    if (encoded.status === 202) {
      sendEmpty(res, req, 202);
      return;
    }
    applyCors(req, res);
    res.statusCode = encoded.status;
    res.setHeader("content-type", encoded.contentType);
    res.end(encoded.body || "");
    return;
  }

  const assetMatch = url.pathname.match(/^\/assets\/([a-f0-9]{64})$/i);
  if (assetMatch && req.method === "GET") {
    const hash = assetMatch[1].toLowerCase();
    const asset = await disk.readAsset(hash);
    if (!asset) {
      sendJson(res, req, 404, { error: "not_found" });
      return;
    }
    applyCors(req, res);
    res.statusCode = 200;
    res.setHeader("content-type", asset.mime);
    res.setHeader("content-length", String(asset.bytes.byteLength));
    res.setHeader("cache-control", "public, max-age=31536000, immutable");
    res.end(Buffer.from(asset.bytes));
    return;
  }

  const renderPut = url.pathname.match(/^\/renders\/([a-f0-9]{64})$/i);
  if (renderPut && req.method === "PUT") {
    await putRender(req, res, disk, renderPut[1].toLowerCase(), origin);
    return;
  }

  const outputMatch = url.pathname.match(/^\/renders\/output\/([^/]+)\/([^/]+)$/);
  if (outputMatch && req.method === "GET") {
    await sendRenderFile(req, res, disk, decodeURIComponent(outputMatch[1]), decodeURIComponent(outputMatch[2]));
    return;
  }

  const fileMatch = url.pathname.match(/^\/f\/([a-f0-9]{64})(?:\/([^/]+))?$/i);
  if (fileMatch && req.method === "GET") {
    const record = await disk.readRenderToken(fileMatch[1].toLowerCase());
    if (!record?.uploaded) {
      sendJson(res, req, 404, { error: "not_found" });
      return;
    }
    const filename = fileMatch[2] ? decodeURIComponent(fileMatch[2]) : record.filename;
    await sendRenderFile(req, res, disk, record.projectId, filename);
    return;
  }

  const projectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)$/);
  if (projectMatch) {
    const id = decodeURIComponent(projectMatch[1]);
    if (req.method === "GET") {
      await getProject(req, res, disk, id, token, origin);
      return;
    }
    if (req.method === "PUT") {
      await putProject(req, res, disk, id, token);
      return;
    }
    sendJson(res, req, 405, { error: "method_not_allowed" });
    return;
  }

  if (req.method === "GET" || req.method === "HEAD") {
    await sendStatic(req, res, url.pathname);
    return;
  }
  sendJson(res, req, 404, { error: "not_found" });
}

async function getProject(req: IncomingMessage, res: ServerResponse, disk: Disk, id: string, token: string, origin: string): Promise<void> {
  const envelope = await disk.get(id);
  if (!envelope) {
    sendJson(res, req, 404, { error: "not_found" });
    return;
  }
  if (!projectAuthorized(req, envelope.editKey, token)) {
    sendJson(res, req, 401, { error: "unauthorized", message: "A valid edit key or MCP token is required." });
    return;
  }
  sendJson(res, req, 200, presentBackup(envelope.backup, origin), { "cache-control": "no-store" });
}

async function putProject(req: IncomingMessage, res: ServerResponse, disk: Disk, id: string, token: string): Promise<void> {
  const envelope = await disk.get(id);
  if (!envelope) {
    sendJson(res, req, 404, { error: "not_found" });
    return;
  }
  if (!projectAuthorized(req, envelope.editKey, token)) {
    sendJson(res, req, 401, { error: "unauthorized", message: "A valid edit key or MCP token is required." });
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(await readBody(req, 80 * 1024 * 1024)));
  } catch (error) {
    sendJson(res, req, 400, { error: "invalid_backup", message: error instanceof Error ? error.message : "Body is not JSON." });
    return;
  }
  try {
    const updatedAt = await saveEditorBackup(disk, id, parsed);
    sendJson(res, req, 200, { ok: true, project_id: id, updated_at: updatedAt });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not save the project.";
    const code = error instanceof Error && "code" in error ? String((error as { code?: string }).code) : "invalid_backup";
    sendJson(res, req, 400, { error: code, message });
  }
}

function integerHeader(req: IncomingMessage, name: string): number | null {
  const raw = req.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value == null || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

async function putRender(req: IncomingMessage, res: ServerResponse, disk: Disk, token: string, origin: string): Promise<void> {
  const record = await disk.readRenderToken(token);
  if (!record) {
    sendJson(res, req, 404, { error: "not_found", message: "Upload token is unknown." });
    return;
  }
  const index = integerHeader(req, "x-appscreen-index");
  const width = integerHeader(req, "x-appscreen-width");
  const height = integerHeader(req, "x-appscreen-height");
  const crc = integerHeader(req, "x-appscreen-crc");
  const sha = String(req.headers["x-appscreen-sha256"] || "").toLowerCase();
  if (index !== record.index || width == null || width <= 0 || height == null || height <= 0) {
    sendJson(res, req, 400, { error: "invalid_upload", message: "Screenshot index and pixel size are required." });
    return;
  }
  if (crc == null || crc > 0xffffffff || !/^[a-f0-9]{64}$/.test(sha)) {
    sendJson(res, req, 400, { error: "invalid_upload", message: "Screenshot crc32 and sha256 are required." });
    return;
  }
  const bytes = await readBody(req, 80 * 1024 * 1024);
  if (bytes.byteLength === 0) {
    sendJson(res, req, 400, { error: "invalid_upload", message: "Rendered PNG is empty." });
    return;
  }
  const actualSha = sha256Hex(bytes);
  const actualCrc = crc32(bytes);
  if (actualSha !== sha || actualCrc !== crc) {
    sendJson(res, req, 400, { error: "invalid_upload", message: "Uploaded PNG checksum does not match the headers." });
    return;
  }
  await disk.writeRenderFile(record.projectId, record.filename, bytes);
  await disk.writeRenderToken(token, { ...record, uploaded: true, bytes: bytes.byteLength, width, height, sha256: sha, crc });
  const url = new URL(`/renders/output/${encodeURIComponent(record.projectId)}/${encodeURIComponent(record.filename)}`, origin);
  sendJson(res, req, 200, { ok: true, bytes: bytes.byteLength, url: url.toString() });
}

async function sendRenderFile(req: IncomingMessage, res: ServerResponse, disk: Disk, projectId: string, filename: string): Promise<void> {
  let file: string;
  try {
    file = disk.renderOutputPath(projectId, filename);
  } catch {
    sendJson(res, req, 400, { error: "invalid_request" });
    return;
  }
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error("missing");
    applyCors(req, res);
    const type = filename.endsWith(".zip") ? "application/zip" : "image/png";
    res.statusCode = 200;
    res.setHeader("content-type", type);
    res.setHeader("content-length", String(info.size));
    res.setHeader("cache-control", "no-store");
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    createReadStream(file).pipe(res);
  } catch {
    sendJson(res, req, 404, { error: "not_found" });
  }
}

function safeStaticPath(pathname: string): string | null {
  const decoded = decodeURIComponent(pathname);
  if (decoded.includes("\0")) return null;
  const rel = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  if (rel.split("/").some((part) => part === ".." || part === "." || part.startsWith("."))) return null;
  const blocked = ["worker", "local", "data", "node_modules", "test", "src-tauri"];
  if (blocked.includes(rel.split("/")[0])) return null;
  const full = path.resolve(ROOT, rel);
  if (!full.startsWith(`${ROOT}/`) && full !== path.join(ROOT, "index.html")) return null;
  return full;
}

async function sendStatic(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
  const full = safeStaticPath(pathname);
  if (!full) {
    sendJson(res, req, 404, { error: "not_found" });
    return;
  }
  try {
    const info = await stat(full);
    if (!info.isFile()) {
      sendJson(res, req, 404, { error: "not_found" });
      return;
    }
    const type = STATIC_TYPES[path.extname(full).toLowerCase()] || "application/octet-stream";
    applyCors(req, res);
    res.statusCode = 200;
    res.setHeader("content-type", type);
    res.setHeader("content-length", String(info.size));
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    createReadStream(full).pipe(res);
  } catch {
    sendJson(res, req, 404, { error: "not_found" });
  }
}

function parseArgs(argv: string[]): ServerOptions {
  let port = Number(process.env.PORT || "8787");
  let host = process.env.HOST || "127.0.0.1";
  let dataDir = process.env.APPSCREEN_DATA || path.join(ROOT, "data");
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--port" && next) {
      port = Number(next);
      i++;
    } else if (arg === "--host" && next) {
      host = next;
      i++;
    } else if (arg === "--data" && next) {
      dataDir = path.resolve(next);
      i++;
    } else if (arg === "--help") {
      console.log("Usage: npm start -- [--port 8787] [--host 127.0.0.1] [--data ./data]");
      process.exit(0);
    }
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid port ${port}.`);
  }
  return { port, host, dataDir, token: process.env.APPSCREEN_MCP_TOKEN || "" };
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const options = parseArgs(process.argv.slice(2));
  startServer(options)
    .then(({ port, origin }) => {
      console.log(`HomeBooks screenshot editor ${origin}`);
      console.log(`MCP ${origin}/mcp`);
      console.log(`Projects and renders under ${options.dataDir}`);
      console.log(`Bound to ${options.host}:${port}. No Cloudflare connection.`);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    });
}
