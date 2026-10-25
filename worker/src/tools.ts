import { assertPanoramaBytes, buildRenderSupply, inlineAssetRefs, storeAsset } from "./assets.ts";
import { findGradientPreset, backupSchema, describeOptions } from "./schema.ts";
import {
  addScreenshot,
  assertPublicImageUrl,
  backupSummary,
  clone,
  createBackup,
  decodeImageBase64,
  outputSizeOf,
  primaryProject,
  ProjectError,
  projectName,
  renderSourceKeys,
  removeScreenshot,
  reorderScreenshots,
  replaceScreenshot,
  setOutputSize,
  setPanoramicBackground,
  setProjectName,
  updateGlobalSettings,
  updateScreenshotSettings,
  type BackupDump,
} from "./project.ts";
import {
  deleteProjectRecord,
  getEnvelope,
  installProject,
  listProjectIndex,
  modifyProject,
  putPublicFile,
  readProjectDoc,
  rememberFile,
  withRenderLock,
  type ProjectEnvelope,
} from "./store.ts";
import { assertRenderedFrames } from "./render.ts";
import { zipStore } from "./zip.ts";
import { KvLimitError } from "./kvblob.ts";
import type { Services } from "./types.ts";

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const imageProps = {
  image_url: {
    type: "string",
    description: "Public https URL of a PNG, JPEG, or WebP screenshot. Private and link-local hosts are rejected.",
  },
  image_base64: {
    type: "string",
    description: "Raw base64 or a data:image/...;base64, URL. Max 15 MiB decoded.",
  },
  name: { type: "string", description: "File name shown in the editor." },
  language: { type: "string", description: "Language code for this image, default en." },
  device_type: { type: "string", enum: ["iPhone", "iPad"], description: "Source device hint. Default iPhone." },
};

const settingsSchema = {
  type: "object",
  description:
    "Partial backup settings. background, screenshot, and text deep-merge. Text aliases (font_family, font_weight, headline, subheadline, textGap, letter spacing, headlineSize, headlineTextWrap, subheadlineTextWrap) apply under settings.text and at the top level. headlineSize also writes text.languageSettings for the active language, because that entry overrides the global size when per-language layout is on. headlineTextWrap and subheadlineTextWrap are wrap or balance. At scale 100 the 3D phone is about 108% of the canvas height. Unknown keys are an error. colour is an alias of color.",
  additionalProperties: true,
};

