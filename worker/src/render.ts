import { logStage } from "./log.ts";
import type { RenderedFrame } from "./types.ts";

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

interface BrowserPage {
  setViewport(viewport: { width: number; height: number; deviceScaleFactor: number }): Promise<unknown>;
  setCacheEnabled?(enabled: boolean): Promise<void>;
  on?(event: string, handler: (payload: unknown) => void): void;
  goto(url: string, options: { waitUntil: string; timeout: number }): Promise<unknown>;
  waitForFunction(fn: () => boolean, options: { timeout: number }): Promise<unknown>;
  evaluate<T>(fn: (...args: never[]) => T): Promise<T>;
  close?: () => Promise<void>;
}

interface BrowserHandle {
  newPage(): Promise<BrowserPage>;
  version?(): Promise<string>;
  disconnect?: () => Promise<void>;
  close?: () => Promise<void>;
}

export interface PuppeteerBinding {
  sessions(endpoint: unknown): Promise<BrowserSessionInfo[]>;
  connect(endpoint: unknown, sessionId: string): Promise<BrowserHandle>;
  launch(endpoint: unknown, options?: { keep_alive?: number }): Promise<BrowserHandle>;
  limits?(endpoint: unknown): Promise<BrowserLimits>;
}

/** How long a disconnected healthy session stays available for the next render. */
export const BROWSER_KEEP_ALIVE_MS = 180_000;

/** Launch attempts per call. A 429 does not sleep and does not loop. */
export const BROWSER_LAUNCH_ATTEMPTS = 2;

/** Shared budget for navigation and the upload wait. Under the 60s browser idle timeout. */
export const RENDER_WALL_MS = 50_000;

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

/**
 * Cloudflare's daily cap is `Browser time limit exceeded for today`, not the
 * per-minute new-browser 429. A wait of half an hour or more is the same cap
 * when the message text is generic.
 */
export function isDailyBrowserAllowance(cause: unknown, limits?: BrowserLimits | null): boolean {
  const raw = cause instanceof Error ? cause.message : String(cause);
  if (/browser time limit exceeded|exceeded for today|daily browser|per day|duration quota/i.test(raw)) return true;
  const wait = acquisitionWaitMs(limits?.timeUntilNextAllowedBrowserAcquisition);
  return wait != null && wait >= 30 * 60 * 1000;
}

export function browserRateLimitError(cause: unknown, limits?: BrowserLimits | null): Error {
  const raw = cause instanceof Error ? cause.message : String(cause);
  if (isDailyBrowserAllowance(cause, limits)) {
    return new Error(
      `Browser Rendering daily allowance is exhausted. The Workers Free plan includes about 10 minutes of browser time per UTC day. ${raw}. Retry after the daily reset at 00:00 UTC. This is not the per-minute new-browser limit, and launching again will not help until the allowance resets.`,
    );
  }
  const waitMs = acquisitionWaitMs(limits?.timeUntilNextAllowedBrowserAcquisition);
  const seconds = waitMs != null ? Math.max(1, Math.ceil(waitMs / 1000)) : 60;
  return new Error(
    `Browser Rendering rate limit: ${raw}. retry-after: ${seconds} seconds. This is the per-minute limit on creating a new browser. Wait about ${seconds} seconds and call render_preview or export_project again. A healthy session is reused, including after a page error. A browser that stops answering is closed.`,
  );
}

/** CDP/browser failures. A page that reports its own error is not poisoned. */
export function isPoisonedBrowser(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /protocol error|target closed|session closed|browser has disconnected|browser closed|websocket|connection closed|ECONNRESET|crashed|most likely the page has been closed|not ready yet/i.test(message);
}

async function browserHealthy(browser: BrowserHandle): Promise<boolean> {
  if (typeof browser.version !== "function") return true;
  try {
    await browser.version();
    return true;
  } catch {
    return false;
  }
}

async function closeQuietly(browser: BrowserHandle): Promise<void> {
  if (typeof browser.close !== "function") return;
  try {
    await browser.close();
  } catch {
    /* The session is already gone. */
  }
}

