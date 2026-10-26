import { canWriteProject, editKeyFromRequest, requireMcpToken } from "./auth.ts";
import { foldAssetUrls, presentAssetRefs, replaceDataUrls } from "./assets.ts";
import { KV_VALUE_LIMIT, KvLimitError, MAX_OBJECT_BYTES, openByteStream, putStreamedBytes, readBlobMeta } from "./kvblob.ts";
import { logStage } from "./log.ts";
import { handleMcpRpc, mcpHttpBody } from "./mcp.ts";
import { assertBackup, ProjectError, setProjectName } from "./project.ts";
import { getEnvelope, publicFileKey, readProjectDoc, readRenderToken, replaceProjectDoc, writeRenderToken } from "./store.ts";
import type { Env, Services } from "./types.ts";
import { storeZipStream } from "./zip.ts";

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

/** Union of the headers this API uses and the headers this preflight asked to send. */
export function accessControlAllowHeaders(request: Request): string {
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
  for (const part of (request.headers.get("Access-Control-Request-Headers") || "").split(",")) add(part);
  return names.join(", ");
}

export function corsHeaders(request: Request, env: Env): Headers {
  const headers = new Headers();
  const origin = request.headers.get("Origin");
  if (!origin) return headers;
  const pages = (env.PAGES_ORIGIN || PAGES_ORIGIN).replace(/\/$/, "");
  const allowed =
    origin === pages ||
    /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  if (!allowed) return headers;
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Vary", "Origin");
  headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  headers.set("Access-Control-Allow-Headers", accessControlAllowHeaders(request));
  headers.set("Access-Control-Max-Age", "600");
  return headers;
}

function withCors(request: Request, env: Env, response: Response): Response {
  const headers = new Headers(response.headers);
  corsHeaders(request, env).forEach((value, key) => headers.set(key, value));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function json(data: unknown, status = 200, extra?: HeadersInit): Response {
  const headers = new Headers(extra);
  if (!headers.has("content-type")) headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data), { status, headers });
}

export function publicOrigin(request: Request, env: Env): string {
  if (env.PUBLIC_BASE_URL) return env.PUBLIC_BASE_URL.replace(/\/$/, "");
  return new URL(request.url).origin;
}

function servicesFor(request: Request, env: Env, renderScreenshots: Services["renderScreenshots"]): Services {
  return {
    env,
    publicOrigin: publicOrigin(request, env),
    renderScreenshots,
  };
}

export async function route(
  request: Request,
  env: Env,
  renderScreenshots?: Services["renderScreenshots"],
): Promise<Response> {
  const response = await routeInner(request, env, renderScreenshots);
  return withCors(request, env, response);
}

async function routeInner(
  request: Request,
  env: Env,
  renderScreenshots?: Services["renderScreenshots"],
): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(request, env) });
  }

  if (url.pathname === "/" || url.pathname === "/health") {
    return json({
      name: "homebooks-appscreen-mcp",
      mcp: "/mcp",
      pages: "https://matinrahimik.github.io/homebooks-appscreen/",
    });
  }

  if (url.pathname === "/mcp") {
    if (request.method === "GET" || request.method === "DELETE") {
      return json(
        { jsonrpc: "2.0", id: null, error: { code: -32000, message: "This MCP endpoint is stateless. POST JSON-RPC to /mcp." } },
        405,
        { Allow: "POST, OPTIONS" },
      );
    }
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    const denied = requireMcpToken(request, env);
    if (denied) return denied;
    let message: unknown;
    try {
      message = await request.json();
    } catch {
      return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
    }
    const rpc = await handleMcpRpc(servicesFor(request, env, renderScreenshots), message);
    const encoded = mcpHttpBody(request.headers.get("accept"), rpc);
    if (encoded.status === 202) return new Response(null, { status: 202 });
    return new Response(encoded.body, {
      status: encoded.status,
      headers: { "content-type": encoded.contentType },
    });
  }

  const assetMatch = url.pathname.match(/^\/assets\/([a-f0-9]{64})$/i);
  if (assetMatch && request.method === "GET") {
    return streamAsset(env, assetMatch[1].toLowerCase());
  }

  const renderMatch = url.pathname.match(/^\/renders\/([a-f0-9]{64})$/i);
  if (renderMatch && request.method === "PUT") {
    return putRender(request, env, renderMatch[1].toLowerCase());
  }

  const fileMatch = url.pathname.match(/^\/f\/([a-f0-9]{32,128})(?:\/([^/]+))?$/i);
  if (fileMatch && request.method === "GET") {
    const filename = fileMatch[2] ? decodeURIComponent(fileMatch[2]) : "download";
    return streamPublicFile(env, fileMatch[1], filename);
  }

  const projectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)$/);
  if (projectMatch) {
    const id = decodeURIComponent(projectMatch[1]);
    if (request.method === "GET") return getProject(request, env, id);
    if (request.method === "PUT") return putProject(request, env, id);
    return json({ error: "method_not_allowed" }, 405);
  }

  return json({ error: "not_found" }, 404);
}

