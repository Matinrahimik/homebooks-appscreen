import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe, it } from "node:test";

const require = createRequire(import.meta.url);
const ready = require("../render-ready.js");

describe("render readiness", () => {
  it("treats a failed image as an error even though complete is true", () => {
    const failed = { complete: true, naturalWidth: 0, src: "https://worker.test/assets/" + "ab".repeat(32) };
    const status = ready.imageState(failed, "Screenshot 3");
    assert.equal(status.state, "error");
    assert.match(status.message, /asset abababab/);
    assert.match(status.message, /failed to load/);

    const empty = { complete: true, naturalWidth: 0, src: "" };
    assert.equal(ready.imageState(empty, "Screenshot 0").state, "error");

    const loading = { complete: false, naturalWidth: 0, src: "data:image/png;base64,QQ==" };
    assert.equal(ready.imageState(loading, "Screenshot 0").state, "pending");

    const decoded = { complete: true, naturalWidth: 400, src: "data:image/png;base64,QQ==" };
    assert.equal(ready.imageState(decoded, "Screenshot 0").state, "ok");
    assert.equal(ready.assetLabel(decoded.src), "inlined image");
  });

  it("does not signal ready before the project pull finishes", () => {
    assert.equal(ready.pullStillRunning(true, false, false), true);
    assert.equal(ready.pullStillRunning(true, true, false), false);
    assert.equal(ready.pullStillRunning(false, false, false), false);
  });

  it("names the localized screenshot the frame has to decode", () => {
    const shot = {
      src: "",
      localizedImages: {
        en: { src: "asset:" + "cd".repeat(32) },
        de: { src: "https://worker.test/assets/" + "ef".repeat(32) },
      },
    };
    assert.equal(ready.screenshotSource(shot, "de"), shot.localizedImages.de.src);
    assert.equal(ready.assetLabel(shot.localizedImages.en.src), "asset " + "cd".repeat(32));
    assert.equal(ready.screenshotSource({ src: "legacy" }, "en"), "legacy");
  });

  it("retries a failed asset a few times and names the hash", () => {
    const hash = "ab".repeat(32);
    const failed = { complete: true, naturalWidth: 0, src: "https://worker.test/assets/" + hash + "?cb=1" };
    const first = ready.nextImageAttempt(failed, "Screenshot 0", 1, ready.IMAGE_LOAD_ATTEMPTS);
    assert.equal(first.action, "retry");
    assert.match(first.message, new RegExp(hash));
    const last = ready.nextImageAttempt(failed, "Screenshot 0", ready.IMAGE_LOAD_ATTEMPTS, ready.IMAGE_LOAD_ATTEMPTS);
    assert.equal(last.action, "fail");
    assert.match(last.message, /failed to load/);
    assert.equal(ready.nextImageAttempt({ complete: false, naturalWidth: 0, src: failed.src }, "Screenshot 0", 1, 3).action, "wait");
    assert.equal(ready.nextImageAttempt({ complete: true, naturalWidth: 20, src: failed.src }, "Screenshot 0", 1, 3).action, "ok");
    assert.equal(
      ready.assetRetryUrl(failed.src, 2, 99),
      "https://worker.test/assets/" + hash + "?retry=2&t=99",
    );
    const slots = ready.parseUploads("0:" + "cd".repeat(32) + ",1:nope");
    assert.equal(slots[0], "cd".repeat(32));
    assert.equal(slots[1], undefined);
    const crc = ready.crc32(new TextEncoder().encode("123456789"));
    assert.equal(crc, 0xcbf43926);
  });

  it("hashes the bytes the page will upload", async () => {
    const sha = await ready.sha256Hex(new TextEncoder().encode("abc"));
    assert.equal(sha, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