export const TOOLS: ToolDef[] = [
  {
    name: "list_projects",
    description: "List HomeBooks App Store screenshot projects stored for this MCP server.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "create_project",
    description:
      "Create an empty project in the app's backup JSON format. Returns the live edit URL (Pages app with ?project and ?key) and the edit key the browser uses to sync.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Project name. Default: HomeBooks." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_project",
    description:
      "Fetch a project summary and its live edit URL. Set include_backup to return the self-contained Export/Import backup JSON with image data URLs. The stored project document keeps images as asset refs, so a settings edit does not rewrite them.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        include_backup: { type: "boolean" },
      },
      required: ["project_id"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_project",
    description: "Delete a project, its backup JSON, and exported files.",
    inputSchema: {
      type: "object",
      properties: { project_id: { type: "string" } },
      required: ["project_id"],
      additionalProperties: false,
    },
  },
  {
    name: "add_screenshot",
    description: "Append or insert a screenshot image (https URL or base64) using the current default style.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        index: { type: "integer", description: "Insert position. Omit to append." },
        ...imageProps,
      },
      required: ["project_id"],
      additionalProperties: false,
    },
  },
  {
    name: "replace_screenshot",
    description: "Replace the image for one screenshot index without resetting its style.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        index: { type: "integer" },
        ...imageProps,
      },
      required: ["project_id", "index"],
      additionalProperties: false,
    },
  },
  {
    name: "reorder_screenshots",
    description: "Reorder screenshots. `order` is a permutation of the current indexes, for example [2, 0, 1].",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        order: { type: "array", items: { type: "integer" } },
      },
      required: ["project_id", "order"],
      additionalProperties: false,
    },
  },
  {
    name: "remove_screenshot",
    description: "Remove the screenshot at an index.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        index: { type: "integer" },
      },
      required: ["project_id", "index"],
      additionalProperties: false,
    },
  },
  {
    name: "update_global_settings",
    description:
      "Update background, device, text, and other default settings. apply_to all (default) also copies the patch onto every screenshot. apply_to defaults only affects screenshots added later.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        apply_to: { type: "string", enum: ["all", "defaults"] },
        settings: settingsSchema,
      },
      required: ["project_id", "settings"],
      additionalProperties: false,
    },
  },
  {
    name: "update_screenshot_settings",
    description:
      "Update one screenshot: background (gradient, solid, image), 2D/3D device and position preset, scale, rotation, shadow, frame, and text. settings.text and settings.screenshot objects apply, and the same text aliases work at the top level. This writes only the small project JSON. Unknown keys are an error. At scale 100 the 3D phone is about 108% of the canvas height. headlineSize writes text.languageSettings.<lang>.headlineSize as well as the global size.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        index: { type: "integer" },
        settings: settingsSchema,
      },
      required: ["project_id", "index", "settings"],
      additionalProperties: false,
    },
  },
  {
    name: "set_panoramic_background",
    description:
      "Use one wide image as a background sliced across screenshots in order. overlap is 0–0.8 (share of each slice). scale is percent. offset_y shifts the crop vertically, as a percent of image height. Omit the image to change overlap, scale, or offset only. A new panorama must be 8 MiB or smaller.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        image_url: imageProps.image_url,
        image_base64: imageProps.image_base64,
        enabled: { type: "boolean" },
        overlap: { type: "number", description: "0 to 0.8. 0 tiles the image with no shared pixels." },
        scale: { type: "number", description: "Zoom percent. 100 shows the full slice." },
        offset_y: { type: "number", description: "Vertical shift as a percent of image height." },
      },
      required: ["project_id"],
      additionalProperties: false,
    },
  },
  {
    name: "set_output_size",
    description:
      'Set the export pixel size. device is iphone-6.9, iphone-6.7, iphone-6.5, iphone-5.5, ipad-12.9, ipad-11, or custom with width and height.',
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        device: { type: "string" },
        width: { type: "number" },
        height: { type: "number" },
      },
      required: ["project_id"],
      additionalProperties: false,
    },
  },
  {
    name: "render_preview",
    description:
      "Render one screenshot to a PNG at the project's exact output pixel size using the hosted app (2D canvas and three.js). Returns a public URL. Set inline true to also embed the PNG.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        index: { type: "integer" },
        inline: { type: "boolean" },
      },
      required: ["project_id", "index"],
      additionalProperties: false,
    },
  },
  {
    name: "export_project",
    description: "Render every screenshot to PNG and a ZIP. Returns public unguessable URLs.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
      },
      required: ["project_id"],
      additionalProperties: false,
    },
  },
  {
    name: "get_schema",
    description: "Describe the backup JSON format and the argument schema of every tool.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "describe_options",
    description: "List output sizes, position presets, gradient presets, fonts, 3D devices, and other allowed values.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

export interface ToolSuccess {
  data: unknown;
  images?: { base64: string; mimeType: string }[];
}

function pagesBase(services: Services): string {
  const origin = (services.env.PAGES_ORIGIN || "https://matinrahimik.github.io").replace(/\/$/, "");
  let path = services.env.PAGES_PATH || "/homebooks-appscreen/";
  if (!path.startsWith("/")) path = `/${path}`;
  if (!path.endsWith("/")) path = `${path}/`;
  return `${origin}${path}`;
}

export function editUrl(services: Services, id: string, editKey: string): string {
  const url = new URL(pagesBase(services));
  url.searchParams.set("project", id);
  url.searchParams.set("key", editKey);
  url.searchParams.set("api", services.publicOrigin);
  return url.toString();
}

function renderUrl(services: Services, id: string, editKey: string, render: string): string {
  const url = new URL(editUrl(services, id, editKey));
  url.searchParams.set("render", render);
  return url.toString();
}

function nowIso(services: Services): string {
  return services.now ? services.now() : new Date().toISOString();
}

function randomId(): string {
  return crypto.randomUUID();
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function requireProject(services: Services, projectId: string): Promise<{ envelope: ProjectEnvelope; backup: BackupDump }> {
  if (!projectId || typeof projectId !== "string") {
    throw new ProjectError("invalid_request", "project_id is required.");
  }
  const envelope = await getEnvelope(services.env.APPSCREEN_KV, projectId);
  const loaded = envelope ? await readProjectDoc(services.env, projectId) : null;
  if (!envelope || !loaded) throw new ProjectError("not_found", `Project ${projectId} was not found.`);
  return { envelope, backup: loaded.backup };
}

async function editProject(
  services: Services,
  projectId: string,
  mutate: (draft: BackupDump) => void | Promise<void>,
): Promise<{ envelope: ProjectEnvelope; backup: BackupDump }> {
  if (!projectId || typeof projectId !== "string") {
    throw new ProjectError("invalid_request", "project_id is required.");
  }
  const backup = await modifyProject(services.env, projectId, mutate, nowIso(services));
  const envelope = await getEnvelope(services.env.APPSCREEN_KV, projectId);
  if (!envelope) throw new ProjectError("not_found", `Project ${projectId} was not found.`);
  return { envelope, backup };
}

function resolveGradients(settings: Record<string, unknown>): void {
  const apply = (node: Record<string, unknown> | undefined) => {
    if (!node) return;
    const name = typeof node.gradientPreset === "string" ? node.gradientPreset : undefined;
    if (!name) return;
    const preset = findGradientPreset(name);
    if (!preset) {
      throw new ProjectError("invalid_preset", `Unknown gradient preset "${name}". Call describe_options.`);
    }
    node.type = node.type || "gradient";
    node.gradient = { angle: preset.angle, stops: preset.stops };
    delete node.gradientPreset;
  };
  apply(settings);
  if (settings.background && typeof settings.background === "object") {
    apply(settings.background as Record<string, unknown>);
  }
}

async function applyBackgroundImageArgs(services: Services, settings: Record<string, unknown>): Promise<void> {
  const bg = settings.background && typeof settings.background === "object" && !Array.isArray(settings.background)
    ? (settings.background as Record<string, unknown>)
    : {};
  const b64 = typeof settings.background_image_base64 === "string"
    ? settings.background_image_base64
    : typeof bg.image_base64 === "string"
      ? bg.image_base64
      : "";
  const url = typeof settings.background_image_url === "string"
    ? settings.background_image_url
    : typeof bg.image_url === "string"
      ? bg.image_url
      : "";
  if (!b64.trim() && !url.trim()) return;
  const image = await loadImageBytes(services, { image_base64: b64, image_url: url });
  const ref = await storeAsset(services.env.APPSCREEN_KV, image.bytes, image.mime);
  settings.background = { ...bg, type: "image", imageSrc: ref, image: null };
  delete (settings.background as Record<string, unknown>).image_base64;
  delete (settings.background as Record<string, unknown>).image_url;
  delete settings.background_image_base64;
  delete settings.background_image_url;
}

async function loadImageBytes(services: Services, args: Record<string, unknown>): Promise<{ mime: string; bytes: Uint8Array; name?: string; language?: string; deviceType?: string }> {
  const named = typeof args.name === "string" ? args.name : undefined;
  const language = typeof args.language === "string" ? args.language : undefined;
  const deviceType = typeof args.device_type === "string" ? args.device_type : undefined;
  if (typeof args.image_base64 === "string" && args.image_base64.trim()) {
    const decoded = decodeImageBase64(args.image_base64);
    return { mime: decoded.mime, bytes: decoded.bytes, name: named, language, deviceType };
  }
  if (typeof args.image_url === "string" && args.image_url.trim()) {
    assertPublicImageUrl(args.image_url);
    const loader = services.loadImage || defaultLoadImage;
    const loaded = await loader(args.image_url);
    return { mime: loaded.mime, bytes: loaded.bytes, name: named, language, deviceType };
  }
  throw new ProjectError("invalid_image", "Provide image_url or image_base64.");
}

export async function defaultLoadImage(url: string): Promise<{ mime: string; bytes: Uint8Array }> {
  assertPublicImageUrl(url);
  const response = await fetch(url, { redirect: "follow" });
  if (response.url) assertPublicImageUrl(response.url);
  if (!response.ok) {
    throw new ProjectError("image_fetch_failed", `Fetching image failed with HTTP ${response.status}.`);
  }
  const mime = (response.headers.get("content-type") || "image/png").split(";")[0].trim();
  if (!mime.startsWith("image/")) {
    throw new ProjectError("image_fetch_failed", `URL did not return an image (content-type ${mime}).`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  return { mime, bytes };
}

async function storeRendered(
  services: Services,
  projectId: string,
  bytes: Uint8Array,
  contentType: string,
  filename: string,
): Promise<string> {
  const token = randomToken();
  await putPublicFile(services.env.APPSCREEN_KV, token, bytes, contentType);
  await rememberFile(services.env.APPSCREEN_KV, projectId, token);
  const url = new URL(`/f/${token}/${filename}`, services.publicOrigin);
  return url.toString();
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const stride = 0x8000;
  for (let i = 0; i < bytes.length; i += stride) {
    binary += String.fromCharCode(...bytes.subarray(i, i + stride));
  }
  return btoa(binary);
}

const INLINE_LIMIT = 4 * 1024 * 1024;

export async function callTool(services: Services, name: string, args: Record<string, unknown>): Promise<ToolSuccess> {
  switch (name) {
    case "list_projects": {
      const projects = await listProjectIndex(services.env.APPSCREEN_KV);
      const detailed = [];
      for (const entry of projects) {
        const envelope = await getEnvelope(services.env.APPSCREEN_KV, entry.id);
        detailed.push({
          ...entry,
          edit_url: envelope ? editUrl(services, entry.id, envelope.editKey) : null,
        });
      }
      return { data: { projects: detailed } };
    }
    case "create_project": {
      const id = randomId();
      const projectNameInput = typeof args.name === "string" && args.name.trim() ? args.name.trim() : "HomeBooks";
      const editKey = randomToken();
      const backup = createBackup(id, projectNameInput);
      const stamp = nowIso(services);
      const envelope: ProjectEnvelope = {
        id,
        name: projectNameInput,
        editKey,
        createdAt: stamp,
        updatedAt: stamp,
        screenshotCount: 0,
        fileTokens: [],
      };
      await installProject(services.env, envelope, backup);
      return {
        data: {
          project_id: id,
          name: projectNameInput,
          edit_key: editKey,
          edit_url: editUrl(services, id, editKey),
          api_base: services.publicOrigin,
          created_at: stamp,
        },
      };
    }
    case "get_project": {
      const { envelope, backup } = await requireProject(services, String(args.project_id || ""));
      const project = primaryProject(backup);
      const data: Record<string, unknown> = {
        project_id: envelope.id,
        name: projectName(backup),
        edit_url: editUrl(services, envelope.id, envelope.editKey),
        api_base: services.publicOrigin,
        created_at: envelope.createdAt,
        updated_at: envelope.updatedAt,
        output: outputSizeOf(project),
        summary: backupSummary(backup),
      };
      if (args.include_backup === true) data.backup = await inlineAssetRefs(services.env.APPSCREEN_KV, clone(backup));
      return { data };
    }
    case "delete_project": {
      const id = String(args.project_id || "");
      const removed = await deleteProjectRecord(services.env, id);
      if (!removed) throw new ProjectError("not_found", `Project ${id} was not found.`);
      return { data: { deleted: true, project_id: id } };
    }
    case "add_screenshot": {
      const image = await loadImageBytes(services, args);
      const ref = await storeAsset(services.env.APPSCREEN_KV, image.bytes, image.mime);
      const indexArg = Number.isInteger(args.index) ? Number(args.index) : undefined;
      let index = 0;
      const { envelope, backup } = await editProject(services, String(args.project_id || ""), (draft) => {
        index = addScreenshot(draft, { ...image, dataUrl: ref }, indexArg);
      });
      return { data: { project_id: envelope.id, index, screenshot_count: primaryProject(backup).screenshots.length } };
    }
    case "replace_screenshot": {
      const image = await loadImageBytes(services, args);
      const ref = await storeAsset(services.env.APPSCREEN_KV, image.bytes, image.mime);
      const index = Number(args.index);
      const { envelope } = await editProject(services, String(args.project_id || ""), (draft) => {
        replaceScreenshot(draft, index, { ...image, dataUrl: ref });
      });
      return { data: { project_id: envelope.id, index } };
    }
    case "reorder_screenshots": {
      if (!Array.isArray(args.order)) throw new ProjectError("invalid_order", "order must be an array of indexes.");
      const order = args.order.map((n) => Number(n));
      const { envelope } = await editProject(services, String(args.project_id || ""), (draft) => {
        reorderScreenshots(draft, order);
      });
      return { data: { project_id: envelope.id, order: args.order } };
    }
    case "remove_screenshot": {
      const index = Number(args.index);
      const { envelope, backup } = await editProject(services, String(args.project_id || ""), (draft) => {
        removeScreenshot(draft, index);
      });
      return { data: { project_id: envelope.id, screenshot_count: primaryProject(backup).screenshots.length } };
    }
    case "update_global_settings": {
      if (!args.settings || typeof args.settings !== "object" || Array.isArray(args.settings)) {
        throw new ProjectError("invalid_request", "settings object is required.");
      }
      const settings = { ...(args.settings as Record<string, unknown>) };
      resolveGradients(settings);
      await applyBackgroundImageArgs(services, settings);
      const applyTo = args.apply_to === "defaults" ? "defaults" : "all";
      const { envelope, backup } = await editProject(services, String(args.project_id || ""), (draft) => {
        updateGlobalSettings(draft, settings, applyTo);
        if (typeof settings.name === "string") setProjectName(draft, settings.name);
      });
      return { data: { project_id: envelope.id, summary: backupSummary(backup) } };
    }
    case "update_screenshot_settings": {
      if (!args.settings || typeof args.settings !== "object" || Array.isArray(args.settings)) {
        throw new ProjectError("invalid_request", "settings object is required.");
      }
      const settings = { ...(args.settings as Record<string, unknown>) };
      resolveGradients(settings);
      await applyBackgroundImageArgs(services, settings);
      const index = Number(args.index);
      const { envelope, backup } = await editProject(services, String(args.project_id || ""), (draft) => {
        updateScreenshotSettings(draft, index, settings);
      });
      return { data: { project_id: envelope.id, index, summary: backupSummary(backup) } };
    }
    case "set_panoramic_background": {
      let src: string | undefined;
      if ((typeof args.image_base64 === "string" && args.image_base64.trim()) || (typeof args.image_url === "string" && args.image_url.trim())) {
        const image = await loadImageBytes(services, args);
        assertPanoramaBytes(image.bytes.byteLength);
        src = await storeAsset(services.env.APPSCREEN_KV, image.bytes, image.mime);
      }
      let pano: Record<string, unknown> = {};
      const { envelope } = await editProject(services, String(args.project_id || ""), (draft) => {
        pano = setPanoramicBackground(draft, {
          src,
          enabled: typeof args.enabled === "boolean" ? args.enabled : undefined,
          overlap: typeof args.overlap === "number" ? args.overlap : undefined,
          scale: typeof args.scale === "number" ? args.scale : undefined,
          offsetY: typeof args.offset_y === "number" ? args.offset_y : undefined,
        });
      });
      return {
        data: {
          project_id: envelope.id,
          panoramicBackground: {
            enabled: pano.enabled,
            overlap: pano.overlap,
            scale: pano.scale,
            offsetY: pano.offsetY,
            hasImage: Boolean(pano.src),
          },
        },
      };
    }
    case "set_output_size": {
      if (typeof args.device !== "string" && typeof args.width !== "number" && typeof args.height !== "number") {
        throw new ProjectError("invalid_size", "Provide device, or width and height for a custom size.");
      }
      let size: { device: string; width: number; height: number } = { device: "custom", width: 0, height: 0 };
      const { envelope } = await editProject(services, String(args.project_id || ""), (draft) => {
        size = setOutputSize(draft, {
          device: typeof args.device === "string" ? args.device : undefined,
          width: typeof args.width === "number" ? args.width : undefined,
          height: typeof args.height === "number" ? args.height : undefined,
        });
      });
      return { data: { project_id: envelope.id, ...size } };
    }
    case "render_preview": {
      const { envelope, backup } = await requireProject(services, String(args.project_id || ""));
      const index = Number(args.index);
      const project = primaryProject(backup);
      if (!Number.isInteger(index) || index < 0 || index >= project.screenshots.length) {
        throw new ProjectError("invalid_index", `Screenshot index ${index} is out of range.`);
      }
      const shots = await renderProject(services, envelope, backup, [index]);
      const shot = shots[0];
      const url = await storeRendered(services, envelope.id, shot.png, "image/png", `screenshot-${index + 1}.png`);
      const data: Record<string, unknown> = {
        project_id: envelope.id,
        index,
        url,
        width: shot.width,
        height: shot.height,
        bytes: shot.png.byteLength,
      };
      const images = [];
      if (args.inline === true) {
        if (shot.png.byteLength > INLINE_LIMIT) {
          data.inline_omitted = `PNG is ${shot.png.byteLength} bytes, above the ${INLINE_LIMIT} byte inline limit. Use url.`;
        } else {
          images.push({ base64: bytesToBase64(shot.png), mimeType: "image/png" });
        }
      }
      return { data, images };
    }
    case "export_project": {
      const { envelope, backup } = await requireProject(services, String(args.project_id || ""));
      const project = primaryProject(backup);
      if (project.screenshots.length === 0) {
        throw new ProjectError("empty_project", "Project has no screenshots to export.");
      }
      const indexes = project.screenshots.map((_, i) => i);
      const shots = await renderProject(services, envelope, backup, indexes);
      const pngs = [];
      const zipEntries = [];
      for (const shot of shots) {
        const filename = `screenshot-${shot.index + 1}.png`;
        const url = await storeRendered(services, envelope.id, shot.png, "image/png", filename);
        pngs.push({ index: shot.index, url, width: shot.width, height: shot.height, bytes: shot.png.byteLength });
        zipEntries.push({ name: filename, data: shot.png });
      }
      const zip = zipStore(zipEntries);
      const zipUrl = await storeRendered(services, envelope.id, zip, "application/zip", "screenshots.zip");
      return {
        data: {
          project_id: envelope.id,
          output: outputSizeOf(project),
          pngs,
          zip_url: zipUrl,
        },
      };
    }
    case "get_schema":
      return {
        data: {
          backup: backupSchema(),
          tools: TOOLS.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
        },
      };
    case "describe_options":
      return { data: describeOptions() };
    default:
      throw new ProjectError("unknown_tool", `Unknown tool "${name}".`);
  }
}

async function renderProject(services: Services, envelope: ProjectEnvelope, backup: BackupDump, indexes: number[]) {
  if (!services.renderScreenshots) {
    throw new ProjectError("render_unavailable", "Browser rendering is not configured.");
  }
  const url = renderUrl(services, envelope.id, envelope.editKey, indexes.length === 1 ? String(indexes[0]) : "all");
  try {
    return await withRenderLock(services.env, envelope.id, async () => {
      const supply = await buildRenderSupply(services.env.APPSCREEN_KV, backup);
      const shots = await services.renderScreenshots!(url, indexes, supply);
      const sources = renderSourceKeys(backup);
      await assertRenderedFrames(shots, indexes.map((index) => sources[index] || { image: "", panorama: false }));
      return shots;
    });
  } catch (error) {
    if (error instanceof ProjectError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new ProjectError("render_failed", message);
  }
}

export function toolErrorStatus(error: unknown): { message: string } {
  if (error instanceof ProjectError || error instanceof KvLimitError) {
    return { message: error.message };
  }
  const message = error instanceof Error ? error.message : "Tool failed.";
  return { message };
}
