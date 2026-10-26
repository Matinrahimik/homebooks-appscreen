import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { primaryProject, projectName, type BackupDump } from "../worker/src/project.ts";

export interface Envelope {
  id: string;
  name: string;
  editKey: string;
  createdAt: string;
  updatedAt: string;
  screenshotCount: number;
  backup: BackupDump;
}

export interface RenderTokenRecord {
  projectId: string;
  index: number;
  filename: string;
  uploaded: boolean;
  bytes?: number;
  width?: number;
  height?: number;
  sha256?: string;
  crc?: number;
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const HASH_RE = /^[a-f0-9]{64}$/;

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function randomToken(): string {
  return randomBytes(32).toString("hex");
}

export function assertId(id: string): string {
  if (!ID_RE.test(id)) {
    throw new Error(`Invalid project id "${id}".`);
  }
  return id;
}

function mimeFromBytes(bytes: Uint8Array): string {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) return "image/webp";
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif";
  return "application/octet-stream";
}

export class Disk {
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  projectsDir(): string {
    return path.join(this.root, "projects");
  }

  assetsDir(): string {
    return path.join(this.root, "assets");
  }

  rendersDir(projectId?: string): string {
    const base = path.join(this.root, "renders");
    return projectId ? path.join(base, assertId(projectId)) : base;
  }

  async ensure(): Promise<void> {
    await mkdir(this.projectsDir(), { recursive: true });
    await mkdir(this.assetsDir(), { recursive: true });
    await mkdir(path.join(this.root, "render-tokens"), { recursive: true });
    await mkdir(this.rendersDir(), { recursive: true });
  }

  private projectPath(id: string): string {
    return path.join(this.projectsDir(), `${assertId(id)}.json`);
  }

  async list(): Promise<Envelope[]> {
    await this.ensure();
    const names = await readdir(this.projectsDir());
    const out: Envelope[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const envelope = await this.readEnvelopeFile(path.join(this.projectsDir(), name));
      if (envelope) out.push(envelope);
    }
    out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return out;
  }

  async get(id: string): Promise<Envelope | null> {
    return this.readEnvelopeFile(this.projectPath(id));
  }

  async save(envelope: Envelope): Promise<void> {
    await this.ensure();
    const project = primaryProject(envelope.backup);
    envelope.screenshotCount = project.screenshots.length;
    envelope.name = projectName(envelope.backup) || envelope.name;
    envelope.updatedAt = envelope.updatedAt || new Date().toISOString();
    const file = this.projectPath(envelope.id);
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(envelope));
    await rename(tmp, file);
  }

  async remove(id: string): Promise<boolean> {
    const file = this.projectPath(id);
    try {
      await rm(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    await rm(this.rendersDir(id), { recursive: true, force: true });
    return true;
  }

  assetPath(hash: string): string {
    if (!HASH_RE.test(hash)) throw new Error(`Invalid asset hash "${hash}".`);
    return path.join(this.assetsDir(), hash);
  }

  async hasAsset(hash: string): Promise<boolean> {
    try {
      const info = await stat(this.assetPath(hash));
      return info.isFile() && info.size > 0;
    } catch {
      return false;
    }
  }

  /** Store bytes once, keyed by SHA-256. Returns `asset:<hash>`. No size cap. */
  async storeAsset(bytes: Uint8Array, mime: string): Promise<string> {
    await this.ensure();
    const hash = sha256Hex(bytes);
    const file = this.assetPath(hash);
    if (!(await this.hasAsset(hash))) {
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, bytes);
      await rename(tmp, file);
    }
    const safe = /^image\/[a-zA-Z0-9.+-]+$/.test(mime) ? mime : mimeFromBytes(bytes);
    await writeFile(`${file}.mime`, safe);
    return `asset:${hash}`;
  }

  async readAsset(hash: string): Promise<{ bytes: Uint8Array; mime: string } | null> {
    if (!(await this.hasAsset(hash))) return null;
    const file = this.assetPath(hash);
    const bytes = new Uint8Array(await readFile(file));
    let mime = mimeFromBytes(bytes);
    try {
      const side = (await readFile(`${file}.mime`, "utf8")).trim();
      if (/^image\/[a-zA-Z0-9.+-]+$/.test(side)) mime = side;
    } catch {
      /* magic bytes are enough */
    }
    return { bytes, mime };
  }

  private tokenPath(token: string): string {
    if (!HASH_RE.test(token)) throw new Error("Invalid render token.");
    return path.join(this.root, "render-tokens", `${token}.json`);
  }

  async writeRenderToken(token: string, record: RenderTokenRecord): Promise<void> {
    await this.ensure();
    await writeFile(this.tokenPath(token), JSON.stringify(record));
  }

  async readRenderToken(token: string): Promise<RenderTokenRecord | null> {
    try {
      const raw = await readFile(this.tokenPath(token), "utf8");
      return JSON.parse(raw) as RenderTokenRecord;
    } catch {
      return null;
    }
  }

  renderOutputPath(projectId: string, filename: string): string {
    const safe = filename.replace(/[^A-Za-z0-9._-]/g, "");
    if (!safe || safe !== filename) throw new Error("Invalid render filename.");
    return path.join(this.rendersDir(projectId), safe);
  }

  async writeRenderFile(projectId: string, filename: string, bytes: Uint8Array): Promise<string> {
    await mkdir(this.rendersDir(projectId), { recursive: true });
    const file = this.renderOutputPath(projectId, filename);
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, bytes);
    await rename(tmp, file);
    return file;
  }

  private async readEnvelopeFile(file: string): Promise<Envelope | null> {
    try {
      const raw = await readFile(file, "utf8");
      const parsed = JSON.parse(raw) as Envelope;
      if (!parsed || typeof parsed.id !== "string" || !parsed.backup) return null;
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
}
