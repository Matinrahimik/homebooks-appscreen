import type { RenderSupply } from "./assets.ts";
import type { RenderShot } from "./types.ts";

interface BrowserEnv {
  BROWSER?: unknown;
}

export interface BrowserSessionInfo {
  sessionId: string;
  connectionId?: string;
}

export interface BrowserLimits {
  allowedBrowserAcquisitions?: number;
  timeUntilNextAllowedBrowserAcquisition?: number;
}

interface InterceptedRequest {
  url(): string;
  continue(): Promise<void>;
  respond(response: {
    status: number;
    contentType?: string;
    headers?: Record<string, string>;
    body?: string | Uint8Array | Buffer;
  }): Promise<void>;
  abort?(reason?: string): Promise<void>;
}

interface BrowserPage {
  setViewport(viewport: { width: number; height: number; deviceScaleFactor: number }): Promise<unknown>;
  setCacheEnabled?(enabled: boolean): Promise<void>;
  setRequestInterception?(value: boolean): Promise<void>;
  on?(event: "request", handler: (request: InterceptedRequest) => void | Promise<void>): void;
  goto(url: string, options: { waitUntil: string; timeout: number }): Promise<unknown>;
  waitForFunction(fn: () => boolean, options: { timeout: number }): Promise<unknown>;
  evaluate<T>(fn: (...args: never[]) => T, arg?: unknown): Promise<T>;
  close?: () => Promise<void>;
}

interface BrowserHandle {
  newPage(): Promise<BrowserPage>;
  disconnect?: () => Promise<void>;
  close?: () => Promise<void>;
}

export interface PuppeteerBinding {
  sessions(endpoint: unknown): Promise<BrowserSessionInfo[]>;
  connect(endpoint: unknown, sessionId: string): Promise<BrowserHandle>;
  launch(endpoint: unknown, options?: { keep_alive?: number }): Promise<BrowserHandle>;
  limits?(endpoint: unknown): Promise<BrowserLimits>;
}

/** How long a disconnected session stays available for the next render. Milliseconds. */
export const BROWSER_KEEP_ALIVE_MS = 180_000;

/** Backoff used when the account does not say how long the new-browser limit lasts. */
export const BROWSER_RETRY_DELAYS_MS = [2_000, 8_000];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function isBrowserRateLimit(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b429\b/.test(message) || /rate limit/i.test(message);
}

/**
 * `limits().timeUntilNextAllowedBrowserAcquisition` is milliseconds in current
 * accounts and a small second count in older responses. Values under 1000 are
 * seconds; 0 means a new browser can be acquired now.
 */
export function acquisitionWaitMs(value: number | undefined): number | null {
  if (value == null || !Number.isFinite(value) || value <= 0) return null;
  if (value < 1000) return Math.round(value * 1000);
  return Math.round(value);
}

export function browserRateLimitError(cause: unknown, limits?: BrowserLimits | null): Error {
  const raw = cause instanceof Error ? cause.message : String(cause);
  const waitMs = acquisitionWaitMs(limits?.timeUntilNextAllowedBrowserAcquisition);
  const seconds = waitMs != null ? Math.max(1, Math.ceil(waitMs / 1000)) : 60;
  const daily = /daily|browser hours|duration quota/i.test(raw)
    ? " If the message is the free-plan daily browser-time cap, retry after that allowance resets."
    : "";
  return new Error(
    `Browser Rendering rate limit: ${raw}. This is the per-minute limit on creating a new browser. Wait about ${seconds} seconds and call render_preview or export_project again. A free session is reused when one is still alive, and every screenshot in one call shares that browser.${daily}`,
  );
}

async function connectFreeSession(puppeteer: PuppeteerBinding, endpoint: unknown): Promise<BrowserHandle | null> {
  let sessions: BrowserSessionInfo[] = [];
  try {
    sessions = await puppeteer.sessions(endpoint);
  } catch {
    return null;
  }
  for (const session of sessions) {
    if (!session?.sessionId || session.connectionId) continue;
    try {
      return await puppeteer.connect(endpoint, session.sessionId);
    } catch {
      /* Session was taken or is not ready. Try the next one, then launch. */
    }
  }
  return null;
}

async function readLimits(puppeteer: PuppeteerBinding, endpoint: unknown): Promise<BrowserLimits | null> {
  if (!puppeteer.limits) return null;
  try {
    return await puppeteer.limits(endpoint);
  } catch {
    return null;
  }
}

