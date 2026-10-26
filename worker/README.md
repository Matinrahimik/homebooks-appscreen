# HomeBooks App Screen MCP

Remote MCP server and the small REST API used by the designer's live project mode. It stores projects in Workers KV (R2 is not used) and renders PNGs by opening the GitHub Pages app in headless Chrome.

| | |
| --- | --- |
| MCP URL | `https://homebooks-appscreen-mcp.matinrahimi.workers.dev/mcp` |
| Script name | `homebooks-appscreen-mcp` |
| Pages app | `https://matinrahimik.github.io/homebooks-appscreen/` |
| Secret | `APPSCREEN_MCP_TOKEN` (Worker secret, bearer token for `/mcp` and privileged calls) |

`/mcp` speaks stateless [Streamable HTTP](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports). `POST` a JSON-RPC body with `Authorization: Bearer <APPSCREEN_MCP_TOKEN>`. `GET` and `DELETE` return 405. No MCP session id is issued.

The browser live mode does **not** use that token. `create_project` returns a per-project `edit_key` and an `edit_url`. The Pages app sends the edit key as `X-Edit-Key`.

## Layout

```
worker/
  src/                 TypeScript source
  dist/worker.js       bundled ESM (commit this; upload it as worker.js)
  deploy/metadata.json Workers script-upload metadata
  wrangler.toml        same bindings, for a future wrangler deploy
```

`npm run build` (esbuild) rewrites `dist/worker.js` with dependencies inlined. Node built-ins stay as `node:` imports for the `nodejs_compat` flag. `npm test` covers backup mutations, KV chunking, auth, and MCP tool handlers with rendering mocked.

## Deploy with the Cloudflare API

You need an API token that can edit Workers scripts, KV, and Browser Rendering. Replace `ACCOUNT_ID`. The account workers.dev subdomain is `matinrahimi`.

1. Create the KV namespace (R2 is not available on this account):

```bash
curl -X POST "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/storage/kv/namespaces" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title":"homebooks-appscreen"}'
```

Copy `result.id`.

2. Put that id in a copy of `worker/deploy/metadata.json` (the committed file keeps the placeholder `__KV_NAMESPACE_ID__`).

3. Upload the bundled script. The metadata part's `main_module` is `worker.js`, so the file part must use that name:

```bash
curl -X PUT "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/workers/scripts/homebooks-appscreen-mcp" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -F "metadata=@worker/deploy/metadata.json;type=application/json" \
  -F "worker.js=@worker/dist/worker.js;filename=worker.js;type=application/javascript+module"
```

Bindings in that metadata:

- `APPSCREEN_KV` — `kv_namespace`, `namespace_id` = the id from step 1
- `BROWSER` — `browser` (Cloudflare Browser Rendering)
- `PAGES_ORIGIN` — `https://matinrahimik.github.io`
- `PAGES_PATH` — `/homebooks-appscreen/`
- `PROJECT_GATE` — `durable_object_namespace`, class `ProjectGate`

`v1-project-gate` (`new_sqlite_classes`: `ProjectGate`) is already applied on the production script. Later uploads of this metadata omit `migrations`. Sending it again, or sending Wrangler's `[[migrations]]` array, is rejected: the script-upload API expects an object (`cannot unmarshal array into ... ActorMigrations`), and an already-applied tag cannot be reused.

The upload shape, when a migration is actually new, is an object:

```json
"migrations": { "old_tag": "v1-project-gate", "new_tag": "v2-example", "new_sqlite_classes": ["Example"] }
```

The first tag on a script has no `old_tag`: `{ "new_tag": "v1-project-gate", "new_sqlite_classes": ["ProjectGate"] }`. `worker/wrangler.toml` still has `[[migrations]]` because Wrangler converts that array itself. Do not copy the array into `metadata.json`.

Compatibility date `2026-10-25`, flag `nodejs_compat`.

4. Set the MCP secret (exact name):

```bash
curl -X PUT "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/workers/scripts/homebooks-appscreen-mcp/secrets" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"APPSCREEN_MCP_TOKEN","text":"choose-a-long-random-token","type":"secret_text"}'
```

5. Enable the workers.dev route:

```bash
curl -X POST "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/workers/scripts/homebooks-appscreen-mcp/subdomain" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"enabled":true}'
```

The script is then at `https://homebooks-appscreen-mcp.matinrahimi.workers.dev`. `GET /health` is public.

Browser Rendering must be enabled on the account. `wrangler.toml` matches this configuration for a later `npx wrangler deploy` from `worker/` after the KV id is filled in. Do not commit a real namespace id or the MCP token.

## REST API used by the app

CORS allows `https://matinrahimik.github.io` and `http://localhost` / `http://127.0.0.1` (any port).

