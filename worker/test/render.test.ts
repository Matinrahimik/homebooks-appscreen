import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertAssetsPresent, storeAsset } from "../src/assets.ts";
import { addScreenshot, createBackup } from "../src/project.ts";
import {
  acquireBrowser,
  acquisitionWaitMs,
  assertRenderedFrames,
  BROWSER_KEEP_ALIVE_MS,
  BROWSER_LAUNCH_ATTEMPTS,
  browserRateLimitError,
  isBrowserRateLimit,
  isDailyBrowserAllowance,
  renderScreenshots,
  type BrowserHandle,
  type PuppeteerBinding,
} from "../src/render.ts";
import { withRenderLock } from "../src/store.ts";
import { createMemoryKv } from "./memory-kv.ts";

const RATE_LIMIT = "Unable to create new browser: code: 429: message: Rate limit exceeded";

function browser(id = "b", options?: { healthy?: boolean }): BrowserHandle & { id: string; closed: boolean; disconnected: boolean } {
  const handle = {
    id,
    closed: false,
    disconnected: false,
    async newPage() {
      throw new Error("newPage is not used in acquireBrowser tests");
    },
    async version() {
      if (options?.healthy === false) throw new Error("Protocol error: target closed");
      return "Chrome";
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
    assert.match(browserRateLimitError(new Error(RATE_LIMIT)).message, /retry-after: 60 seconds/);
    assert.match(browserRateLimitError(new Error(RATE_LIMIT)).message, /Wait about 60 seconds/);
    assert.match(
      browserRateLimitError(new Error(RATE_LIMIT), { timeUntilNextAllowedBrowserAcquisition: 45_000 }).message,
      /Wait about 45 seconds/,
    );
    const daily = "Unable to create new browser: code: 429: message: Browser time limit exceeded for today";
    assert.equal(isDailyBrowserAllowance(new Error(daily)), true);
    assert.equal(isDailyBrowserAllowance(new Error(RATE_LIMIT), { timeUntilNextAllowedBrowserAcquisition: 45_000 }), false);
    const dailyMessage = browserRateLimitError(new Error(daily)).message;
    assert.match(dailyMessage, /daily allowance is exhausted/);
    assert.match(dailyMessage, /10 minutes of browser time per UTC day/);
    assert.match(dailyMessage, /00:00 UTC/);
    assert.doesNotMatch(dailyMessage, /per-minute limit on creating a new browser/);
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
    assert.deepEqual(sleeps, []);
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
        assert.match(message, /retry-after: 45 seconds/);
        assert.match(message, /Wait about 45 seconds/);
        assert.match(message, /render_preview or export_project/);
        return true;
      },
    );
    assert.equal(launches, 1);
    assert.deepEqual(sleeps, []);
  });

  it("launches at most twice and does not sleep when another acquisition is allowed", async () => {
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
        return { allowedBrowserAcquisitions: 1, timeUntilNextAllowedBrowserAcquisition: 1_000 };
      },
    };
    await assert.rejects(() => acquireBrowser(puppeteer, {}, async (ms) => {
      sleeps.push(ms);
    }), /retry-after: 1 seconds/);
    assert.equal(BROWSER_LAUNCH_ATTEMPTS, 2);
    assert.equal(launches, 2);
    assert.deepEqual(sleeps, []);
  });

  it("closes a session that does not answer and launches another", async () => {
    const closed: string[] = [];
    let launches = 0;
    const puppeteer: PuppeteerBinding = {
      async sessions() {
        return [{ sessionId: "bad" }];
      },
      async connect() {
        return {
          async newPage() {
            throw new Error("unused");
          },
          async version() {
            throw new Error("Protocol error: target closed");
          },
          async close() {
            closed.push("bad");
          },
        };
      },
      async launch() {
        launches += 1;
        return browser("fresh");
      },
    };
    const handle = await acquireBrowser(puppeteer, {});
    assert.equal(launches, 1);
    assert.deepEqual(closed, ["bad"]);
    assert.equal((handle as { id: string }).id, "fresh");
  });

  it("reuses a still-connected session when a new browser is not allowed", async () => {
    let launches = 0;
    const puppeteer: PuppeteerBinding = {
      async sessions() {
        return [{ sessionId: "stuck", connectionId: "old-worker" }];
      },
      async connect(_endpoint, sessionId) {
        assert.equal(sessionId, "stuck");
        return browser("stuck");
      },
      async launch() {
        launches += 1;
        throw new Error(RATE_LIMIT);
      },
      async limits() {
        return { allowedBrowserAcquisitions: 0, timeUntilNextAllowedBrowserAcquisition: 45_000 };
      },
    };
    const handle = await acquireBrowser(puppeteer, {});
    assert.equal(launches, 0);
    assert.equal((handle as { id: string }).id, "stuck");
  });
});

