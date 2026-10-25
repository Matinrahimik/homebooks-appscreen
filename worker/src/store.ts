import { externalizeValue, replaceDataUrls } from "./assets.ts";
import { memoryProjectGate, ProjectGate } from "./gate.ts";
import { deleteBlob, getBytes, getText, putBytes } from "./kvblob.ts";
import { assertBackup, clone, primaryProject, ProjectError, projectName, type BackupDump } from "./project.ts";
import type { Env, KvLike } from "./types.ts";

export interface ProjectEnvelope {
  id: string;
  name: string;
  editKey: string;
  createdAt: string;
  updatedAt: string;
  screenshotCount: number;
  fileTokens: string[];
  docVersion?: number;
}

export interface ProjectIndexEntry {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  screenshotCount: number;
  docVersion?: number;
}

interface GateResult {
  ok?: boolean;
  version?: number;
  doc?: string | null;
  retryMs?: number;
}

const INDEX_KEY = "idx:projects";

function projectKey(id: string): string {
  return `proj:${id}`;
}
function fileKey(token: string): string {
  return `file:${token}`;
}
function docKey(id: string): string {
  return `proj:${id}:doc`;
}
function legacyKey(id: string): string {
  return `proj:${id}:backup`;
}

function gateNamespace(env: Env): { idFromName(name: string): unknown; get(id: unknown): { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> } } {
  if (env.PROJECT_GATE) return env.PROJECT_GATE;
  return memoryProjectGate(env.APPSCREEN_KV);
}