| Method | Path | Auth | Body |
| --- | --- | --- | --- |
| `GET` | `/api/projects/:id` | `X-Edit-Key` or MCP bearer | — |
| `PUT` | `/api/projects/:id` | `X-Edit-Key` or MCP bearer | backup JSON |
| `GET` | `/assets/:sha256` | none (content hash) | streamed image bytes, long immutable cache, CORS for Pages and localhost |
| `PUT` | `/renders/:token` | one-time upload token | streamed PNG body, stored without decoding |
| `GET` | `/f/:token/:filename` | none (unguessable token) | streamed PNG, or a STORE ZIP assembled while downloading |
| `POST` | `/mcp` | MCP bearer | JSON-RPC |

`GET /api/projects/:id` returns the backup JSON with image fields rewritten to `https://<worker>/assets/<sha256>` so the editor does not download or upload the pixels on a settings change. The response is `cache-control: no-store`. `PUT` accepts those URLs, `asset:<sha256>` refs, or a self-contained backup whose images are still data URLs. `get_project` with `include_backup: true` returns the original self-contained Export/Import backup.

`render_preview` and `export_project` do not read image bytes. The browser loads each asset with `GET /assets/<hash>` (its own Worker invocation streams the KV value) and uploads each finished PNG with `PUT /renders/<token>`. The orchestrating call only waits for a small `done` signal. One render runs at a time per project. The project fetch uses `cache: "no-store"` and does not send a `Cache-Control` request header, because that header is not CORS-safelisted and the browser cancels the GET when the preflight does not allow it. `Access-Control-Allow-Headers` still includes `Cache-Control` and any other header the preflight asks for, so a page that still sends it is not blocked. A page error (including a failed fetch) disconnects the browser so the next call reuses that session. A browser that stops answering is closed. The Free plan daily browser allowance is a distinct error from the per-minute new-browser limit.

The on-disk shape the app exports is still:

```json
{
  "projects": [{ "id": "...", "formatVersion": 2, "screenshots": [], "outputDevice": "iphone-6.9", "defaults": {} }],
  "meta": [
    { "key": "projects", "value": [{ "id": "...", "name": "HomeBooks", "screenshotCount": 0 }] },
    { "key": "currentProject", "value": "..." }
  ]
}
```

In a full export, screenshot images are data URLs on `localizedImages.<lang>.src` and the legacy `src` field. While a project is stored, each screenshot, background image, and panorama is its own KV blob (8 MiB chunks when needed) keyed by SHA-256. The project document keeps `asset:<hash>` refs, so a settings edit rewrites only that small JSON.

An existing project whose backup still embeds data URLs, including a large panorama, is split into those blobs the first time it is read or written. The old chunked backup is deleted only after the small document is saved.

KV values are capped at 25 MiB. Exported files and image blobs are stored in 8 MiB chunks, up to 80 MiB. A single screenshot upload over 15 MiB is rejected. A new panoramic upload over 8 MiB is rejected with an error that asks for a smaller JPEG; a panorama already stored on a project is kept. Settings edits do not base64-decode images.

## Live editor and headless render

```
https://matinrahimik.github.io/homebooks-appscreen/?project=PROJECT_ID&key=EDIT_KEY
```

Optional `api` overrides the Worker origin (default `https://homebooks-appscreen-mcp.matinrahimi.workers.dev`). Edits are saved about 800ms after the last change. Without `project` and `key`, the app stays on local IndexedDB only.

Headless mode adds `render` and `uploads`:

```
?project=PROJECT_ID&key=EDIT_KEY&render=0&uploads=0:TOKEN
?project=PROJECT_ID&key=EDIT_KEY&render=all&uploads=0:TOKEN,1:TOKEN
```

The sidebars are hidden. The preview canvas is the export pixel size (not the on-screen preview scale). Each asset is loaded from `GET /assets/<hash>`. A failed image (`naturalWidth === 0` or `decode()` rejecting) is retried inside the page, then the error names the asset hash. The page encodes the canvas with `canvas.toBlob`, computes crc32 and sha256, and `PUT`s the blob to `/renders/<token>`.

- `document.documentElement.dataset.appscreenStatus` is `done` or `error`
- `dataset.appscreenResult` is a small JSON object `{ shots: [...] }` with index, token, width, height, bytes, sha256, and crc. It does not contain pixels.
- `window.__appscreen.capture(index)` still returns a data URL for local debugging when `uploads` is absent

`render_preview` and `export_project` open that URL and wait until the status is `done`. They never call `setRequestInterception` and never receive the PNG.

Assets are relative. On the project site, `index.html` sets `<base href="/homebooks-appscreen/">` so `models/*.glb` and `img/*` load under the Pages subpath. Local `python3 -m http.server` keeps base `/`.

## Tools

