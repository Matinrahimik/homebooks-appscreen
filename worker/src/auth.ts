import type { Env } from "./types.ts";

/** Constant-time string compare. Does not throw on length mismatch. */
export function tokensEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let mismatch = a.length === b.length ? 0 : 1;
  for (let i = 0; i < len; i++) {
    const ca = i < a.length ? a.charCodeAt(i) : 0;
    const cb = i < b.length ? b.charCodeAt(i) : 0;
    mismatch |= ca ^ cb;
  }
  return mismatch === 0;
}

export function bearerToken(request: Request): string {
  const header = request.headers.get("Authorization") || request.headers.get("authorization") || "";
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match ? match[1] : "";
}

export function editKeyFromRequest(request: Request): string {
  const header = request.headers.get("X-Edit-Key") || request.headers.get("x-edit-key") || "";
  if (header) return header.trim();
  try {
    return new URL(request.url).searchParams.get("key")?.trim() || "";
  } catch {
    return "";
  }
}

/**
 * MCP and privileged writes require the Worker secret.
 * Returns null when the caller is authorized, or a 401 Response.
 */
export function requireMcpToken(request: Request, env: Env): Response | null {
  const expected = env.APPSCREEN_MCP_TOKEN || "";
  const presented = bearerToken(request);
  if (!expected || !presented || !tokensEqual(presented, expected)) {
    return Response.json(
      { error: "unauthorized", message: "Authorization: Bearer <APPSCREEN_MCP_TOKEN> is required." },
      { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="homebooks-appscreen-mcp"' } },
    );
  }
  return null;
}

/** Live-mode REST: the per-project edit key, or the MCP token. */
export function canWriteProject(request: Request, env: Env, editKey: string): boolean {
  const presentedKey = editKeyFromRequest(request);
  if (editKey && presentedKey && tokensEqual(presentedKey, editKey)) return true;
  const expected = env.APPSCREEN_MCP_TOKEN || "";
  const presented = bearerToken(request);
  return Boolean(expected && presented && tokensEqual(presented, expected));
}