const IMMUTABLE = "public, max-age=31536000, immutable";

function contentLength(request: Request): number | null {
  const raw = request.headers.get("content-length");
  if (raw == null || !/^\d+$/.test(raw)) return null;
  const size = Number(raw);
  return Number.isSafeInteger(size) ? size : null;
}

function integerHeader(request: Request, name: string): number | null {
  const raw = request.headers.get(name);
  if (raw == null || !/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

async function streamAsset(env: Env, hash: string): Promise<Response> {
  const key = `asset:${hash}`;
  const meta = await readBlobMeta(env.APPSCREEN_KV, key);
  if (!meta || meta.encoding !== "bytes") return json({ error: "not_found" }, 404);
  const opened = await openByteStream(env.APPSCREEN_KV, key);
  if (!opened) return json({ error: "not_found" }, 404);
  logStage("asset_stream", { hash, bytes: opened.size, chunks: meta.chunks });
  return new Response(opened.stream, {
    status: 200,
    headers: {
      "content-type": opened.contentType,
      "content-length": String(opened.size),
      "cache-control": IMMUTABLE,
    },
  });
}

async function streamPublicFile(env: Env, token: string, filename: string): Promise<Response> {
  const key = publicFileKey(token);
  const meta = await readBlobMeta(env.APPSCREEN_KV, key);
  if (!meta) return json({ error: "not_found" }, 404);
  const safeName = filename.replace(/"/g, "");
  const disposition = `${meta.contentType === "application/zip" ? "attachment" : "inline"}; filename="${safeName}"`;
  if (meta.encoding === "store-zip") {
    const files = meta.files || [];
    const stream = storeZipStream(
      files.map((file) => ({ name: file.name, crc: file.crc, size: file.size })),
      async (index) => {
        const opened = await openByteStream(env.APPSCREEN_KV, files[index].key);
        return opened ? opened.stream : null;
      },
      new Date(meta.when || "2020-01-01T00:00:00.000Z"),
    );
    logStage("zip_stream", { files: files.length, bytes: meta.size });
    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": "application/zip",
        "content-length": String(meta.size),
        "cache-control": IMMUTABLE,
        "content-disposition": disposition,
      },
    });
  }
  if (meta.encoding !== "bytes") return json({ error: "not_found" }, 404);
  const opened = await openByteStream(env.APPSCREEN_KV, key);
  if (!opened) return json({ error: "not_found" }, 404);
  return new Response(opened.stream, {
    status: 200,
    headers: {
      "content-type": opened.contentType,
      "content-length": String(opened.size),
      "cache-control": IMMUTABLE,
      "content-disposition": disposition,
    },
  });
}

async function putRender(request: Request, env: Env, token: string): Promise<Response> {
  const record = await readRenderToken(env.APPSCREEN_KV, token);
  if (!record) return json({ error: "not_found", message: "Upload token is unknown." }, 404);
  const index = integerHeader(request, "x-appscreen-index");
  const width = integerHeader(request, "x-appscreen-width");
  const height = integerHeader(request, "x-appscreen-height");
  const crc = integerHeader(request, "x-appscreen-crc");
  const sha = (request.headers.get("x-appscreen-sha256") || "").toLowerCase();
  if (index !== record.index || width == null || width <= 0 || height == null || height <= 0) {
    return json({ error: "invalid_upload", message: "Screenshot index and pixel size are required." }, 400);
  }
  if (crc == null || crc > 0xffffffff || !/^[a-f0-9]{64}$/.test(sha)) {
    return json({ error: "invalid_upload", message: "Screenshot crc32 and sha256 are required." }, 400);
  }
  const size = contentLength(request);
  if (size == null) {
    return json({ error: "length_required", message: "Content-Length is required. The body is stored as a stream." }, 411);
  }
  if (size <= 0) return json({ error: "invalid_upload", message: "Rendered PNG is empty." }, 400);
  if (size > KV_VALUE_LIMIT) {
    return json(
      {
        error: "kv_limit",
        message: `Rendered PNG is ${size} bytes, above the ${KV_VALUE_LIMIT} byte KV value limit. The upload was not read.`,
      },
      413,
    );
  }
  if (!request.body) return json({ error: "invalid_upload", message: "Rendered PNG body is missing." }, 400);
  await putStreamedBytes(env.APPSCREEN_KV, publicFileKey(token), request.body, size, "image/png");
  await writeRenderToken(env.APPSCREEN_KV, token, {
    ...record,
    uploaded: true,
    bytes: size,
    width,
    height,
    sha256: sha,
    crc,
  });
  logStage("render_upload", { index, bytes: size, sha256: sha });
  const url = new URL(`/f/${token}/${record.filename}`, publicOrigin(request, env));
  return json({ ok: true, bytes: size, url: url.toString() });
}

