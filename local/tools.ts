import { foldAssetUrls, presentAssetRefs, assertPanoramaBytes } from "../worker/src/assets.ts";
import {
  addScreenshot,
  assertBackup,
  backupSummary,
  base64ToBytes,
  clone,
  createBackup,
  decodeImageBase64,
  outputSizeOf,
  primaryProject,
  ProjectError,
  projectName,
  removeScreenshot,
  reorderScreenshots,
  replaceScreenshot,
  setOutputSize,
  setPanoramicBackground,
  setProjectName,
  updateGlobalSettings,
  updateScreenshotSettings,
  bytesToBase64,
} from "../worker/src/project.ts";
import { findGradientPreset, backupSchema, describeOptions } from "../worker/src/schema.ts";
import { TOOLS, defaultLoadImage, type ToolDef } from "../worker/src/tools.ts";
import { assertRenderedFrames } from "../worker/src/render.ts";
import { renderSourceKeys, type BackupDump } from "../worker/src/project.ts";
import { zipStore } from "../worker/src/zip.ts";
import { readFile } from "node:fs/promises";
import { Disk, randomToken, type Envelope } from "./disk.ts";
import { DEFAULT_REMOTE, fetchRemoteBackup, installBackup } from "./import-project.ts";
import { renderIndexes } from "./render.ts";

export interface ToolSuccess {
  data: unknown;
}

const IMPORT_TOOL: ToolDef = {
  name: "import_remote_project",
  description:
    "Copy a project and every referenced image into the local disk store, unchanged. Reads the remote project with GET /api/projects/:id (Authorization bearer or X-Edit-Key) and each asset with GET /assets/<sha256>, then checks the sha256. Pass file and assets_dir to import a local backup instead. Does not write to Cloudflare.",
  inputSchema: {
    type: "object",
    properties: {
      project_id: { type: "string", description: "Remote project id. Optional when file is set." },
      edit_key: { type: "string", description: "Remote edit key, sent as X-Edit-Key. Also stored locally when set." },
      base_url: { type: "string", description: "Remote origin. Default is the deployed HomeBooks Worker." },
      file: { type: "string", description: "Path to a local Export/Import backup JSON." },
      assets_dir: { type: "string", description: "Folder of image files named by sha256, or any files whose bytes hash to the refs." },
    },
    additionalProperties: false,
  },
};

export const LOCAL_TOOLS: ToolDef[] = [
  ...TOOLS.map((tool) => {
    if (tool.name === "render_preview") {
      return {
        ...tool,
        description:
          "Render one screenshot to a PNG at the project's exact output pixel size using local headless Chromium. Returns a filesystem path and an http://localhost URL. inline is accepted and ignored: image bytes are not copied into the tool result.",
      };
    }
    if (tool.name === "export_project") {
      return {
        ...tool,
        description:
          "Render every screenshot in one local headless Chromium session. Returns filesystem paths and http://localhost URLs for each PNG and for the ZIP.",
      };
    }
    return tool;
  }),
  IMPORT_TOOL,
];

function editUrl(origin: string, id: string, editKey: string): string {
  const url = new URL("/", origin);
  url.searchParams.set("project", id);
  url.searchParams.set("key", editKey);
  url.searchParams.set("api", origin);
  return url.toString();
}

function publicFileUrl(origin: string, projectId: string, filename: string): string {
  return new URL(`/renders/output/${encodeURIComponent(projectId)}/${encodeURIComponent(filename)}`, origin).toString();
}

const locks = new Map<string, Promise<unknown>>();

function withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(id) || Promise.resolve();
  const run = prev.catch(() => undefined).then(fn);
  locks.set(id, run);
  return run;
}

async function requireProject(disk: Disk, projectId: string): Promise<Envelope> {
  if (!projectId || typeof projectId !== "string") throw new ProjectError("invalid_request", "project_id is required.");
  const envelope = await disk.get(projectId);
  if (!envelope) throw new ProjectError("not_found", `Project ${projectId} was not found.`);
  return envelope;
}