function retryDelay(attempt: number, limits: BrowserLimits | null): number {
  const indicated = acquisitionWaitMs(limits?.timeUntilNextAllowedBrowserAcquisition);
  if (indicated == null) return BROWSER_RETRY_DELAYS_MS[attempt] ?? 8_000;
  return Math.min(Math.max(indicated, 250), 15_000);
}

/**
 * Reuse a Browser Rendering session that no longer has a worker attached.
 * Launching a new browser is the fallback, with keep-alive so the next tool
 * call can connect instead of hitting the per-minute new-browser limit.
 */
export async function acquireBrowser(
  puppeteer: PuppeteerBinding,
  endpoint: unknown,
  wait: (ms: number) => Promise<void> = sleep,
): Promise<BrowserHandle> {
  const existing = await connectFreeSession(puppeteer, endpoint);
  if (existing) return existing;

  let lastError: unknown;
  let lastLimits: BrowserLimits | null = null;
  const attempts = BROWSER_RETRY_DELAYS_MS.length + 1;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await puppeteer.launch(endpoint, { keep_alive: BROWSER_KEEP_ALIVE_MS });
    } catch (error) {
      lastError = error;
      if (!isBrowserRateLimit(error)) throw error;
      lastLimits = await readLimits(puppeteer, endpoint);
      if (attempt === attempts - 1) throw browserRateLimitError(error, lastLimits);
      await wait(retryDelay(attempt, lastLimits));
      const freed = await connectFreeSession(puppeteer, endpoint);
      if (freed) return freed;
    }
  }
  throw browserRateLimitError(lastError, lastLimits);
}

export async function releaseBrowser(browser: BrowserHandle, discard = false): Promise<void> {
  if (discard && typeof browser.close === "function") {
    await browser.close();
    return;
  }
  if (typeof browser.disconnect === "function") {
    await browser.disconnect();
    return;
  }
  if (typeof browser.close === "function") await browser.close();
}

export type FulfillDecision =
  | { kind: "continue" }
  | { kind: "missing"; url: string }
  | { kind: "respond"; status: number; contentType: string; body: Uint8Array | string; headers: Record<string, string> };

/** Answer the render page's project and asset fetches from memory. Everything else uses the network. */
export function fulfillRenderRequest(rawUrl: string, supply: RenderSupply): FulfillDecision {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { kind: "continue" };
  }
  if (/\/api\/projects\/[^/]+$/.test(url.pathname)) {
    return {
      kind: "respond",
      status: 200,
      contentType: "application/json; charset=utf-8",
      body: supply.projectBody,
      headers: { "cache-control": "no-store" },
    };
  }
  const asset = url.pathname.match(/\/assets\/([a-f0-9]{64})$/i);
  if (!asset) return { kind: "continue" };
  const blob = supply.assets.get(asset[1].toLowerCase());
  if (!blob) return { kind: "missing", url: rawUrl };
  return {
    kind: "respond",
    status: 200,
    contentType: blob.mime,
    body: blob.bytes,
    headers: { "cache-control": "no-store" },
  };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface CaptureSource {
  image: string;
  panorama: boolean;
}

/**
 * Identical PNGs are the export failure mode: every index captured the gradient
 * before its photo or panorama decoded. Matching frames are allowed when they
 * really share one image and there is no panorama to slice.
 */
export async function assertRenderedFrames(
  shots: { index: number; png: Uint8Array }[],
  sources: CaptureSource[],
): Promise<void> {
  if (shots.length < 2) return;
  const hashes = await Promise.all(shots.map((shot) => sha256Hex(shot.png)));
  const allSame = hashes.every((hash) => hash === hashes[0]);
  const distinctImages = new Set(sources.map((source) => source.image).filter(Boolean));
  const panorama = sources.some((source) => source.panorama);
  if (allSame && (panorama || distinctImages.size > 1)) {
    throw new Error(
      `All ${shots.length} rendered PNGs are byte-identical. The device screenshot or panoramic background did not load before capture.`,
    );
  }
  const byHash = new Map<string, Set<string>>();
  hashes.forEach((hash, i) => {
    const image = sources[i]?.image || "";
    if (!image) return;
    const set = byHash.get(hash) || new Set<string>();
    set.add(image);
    byHash.set(hash, set);
  });
  for (const [, images] of byHash) {
    if (images.size > 1) {
      throw new Error(
        `Screenshots that use different images (${[...images].join(", ")}) rendered to the same PNG. Capture ran before those images loaded.`,
      );
    }
  }
}

interface RenderHooks {
  puppeteer?: PuppeteerBinding;
  sleep?: (ms: number) => Promise<void>;
  /** When set, project JSON and /assets are answered from KV bytes. No loopback. */
  supply?: RenderSupply;
}

