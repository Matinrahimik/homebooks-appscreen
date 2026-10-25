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
| `GET` | `/f/:token/:filename` | none (unguessable token) | PNG or ZIP bytes |
| `POST` | `/mcp` | MCP bearer | JSON-RPC |

`GET` and `PUT` use the same JSON as **Export Project Backup** / **Import Project Backup**:

```json
{
  "projects": [{ "id": "...", "formatVersion": 2, "screenshots": [], "outputDevice": "iphone-6.9", "defaults": {} }],
  "meta": [
    { "key": "projects", "value": [{ "id": "...", "name": "HomeBooks", "screenshotCount": 0 }] },
    { "key": "currentProject", "value": "..." }
  ]
}
```

Screenshot images are data URLs on `localizedImages.<lang>.src` and the legacy `src` field.

KV values are capped at 25 MiB. Project JSON and exported blobs are stored in 8 MiB chunks. Anything that would exceed 80 MiB total, or a single image over 15 MiB, is rejected with a clear error instead of a partial write.

## Live editor and headless render

```
https://matinrahimik.github.io/homebooks-appscreen/?project=PROJECT_ID&key=EDIT_KEY
```

Optional `api` overrides the Worker origin (default `https://homebooks-appscreen-mcp.matinrahimi.workers.dev`). Edits are saved about 800ms after the last change. Without `project` and `key`, the app stays on local IndexedDB only.

Headless mode adds `render`:

```
?project=PROJECT_ID&key=EDIT_KEY&render=0
?project=PROJECT_ID&key=EDIT_KEY&render=all
```

The sidebars are hidden. The preview canvas is the export pixel size (not the on-screen preview scale). When drawing finishes (images, fonts, and the three.js device model when 3D is on):

- `document.documentElement.dataset.appscreenStatus` is `ready` or `error`
- `window.__appscreenReady === true`
- `await window.__appscreen.capture(index)` resolves to `{ index, width, height, dataUrl }`
- `await window.__appscreen.captureAll()` captures every screenshot
- `window.__appscreen.getCanvas()` is the `#preview-canvas` element

`render_preview` and `export_project` open that URL with `@cloudflare/puppeteer` and read `capture()`, so server output matches the editor.

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

Returns `url`, `width`, `height`. `inline: true` also adds an MCP image block when the PNG is under 4 MiB.

### export_project

```json
{ "project_id": "PROJECT_ID" }
```

Returns `pngs[]` (one public URL each) and `zip_url`.

### get_schema

`{}` → backup JSON shape plus every tool's input schema.

### describe_options

`{}` → output devices, position presets, gradient presets, system and popular Google fonts, 3D devices, frame colours, shadow and frame fields. Any Google Fonts family name is accepted, not only the popular list.

## Caveats

- **Browser Rendering on the Workers Free plan** is capped at [10 minutes of browser time per UTC day](https://developers.cloudflare.com/browser-run/limits/). Over the cap, new sessions fail with HTTP 429 until the next UTC day. Paid plans have a higher allowance. Each preview or export launches a browser, loads the Pages app, the 3D model (when needed), and Google Fonts.
- Rendering does nothing useful until the Pages site is deployed and Browser Rendering is enabled. The Worker and the Pages origin must both be public so the headless browser can load the app and the app can fetch the project.
- KV is eventually consistent and each value is at most 25 MiB. Exports and projects are chunked, then rejected above 80 MiB. This is not a substitute for object storage.
- The edit URL is a capability link. Anyone with `project` and `key` can read and overwrite that project. It is not the MCP token. The token can read and write every project.
- Last write wins between the agent and the open editor. The editor does not live-reload remote changes until the page is opened again.
- Noise overlay uses `Math.random`, so those frames are not pixel-stable between renders.
- 3D screenshots need the GLB models on Pages (`models/iphone-15-pro-max.glb`, `models/samsung-galaxy-s25-ultra.glb`). Those models stay under their CC BY 4.0 credits in the root README.
