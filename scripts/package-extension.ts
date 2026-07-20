import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm, chmod, utimes, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildExtension, type PublicProductConfig } from "./build.js";
import { RELEASE_FILES, STATIC_RELEASE_FILES } from "./release-files.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = path.resolve(process.env.NQN_RELEASE_ROOT || path.join(projectRoot, "release"));
const stageRoot = path.join(outputRoot, "chrome-extension");
assertSafeOutputRoot(outputRoot);

const configuration = await loadConfiguration();
const broker = validateConfiguration(configuration);
const manifest = JSON.parse(await readFile(path.join(projectRoot, "manifest.json"), "utf8"));
manifest.optional_host_permissions = [`${broker.origin}/*`];

await rm(stageRoot, { recursive: true, force: true });
await mkdir(stageRoot, { recursive: true });
for (const file of STATIC_RELEASE_FILES) {
  const source = path.join(projectRoot, file);
  const destination = path.join(stageRoot, file);
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination);
}

await writeFile(path.join(stageRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
await buildExtension({
  outdir: path.join(stageRoot, "dist"),
  productConfig: {
  notionClientId: configuration.notionClientId,
  oauthBrokerUrl: configuration.oauthBrokerUrl.replace(/\/$/, "")
  }
});

const audit = spawnSync(process.execPath, ["--import", "tsx", path.join(projectRoot, "scripts/check-release.ts"), "--package", stageRoot], {
  cwd: projectRoot,
  encoding: "utf8"
});
if (audit.stdout) process.stdout.write(audit.stdout);
if (audit.stderr) process.stderr.write(audit.stderr);
if (audit.status !== 0) throw new Error("Packaged extension audit failed.");

const stableTimestamp = new Date("1980-01-01T00:00:00.000Z");
for (const file of RELEASE_FILES) {
  const target = path.join(stageRoot, file);
  await chmod(target, 0o644);
  await utimes(target, stableTimestamp, stableTimestamp);
}

const zipName = `notion-quick-note-${manifest.version}.zip`;
const zipPath = path.join(outputRoot, zipName);
await rm(zipPath, { force: true });
const zipped = spawnSync("zip", ["-X", "-q", "-9", zipPath, ...[...RELEASE_FILES].sort()], {
  cwd: stageRoot,
  env: { ...process.env, TZ: "UTC" },
  encoding: "utf8"
});
if (zipped.status !== 0) throw new Error(zipped.stderr || "Could not create the extension ZIP archive.");

const digest = createHash("sha256").update(await readFile(zipPath)).digest("hex");
await writeFile(`${zipPath}.sha256`, `${digest}  ${zipName}\n`);
console.log(`Created ${zipPath}`);
console.log(`SHA-256 ${digest}`);

async function loadConfiguration(): Promise<PublicProductConfig> {
  if (process.env.NQN_NOTION_CLIENT_ID || process.env.NQN_OAUTH_BROKER_URL) {
    return {
      notionClientId: process.env.NQN_NOTION_CLIENT_ID || "",
      oauthBrokerUrl: process.env.NQN_OAUTH_BROKER_URL || ""
    };
  }
  try {
    return JSON.parse(await readFile(path.join(projectRoot, "release.config.json"), "utf8"));
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new Error("Create release.config.json from release.config.json.example, or set NQN_NOTION_CLIENT_ID and NQN_OAUTH_BROKER_URL.");
    }
    throw error;
  }
}

function validateConfiguration(value: PublicProductConfig): URL {
  if (typeof value.notionClientId !== "string" || !value.notionClientId.trim()) {
    throw new Error("Release configuration requires the public Notion client ID.");
  }
  if (/replace|example|your_/i.test(value.notionClientId)) throw new Error("Replace the example Notion client ID before packaging.");
  const broker = new URL(value.oauthBrokerUrl || "");
  if (broker.protocol !== "https:") throw new Error("The production OAuth broker must use HTTPS.");
  if (broker.username || broker.password || broker.search || broker.hash) {
    throw new Error("The OAuth broker URL must not contain credentials, query parameters, or a fragment.");
  }
  return broker;
}

function assertSafeOutputRoot(target: string): void {
  const parsedRoot = path.parse(target).root;
  if ([parsedRoot, homedir(), projectRoot].includes(target)) {
    throw new Error(`Refusing to use unsafe release output directory: ${target}`);
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}
