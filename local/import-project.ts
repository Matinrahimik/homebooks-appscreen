import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { collectAssetHashes, foldAssetUrls } from "../worker/src/assets.ts";
import {
  assertBackup,
  primaryProject,
  ProjectError,
  projectName,
  setProjectName,
  type BackupDump,
} from "../worker/src/project.ts";
import { Disk, randomToken, sha256Hex, type Envelope } from "./disk.ts";

export const DEFAULT_REMOTE = "https://homebooks-appscreen-mcp.matinrahimi.workers.dev";

const HASH_IN_TEXT = /(?:asset:|(?:https?:\/\/[^/\s]+)?\/assets\/)([a-f0-9]{64})/gi;

export function collectReferencedHashes(value: unknown, out = new Set<string>()): Set<string> {
  collectAssetHashes(value, out);
  if (typeof value === "string") {
    for (const match of value.matchAll(HASH_IN_TEXT)) out.add(match[1].toLowerCase());
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectReferencedHashes(item, out);
    return out;
  }
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) collectReferencedHashes(child, out);
  }
  return out;
}

async function filesInDir(dir: string): Promise<string[]> {
  const found: string[] = [];
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return found;
    throw error;
  }
  for (const name of names) {
    const full = path.join(dir, name);
    found.push(full);
  }
  return found;
}

async function assetFromFolder(dir: string | undefined, hash: string): Promise<{ bytes: Uint8Array; mime: string } | null> {
  if (!dir) return null;
  const candidates = [
    path.join(dir, hash),
    path.join(dir, `${hash}.png`),
    path.join(dir, `${hash}.jpg`),
    path.join(dir, `${hash}.jpeg`),
    path.join(dir, `${hash}.webp`),
  ];
  for (const file of candidates) {
    try {
      const bytes = new Uint8Array(await readFile(file));
      if (sha256Hex(bytes) !== hash) {
        throw new ProjectError("asset_mismatch", `File ${file} is named ${hash} but its sha256 does not match. It was not stored.`);
      }
      return { bytes, mime: mimeFor(file, bytes) };
    } catch (error) {
      if (error instanceof ProjectError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  for (const file of await filesInDir(dir)) {
    try {
      const bytes = new Uint8Array(await readFile(file));
      if (sha256Hex(bytes) === hash) return { bytes, mime: mimeFor(file, bytes) };
    } catch {
      /* skip unreadable entries */
    }
  }
  return null;
}

function mimeFor(file: string, bytes: Uint8Array): string {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  return "image/png";
}

export interface RemoteAuth {
  editKey?: string;
  bearer?: string;
}

export async function fetchRemoteBackup(projectId: string, base: string, auth: RemoteAuth): Promise<BackupDump> {
  const origin = base.replace(/\/$/, "");
  const url = `${origin}/api/projects/${encodeURIComponent(projectId)}`;
  const headers = new Headers({ Accept: "application/json" });
  if (auth.editKey) headers.set("X-Edit-Key", auth.editKey);
  if (auth.bearer) headers.set("Authorization", `Bearer ${auth.bearer}`);
  if (!auth.editKey && !auth.bearer) {
    throw new ProjectError(
      "unauthorized",
      "Import needs APPSCREEN_MCP_TOKEN or the project edit key. The remote project GET is not public.",
    );
  }
  const response = await fetch(url, { headers, redirect: "follow" });
  if (response.status === 401) {
    throw new ProjectError("unauthorized", `Remote project GET ${url} returned 401. Check the edit key or APPSCREEN_MCP_TOKEN.`);
  }
  if (!response.ok) {
    throw new ProjectError("import_failed", `Remote project GET ${url} returned HTTP ${response.status}.`);
  }
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    throw new ProjectError("invalid_backup", "Remote project response was not JSON.");
  }
  return assertBackup(parsed);
}

/**
 * Copy a backup onto disk. Asset bytes come from `assetsDir` and, for anything
 * still missing, a read-only GET of `/assets/<sha256>` on `remoteBase`.
 * Typography and layout fields are stored as they arrived.
 */
export async function installBackup(
  disk: Disk,
  backupInput: unknown,
  options: {
    assetsDir?: string;
    remoteBase?: string;
    editKey?: string;
    id?: string;
  } = {},
): Promise<{ envelope: Envelope; assets: string[] }> {
  const backup = assertBackup(structuredClone(backupInput));
  const hashes = [...collectReferencedHashes(backup)];
  const remote = (options.remoteBase || DEFAULT_REMOTE).replace(/\/$/, "");
  for (const hash of hashes) {
    if (await disk.hasAsset(hash)) {
      const existing = await disk.readAsset(hash);
      if (!existing || sha256Hex(existing.bytes) !== hash) {
        throw new ProjectError("asset_mismatch", `Stored asset ${hash} does not match its sha256.`);
      }
      continue;
    }
    const local = await assetFromFolder(options.assetsDir, hash);
    let bytes = local?.bytes;
    let mime = local?.mime || "application/octet-stream";
    if (!bytes) {
      const response = await fetch(`${remote}/assets/${hash}`, { redirect: "follow" });
      if (!response.ok) {
        throw new ProjectError(
          "missing_asset",
          `Asset ${hash} was not in the assets folder and GET ${remote}/assets/${hash} returned HTTP ${response.status}.`,
        );
      }
      bytes = new Uint8Array(await response.arrayBuffer());
      mime = (response.headers.get("content-type") || mime).split(";")[0].trim();
    }
    const actual = sha256Hex(bytes);
    if (actual !== hash) {
      throw new ProjectError("asset_mismatch", `Asset ${hash} downloaded as sha256 ${actual}. It was not stored.`);
    }
    await disk.storeAsset(bytes, mime);
  }
  foldAssetUrls(backup);
  const project = primaryProject(backup);
  const id = options.id || project.id;
  if (!id || typeof id !== "string") throw new ProjectError("invalid_backup", "Backup is missing a project id.");
  project.id = id;
  const current = backup.meta.find((item) => item.key === "currentProject");
  if (current) current.value = id;
  else backup.meta.push({ key: "currentProject", value: id });
  const name = projectName(backup) || "HomeBooks";
  setProjectName(backup, name);
  const now = new Date().toISOString();
  const previous = await disk.get(id);
  const envelope: Envelope = {
    id,
    name,
    editKey: options.editKey || previous?.editKey || randomToken(),
    createdAt: previous?.createdAt || now,
    updatedAt: now,
    screenshotCount: project.screenshots.length,
    backup,
  };
  await disk.save(envelope);
  return { envelope, assets: hashes };
}