async function editProject(disk: Disk, projectId: string, mutate: (draft: BackupDump) => void | Promise<void>): Promise<Envelope> {
  return withLock(projectId, async () => {
    const envelope = await requireProject(disk, projectId);
    const draft = clone(envelope.backup);
    await mutate(draft);
    envelope.backup = draft;
    envelope.updatedAt = new Date().toISOString();
    await disk.save(envelope);
    return envelope;
  });
}

function resolveGradients(settings: Record<string, unknown>): void {
  const apply = (node: Record<string, unknown> | undefined) => {
    if (!node) return;
    const name = typeof node.gradientPreset === "string" ? node.gradientPreset : undefined;
    if (!name) return;
    const preset = findGradientPreset(name);
    if (!preset) throw new ProjectError("invalid_preset", `Unknown gradient preset "${name}". Call describe_options.`);
    node.type = node.type || "gradient";
    node.gradient = { angle: preset.angle, stops: preset.stops };
    delete node.gradientPreset;
  };
  apply(settings);
  if (settings.background && typeof settings.background === "object") apply(settings.background as Record<string, unknown>);
}

async function loadImageBytes(args: Record<string, unknown>): Promise<{ mime: string; bytes: Uint8Array; name?: string; language?: string; deviceType?: string }> {
  const named = typeof args.name === "string" ? args.name : undefined;
  const language = typeof args.language === "string" ? args.language : undefined;
  const deviceType = typeof args.device_type === "string" ? args.device_type : undefined;
  if (typeof args.image_base64 === "string" && args.image_base64.trim()) {
    const decoded = decodeImageBase64(args.image_base64);
    return { mime: decoded.mime, bytes: decoded.bytes, name: named, language, deviceType };
  }
  if (typeof args.image_url === "string" && args.image_url.trim()) {
    const loaded = await defaultLoadImage(args.image_url);
    return { mime: loaded.mime, bytes: loaded.bytes, name: named, language, deviceType };
  }
  throw new ProjectError("invalid_image", "Provide image_url or image_base64.");
}

async function applyBackgroundImageArgs(disk: Disk, settings: Record<string, unknown>): Promise<void> {
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
  const image = await loadImageBytes({ image_base64: b64, image_url: url });
  const ref = await disk.storeAsset(image.bytes, image.mime);
  settings.background = { ...bg, type: "image", imageSrc: ref, image: null };
  delete (settings.background as Record<string, unknown>).image_base64;
  delete (settings.background as Record<string, unknown>).image_url;
  delete settings.background_image_base64;
  delete settings.background_image_url;
}

async function inlineAssets(disk: Disk, value: unknown): Promise<unknown> {
  if (typeof value === "string") {
    const match = /^asset:([a-f0-9]{64})$/.exec(value);
    if (!match) return value;
    const blob = await disk.readAsset(match[1]);
    if (!blob) throw new ProjectError("missing_asset", `Image asset ${match[1]} is missing.`);
    return `data:${blob.mime};base64,${bytesToBase64(blob.bytes)}`;
  }
  if (Array.isArray(value)) return Promise.all(value.map((item) => inlineAssets(disk, item)));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) out[key] = await inlineAssets(disk, child);
    return out;
  }
  return value;
}

async function externalizeDataUrls(disk: Disk, value: unknown): Promise<void> {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const child = value[i];
      if (typeof child === "string") value[i] = await externalizeString(disk, child);
      else await externalizeDataUrls(disk, child);
    }
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const child = record[key];
    if (typeof child === "string") record[key] = await externalizeString(disk, child);
    else await externalizeDataUrls(disk, child);
  }
}

async function externalizeString(disk: Disk, value: string): Promise<string> {
  const data = /^data:([^;,]+);base64,([\s\S]+)$/i.exec(value);
  if (!data) return value;
  const bytes = base64ToBytes(data[2]);
  return disk.storeAsset(bytes, data[1]);
}