async function getProject(request: Request, env: Env, id: string): Promise<Response> {
  const envelope = await getEnvelope(env.APPSCREEN_KV, id);
  if (!envelope) return json({ error: "not_found" }, 404);
  if (!canWriteProject(request, env, envelope.editKey)) {
    return json({ error: "unauthorized", message: "A valid edit key or MCP token is required." }, 401);
  }
  const loaded = await readProjectDoc(env, id);
  if (!loaded) return json({ error: "not_found" }, 404);
  const headers = new Headers({ "cache-control": "no-store" });
  return json(presentAssetRefs(loaded.backup, publicOrigin(request, env)), 200, headers);
}

async function putProject(request: Request, env: Env, id: string): Promise<Response> {
  const envelope = await getEnvelope(env.APPSCREEN_KV, id);
  if (!envelope) return json({ error: "not_found" }, 404);
  if (!canWriteProject(request, env, envelope.editKey)) {
    return json({ error: "unauthorized", message: "A valid edit key or MCP token is required." }, 401);
  }
  const claimed = Number(request.headers.get("content-length") || "0");
  if (claimed > MAX_OBJECT_BYTES) {
    return json({ error: "kv_limit", message: `Request body exceeds ${MAX_OBJECT_BYTES} bytes.` }, 413);
  }
  let text: string;
  try {
    text = await request.text();
  } catch {
    return json({ error: "invalid_backup", message: "Could not read the request body." }, 400);
  }
  if (text.length > MAX_OBJECT_BYTES) {
    return json({ error: "kv_limit", message: `Backup exceeds ${MAX_OBJECT_BYTES} bytes.` }, 413);
  }
  let parsed: unknown;
  try {
    if (text.includes("data:image/")) text = await replaceDataUrls(env.APPSCREEN_KV, text);
    parsed = JSON.parse(text);
  } catch (error) {
    if (error instanceof ProjectError) {
      return json({ error: error.code, message: error.message }, 400);
    }
    return json({ error: "invalid_backup", message: "Body is not JSON." }, 400);
  }
  try {
    foldAssetUrls(parsed);
    const backup = assertBackup(parsed);
    const project = backup.projects.find((item) => item.id === id) || backup.projects[0];
    project.id = id;
    const current = backup.meta.find((item) => item.key === "currentProject");
    if (current) current.value = id;
    else backup.meta.push({ key: "currentProject", value: id });
    const listed = backup.meta.find((item) => item.key === "projects");
    if (listed && Array.isArray(listed.value)) {
      for (const entry of listed.value as { id?: string }[]) {
        if (entry && typeof entry === "object") entry.id = id;
      }
      if ((listed.value as unknown[]).length > 0) {
        setProjectName(backup, ((listed.value as { name?: string }[])[0].name) || envelope.name);
      }
    }
    const updatedAt = new Date().toISOString();
    await replaceProjectDoc(env, id, backup, updatedAt);
    return json({ ok: true, project_id: id, updated_at: updatedAt });
  } catch (error) {
    if (error instanceof ProjectError || error instanceof KvLimitError) {
      const status = error instanceof KvLimitError ? 413 : 400;
      return json({ error: error instanceof KvLimitError ? "kv_limit" : error.code, message: error.message }, status);
    }
    throw error;
  }
}

export function readEditKey(request: Request): string {
  return editKeyFromRequest(request);
}
