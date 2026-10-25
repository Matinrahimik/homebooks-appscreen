import { deleteBlob, getBytes, getText, putBytes, putText } from "./kvblob.ts";
import { assertBackup, type BackupDump, primaryProject, projectName } from "./project.ts";
import type { KvLike } from "./types.ts";

export interface ProjectEnvelope {
  id: string;
  name: string;
  editKey: string;
  createdAt: string;
  updatedAt: string;
  screenshotCount: number;
  fileTokens: string[];
}

export interface ProjectIndexEntry {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  screenshotCount: number;
}

const INDEX_KEY = "idx:projects";

function projectKey(id: string): string {
  return `proj:${id}`;
}
function fileKey(token: string): string {
  return `file:${token}`;
}

async function readIndex(kv: KvLike): Promise<ProjectIndexEntry[]> {
  const raw = await kv.get(INDEX_KEY, { type: "text" });
  if (typeof raw !== "string" || !raw) return [];
  const parsed = JSON.parse(raw) as ProjectIndexEntry[];
  return Array.isArray(parsed) ? parsed : [];
}

async function writeIndex(kv: KvLike, entries: ProjectIndexEntry[]): Promise<void> {
  await kv.put(INDEX_KEY, JSON.stringify(entries));
}

export async function listProjectIndex(kv: KvLike): Promise<ProjectIndexEntry[]> {
  return readIndex(kv);
}

export async function getEnvelope(kv: KvLike, id: string): Promise<ProjectEnvelope | null> {
  const raw = await kv.get(`${projectKey(id)}:envelope`, { type: "text" });
  if (typeof raw !== "string" || !raw) return null;
  return JSON.parse(raw) as ProjectEnvelope;
}

export async function getBackup(kv: KvLike, id: string): Promise<BackupDump | null> {
  const text = await getText(kv, `${projectKey(id)}:backup`);
  if (!text) return null;
  return assertBackup(JSON.parse(text));
}

export async function saveProject(
  kv: KvLike,
  envelope: ProjectEnvelope,
  backup: BackupDump,
): Promise<void> {
  const project = primaryProject(backup);
  envelope.name = projectName(backup, envelope.id) || envelope.name;
  envelope.screenshotCount = project.screenshots.length;
  envelope.updatedAt = envelope.updatedAt || new Date().toISOString();
  const body = JSON.stringify(backup);
  await putText(kv, `${projectKey(envelope.id)}:backup`, body);
  await kv.put(`${projectKey(envelope.id)}:envelope`, JSON.stringify(envelope));
  const index = await readIndex(kv);
  const entry: ProjectIndexEntry = {
    id: envelope.id,
    name: envelope.name,
    createdAt: envelope.createdAt,
    updatedAt: envelope.updatedAt,
    screenshotCount: envelope.screenshotCount,
  };
  const existing = index.findIndex((item) => item.id === envelope.id);
  if (existing === -1) index.push(entry);
  else index[existing] = entry;
  await writeIndex(kv, index);
}

export async function deleteProjectRecord(kv: KvLike, id: string): Promise<boolean> {
  const envelope = await getEnvelope(kv, id);
  if (!envelope) return false;
  await deleteBlob(kv, `${projectKey(id)}:backup`);
  await kv.delete(`${projectKey(id)}:envelope`);
  for (const token of envelope.fileTokens || []) {
    await deleteBlob(kv, fileKey(token));
  }
  const index = await readIndex(kv);
  await writeIndex(
    kv,
    index.filter((item) => item.id !== id),
  );
  return true;
}

export async function rememberFile(kv: KvLike, id: string, token: string): Promise<void> {
  const envelope = await getEnvelope(kv, id);
  if (!envelope) return;
  envelope.fileTokens = [...new Set([...(envelope.fileTokens || []), token])];
  await kv.put(`${projectKey(id)}:envelope`, JSON.stringify(envelope));
}

export async function putPublicFile(
  kv: KvLike,
  token: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<void> {
  await putBytes(kv, fileKey(token), bytes, contentType);
}

export async function getPublicFile(
  kv: KvLike,
  token: string,
): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  return getBytes(kv, fileKey(token));
}
