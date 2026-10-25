import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertObjectSize, chunkBytes, getBytes, getText, KvLimitError, putBytes, putText } from "../src/kvblob.ts";
import {
  addScreenshot,
  createBackup,
  dataUrlFromBytes,
  POSITION_PRESETS,
  primaryProject,
  removeScreenshot,
  reorderScreenshots,
  replaceScreenshot,
  setOutputSize,
  setPanoramicBackground,
  updateGlobalSettings,
  updateScreenshotSettings,
  fontValue,
} from "../src/project.ts";
import { parseCssGradient } from "../src/schema.ts";
import { zipStore, crc32 } from "../src/zip.ts";
import { createMemoryKv } from "./memory-kv.ts";

const PNG = dataUrlFromBytes("image/png", new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]));

describe("backup mutations", () => {
  it("creates the app export/import shape", () => {
    const dump = createBackup("p1", "HomeBooks");
    assert.equal(dump.projects.length, 1);
    assert.equal(dump.projects[0].id, "p1");
    assert.equal(dump.projects[0].formatVersion, 2);
    assert.deepEqual(dump.projects[0].screenshots, []);
    assert.equal(dump.projects[0].outputDevice, "iphone-6.9");
    const metaProjects = dump.meta.find((m) => m.key === "projects");
    const current = dump.meta.find((m) => m.key === "currentProject");
    assert.equal(current?.value, "p1");
    assert.deepEqual(metaProjects?.value, [{ id: "p1", name: "HomeBooks", screenshotCount: 0 }]);
  });

  it("adds, replaces, reorders, and removes screenshots", () => {
    const dump = createBackup("p1", "HomeBooks");
    const first = addScreenshot(dump, { dataUrl: PNG, name: "one.png", language: "en" });
    const second = addScreenshot(dump, { dataUrl: PNG, name: "two.png", language: "de" }, 0);
    assert.equal(first, 0);
    assert.equal(second, 0);
    const project = primaryProject(dump);
    assert.equal(project.screenshots[0].name, "two.png");
    assert.equal(project.screenshots[1].name, "one.png");
    assert.equal(project.screenshots[0].localizedImages.de.src, PNG);
    assert.ok(project.projectLanguages.includes("de"));
    replaceScreenshot(dump, 1, { dataUrl: "data:image/png;base64,AAAA", name: "one-b.png", language: "en" });
    assert.equal(project.screenshots[1].localizedImages.en.src, "data:image/png;base64,AAAA");
    assert.equal(project.screenshots[1].screenshot.scale, 70);
    reorderScreenshots(dump, [1, 0]);
    assert.equal(primaryProject(dump).screenshots[0].name, "one-b.png");
    removeScreenshot(dump, 0);
    assert.equal(primaryProject(dump).screenshots.length, 1);
    assert.equal((dump.meta.find((m) => m.key === "projects")?.value as { screenshotCount: number }[])[0].screenshotCount, 1);
  });

  it("applies position presets, colour aliases, text, and output sizes", () => {
    const dump = createBackup("p1", "HomeBooks");
    addScreenshot(dump, { dataUrl: PNG, name: "shot.png" });
    updateScreenshotSettings(dump, 0, {
      positionPreset: "tilt-left",
      headline: "Track every book",
      subheadline: "For the household",
      headlineFont: "Inter",
      headlineWeight: "700",
      headlineSize: 92,
      headlineColour: "#fff8e7",
      position: "top",
      background: {
        type: "solid",
        solid: "#102030",
        overlayColour: "#000000",
      },
      screenshot: {
        shadow: { enabled: true, colour: "#111111", blur: 12, opacity: 40, x: 2, y: 8 },
        use3D: true,
        device3D: "iphone",
        rotation3D: { x: 8, y: -12, z: 0 },
      },
    });
    const shot = primaryProject(dump).screenshots[0];
    assert.equal(shot.screenshot.rotation, POSITION_PRESETS["tilt-left"].rotation);
    assert.equal(shot.screenshot.scale, 65);
    assert.equal((shot.text.headlines as { en: string }).en, "Track every book");
    assert.equal(shot.text.headlineFont, "'Inter', sans-serif");
    assert.equal(shot.text.headlineColor, "#fff8e7");
    assert.equal(shot.text.headlineWeight, "700");
    assert.equal(shot.text.position, "top");
    assert.equal(shot.background.type, "solid");
    assert.equal(shot.background.overlayColor, "#000000");
    assert.equal((shot.screenshot.shadow as { color: string }).color, "#111111");
    assert.equal(shot.screenshot.use3D, true);

    updateGlobalSettings(dump, { background: { type: "gradient", gradient: { angle: 90, stops: [{ color: "#000", position: 0 }] } } }, "defaults");
    assert.equal(primaryProject(dump).defaults.background.type, "gradient");
    assert.equal(primaryProject(dump).screenshots[0].background.type, "solid");

    const size = setOutputSize(dump, { device: "ipad-11" });
    assert.deepEqual(size, { device: "ipad-11", width: 1668, height: 2388 });
    const custom = setOutputSize(dump, { width: 800, height: 1200 });
    assert.deepEqual(custom, { device: "custom", width: 800, height: 1200 });
    assert.throws(() => setOutputSize(dump, { device: "iphone-99" }), /Unknown device/);
    assert.throws(() => setOutputSize(dump, { width: 10, height: 10 }), /between 100 and 4000/);
  });

  it("keeps Rubik, text spacing, off-canvas framing, and a panoramic slice", () => {
    assert.equal(fontValue("Rubik"), "'Rubik', sans-serif");
    const dump = createBackup("p1", "HomeBooks");
    addScreenshot(dump, { dataUrl: PNG, name: "one.png" });
    addScreenshot(dump, { dataUrl: PNG, name: "two.png" });
    updateScreenshotSettings(dump, 0, {
      font_family: "Rubik",
      font_weight: 600,
      textGap: 24,
      textGapUnit: "percent",
      headlineLetterSpacing: 4,
      subheadlineLetterSpacing: 1,
      screenshot: { scale: 160, x: -30, y: 150, rotation3D: { x: 1, y: 2, z: 3 } },
    });
    const shot = primaryProject(dump).screenshots[0];
    assert.equal(shot.text.headlineFont, "'Rubik', sans-serif");
    assert.equal(shot.text.subheadlineFont, "'Rubik', sans-serif");
    assert.equal(shot.text.headlineWeight, "600");
    assert.equal(shot.text.textGap, 24);
    assert.equal(shot.text.textGapUnit, "percent");
    assert.equal(shot.text.headlineLetterSpacing, 4);
    assert.equal(shot.screenshot.scale, 160);
    assert.equal(shot.screenshot.x, -30);
    assert.deepEqual(shot.screenshot.rotation3D, { x: 1, y: 2, z: 3 });
    const pano = setPanoramicBackground(dump, { src: PNG, overlap: 0.2, scale: 120, offsetY: -5 });
    assert.equal(pano.enabled, true);
    assert.equal(primaryProject(dump).panoramicBackground, pano);
    const reloaded = JSON.parse(JSON.stringify(dump));
    assert.equal(reloaded.projects[0].screenshots[0].text.headlineFont, "'Rubik', sans-serif");
    assert.equal(reloaded.projects[0].panoramicBackground.overlap, 0.2);
    assert.equal(reloaded.projects[0].screenshots[0].screenshot.scale, 160);
  });

  it("parses a UI gradient preset into stops", () => {
    const parsed = parseCssGradient("linear-gradient(135deg, #667eea 0%, #764ba2 100%)");
    assert.equal(parsed.angle, 135);
    assert.deepEqual(parsed.stops, [
      { color: "#667eea", position: 0 },
      { color: "#764ba2", position: 100 },
    ]);
  });
});