/**
 * Open the hosted Pages app in render mode and read each finished canvas
 * at its real output pixel size via window.__appscreen.capture().
 * Every index is captured in the same browser session.
 */
function respondBody(body: Uint8Array | string): string | Buffer {
  if (typeof body === "string") return body;
  return Buffer.from(body);
}

async function installSupply(page: BrowserPage, supply: RenderSupply): Promise<() => string> {
  if (!page.setRequestInterception || !page.on) {
    throw new Error("This browser cannot intercept asset requests, so render would loop back to /assets and can capture a broken frame.");
  }
  let interceptError = "";
  await page.setRequestInterception(true);
  page.on("request", async (request) => {
    try {
      const decision = fulfillRenderRequest(request.url(), supply);
      if (decision.kind === "continue") {
        await request.continue();
        return;
      }
      if (decision.kind === "missing") {
        interceptError = `Render asset failed to load: ${decision.url}`;
        await request.respond({ status: 404, contentType: "text/plain", body: interceptError, headers: { "cache-control": "no-store" } });
        return;
      }
      await request.respond({
        status: decision.status,
        contentType: decision.contentType,
        headers: decision.headers,
        body: respondBody(decision.body),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      interceptError = interceptError || `Render request failed for ${request.url()}: ${message}`;
      try {
        await request.abort?.("failed");
      } catch {
        /* The page will see the failed asset and refuse to mark ready. */
      }
    }
  });
  return () => interceptError;
}

/**
 * Open a fresh page in render mode and read each finished canvas at its real
 * output pixel size. A failed render closes the browser so the next call does
 * not reconnect to a session whose HTTP cache or IndexedDB is poisoned.
 */
export async function renderScreenshots(
  env: BrowserEnv,
  pageUrl: string,
  indices: number[],
  hooks?: RenderHooks,
): Promise<RenderShot[]> {
  if (!env.BROWSER && !hooks?.puppeteer) {
    throw new Error("Browser Rendering binding BROWSER is not configured.");
  }
  const puppeteer = hooks?.puppeteer ?? ((await import("@cloudflare/puppeteer")).default as PuppeteerBinding);
  const browser = await acquireBrowser(puppeteer, env.BROWSER, hooks?.sleep);
  let page: BrowserPage | undefined;
  let discard = false;
  try {
    page = await browser.newPage();
    await page.setViewport({ width: 900, height: 900, deviceScaleFactor: 1 });
    if (page.setCacheEnabled) await page.setCacheEnabled(false);
    const interceptionError = hooks?.supply ? await installSupply(page, hooks.supply) : null;
    const opened = new URL(pageUrl);
    opened.searchParams.set("cb", String(Date.now()));
    await page.goto(opened.toString(), { waitUntil: "networkidle0", timeout: 90_000 });
    if (interceptionError) {
      const missed = interceptionError();
      if (missed) throw new Error(missed);
    }
    await page.waitForFunction(
      () => {
        const status = document.documentElement.dataset.appscreenStatus;
        return status === "ready" || status === "error";
      },
      { timeout: 90_000 },
    );
    const status = await page.evaluate(() => ({
      status: document.documentElement.dataset.appscreenStatus || "",
      error: document.documentElement.dataset.appscreenError || (window as unknown as { __appscreenError?: string }).__appscreenError || "",
    }));
    if (interceptionError) {
      const missed = interceptionError();
      if (missed) throw new Error(missed);
    }
    if (status.status === "error") {
      throw new Error(status.error || "Headless render failed in the Pages app.");
    }
    const shots = await page.evaluate(async (wanted: number[]) => {
      const hook = (window as unknown as {
        __appscreen?: {
          capture: (index: number) => Promise<{ index: number; width: number; height: number; dataUrl: string }>;
        };
      }).__appscreen;
      if (!hook) throw new Error("window.__appscreen is missing.");
      const out = [];
      for (const index of wanted) out.push(await hook.capture(index));
      return out;
    }, indices);
    return shots.map((shot) => {
      const match = /^data:image\/png;base64,(.+)$/i.exec(shot.dataUrl || "");
      if (!match) throw new Error(`Screenshot ${shot.index} did not return a PNG data URL.`);
      const binary = atob(match[1]);
      const png = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) png[i] = binary.charCodeAt(i);
      return { index: shot.index, png, width: shot.width, height: shot.height };
    });
  } catch (error) {
    discard = true;
    throw error;
  } finally {
    if (page?.close) {
      try {
        await page.close();
      } catch {
        /* A discarded session is closed below. A healthy one stays reusable. */
      }
    }
    await releaseBrowser(browser, discard);
  }
}
