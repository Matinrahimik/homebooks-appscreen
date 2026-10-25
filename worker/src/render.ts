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

interface BrowserPage {
  setViewport(viewport: { width: number; height: number; deviceScaleFactor: number }): Promise<unknown>;
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

export async function releaseBrowser(browser: BrowserHandle): Promise<void> {
  if (typeof browser.disconnect === "function") {
    await browser.disconnect();
    return;
  }
  if (typeof browser.close === "function") await browser.close();
}

interface RenderHooks {
  puppeteer?: PuppeteerBinding;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Open the hosted Pages app in render mode and read each finished canvas
 * at its real output pixel size via window.__appscreen.capture().
 * Every index is captured in the same browser session.
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
  try {
    page = await browser.newPage();
    await page.setViewport({ width: 900, height: 900, deviceScaleFactor: 1 });
    await page.goto(pageUrl, { waitUntil: "networkidle0", timeout: 90_000 });
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
  } finally {
    if (page?.close) {
      try {
        await page.close();
      } catch {
        /* The session is still reusable after the page goes away. */
      }
    }
    await releaseBrowser(browser);
  }
}
