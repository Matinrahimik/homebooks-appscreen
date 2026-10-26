import { readFile } from "node:fs/promises";
import { crc32 } from "../worker/src/zip.ts";
import { Disk, randomToken, sha256Hex, type RenderTokenRecord } from "./disk.ts";

export const RENDER_TIMEOUT_MS = 180_000;

export interface LocalFrame {
  index: number;
  token: string;
  width: number;
  height: number;
  bytes: number;
  sha256: string;
  crc: number;
}

export async function renderIndexes(options: {
  origin: string;
  projectId: string;
  editKey: string;
  indexes: number[];
  disk: Disk;
}): Promise<LocalFrame[]> {
  const { origin, projectId, editKey, indexes, disk } = options;
  if (indexes.length === 0) return [];
  const slots = indexes.map((index) => ({
    index,
    token: randomToken(),
    filename: `screenshot-${index + 1}.png`,
  }));
  for (const slot of slots) {
    const record: RenderTokenRecord = {
      projectId,
      index: slot.index,
      filename: slot.filename,
      uploaded: false,
    };
    await disk.writeRenderToken(slot.token, record);
  }
  const pageUrl = new URL("/", origin);
  pageUrl.searchParams.set("project", projectId);
  pageUrl.searchParams.set("key", editKey);
  pageUrl.searchParams.set("api", origin);
  pageUrl.searchParams.set("render", indexes.length === 1 ? String(indexes[0]) : "all");
  pageUrl.searchParams.set("uploads", slots.map((slot) => `${slot.index}:${slot.token}`).join(","));
  pageUrl.searchParams.set("cb", String(Date.now()));

  const logs: string[] = [];
  let browser: { close: () => Promise<void> } | undefined;
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--use-gl=angle",
        "--use-angle=swiftshader",
      ],
    });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on("console", (message) => {
      logs.push(`console: ${message.type()}: ${message.text()}`);
      if (logs.length > 40) logs.shift();
    });
    page.on("pageerror", (error) => {
      logs.push(`pageerror: ${error.message}`);
      if (logs.length > 40) logs.shift();
    });
    page.on("requestfailed", (request) => {
      const failure = request.failure();
      logs.push(`requestfailed: ${request.url()} ${failure?.errorText || ""}`.trim());
      if (logs.length > 40) logs.shift();
    });
    await page.goto(pageUrl.toString(), { waitUntil: "domcontentloaded", timeout: RENDER_TIMEOUT_MS });
    try {
      await page.waitForFunction(
        () => {
          const status = document.documentElement.dataset.appscreenStatus;
          return status === "done" || status === "error";
        },
        { timeout: RENDER_TIMEOUT_MS },
      );
    } catch (error) {
      const snapshot = await readSnapshot(page);
      throw new Error(`${timeoutMessage(snapshot)}\n${tail(logs)}`, { cause: error });
    }
    const snapshot = await readSnapshot(page);
    if (snapshot.status === "error") {
      throw new Error(
        `Render failed. status=${snapshot.status} stage=${snapshot.stage} error=${snapshot.error}\n${tail(logs)}`,
      );
    }
    const frames: LocalFrame[] = [];
    for (const slot of slots) {
      const record = await disk.readRenderToken(slot.token);
      if (!record?.uploaded || record.sha256 == null || record.bytes == null || record.crc == null || record.width == null || record.height == null) {
        throw new Error(
          `Screenshot ${slot.index} did not upload. status=${snapshot.status} stage=${snapshot.stage}\n${tail(logs)}`,
        );
      }
      const bytes = new Uint8Array(await readFile(disk.renderOutputPath(projectId, slot.filename)));
      const actual = sha256Hex(bytes);
      if (actual !== record.sha256 || bytes.byteLength !== record.bytes || crc32(bytes) !== record.crc) {
        throw new Error(`Screenshot ${slot.index} on disk does not match the upload checksum.`);
      }
      frames.push({
        index: slot.index,
        token: slot.token,
        width: record.width,
        height: record.height,
        bytes: record.bytes,
        sha256: record.sha256,
        crc: record.crc,
      });
    }
    return frames;
  } finally {
    if (browser) await browser.close().catch(() => undefined);
  }
}

async function readSnapshot(page: {
  evaluate: <T>(fn: () => T) => Promise<T>;
}): Promise<{ status: string; stage: string; error: string }> {
  try {
    return await page.evaluate(() => ({
      status: document.documentElement.dataset.appscreenStatus || "",
      stage: document.documentElement.dataset.appscreenStage || "",
      error: document.documentElement.dataset.appscreenError || "",
    }));
  } catch {
    return { status: "", stage: "", error: "" };
  }
}

function timeoutMessage(snapshot: { status: string; stage: string; error: string }): string {
  return `Render timed out after ${RENDER_TIMEOUT_MS}ms. status=${snapshot.status || "missing"} stage=${snapshot.stage || "missing"} error=${snapshot.error || "none"}`;
}

function tail(logs: string[]): string {
  if (logs.length === 0) return "console: (no console, pageerror, or requestfailed events)";
  return logs.join("\n");
}