describe("renderScreenshots", () => {
  it("waits for the page upload and disconnects a healthy session", async () => {
    let launches = 0;
    let closes = 0;
    let disconnects = 0;
    let intercepted = false;
    const tokens = [0, 1, 2].map((index) => `${index === 0 ? "ab" : index === 1 ? "cd" : "ef"}${"01".repeat(31)}`);
    const page = {
      async setViewport() {},
      async setRequestInterception() {
        intercepted = true;
        throw new Error("request interception must not run");
      },
      async goto(url: string) {
        assert.match(url, /cb=/);
        assert.match(url, /uploads=/);
        assert.equal(url.includes("data:image"), false);
      },
      async waitForFunction() {},
      async evaluate() {
        return {
          status: "done",
          error: "",
          result: JSON.stringify({
            shots: tokens.map((token, index) => ({
              index,
              token,
              width: 10 + index,
              height: 20,
              bytes: 1000 + index,
              sha256: (index + 1).toString(16).padStart(64, "0"),
              crc: 10 + index,
            })),
          }),
        };
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
    const pageUrl = `https://example.test/?render=all&uploads=${tokens.map((token, index) => `${index}:${token}`).join(",")}`;
    const shots = await renderScreenshots({ BROWSER: {} }, pageUrl, [0, 1, 2], { puppeteer });
    assert.equal(intercepted, false);
    assert.equal(launches, 1);
    assert.deepEqual(shots.map((shot) => shot.index), [0, 1, 2]);
    assert.equal(shots[0].token, tokens[0]);
    assert.equal(shots[0].bytes, 1000);
    assert.equal("png" in shots[0], false);
    assert.equal(disconnects, 1);
    assert.equal(closes, 1);
  });

  it("keeps a healthy session after a page error and reports the fetch failure", async () => {
    let disconnects = 0;
    let closes = 0;
    const listeners: Record<string, ((payload: unknown) => void)[]> = {};
    const page = {
      async setViewport() {},
      async setCacheEnabled() {},
      on(event: string, handler: (payload: unknown) => void) {
        (listeners[event] ||= []).push(handler);
      },
      async goto() {
        for (const handler of listeners.console || []) {
          handler({
            type: () => "error",
            text: () => "Access to fetch at 'https://worker.test/api/projects/p?cb=1' has been blocked by CORS policy: Request header field cache-control is not allowed by Access-Control-Allow-Headers in preflight response.",
          });
        }
        for (const handler of listeners.requestfailed || []) {
          handler({
            method: () => "GET",
            url: () => "https://worker.test/api/projects/p?cb=1&key=secret-edit-key",
            failure: () => ({ errorText: "net::ERR_FAILED" }),
          });
        }
        for (const handler of listeners.response || []) {
          handler({
            status: () => 204,
            url: () => "https://worker.test/api/projects/p?cb=1",
            request: () => ({ method: () => "OPTIONS" }),
          });
        }
      },
      async waitForFunction() {},
      async evaluate() {
        return {
          status: "error",
          error: "Could not reach the screenshot API: GET https://worker.test/api/projects/p (Failed to fetch)",
        };
      },
      async close() {},
    };
    const puppeteer: PuppeteerBinding = {
      async sessions() {
        return [];
      },
      async connect() {
        throw new Error("none");
      },
      async launch() {
        return {
          async newPage() {
            return page;
          },
          async disconnect() {
            disconnects += 1;
          },
          async close() {
            closes += 1;
          },
        };
      },
    };
    const token = "ab".repeat(32);
    await assert.rejects(
      () => renderScreenshots({ BROWSER: {} }, `https://example.test/?render=0&uploads=0:${token}`, [0], { puppeteer }),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /Could not reach the screenshot API/);
        assert.match(message, /cache-control is not allowed/);
        assert.match(message, /requestfailed: GET https:\/\/worker\.test\/api\/projects\/p/);
        assert.match(message, /net::ERR_FAILED/);
        assert.match(message, /response: 204 OPTIONS/);
        assert.match(message, /key=redacted/);
        assert.equal(message.includes("secret-edit-key"), false);
        return true;
      },
    );
    assert.equal(closes, 0);
    assert.equal(disconnects, 1);
  });

  it("closes a browser that dies during navigation", async () => {
    let disconnects = 0;
    let closes = 0;
    const page = {
      async setViewport() {},
      async setCacheEnabled() {},
      async goto() {
        throw new Error("Protocol error (Target.goto): target closed");
      },
      async waitForFunction() {},
      async evaluate() {
        return { status: "done", error: "", result: "" };
      },
      async close() {},
    };
    const puppeteer: PuppeteerBinding = {
      async sessions() {
        return [];
      },
      async connect() {
        throw new Error("none");
      },
      async launch() {
        return {
          async newPage() {
            return page;
          },
          async disconnect() {
            disconnects += 1;
          },
          async close() {
            closes += 1;
          },
        };
      },
    };
    const token = "ab".repeat(32);
    await assert.rejects(
      () => renderScreenshots({ BROWSER: {} }, `https://example.test/?render=0&uploads=0:${token}`, [0], { puppeteer }),
      /target closed/,
    );
    assert.equal(closes, 1);
    assert.equal(disconnects, 0);
  });

});