describe("kv limits", () => {
  it("rejects objects above the configured cap and round-trips chunks", async () => {
    assert.throws(() => assertObjectSize(90, "blob", 80), KvLimitError);
    const kv = createMemoryKv();
    const payload = "abcdefghijklmnopqrstuvwxyz".repeat(5);
    await putText(kv, "note", payload, 10_000, 20);
    const meta = JSON.parse(String(await kv.get("note:meta")));
    assert.ok(meta.chunks > 1);
    assert.equal(await getText(kv, "note"), payload);

    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    await putBytes(kv, "bin", bytes, "image/png", 100, 4);
    const binMeta = JSON.parse(String(await kv.get("bin:meta")));
    assert.equal(binMeta.chunks, 3);
    for (let i = 0; i < binMeta.chunks; i++) {
      const part = await kv.get(`bin:c:${i}`, { type: "arrayBuffer" });
      assert.ok(part instanceof ArrayBuffer);
      assert.ok((part as ArrayBuffer).byteLength <= 4);
    }
    const loaded = await getBytes(kv, "bin");
    assert.deepEqual([...(loaded?.bytes || [])], [...bytes]);
    await assert.rejects(() => putBytes(kv, "big", new Uint8Array(50), "application/zip", 40), KvLimitError);
  });

  it("writes a readable zip of png bytes", () => {
    const png = new Uint8Array([137, 80, 78, 71, 13, 10]);
    const zip = zipStore([{ name: "screenshot-1.png", data: png }], new Date("2026-01-02T03:04:05Z"));
    assert.equal(zip[0], 0x50);
    assert.equal(zip[1], 0x4b);
    assert.equal(crc32(png) >>> 0, crc32(png) >>> 0);
    const name = new TextDecoder().decode(zip);
    assert.match(name, /screenshot-1\.png/);
  });
});
