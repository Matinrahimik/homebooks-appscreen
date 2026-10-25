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
});