describe("capture diversity", () => {
  it("rejects identical frames when the screenshots or panorama differ", () => {
    const hash = "aa".repeat(32);
    assert.throws(
      () => assertRenderedFrames(
        [{ index: 0, sha256: hash }, { index: 1, sha256: hash }],
        [{ image: "asset:aaa", panorama: false }, { image: "asset:bbb", panorama: false }],
      ),
      /byte-identical/,
    );
    assert.throws(
      () => assertRenderedFrames(
        [{ index: 0, sha256: hash }, { index: 1, sha256: hash }],
        [{ image: "asset:aaa", panorama: true }, { image: "asset:aaa", panorama: true }],
      ),
      /panoramic background/,
    );
    assertRenderedFrames(
      [{ index: 0, sha256: hash }, { index: 1, sha256: hash }],
      [{ image: "asset:aaa", panorama: false }, { image: "asset:aaa", panorama: false }],
    );
  });

  it("checks asset metadata only and names a missing hash", async () => {
    const kv = createMemoryKv();
    const dump = createBackup("p1", "HomeBooks");
    addScreenshot(dump, { dataUrl: "data:image/png;base64,QQ==", name: "one.png" });
    const missing = "cd".repeat(32);
    const backup = JSON.parse(JSON.stringify(dump).replace("data:image/png;base64,QQ==", `asset:${missing}`));
    await assert.rejects(() => assertAssetsPresent(kv, backup), /cdcdcdcd/);
    const present = await storeAsset(kv, new Uint8Array(64), "image/png");
    const kept = JSON.parse(JSON.stringify(dump).replace("data:image/png;base64,QQ==", present));
    const before = kv.gets.length;
    await assertAssetsPresent(kv, kept);
    assert.equal(kv.gets.slice(before).every((get) => get.type === "text"), true);
    assert.equal(kv.gets.slice(before).some((get) => get.type === "arrayBuffer"), false);
  });
});

describe("render lock", () => {
  it("runs one render per project at a time", async () => {
    const env = { APPSCREEN_KV: createMemoryKv() };
    let active = 0;
    let max = 0;
    const run = () => withRenderLock(env, "project-1", async () => {
      active += 1;
      max = Math.max(max, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
    });
    await Promise.all([run(), run(), run()]);
    assert.equal(max, 1);
    await withRenderLock(env, "project-1", async () => {
      max = 0;
    });
    assert.equal(max, 0);
  });
});
