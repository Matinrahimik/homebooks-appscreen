import { route } from "./http.ts";
import { renderScreenshots } from "./render.ts";
import type { Env } from "./types.ts";

export { ProjectGate } from "./gate.ts";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return route(request, env, (pageUrl, indices) => renderScreenshots(env, pageUrl, indices));
  },
};