/**
 * Reuse a session that answers `version()`. Sessions with a connectionId are
 * skipped unless `includeConnected` is set, which is only used when a new
 * launch is not allowed and the previous call may have died mid-connection.
 * A session that connects but does not answer is closed.
 */
async function takeReusableSession(
  puppeteer: PuppeteerBinding,
  endpoint: unknown,
  includeConnected: boolean,
): Promise<BrowserHandle | null> {
  let sessions: BrowserSessionInfo[] = [];
  try {
    sessions = await puppeteer.sessions(endpoint);
  } catch {
    return null;
  }
  for (const session of sessions) {
    if (!session?.sessionId) continue;
    if (session.connectionId && !includeConnected) continue;
    let handle: BrowserHandle;
    try {
      handle = await puppeteer.connect(endpoint, session.sessionId);
    } catch {
      continue;
    }
    if (await browserHealthy(handle)) return handle;
    logStage("browser_closed", { reason: "unhealthy" });
    await closeQuietly(handle);
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

/**
 * Reuse a session that answers. Otherwise launch, at most twice.
 * There is no sleep loop. A 429 reads limits(), reuses a free or still-connected
 * session if one answers, and otherwise returns retry-after. A second launch
 * happens only when the account still allows an acquisition. The daily
 * allowance is reported on its own, not as a one-minute wait.
 */
export async function acquireBrowser(
  puppeteer: PuppeteerBinding,
  endpoint: unknown,
  _wait: (ms: number) => Promise<void> = () => Promise.resolve(),
): Promise<BrowserHandle> {
  const existing = await takeReusableSession(puppeteer, endpoint, false);
  if (existing) {
    logStage("browser_acquired", { reused: true });
    return existing;
  }

  let lastError: unknown;
  let lastLimits: BrowserLimits | null = null;
  for (let attempt = 0; attempt < BROWSER_LAUNCH_ATTEMPTS; attempt++) {
    lastLimits = await readLimits(puppeteer, endpoint);
    if (lastLimits?.allowedBrowserAcquisitions === 0) {
      const stuck = await takeReusableSession(puppeteer, endpoint, true);
      if (stuck) {
        logStage("browser_acquired", { reused: true, attempt });
        return stuck;
      }
      if (attempt > 0) throw browserRateLimitError(lastError ?? new Error("Rate limit exceeded"), lastLimits);
    }
    try {
      const handle = await puppeteer.launch(endpoint, { keep_alive: BROWSER_KEEP_ALIVE_MS });
      logStage("browser_acquired", { reused: false, attempt });
      return handle;
    } catch (error) {
      lastError = error;
      if (!isBrowserRateLimit(error)) throw error;
      const freed = await takeReusableSession(puppeteer, endpoint, true);
      if (freed) {
        logStage("browser_acquired", { reused: true, attempt });
        return freed;
      }
      lastLimits = (await readLimits(puppeteer, endpoint)) ?? lastLimits;
      const allowed = lastLimits?.allowedBrowserAcquisitions ?? 0;
      if (isDailyBrowserAllowance(error, lastLimits) || allowed <= 0 || attempt === BROWSER_LAUNCH_ATTEMPTS - 1) {
        throw browserRateLimitError(error, lastLimits);
      }
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

export function parseUploads(value: string | null | undefined): Map<number, string> {
  const slots = new Map<number, string>();
  for (const part of String(value || "").split(",")) {
    const splitAt = part.indexOf(":");
    if (splitAt <= 0) continue;
    const index = part.slice(0, splitAt);
    const token = part.slice(splitAt + 1);
    if (!/^\d+$/.test(index) || !/^[a-f0-9]{64}$/i.test(token)) continue;
    slots.set(Number(index), token.toLowerCase());
  }
  return slots;
}

export interface CaptureSource {
  image: string;
  panorama: boolean;
}

/**
 * Identical PNGs are the export failure mode: every index captured the gradient
 * before its photo or panorama decoded. The page reports sha256; this does not
 * hash image bytes. Matching frames are allowed when they really share one image
 * and there is no panorama to slice.
 */
export function assertRenderedFrames(
  shots: { index: number; sha256: string }[],
  sources: CaptureSource[],
): void {
  if (shots.length < 2) return;
  const hashes = shots.map((shot) => shot.sha256);
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
}

interface PageShot {
  index?: number;
  token?: string;
  width?: number;
  height?: number;
  bytes?: number;
  sha256?: string;
  crc?: number;
}

function frameFromPage(shot: PageShot | undefined, index: number, token: string): RenderedFrame {
  if (!shot || shot.index !== index || String(shot.token || "").toLowerCase() !== token) {
    throw new Error(`Screenshot ${index} did not upload.`);
  }
  if (!Number.isInteger(shot.width) || shot.width <= 0 || !Number.isInteger(shot.height) || shot.height <= 0) {
    throw new Error(`Screenshot ${index} reported an invalid size.`);
  }
  if (!Number.isInteger(shot.bytes) || shot.bytes <= 0) {
    throw new Error(`Screenshot ${index} reported an empty PNG.`);
  }
  if (!/^[a-f0-9]{64}$/i.test(shot.sha256 || "")) {
    throw new Error(`Screenshot ${index} did not report a sha256.`);
  }
  if (!Number.isInteger(shot.crc) || shot.crc < 0 || shot.crc > 0xffffffff) {
    throw new Error(`Screenshot ${index} did not report a crc32.`);
  }
  return {
    index,
    token,
    width: shot.width,
    height: shot.height,
    bytes: shot.bytes,
    sha256: shot.sha256.toLowerCase(),
    crc: shot.crc >>> 0,
  };
}

function remaining(deadline: number): number {
  return Math.max(1_000, deadline - Date.now());
}

interface PageEvent {
  kind: "console" | "requestfailed" | "response";
  text: string;
}

function scrubUrl(value: string): string {
  return value.replace(/([?&](?:key|uploads|token)=)[^&\s'"]+/gi, "$1redacted");
}

function callText(value: unknown, method: string): string {
  if (!value || typeof value !== "object") return "";
  const fn = (value as Record<string, unknown>)[method];
  if (typeof fn !== "function") return "";
  try {
    const result = fn.call(value);
    return result == null ? "" : String(result);
  } catch {
    return "";
  }
}

function relevantRequest(url: string): boolean {
  return /\/api\/projects|\/assets\/|\/renders\/|\/models\//.test(url);
}

/**
 * The page's fetch() only sees "Failed to fetch" for a CORS rejection. The
 * CORS reason, the failed URL, and the preflight status are on these events.
 */
function attachPageDiagnostics(page: BrowserPage): PageEvent[] {
  const events: PageEvent[] = [];
  if (typeof page.on !== "function") return events;
  const push = (kind: PageEvent["kind"], text: string) => {
    const clean = scrubUrl(text).replace(/\s+/g, " ").trim().slice(0, 400);
    if (!clean) return;
    if (events.some((event) => event.kind === kind && event.text === clean)) return;
    events.push({ kind, text: clean });
    if (events.length > 12) events.shift();
  };
  page.on("console", (message) => {
    const type = callText(message, "type");
    const text = callText(message, "text") || (typeof message === "string" ? message : "");
    if (type && type !== "error" && type !== "warning" && !/CORS|blocked|failed|net::/i.test(text)) return;
    push("console", text);
  });
  page.on("requestfailed", (request) => {
    const url = callText(request, "url");
    const method = callText(request, "method") || "GET";
    const failure = request && typeof request === "object" ? (request as { failure?: () => { errorText?: string } | null }).failure?.() : null;
    const reason = failure?.errorText || "failed";
    if (!relevantRequest(url) && !/CORS|ERR_|blocked/i.test(reason)) return;
    push("requestfailed", `${method} ${url} ${reason}`);
  });
  page.on("response", (response) => {
    const url = callText(response, "url");
    const status = callText(response, "status");
    const request = response && typeof response === "object" ? (response as { request?: () => unknown }).request?.() : null;
    const method = callText(request, "method");
    if (method !== "OPTIONS" && !relevantRequest(url) && Number(status) < 400) return;
    push("response", `${status} ${method} ${url}`.trim());
  });
  return events;
}

function withDiagnostics(error: unknown, events: PageEvent[]): Error {
  const base = error instanceof Error ? error : new Error(String(error));
  if (!events.length || base.message.includes("Page network:")) return base;
  const lines = events.slice(-8).map((event) => `${event.kind}: ${event.text}`);
  return new Error(`${base.message} Page network: ${lines.join(" | ")}`);
}

/**
 * Open the hosted page and wait until it has uploaded each PNG. The return
 * value is the small done JSON. Screenshot bytes never enter this isolate.
 * A page error disconnects the browser so the next call reuses it. A browser
 * that stops answering is closed.
 */
export async function renderScreenshots(
  env: BrowserEnv,
  pageUrl: string,
  indices: number[],
  hooks?: RenderHooks,
): Promise<RenderedFrame[]> {
  if (!env.BROWSER && !hooks?.puppeteer) {
    throw new Error("Browser Rendering binding BROWSER is not configured.");
  }
  const uploads = parseUploads(new URL(pageUrl).searchParams.get("uploads"));
  for (const index of indices) {
    if (!uploads.get(index)) throw new Error(`Screenshot ${index} has no upload token.`);
  }
  const puppeteer = hooks?.puppeteer ?? ((await import("@cloudflare/puppeteer")).default as PuppeteerBinding);
  const browser = await acquireBrowser(puppeteer, env.BROWSER, hooks?.sleep);
  const deadline = Date.now() + RENDER_WALL_MS;
  let page: BrowserPage | undefined;
  let discard = false;
  let events: PageEvent[] = [];
  try {
    page = await browser.newPage();
    events = attachPageDiagnostics(page);
    await page.setViewport({ width: 900, height: 900, deviceScaleFactor: 1 });
    if (page.setCacheEnabled) await page.setCacheEnabled(false);
    const opened = new URL(pageUrl);
    opened.searchParams.set("cb", String(Date.now()));
    try {
      await page.goto(opened.toString(), { waitUntil: "networkidle0", timeout: remaining(deadline) });
      logStage("page_opened", { indexes: indices });
      await page.waitForFunction(
        () => {
          const status = document.documentElement.dataset.appscreenStatus;
          return status === "done" || status === "error";
        },
        { timeout: remaining(deadline) },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/timeout|timed out/i.test(message)) {
        throw new Error(
          `Render timed out after ${RENDER_WALL_MS}ms. The page did not finish uploading. On the Workers Free plan a browser session is short, and a multi-screenshot 3D export can exceed it.`,
        );
      }
      throw error;
    }
    const reported = await page.evaluate(() => ({
      status: document.documentElement.dataset.appscreenStatus || "",
      error: document.documentElement.dataset.appscreenError || "",
      result: document.documentElement.dataset.appscreenResult || "",
    }));
    if (reported.status === "error") {
      throw new Error(reported.error || "Headless render failed in the Pages app.");
    }
    if (reported.status !== "done") {
      throw new Error(`Render page finished as "${reported.status || "empty"}" without uploading.`);
    }
    let parsed: { shots?: PageShot[] };
    try {
      parsed = JSON.parse(reported.result || "{}") as { shots?: PageShot[] };
    } catch {
      throw new Error("Render page returned a result that was not JSON.");
    }
    const shots = parsed.shots || [];
    return indices.map((index) => frameFromPage(shots.find((shot) => shot.index === index), index, uploads.get(index)!));
  } catch (error) {
    const detailed = withDiagnostics(error, events);
    discard = isPoisonedBrowser(detailed);
    logStage("render_error", {
      message: detailed.message,
      indexes: indices,
      discard,
    });
    throw detailed;
  } finally {
    if (page?.close) {
      try {
        await page.close();
      } catch {
        discard = true;
      }
    }
    await releaseBrowser(browser, discard);
  }
}
