import type { RenderShot } from "./types.ts";

interface BrowserEnv {
  BROWSER?: unknown;
}

/**
 * Open the hosted Pages app in render mode and read each finished canvas
 * at its real output pixel size via window.__appscreen.capture().
 */
export async function renderScreenshots(env: BrowserEnv, pageUrl: string, indices: number[]): Promise<RenderShot[]> {
  if (!env.BROWSER) {
    throw new Error("Browser Rendering binding BROWSER is not configured.");
  }
  const puppeteer = (await import("@cloudflare/puppeteer")).default;
  const browser = await puppeteer.launch(env.BROWSER);
  try {
    const page = await browser.newPage();
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
    await browser.close();
  }
}
