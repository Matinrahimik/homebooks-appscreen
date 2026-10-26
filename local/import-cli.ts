import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Disk } from "./disk.ts";
import { DEFAULT_REMOTE, fetchRemoteBackup, installBackup } from "./import-project.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

async function main(): Promise<void> {
  const project = arg("--project");
  const file = arg("--file");
  const key = arg("--key") || arg("--edit-key");
  const base = arg("--base") || DEFAULT_REMOTE;
  const assets = arg("--assets");
  const dataDir = arg("--data") || process.env.APPSCREEN_DATA || path.join(ROOT, "data");
  if (!project && !file) {
    console.error("Usage: npm run import -- --project <id> [--key <editKey>] [--base <origin>]");
    console.error("       npm run import -- --file backup.json [--assets <dir>] [--project <id>]");
    process.exit(1);
  }
  const disk = new Disk(dataDir);
  await disk.ensure();
  let backup: unknown;
  if (file) {
    backup = JSON.parse(await readFile(path.resolve(file), "utf8"));
  } else {
    const bearer = process.env.APPSCREEN_MCP_TOKEN || "";
    backup = await fetchRemoteBackup(project!, base, { editKey: key, bearer: bearer || undefined });
  }
  const installed = await installBackup(disk, backup, {
    assetsDir: assets ? path.resolve(assets) : undefined,
    remoteBase: base,
    editKey: key,
    id: project,
  });
  console.log(JSON.stringify({
    project_id: installed.envelope.id,
    name: installed.envelope.name,
    edit_key: installed.envelope.editKey,
    screenshot_count: installed.envelope.screenshotCount,
    assets: installed.assets,
    data: dataDir,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