export async function saveEditorBackup(disk: Disk, id: string, parsed: unknown): Promise<string> {
  await externalizeDataUrls(disk, parsed);
  foldAssetUrls(parsed);
  const backup = assertBackup(parsed);
  const project = backup.projects.find((item) => item.id === id) || backup.projects[0];
  project.id = id;
  const current = backup.meta.find((item) => item.key === "currentProject");
  if (current) current.value = id;
  else backup.meta.push({ key: "currentProject", value: id });
  const listed = backup.meta.find((item) => item.key === "projects");
  if (listed && Array.isArray(listed.value)) {
    for (const entry of listed.value as { id?: string }[]) {
      if (entry && typeof entry === "object") entry.id = id;
    }
  }
  const envelope = await requireProject(disk, id);
  if (listed && Array.isArray(listed.value) && (listed.value as unknown[]).length > 0) {
    setProjectName(backup, ((listed.value as { name?: string }[])[0].name) || envelope.name);
  }
  envelope.backup = backup;
  envelope.updatedAt = new Date().toISOString();
  await disk.save(envelope);
  return envelope.updatedAt;
}

export function presentBackup(backup: BackupDump, origin: string): unknown {
  return presentAssetRefs(backup, origin);
}

async function renderProject(disk: Disk, origin: string, envelope: Envelope, indexes: number[]) {
  return withLock(envelope.id, async () => {
    const fresh = await requireProject(disk, envelope.id);
    for (const hash of referenced(fresh.backup)) {
      if (!(await disk.hasAsset(hash))) {
        throw new ProjectError("missing_asset", `Image asset ${hash} is missing. The render was not started.`);
      }
    }
    const frames = await renderIndexes({
      origin,
      projectId: fresh.id,
      editKey: fresh.editKey,
      indexes,
      disk,
    });
    const sources = renderSourceKeys(fresh.backup);
    assertRenderedFrames(frames, indexes.map((index) => sources[index] || { image: "", panorama: false }));
    return frames;
  });
}

