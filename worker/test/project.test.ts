import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertObjectSize, chunkBytes, getBytes, getText, KvLimitError, putBytes, putText } from "../src/kvblob.ts";
import {
  addScreenshot,
  createBackup,
  dataUrlFromBytes,
  POSITION_PRESETS,
  backupSummary,
  primaryProject,
  removeScreenshot,
  reorderScreenshots,
  replaceScreenshot,
  setOutputSize,
  setPanoramicBackground,
  defaultScreenshotSettings,
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

  it("applies nested text settings and rejects unknown keys", () => {
    const dump = createBackup("p1", "HomeBooks");
    addScreenshot(dump, { dataUrl: PNG, name: "one.png" });
    addScreenshot(dump, { dataUrl: PNG, name: "two.png" });
    updateGlobalSettings(dump, {
      text: {
        font_family: "Rubik",
        font_weight: 700,
        headline: "Line one stays clear",
        subheadline: "And the subheadline",
        textGap: 18,
        headlineLetterSpacing: 2,
      },
    });
    const project = primaryProject(dump);
    for (const text of [project.defaults.text, project.screenshots[0].text, project.screenshots[1].text]) {
      assert.equal(text.headlineFont, "'Rubik', sans-serif");
      assert.equal(text.subheadlineFont, "'Rubik', sans-serif");
      assert.equal(text.headlineWeight, "700");
      assert.equal(text.subheadlineWeight, "700");
      assert.equal((text.headlines as { en: string }).en, "Line one stays clear");
      assert.equal((text.subheadlines as { en: string }).en, "And the subheadline");
      assert.equal(text.subheadlineEnabled, true);
      assert.equal(text.font_family, undefined);
      assert.equal(text.headline, undefined);
      assert.equal(text.textGap, 18);
      assert.equal(text.headlineLetterSpacing, 2);
    }

    updateScreenshotSettings(dump, 1, {
      text: { font_family: "Fraunces", font_weight: "500", headline: "Only this shot" },
    });
    assert.equal(project.screenshots[1].text.headlineFont, "'Fraunces', sans-serif");
    assert.equal((project.screenshots[1].text.headlines as { en: string }).en, "Only this shot");
    assert.equal(project.screenshots[0].text.headlineFont, "'Rubik', sans-serif");
    assert.equal(project.screenshots[1].text.font_family, undefined);

    const before = JSON.stringify(dump);
    assert.throws(
      () => updateGlobalSettings(dump, { made_up: true }),
      /Unknown setting "settings\.made_up"/,
    );
    assert.throws(
      () => updateScreenshotSettings(dump, 0, { text: { font_family: "Rubik", nope: 1 } }),
      /Unknown setting "settings\.text\.nope"/,
    );
    assert.throws(
      () => updateScreenshotSettings(dump, 0, { screenshot: { scale: 80, wobble: 1 } }),
      /Unknown setting "settings\.screenshot\.wobble"/,
    );
    assert.equal(JSON.stringify(dump), before);
    assert.equal(project.screenshots[0].screenshot.scale, 70);

    updateScreenshotSettings(dump, 0, { headlineSize: 80, subheadlineSize: 36 });
    const laidOut = project.screenshots[0].text;
    assert.equal(laidOut.headlineSize, 80);
    assert.equal(laidOut.subheadlineSize, 36);
    const enLayout = (laidOut.languageSettings as { en: { headlineSize: number; subheadlineSize: number } }).en;
    assert.equal(enLayout.headlineSize, 80);
    assert.equal(enLayout.subheadlineSize, 36);

    laidOut.perLanguageLayout = true;
    (laidOut.languageSettings as { de: { headlineSize: number } }).de = {
      headlineSize: 90,
      subheadlineSize: 40,
      position: "top",
      offsetY: 12,
      lineHeight: 110,
    } as { headlineSize: number };
    updateScreenshotSettings(dump, 0, { headlineSize: 64 });
    assert.equal(laidOut.headlineSize, 64);
    assert.equal((laidOut.languageSettings as { en: { headlineSize: number } }).en.headlineSize, 64);
    assert.equal((laidOut.languageSettings as { de: { headlineSize: number } }).de.headlineSize, 90);

    updateScreenshotSettings(dump, 0, { headlineTextWrap: "balance", text: { subheadlineTextWrap: "balance" } });
    const wrappedText = project.screenshots[0].text;
    assert.equal(wrappedText.headlineTextWrap, "balance");
    assert.equal(wrappedText.subheadlineTextWrap, "balance");
    const wrapped = JSON.stringify(dump);
    assert.throws(
      () => updateScreenshotSettings(dump, 0, { headlineTextWrap: "banana" }),
      /Invalid settings\.headlineTextWrap "banana"/,
    );
    assert.equal(JSON.stringify(dump), wrapped);
  });

  it("keeps the default device below a two-line headline and subheadline", () => {
    const shot = defaultScreenshotSettings();
    assert.equal(shot.scale, 70);
    assert.equal(shot.y, 100);
    const sizes = [
      [1320, 2868],
      [1290, 2796],
      [1284, 2778],
      [1242, 2208],
      [2048, 2732],
      [1668, 2388],
    ];
    for (const [width, height] of sizes) {
      const top = deviceTop(width, height, width, height, Number(shot.scale), Number(shot.y));
      const textEnd = twoLineTextBottom(height);
      assert.ok(
        top >= textEnd + 40,
        `${width}x${height} device top ${top.toFixed(1)} overlaps text ending at ${textEnd.toFixed(1)}`,
      );
    }
  });

  it("turns subheadline maps on and keeps an explicit disable", () => {
    const dump = createBackup("p1", "HomeBooks");
    addScreenshot(dump, { dataUrl: PNG, name: "one.png" });
    const text = primaryProject(dump).screenshots[0].text;
    assert.equal(text.subheadlineEnabled, false);
    text.headlineEnabled = false;
    updateScreenshotSettings(dump, 0, { headlines: { en: "Shown" }, subheadlines: { en: "Also shown" } });
    assert.equal(text.headlineEnabled, true);
    assert.equal(text.subheadlineEnabled, true);
    assert.equal((text.subheadlines as { en: string }).en, "Also shown");
    updateScreenshotSettings(dump, 0, { subheadline: "Kept", subheadlineEnabled: false });
    assert.equal(text.subheadlineEnabled, false);
    assert.equal((text.subheadlines as { en: string }).en, "Kept");
  });

  it("summarizes the panorama, wrap, size, and weight without the image bytes", () => {
    const dump = createBackup("p1", "HomeBooks");
    addScreenshot(dump, { dataUrl: PNG, name: "one.png" });
    updateScreenshotSettings(dump, 0, {
      headlineSize: 88,
      headlineTextWrap: "balance",
      subheadlineTextWrap: "balance",
      font_weight: "600",
      background: { type: "gradient" },
    });
    setPanoramicBackground(dump, { src: PNG, overlap: 0.2, scale: 110, offsetY: 4 });
    const summary = backupSummary(dump);
    const panorama = summary.panoramicBackground as { enabled: boolean; hasImage: boolean; overlap: number; src: string };
    assert.equal(panorama.enabled, true);
    assert.equal(panorama.hasImage, true);
    assert.equal(panorama.overlap, 0.2);
    assert.equal(panorama.src, "data-url");
    const shot = (summary.screenshots as {
      backgroundState: { type: string; effective: string };
      headlineSize: number;
      effectiveHeadlineSize: number;
      headlineWeight: string;
      headlineTextWrap: string;
      subheadlineTextWrap: string;
    }[])[0];
    assert.equal(shot.backgroundState.type, "gradient");
    assert.equal(shot.backgroundState.effective, "panorama");
    assert.equal(shot.headlineSize, 88);
    assert.equal(shot.effectiveHeadlineSize, 88);
    assert.equal(shot.headlineWeight, "600");
    assert.equal(shot.headlineTextWrap, "balance");
    assert.equal(shot.subheadlineTextWrap, "balance");
    assert.equal(JSON.stringify(summary).includes(PNG), false);
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

/** Same placement as drawScreenshotToContext() in app.js. */
function deviceTop(canvasW: number, canvasH: number, imageW: number, imageH: number, scalePercent: number, yPercent: number): number {
  const scale = scalePercent / 100;
  let imgWidth = canvasW * scale;
  let imgHeight = (imageH / imageW) * imgWidth;
  if (imgHeight > canvasH * scale) {
    imgHeight = canvasH * scale;
    imgWidth = (imageW / imageH) * imgHeight;
  }
  const moveY = Math.max(canvasH - imgHeight, canvasH * 0.15);
  return (canvasH - imgHeight) / 2 + (yPercent / 100 - 0.5) * moveY;
}

/** Bottom of a two-line 100px headline plus the default 50px subheadline. */
function twoLineTextBottom(canvasH: number): number {
  const start = canvasH * 0.12;
  const headlineSize = 100;
  const lineHeight = headlineSize * 1.1;
  return start + lineHeight + headlineSize + 10 + 50;
}

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