Every tool is a `tools/call` with `arguments`. Example envelope:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": { "name": "list_projects", "arguments": {} }
}
```

### list_projects

`{}` → `{ "projects": [{ "id", "name", "screenshotCount", "createdAt", "updatedAt", "edit_url" }] }`

### create_project

```json
{ "name": "HomeBooks" }
```

Returns `project_id`, `edit_key`, `edit_url`, `api_base`.

### get_project

```json
{ "project_id": "PROJECT_ID", "include_backup": false }
```

Always includes `edit_url` and a summary (styles and headlines, not image bytes). `include_backup: true` adds the full backup JSON.

### delete_project

```json
{ "project_id": "PROJECT_ID" }
```

### add_screenshot

Image by URL **or** base64. `index` inserts; omit it to append.

```json
{
  "project_id": "PROJECT_ID",
  "name": "library.png",
  "language": "en",
  "device_type": "iPhone",
  "image_base64": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
}
```

```json
{
  "project_id": "PROJECT_ID",
  "image_url": "https://example.com/screen.png",
  "index": 0
}
```

### replace_screenshot

Same image fields. Keeps background, device, and text.

```json
{ "project_id": "PROJECT_ID", "index": 0, "image_url": "https://example.com/screen.png" }
```

### reorder_screenshots

`order` is a permutation of current indexes.

```json
{ "project_id": "PROJECT_ID", "order": [2, 0, 1] }
```

### remove_screenshot

```json
{ "project_id": "PROJECT_ID", "index": 1 }
```

### update_global_settings

`apply_to` is `all` (default, copies onto every screenshot and the defaults) or `defaults` (future screenshots only).

```json
{
  "project_id": "PROJECT_ID",
  "apply_to": "all",
  "settings": {
    "background": {
      "type": "gradient",
      "gradientPreset": "Indigo Rush"
    },
    "font_family": "Rubik",
    "font_weight": "700",
    "textGap": 28,
    "textGapUnit": "px",
    "headlineLetterSpacing": 1,
    "subheadlineLetterSpacing": 0,
    "headlineSize": 96,
    "headlineColour": "#fff8e7"
  }
}
```

`font_family` is any Google Fonts family (Rubik is supported). `textGapUnit` is `px` or `percent` of canvas height.

`gradientPreset` names come from `describe_options`. A raw gradient is:

```json
{
  "background": {
    "type": "gradient",
    "gradient": {
      "angle": 160,
      "stops": [
        { "color": "#0a0a0f", "position": 0 },
        { "color": "#1a1033", "position": 50 },
        { "color": "#0d1b2a", "position": 100 }
      ]
    }
  }
}
```

Solid and image backgrounds:

```json
{ "background": { "type": "solid", "solid": "#102030" } }
```

```json
{
  "background": {
    "type": "image",
    "imageSrc": "data:image/png;base64,...",
    "imageFit": "cover",
    "imageScale": 120,
    "imageOffsetX": 10,
    "imageOffsetY": -5,
    "imageBlur": 8,
    "overlayColor": "#000000",
    "overlayOpacity": 30
  }
}
```

`background_image_base64` or `background_image_url` on the settings object is stored as `imageSrc`. Offset is a percent of the canvas. Scale is a percent.

### update_screenshot_settings

```json
{
  "project_id": "PROJECT_ID",
  "index": 0,
  "settings": {
    "positionPreset": "tilt-left",
    "headline": "Your household library",
    "subheadline": "Track every book",
    "headlineFont": "Inter",
    "headlineWeight": "700",
    "headlineSize": 92,
    "headlineColour": "#ffffff",
    "subheadlineColor": "#ffffff",
    "subheadlineOpacity": 80,
    "position": "top",
    "offsetY": 12,
    "screenshot": {
      "scale": 150,
      "x": -20,
      "y": 140,
      "rotation": -6,
      "use3D": true,
      "device3D": "iphone",
      "rotation3D": { "x": 8, "y": -14, "z": 0 },
      "frameColor": "desert",
      "shadow": { "enabled": true, "color": "#000000", "blur": 40, "opacity": 30, "x": 0, "y": 20 },
      "frame": { "enabled": false, "color": "#1d1d1f", "width": 12, "opacity": 100 }
    }
  }
}
```

`positionPreset`: `centered`, `bleed-bottom`, `bleed-top`, `float-center`, `tilt-left`, `tilt-right`, `perspective`, `float-bottom` (same numbers as the editor). `device3D` is `iphone` or `samsung`. `scale` is a percent and may be at least 150 so the device can be cropped. `x` and `y` are not clamped to the canvas: values below 0 or above 100 move the device off the sides or the bottom. `rotation3D` is `{ x, y, z }` in degrees. `color` and `colour` both work. Any other backup field is deep-merged.

### set_panoramic_background

One wide image is sliced across the screenshots in order. `overlap` `0` gives equal tiles. `0.25` shares a quarter of each slice with the next screenshot.

```json
{
  "project_id": "PROJECT_ID",
  "image_base64": "iVBORw0KGgo...",
  "overlap": 0.15,
  "scale": 100,
  "offset_y": 0,
  "enabled": true
}
```

### set_output_size

```json
{ "project_id": "PROJECT_ID", "device": "iphone-6.9" }
```

Devices: `iphone-6.9` (1320×2868), `iphone-6.7` (1290×2796), `iphone-6.5` (1284×2778), `iphone-5.5` (1242×2208), `ipad-12.9` (2048×2732), `ipad-11` (1668×2388). The editor's other sizes (`android-phone`, `web-og`, …) are accepted too. Custom:

```json
{ "project_id": "PROJECT_ID", "device": "custom", "width": 1290, "height": 2796 }
```

Width and height must be between 100 and 4000.

### render_preview

```json
{ "project_id": "PROJECT_ID", "index": 0, "inline": false }
```

Returns `url`, `width`, `height`, `bytes`, and `sha256`. `inline: true` is accepted and ignored: the PNG is not copied back through the Worker. Fetch `url`.

### export_project

```json
{ "project_id": "PROJECT_ID" }
```

Returns `pngs[]` (one public URL each) and `zip_url`. The ZIP is not built in the render invocation. `GET` of `zip_url` streams an uncompressed ZIP from the uploaded PNGs and the crc32 values the page already computed.

### get_schema

`{}` → backup JSON shape plus every tool's input schema.

### describe_options

`{}` → output devices, position presets, gradient presets, system and popular Google fonts, 3D devices, frame colours, shadow and frame fields. Any Google Fonts family name is accepted, not only the popular list. At scale 100 the 3D phone is about 108% of the canvas height. `text.languageSettings.<lang>.headlineSize` overrides the global headline size when per-language layout is on; a plain `headlineSize` write updates that entry. `headlineTextWrap` and `subheadlineTextWrap` are `wrap` or `balance`.

## Caveats

- **Workers Free is still not a reliable place to iterate on a real project.** This path keeps image bytes out of the orchestrating isolate: asset `GET`s stream from KV, the page uploads each PNG, and the ZIP is streamed on download. That removes the failure where one invocation base64'd every screenshot and pushed it through CDP (`error code: 1102`, or `Too many API requests by single Worker invocation`). It does not remove the Free plan caps. Worker CPU is about 10 ms per invocation and memory is 128 MB, so any future code that buffers or decodes a multi-megabyte image in that invocation will 1102 again. Subrequests are capped at 50; this call does not intercept page requests and does not retry a 429 in a loop (at most two browser launches, then `retry-after`). Browser Rendering on Free is about 10 minutes per UTC day, 3 concurrent browsers, and one new browser every 20 seconds, with a 60 second inactivity timeout. A 6-screenshot 3D export of multi-megabyte PNGs plus a panorama can spend a large part of that daily 10 minutes and can be killed if it runs long. Reusing a healthy session avoids the new-browser rate. A page error keeps that session for the next call. A browser that stops answering is closed. When the message is `Browser time limit exceeded for today`, the daily 10 minutes are gone until 00:00 UTC; waiting a minute does not help.
- **Workers Paid** is what makes repeated exports of that project reliable. CPU goes from about 10 ms to a 30 second default (configurable up to 5 minutes). Subrequests go from 50 to a default of 10,000. Browser Rendering drops the 10 minute/day cap (usage is billed; the plan has included browser hours, then a per-hour charge) and raises concurrency and the new-browser rate. Paid does not remove the 60 second inactivity timeout; `keep_alive` can extend an idle session. Paid does not make it safe to copy image bytes through the isolate again.
- Rendering does nothing useful until the Pages site is deployed and Browser Rendering is enabled. The Worker and the Pages origin must both be public so the headless browser can load the app, fetch `/assets`, and `PUT /renders`.
- KV is eventually consistent and each value is at most 25 MiB. Image blobs written by the tools are chunked, then rejected above 80 MiB. A rendered PNG is streamed into one KV value, so a single upload above 25 MiB is rejected without being read. The project document itself stays small. Writes to one project are serialized by a Durable Object (`ProjectGate`) with compare-and-swap, so parallel `add_screenshot` calls do not drop screenshots or tear chunk metadata. This is not a substitute for object storage.
- The edit URL is a capability link. Anyone with `project` and `key` can read and overwrite that project. It is not the MCP token. The token can read and write every project.
- Last write wins between the agent and the open editor. The editor does not live-reload remote changes until the page is opened again.
- Noise overlay uses `Math.random`, so those frames are not pixel-stable between renders.
- 3D screenshots need the GLB models on Pages (`models/iphone-15-pro-max.glb`, `models/samsung-galaxy-s25-ultra.glb`). Those models stay under their CC BY 4.0 credits in the root README.