async function gateCall(env: Env, id: string, body: Record<string, unknown>): Promise<GateResult> {
  const ns = gateNamespace(env);
  const stub = ns.get(ns.idFromName(id));
  const response = await stub.fetch(new Request("https://project-gate.internal/", {
    method: "POST",
    body: JSON.stringify(body),
  }));
  return await response.json() as GateResult;
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

async function writeEnvelope(kv: KvLike, envelope: ProjectEnvelope, backup: BackupDump, version: number, updatedAt?: string): Promise<void> {
  const current = await getEnvelope(kv, envelope.id);
  if (current && (current.docVersion || 0) > version) return;
  envelope.docVersion = version;
  envelope.name = projectName(backup, envelope.id) || envelope.name;
  envelope.screenshotCount = primaryProject(backup).screenshots.length;
  if (updatedAt) envelope.updatedAt = updatedAt;
  await kv.put(`${projectKey(envelope.id)}:envelope`, JSON.stringify(envelope));
  const index = await readIndex(kv);
  const existing = index.find((item) => item.id === envelope.id);
  if (existing && (existing.docVersion || 0) > version) return;
  const entry: ProjectIndexEntry = {
    id: envelope.id,
    name: envelope.name,
    createdAt: envelope.createdAt,
    updatedAt: envelope.updatedAt,
    screenshotCount: envelope.screenshotCount,
    docVersion: version,
  };
  if (!existing) index.push(entry);
  else {
    const at = index.findIndex((item) => item.id === envelope.id);
    index[at] = entry;
  }
  await writeIndex(kv, index);
}

function parseDoc(doc: string): BackupDump {
  return assertBackup(JSON.parse(doc));
}

/**
 * Read the small project document. A legacy chunked backup is split into
 * content-addressed image blobs on first read, then the chunked copy is deleted.
 */
export async function readProjectDoc(env: Env, id: string): Promise<{ version: number; backup: BackupDump } | null> {
  const kv = env.APPSCREEN_KV;
  const gate = await gateCall(env, id, { op: "read" });
  if (gate.doc) return { version: gate.version, backup: parseDoc(gate.doc) };

  const mirror = await kv.get(docKey(id), { type: "text" });
  if (typeof mirror === "string" && mirror) {
    const cas = await gateCall(env, id, { op: "cas", expected: gate.version, doc: mirror });
    if (cas.ok) return { version: cas.version, backup: parseDoc(mirror) };
    if (cas.doc) return { version: cas.version, backup: parseDoc(cas.doc) };
  }

  let legacy = await getText(kv, legacyKey(id));
  if (!legacy) return null;
  let text = legacy;
  legacy = "";
  if (text.includes("data:image/")) text = await replaceDataUrls(kv, text);
  const backup = parseDoc(text);
  const doc = JSON.stringify(backup);
  text = "";
  const cas = await gateCall(env, id, { op: "cas", expected: gate.version, doc });
  if (cas.ok) {
    await kv.put(docKey(id), doc);
    await deleteBlob(kv, legacyKey(id));
    return { version: cas.version, backup };
  }
  if (cas.doc) return { version: cas.version, backup: parseDoc(cas.doc) };
  return { version: cas.version, backup };
}

export async function createProjectDoc(env: Env, id: string, backup: BackupDump): Promise<number> {
  const doc = JSON.stringify(backup);
  const current = await gateCall(env, id, { op: "read" });
  if (current.doc) throw new ProjectError("conflict", `Project ${id} already exists.`);
  const cas = await gateCall(env, id, { op: "cas", expected: current.version, doc });
  if (!cas.ok) throw new ProjectError("conflict", `Project ${id} already exists.`);
  await env.APPSCREEN_KV.put(docKey(id), doc);
  return cas.version;
}

export async function installProject(env: Env, envelope: ProjectEnvelope, backup: BackupDump): Promise<void> {
  const version = await createProjectDoc(env, envelope.id, backup);
  await writeEnvelope(env.APPSCREEN_KV, envelope, backup, version, envelope.updatedAt);
}

const RENDER_LOCK_WAIT_MS = 180_000;

/**
 * One render at a time per project. The Durable Object stores the lock, so two
 * isolates cannot both open Browser Rendering for the same project. A crashed
 * holder expires and the next caller takes the lock.
 */
export async function withRenderLock<T>(
  env: Env,
  id: string,
  fn: () => Promise<T>,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<T> {
  const token = crypto.randomUUID();
  const deadline = Date.now() + RENDER_LOCK_WAIT_MS;
  while (true) {
    const acquired = await gateCall(env, id, { op: "acquire", lock: "render", token, ttlMs: RENDER_LOCK_WAIT_MS });
    if (acquired.ok) break;
    if (Date.now() > deadline) {
      throw new ProjectError("render_busy", "Timed out waiting for another render of this project to finish. Retry render_preview or export_project.");
    }
    await wait(Math.min(Math.max(acquired.retryMs || 250, 50), 1000));
  }
  try {
    return await fn();
  } finally {
    await gateCall(env, id, { op: "release", lock: "render", token });
  }
}

/** Last-write-wins replace used by the live editor. Serialized by the project gate. */
export async function replaceProjectDoc(env: Env, id: string, backup: BackupDump, updatedAt: string): Promise<void> {
  await externalizeValue(env.APPSCREEN_KV, backup);
  const doc = JSON.stringify(backup);
  const replaced = await gateCall(env, id, { op: "replace", doc });
  await env.APPSCREEN_KV.put(docKey(id), doc);
  const envelope = await getEnvelope(env.APPSCREEN_KV, id);
  if (envelope) await writeEnvelope(env.APPSCREEN_KV, envelope, backup, replaced.version, updatedAt);
}

/**
 * Read-modify-write the small project JSON. `mutate` runs again from the latest
 * document when another writer commits first. Image bytes must already be asset refs.
 */
export async function modifyProject(
  env: Env,
  id: string,
  mutate: (draft: BackupDump) => void | Promise<void>,
  updatedAt?: string,
): Promise<BackupDump> {
  const envelope = await getEnvelope(env.APPSCREEN_KV, id);
  if (!envelope) throw new ProjectError("not_found", `Project ${id} was not found.`);
  for (let attempt = 0; attempt < 12; attempt++) {
    const current = await readProjectDoc(env, id);
    if (!current) throw new ProjectError("not_found", `Project ${id} was not found.`);
    const draft = clone(current.backup);
    await mutate(draft);
    await externalizeValue(env.APPSCREEN_KV, draft);
    const doc = JSON.stringify(draft);
    const cas = await gateCall(env, id, { op: "cas", expected: current.version, doc });
    if (!cas.ok) continue;
    await env.APPSCREEN_KV.put(docKey(id), doc);
    await writeEnvelope(env.APPSCREEN_KV, envelope, draft, cas.version, updatedAt);
    return draft;
  }
  throw new ProjectError(
    "conflict",
    "Could not save the project after concurrent edits. Retry the tool.",
  );
}

export async function deleteProjectRecord(env: Env, id: string): Promise<boolean> {
  const kv = env.APPSCREEN_KV;
  const envelope = await getEnvelope(kv, id);
  if (!envelope) return false;
  await gateCall(env, id, { op: "delete" });
  await kv.delete(docKey(id));
  await deleteBlob(kv, legacyKey(id));
  await kv.delete(`${projectKey(id)}:envelope`);
  for (const token of envelope.fileTokens || []) {
    await deleteBlob(kv, fileKey(token));
  }
  const index = await readIndex(kv);
  await writeIndex(kv, index.filter((item) => item.id !== id));
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

export { ProjectGate };
