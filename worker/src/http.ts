import { canWriteProject, editKeyFromRequest, requireMcpToken } from "./auth.ts";
import { foldAssetUrls, presentAssetRefs, replaceDataUrls } from "./assets.ts";
import { getBytes, KvLimitError, MAX_OBJECT_BYTES } from "./kvblob.ts";
import { handleMcpRpc, mcpHttpBody } from "./mcp.ts";
import { assertBackup, ProjectError, setProjectName } from "./project.ts";
import { getEnvelope, getPublicFile, readProjectDoc, replaceProjectDoc } from "./store.ts";
import type { Env, Services } from "./types.ts";

const PAGES_ORIGIN = "https://matinrahimik.github.io";

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
  headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Edit-Key, Accept");
  headers.set("Access-Control-Max-Age", "86400");
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
    const file = await getBytes(env.APPSCREEN_KV, `asset:${assetMatch[1].toLowerCase()}`);
    if (!file) return json({ error: "not_found" }, 404);
    return new Response(file.bytes, {
      status: 200,
      headers: {
        "content-type": file.contentType,
        "content-length": String(file.bytes.byteLength),
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
  }

  const fileMatch = url.pathname.match(/^\/f\/([a-f0-9]{32,128})(?:\/([^/]+))?$/i);
  if (fileMatch && request.method === "GET") {
    const file = await getPublicFile(env.APPSCREEN_KV, fileMatch[1]);
    if (!file) return json({ error: "not_found" }, 404);
    const filename = fileMatch[2] ? decodeURIComponent(fileMatch[2]) : "download";
    const headers = new Headers({
      "content-type": file.contentType,
      "content-length": String(file.bytes.byteLength),
      "cache-control": "public, max-age=31536000, immutable",
      "content-disposition": `${file.contentType === "application/zip" ? "attachment" : "inline"}; filename="${filename.replace(/"/g, "")}"`,
    });
    return new Response(file.bytes, { status: 200, headers });
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

async function getProject(request: Request, env: Env, id: string): Promise<Response> {
  const envelope = await getEnvelope(env.APPSCREEN_KV, id);
  if (!envelope) return json({ error: "not_found" }, 404);
  if (!canWriteProject(request, env, envelope.editKey)) {
    return json({ error: "unauthorized", message: "A valid edit key or MCP token is required." }, 401);
  }
  const loaded = await readProjectDoc(env, id);
  if (!loaded) return json({ error: "not_found" }, 404);
  return json(presentAssetRefs(loaded.backup, publicOrigin(request, env)));
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
