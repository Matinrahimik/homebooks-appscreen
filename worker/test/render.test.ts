import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  acquireBrowser,
  acquisitionWaitMs,
  BROWSER_KEEP_ALIVE_MS,
  browserRateLimitError,
  isBrowserRateLimit,
  renderScreenshots,
  type BrowserHandle,
  type PuppeteerBinding,
} from "../src/render.ts";

const RATE_LIMIT = "Unable to create new browser: code: 429: message: Rate limit exceeded";

function browser(id = "b"): BrowserHandle & { closed: boolean; disconnected: boolean } {
  const handle = {
    id,
    closed: false,
    disconnected: false,
    async newPage() {
      throw new Error("newPage is not used in acquireBrowser tests");
    },
    async disconnect() {
      handle.disconnected = true;
    },
    async close() {
      handle.closed = true;
    },
  };
  return handle;
}

describe("browser sessions", () => {
  it("treats 429 and the acquisition timer", () => {
    assert.equal(isBrowserRateLimit(new Error(RATE_LIMIT)), true);
    assert.equal(isBrowserRateLimit(new Error("navigation timeout")), false);
    assert.equal(acquisitionWaitMs(45_000), 45_000);
    assert.equal(acquisitionWaitMs(60), 60_000);
    assert.equal(acquisitionWaitMs(0), null);
    assert.match(browserRateLimitError(new Error(RATE_LIMIT)).message, /Wait about 60 seconds/);
    assert.match(
      browserRateLimitError(new Error(RATE_LIMIT), { timeUntilNextAllowedBrowserAcquisition: 45_000 }).message,
      /Wait about 45 seconds/,
    );
  });

  it("reuses a free session and keeps a new browser alive", async () => {
    const sessions: { sessionId: string; connectionId?: string }[] = [];
    let launches = 0;
    let connects = 0;
    const puppeteer: PuppeteerBinding = {
      async sessions() {
        return sessions;
      },
      async connect(_endpoint, sessionId) {
        connects += 1;
        assert.equal(sessionId, "s1");
        return browser("reused");
      },
      async launch(_endpoint, options) {
        launches += 1;
        assert.equal(options?.keep_alive, BROWSER_KEEP_ALIVE_MS);
        sessions.push({ sessionId: "s1" });
        return browser("fresh");
      },
    };
    const first = await acquireBrowser(puppeteer, {});
    const second = await acquireBrowser(puppeteer, {});
    assert.equal(launches, 1);
    assert.equal(connects, 1);
    assert.equal((first as { id: string }).id, "fresh");
    assert.equal((second as { id: string }).id, "reused");
  });

  it("skips sessions that already have a worker connection", async () => {
    let connects = 0;
    let launches = 0;
    const puppeteer: PuppeteerBinding = {
      async sessions() {
        return [{ sessionId: "busy", connectionId: "worker-1" }];
      },
      async connect() {
        connects += 1;
        return browser();
      },
      async launch() {
        launches += 1;
        return browser();
      },
    };
    await acquireBrowser(puppeteer, {});
    assert.equal(connects, 0);
    assert.equal(launches, 1);
  });

  it("retries a 429 and then reuses a session that becomes free", async () => {
    const sleeps: number[] = [];
    let launches = 0;
    const puppeteer: PuppeteerBinding = {
      async sessions() {
        return launches > 0 ? [{ sessionId: "later" }] : [];
      },
      async connect() {
        return browser("after-limit");
      },
      async launch() {
        launches += 1;
        throw new Error(RATE_LIMIT);
      },
      async limits() {
        return { allowedBrowserAcquisitions: 0, timeUntilNextAllowedBrowserAcquisition: 5_000 };
      },
    };
    const handle = await acquireBrowser(puppeteer, {}, async (ms) => {
      sleeps.push(ms);
    });
    assert.equal(launches, 1);
    assert.deepEqual(sleeps, [5_000]);
    assert.equal((handle as { id: string }).id, "after-limit");
  });

  it("tells the caller when to retry if the limit persists", async () => {
    const sleeps: number[] = [];
    let launches = 0;
    const puppeteer: PuppeteerBinding = {
      async sessions() {
        return [];
      },
      async connect() {
        throw new Error("no free session");
      },
      async launch() {
        launches += 1;
        throw new Error(RATE_LIMIT);
      },
      async limits() {
        return { allowedBrowserAcquisitions: 0, timeUntilNextAllowedBrowserAcquisition: 45_000 };
      },
    };
    await assert.rejects(
      () => acquireBrowser(puppeteer, {}, async (ms) => {
        sleeps.push(ms);
      }),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /429/);
        assert.match(message, /per-minute limit on creating a new browser/);
        assert.match(message, /Wait about 45 seconds/);
        assert.match(message, /render_preview or export_project/);
        return true;
      },
    );
    assert.equal(launches, 3);
    assert.deepEqual(sleeps, [15_000, 15_000]);
  });
});

describe("renderScreenshots", () => {
  it("captures every index in one browser and disconnects to keep the session", async () => {
    const evaluated: unknown[] = [];
    let launches = 0;
    let closes = 0;
    let disconnects = 0;
    const page = {
      async setViewport() {},
      async goto() {},
      async waitForFunction() {},
      async evaluate(_fn: unknown, arg?: unknown) {
        if (arg === undefined) return { status: "ready", error: "" };
        evaluated.push(arg);
        return (arg as number[]).map((index) => ({
          index,
          width: 10,
          height: 20,
          dataUrl: "data:image/png;base64,QQ==",
        }));
      },
      async close() {
        closes += 1;
      },
    };
    const puppeteer: PuppeteerBinding = {
      async sessions() {
        return [];
      },
      async connect() {
        throw new Error("none");
      },
      async launch() {
        launches += 1;
        return {
          async newPage() {
            return page;
          },
          async disconnect() {
            disconnects += 1;
          },
          async close() {
            throw new Error("close would drop the session");
          },
        };
      },
    };
    const shots = await renderScreenshots({ BROWSER: {} }, "https://example.test/?render=all", [0, 1, 2], { puppeteer });
    assert.equal(launches, 1);
    assert.deepEqual(evaluated, [[0, 1, 2]]);
    assert.deepEqual(shots.map((shot) => shot.index), [0, 1, 2]);
    assert.equal(shots[0].png[0], "A".charCodeAt(0));
    assert.equal(disconnects, 1);
    assert.equal(closes, 1);
  });
});
