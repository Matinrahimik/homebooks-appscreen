import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

describe("GitHub Pages artifact", () => {
  it("copies every local script index.html loads, including render-ready.js", () => {
    const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
    const workflow = readFileSync(new URL("../.github/workflows/pages.yml", import.meta.url), "utf8");
    const srcs = [...html.matchAll(/<script\s+src="([^"]+)"/g)]
      .map((match) => match[1])
      .filter((src) => !/^https?:/i.test(src));
    assert.ok(srcs.includes("render-ready.js"));
    for (const src of srcs) {
      assert.match(workflow, new RegExp(`\\b${src.replace(".", "\\.")}\\b`), `${src} is not copied to the Pages artifact`);
    }
  });
});
