import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildRenderSupply, storeAsset } from "../src/assets.ts";
import { addScreenshot, createBackup } from "../src/project.ts";
import {
  acquireBrowser,
  acquisitionWaitMs,
  assertRenderedFrames,
  BROWSER_KEEP_ALIVE_MS,
  browserRateLimitError,
  fulfillRenderRequest,
  isBrowserRateLimit,
  renderScreenshots,
  type BrowserHandle,
  type PuppeteerBinding,
} from "../src/render.ts";
import { withRenderLock } from "../src/store.ts";
import { createMemoryKv } from "./memory-kv.ts";

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

  it("closes a session that rendered an error so the next call cannot reuse it", async () => {
    let disconnects = 0;
    let closes = 0;
    const page = {
      async setViewport() {},
      async setCacheEnabled() {},
      async goto() {},
      async waitForFunction() {},
      async evaluate() {
        return { status: "error", error: "Screenshot 0 (asset abc) failed to load" };
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
    await assert.rejects(
      () => renderScreenshots({ BROWSER: {} }, "https://example.test/?render=0", [0], { puppeteer }),
      /Screenshot 0/,
    );
    assert.equal(closes, 1);
    assert.equal(disconnects, 0);
  });

  it("fulfills the backup and asset from memory and lets the model download continue", async () => {
    const kv = createMemoryKv();
    const photo = new Uint8Array([137, 80, 78, 71, 9]);
    const pano = new Uint8Array([255, 216, 255, 7]);
    const photoRef = await storeAsset(kv, photo, "image/png");
    const panoRef = await storeAsset(kv, pano, "image/jpeg");
    const dump = createBackup("p1", "HomeBooks");
    addScreenshot(dump, { dataUrl: `data:image/png;base64,${Buffer.from(photo).toString("base64")}`, name: "one.png" });
    const backup = JSON.parse(JSON.stringify(dump).replaceAll(`data:image/png;base64,${Buffer.from(photo).toString("base64")}`, photoRef));
    backup.projects[0].panoramicBackground = { enabled: true, src: panoRef, overlap: 0, scale: 100, offsetY: 0 };
    const supply = await buildRenderSupply(kv, backup);
    assert.match(supply.projectBody, /data:image\/png;base64,/);
    assert.match(supply.projectBody, /data:image\/jpeg;base64,/);
    assert.equal(supply.projectBody.includes("/assets/"), false);
    const hash = photoRef.slice("asset:".length);
    const project = fulfillRenderRequest("https://worker.test/api/projects/p1?cb=1", supply);
    assert.equal(project.kind, "respond");
    if (project.kind === "respond") assert.match(String(project.body), /data:image\/png/);
    const asset = fulfillRenderRequest(`https://worker.test/assets/${hash}`, supply);
    assert.equal(asset.kind, "respond");
    if (asset.kind === "respond") assert.equal(asset.headers["cache-control"], "no-store");
    const model = fulfillRenderRequest("https://matinrahimik.github.io/homebooks-appscreen/models/iphone.glb", supply);
    assert.equal(model.kind, "continue");
    const missing = fulfillRenderRequest(`https://worker.test/assets/${"ab".repeat(32)}`, supply);
    assert.equal(missing.kind, "missing");

    const seen: string[] = [];
    let projectBody = "";
    const page = {
      async setViewport() {},
      async setCacheEnabled(enabled: boolean) {
        assert.equal(enabled, false);
      },
      async setRequestInterception(value: boolean) {
        assert.equal(value, true);
      },
      on(_event: string, handler: (request: {
        url: () => string;
        continue: () => Promise<void>;
        respond: (response: { body?: string | Uint8Array }) => Promise<void>;
      }) => Promise<void>) {
        this.handler = handler;
      },
      handler: null as null | ((request: {
        url: () => string;
        continue: () => Promise<void>;
        respond: (response: { body?: string | Uint8Array }) => Promise<void>;
      }) => Promise<void>),
      async goto(url: string) {
        assert.match(url, /cb=/);
        await this.handler!({
          url: () => "https://worker.test/api/projects/p1?cb=9",
          async continue() {
            throw new Error("project fetch must not hit the network");
          },
          async respond(response) {
            projectBody = String(response.body);
          },
        });
        await this.handler!({
          url: () => "https://cdn.example/three.min.js",
          async respond() {
            throw new Error("the model script should use the network");
          },
          async continue() {
            seen.push("cdn");
          },
        });
      },
      async waitForFunction() {},
      async evaluate(_fn: unknown, arg?: unknown) {
        if (arg === undefined) return { status: "ready", error: "" };
        return (arg as number[]).map((index) => ({
          index,
          width: 10,
          height: 20,
          dataUrl: "data:image/png;base64,QQ==",
        }));
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
          async disconnect() {},
        };
      },
    };
    await renderScreenshots({ BROWSER: {} }, "https://example.test/?render=0", [0], { puppeteer, supply });
    assert.match(projectBody, /data:image\/jpeg;base64,/);
    assert.deepEqual(seen, ["cdn"]);
  });
});

describe("capture diversity", () => {
  it("rejects identical frames when the screenshots or panorama differ", async () => {
    const png = new Uint8Array([1, 2, 3, 4]);
    await assert.rejects(
      () => assertRenderedFrames(
        [{ index: 0, png }, { index: 1, png }],
        [{ image: "asset:aaa", panorama: false }, { image: "asset:bbb", panorama: false }],
      ),
      /byte-identical/,
    );
    await assert.rejects(
      () => assertRenderedFrames(
        [{ index: 0, png }, { index: 1, png }],
        [{ image: "asset:aaa", panorama: true }, { image: "asset:aaa", panorama: true }],
      ),
      /panoramic background/,
    );
    await assertRenderedFrames(
      [{ index: 0, png }, { index: 1, png }],
      [{ image: "asset:aaa", panorama: false }, { image: "asset:aaa", panorama: false }],
    );
  });

  it("fails the render before launch when an asset blob is missing", async () => {
    const kv = createMemoryKv();
    const dump = createBackup("p1", "HomeBooks");
    addScreenshot(dump, { dataUrl: "data:image/png;base64,QQ==", name: "one.png" });
    const backup = JSON.parse(JSON.stringify(dump).replace("data:image/png;base64,QQ==", `asset:${"cd".repeat(32)}`));
    await assert.rejects(() => buildRenderSupply(kv, backup), /cdcdcdcd/);
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
