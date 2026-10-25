/** Minimal KV surface used by the Worker and the in-memory test double. */
export interface KvLike {
  get(key: string, options?: { type?: "text" | "json" | "arrayBuffer" }): Promise<unknown>;
  put(key: string, value: string | ArrayBuffer | ArrayBufferView): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface Env {
  APPSCREEN_KV: KvLike;
  /** Cloudflare Browser Rendering binding (`browser` in wrangler / metadata). */
  BROWSER?: unknown;
  /** Worker secret. Exact name: APPSCREEN_MCP_TOKEN. */
  APPSCREEN_MCP_TOKEN?: string;
  PAGES_ORIGIN?: string;
  PAGES_PATH?: string;
  /** Public origin of this Worker. Falls back to the incoming request origin. */
  PUBLIC_BASE_URL?: string;
  /** One Durable Object per project. Serializes compare-and-swap of the project JSON. */
  PROJECT_GATE?: {
    idFromName(name: string): unknown;
    get(id: unknown): { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> };
  };
}

export interface RenderShot {
  index: number;
  png: Uint8Array;
  width: number;
  height: number;
}

export interface Services {
  env: Env;
  publicOrigin: string;
  /** ISO timestamp. Overridable in tests. */
  now?: () => string;
  /** Fetch a remote screenshot image. Overridable in tests. */
  loadImage?: (url: string) => Promise<{ mime: string; bytes: Uint8Array }>;
  /** Headless render. Omitted in unit tests that do not exercise rendering. */
  renderScreenshots?: (pageUrl: string, indices: number[]) => Promise<RenderShot[]>;
}