function referenced(backup: BackupDump): string[] {
  const hashes = new Set<string>();
  const walk = (value: unknown) => {
    if (typeof value === "string") {
      const match = /^asset:([a-f0-9]{64})$/.exec(value);
      if (match) hashes.add(match[1]);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (value && typeof value === "object") {
      for (const child of Object.values(value)) walk(child);
    }
  };
  walk(backup);
  return [...hashes];
}

export async function callLocalTool(disk: Disk, origin: string, name: string, args: Record<string, unknown>): Promise<ToolSuccess> {
  switch (name) {
    case "list_projects": {
      const projects = await disk.list();
      return {
        data: {
          projects: projects.map((entry) => ({
            id: entry.id,
            name: entry.name,
            createdAt: entry.createdAt,
            updatedAt: entry.updatedAt,
            screenshotCount: entry.screenshotCount,
            edit_url: editUrl(origin, entry.id, entry.editKey),
          })),
        },
      };
    }
    case "create_project": {
      const id = crypto.randomUUID();
      const projectNameInput = typeof args.name === "string" && args.name.trim() ? args.name.trim() : "HomeBooks";
      const editKey = randomToken();
      const stamp = new Date().toISOString();
      const envelope: Envelope = {
        id,
        name: projectNameInput,
        editKey,
        createdAt: stamp,
        updatedAt: stamp,
        screenshotCount: 0,
        backup: createBackup(id, projectNameInput),
      };
      await disk.save(envelope);
      return {
        data: {
          project_id: id,
          name: projectNameInput,
          edit_key: editKey,
          edit_url: editUrl(origin, id, editKey),
          api_base: origin,
          created_at: stamp,
        },
      };
    }
    case "get_project": {
      const envelope = await requireProject(disk, String(args.project_id || ""));
      const project = primaryProject(envelope.backup);
      const data: Record<string, unknown> = {
        project_id: envelope.id,
        name: projectName(envelope.backup),
        edit_url: editUrl(origin, envelope.id, envelope.editKey),
        api_base: origin,
        created_at: envelope.createdAt,
        updated_at: envelope.updatedAt,
        output: outputSizeOf(project),
        summary: backupSummary(envelope.backup),
      };
      if (args.include_backup === true) data.backup = await inlineAssets(disk, clone(envelope.backup));
      return { data };
    }
    case "delete_project": {
      const id = String(args.project_id || "");
      const removed = await disk.remove(id);
      if (!removed) throw new ProjectError("not_found", `Project ${id} was not found.`);
      return { data: { deleted: true, project_id: id } };
    }
    case "add_screenshot": {
      const image = await loadImageBytes(args);
      const ref = await disk.storeAsset(image.bytes, image.mime);
      const indexArg = Number.isInteger(args.index) ? Number(args.index) : undefined;
      let index = 0;
      const envelope = await editProject(disk, String(args.project_id || ""), (draft) => {
        index = addScreenshot(draft, { ...image, dataUrl: ref }, indexArg);
      });
      return { data: { project_id: envelope.id, index, screenshot_count: primaryProject(envelope.backup).screenshots.length } };
    }
    case "replace_screenshot": {
      const image = await loadImageBytes(args);
      const ref = await disk.storeAsset(image.bytes, image.mime);
      const index = Number(args.index);
      const envelope = await editProject(disk, String(args.project_id || ""), (draft) => {
        replaceScreenshot(draft, index, { ...image, dataUrl: ref });
      });
      return { data: { project_id: envelope.id, index } };
    }
    case "reorder_screenshots": {
      if (!Array.isArray(args.order)) throw new ProjectError("invalid_order", "order must be an array of indexes.");
      const order = args.order.map((n) => Number(n));
      const envelope = await editProject(disk, String(args.project_id || ""), (draft) => {
        reorderScreenshots(draft, order);
      });
      return { data: { project_id: envelope.id, order: args.order } };
    }
    case "remove_screenshot": {
      const index = Number(args.index);
      const envelope = await editProject(disk, String(args.project_id || ""), (draft) => {
        removeScreenshot(draft, index);
      });
      return { data: { project_id: envelope.id, screenshot_count: primaryProject(envelope.backup).screenshots.length } };
    }
    case "update_global_settings": {
      if (!args.settings || typeof args.settings !== "object" || Array.isArray(args.settings)) {
        throw new ProjectError("invalid_request", "settings object is required.");
      }
      const settings = { ...(args.settings as Record<string, unknown>) };
      resolveGradients(settings);
      await applyBackgroundImageArgs(disk, settings);
      const applyTo = args.apply_to === "defaults" ? "defaults" : "all";
      const envelope = await editProject(disk, String(args.project_id || ""), (draft) => {
        updateGlobalSettings(draft, settings, applyTo);
        if (typeof settings.name === "string") setProjectName(draft, settings.name);
      });
      return { data: { project_id: envelope.id, summary: backupSummary(envelope.backup) } };
    }
    case "update_screenshot_settings": {
      if (!args.settings || typeof args.settings !== "object" || Array.isArray(args.settings)) {
        throw new ProjectError("invalid_request", "settings object is required.");
      }
      const settings = { ...(args.settings as Record<string, unknown>) };
      resolveGradients(settings);
      await applyBackgroundImageArgs(disk, settings);
      const index = Number(args.index);
      const envelope = await editProject(disk, String(args.project_id || ""), (draft) => {
        updateScreenshotSettings(draft, index, settings);
      });
      return { data: { project_id: envelope.id, index, summary: backupSummary(envelope.backup) } };
    }
    case "set_panoramic_background": {
      let src: string | undefined;
      if ((typeof args.image_base64 === "string" && args.image_base64.trim()) || (typeof args.image_url === "string" && args.image_url.trim())) {
        const image = await loadImageBytes(args);
        assertPanoramaBytes(image.bytes.byteLength);
        src = await disk.storeAsset(image.bytes, image.mime);
      }
      let pano: Record<string, unknown> = {};
      const envelope = await editProject(disk, String(args.project_id || ""), (draft) => {
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
      const envelope = await editProject(disk, String(args.project_id || ""), (draft) => {
        size = setOutputSize(draft, {
          device: typeof args.device === "string" ? args.device : undefined,
          width: typeof args.width === "number" ? args.width : undefined,
          height: typeof args.height === "number" ? args.height : undefined,
        });
      });
      return { data: { project_id: envelope.id, ...size } };
    }
    case "render_preview": {
      const envelope = await requireProject(disk, String(args.project_id || ""));
      const index = Number(args.index);
      const project = primaryProject(envelope.backup);
      if (!Number.isInteger(index) || index < 0 || index >= project.screenshots.length) {
        throw new ProjectError("invalid_index", `Screenshot index ${index} is out of range.`);
      }
      const shots = await renderProject(disk, origin, envelope, [index]);
      const shot = shots[0];
      const filename = `screenshot-${index + 1}.png`;
      const data: Record<string, unknown> = {
        project_id: envelope.id,
        index,
        url: publicFileUrl(origin, envelope.id, filename),
        path: relativePath(disk.renderOutputPath(envelope.id, filename)),
        width: shot.width,
        height: shot.height,
        bytes: shot.bytes,
        sha256: shot.sha256,
      };
      if (args.inline === true) {
        data.inline_omitted = "The PNG is on disk. This server does not copy image bytes into the tool result. Use url or path.";
      }
      return { data };
    }
    case "export_project": {
      const envelope = await requireProject(disk, String(args.project_id || ""));
      const project = primaryProject(envelope.backup);
      if (project.screenshots.length === 0) throw new ProjectError("empty_project", "Project has no screenshots to export.");
      const indexes = project.screenshots.map((_, i) => i);
      const shots = await renderProject(disk, origin, envelope, indexes);
      const pngs = shots.map((shot) => {
        const filename = `screenshot-${shot.index + 1}.png`;
        return {
          index: shot.index,
          url: publicFileUrl(origin, envelope.id, filename),
          path: relativePath(disk.renderOutputPath(envelope.id, filename)),
          width: shot.width,
          height: shot.height,
          bytes: shot.bytes,
          sha256: shot.sha256,
        };
      });
      const files = [];
      for (const shot of shots) {
        const filename = `screenshot-${shot.index + 1}.png`;
        const bytes = new Uint8Array(await readFile(disk.renderOutputPath(envelope.id, filename)));
        files.push({ name: filename, data: bytes });
      }
      const zip = zipStore(files);
      await disk.writeRenderFile(envelope.id, "screenshots.zip", zip);
      return {
        data: {
          project_id: envelope.id,
          output: outputSizeOf(project),
          pngs,
          zip_url: publicFileUrl(origin, envelope.id, "screenshots.zip"),
          zip_path: relativePath(disk.renderOutputPath(envelope.id, "screenshots.zip")),
        },
      };
    }
    case "get_schema":
      return {
        data: {
          backup: backupSchema(),
          tools: LOCAL_TOOLS.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
        },
      };
    case "describe_options":
      return { data: describeOptions() };
    case "import_remote_project":
      return { data: await importRemote(disk, origin, args) };
    default:
      throw new ProjectError("unknown_tool", `Unknown tool "${name}".`);
  }
}

function relativePath(file: string): string {
  const cwd = process.cwd();
  return file.startsWith(`${cwd}/`) ? file.slice(cwd.length + 1) : file;
}

async function importRemote(disk: Disk, origin: string, args: Record<string, unknown>): Promise<unknown> {
  const file = typeof args.file === "string" ? args.file : "";
  const assetsDir = typeof args.assets_dir === "string" ? args.assets_dir : undefined;
  const editKey = typeof args.edit_key === "string" ? args.edit_key : undefined;
  const base = typeof args.base_url === "string" && args.base_url.trim() ? args.base_url.trim() : DEFAULT_REMOTE;
  let backup: unknown;
  let id = typeof args.project_id === "string" ? args.project_id : undefined;
  if (file) {
    const { readFile } = await import("node:fs/promises");
    backup = JSON.parse(await readFile(file, "utf8"));
  } else {
    if (!id) throw new ProjectError("invalid_request", "project_id or file is required.");
    const bearer = process.env.APPSCREEN_MCP_TOKEN || "";
    backup = await fetchRemoteBackup(id, base, { editKey, bearer: bearer || undefined });
  }
  const installed = await installBackup(disk, backup, {
    assetsDir,
    remoteBase: base,
    editKey,
    id,
  });
  return {
    project_id: installed.envelope.id,
    name: installed.envelope.name,
    edit_key: installed.envelope.editKey,
    edit_url: editUrl(origin, installed.envelope.id, installed.envelope.editKey),
    screenshot_count: installed.envelope.screenshotCount,
    assets: installed.assets,
  };
}

export function toolErrorMessage(error: unknown): string {
  if (error instanceof ProjectError) return error.message;
  return error instanceof Error ? error.message : "Tool failed.";
}
