import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RELEASE_FILES } from "./release-files.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageArgument = process.argv.indexOf("--package");
const strictPackage = packageArgument >= 0;
const auditRoot = strictPackage
  ? path.resolve(process.argv[packageArgument + 1] || "")
  : projectRoot;

if (strictPackage && !process.argv[packageArgument + 1]) {
  throw new Error("Pass the staged extension directory after --package.");
}

const readText = (file: string) => readFile(path.join(auditRoot, file), "utf8");
const manifest = JSON.parse(await readText("manifest.json"));

assert.equal(manifest.manifest_version, 3, "Chrome Web Store builds must use Manifest V3");
assert.match(manifest.name, /\S/, "manifest name is required");
assert.ok(manifest.description.length > 0 && manifest.description.length <= 132, "manifest description must be 1-132 characters");
assert.match(manifest.version, /^(?:0|[1-9]\d{0,4})(?:\.(?:0|[1-9]\d{0,4})){0,3}$/, "manifest version must use 1-4 numeric components");
for (const component of manifest.version.split(".")) {
  assert.ok(Number(component) <= 65535, "manifest version components must be at most 65535");
}

if (!strictPackage) {
  const packageJson = JSON.parse(await readText("package.json"));
  assert.equal(packageJson.version, manifest.version, "package.json and manifest.json versions must match");
  for (const requiredDoc of ["PRIVACY.md", "docs/RELEASE.md", "docs/STORE_LISTING.md", "release.config.json.example"]) {
    await stat(path.join(auditRoot, requiredDoc));
  }
}

assert.equal(manifest.incognito, "split", "incognito captures require split mode");
assert.equal(manifest.background?.service_worker, "dist/background.js", "background worker must use the generated TypeScript bundle");
assert.equal(
  manifest.content_security_policy?.extension_pages,
  "script-src 'self'; object-src 'none'; base-uri 'none';",
  "extension pages must use the reviewed MV3 CSP"
);

const requiredPermissions = ["alarms", "contextMenus", "identity", "sidePanel", "storage", "tabs"];
assert.deepEqual([...manifest.permissions].sort(), requiredPermissions.sort(), "manifest permissions changed; update the release review intentionally");
assert.deepEqual(manifest.host_permissions, ["https://api.notion.com/*"], "only the Notion API may be a required host permission");
assert.ok(!(manifest.optional_host_permissions || []).includes("<all_urls>"), "optional host permissions must not use <all_urls>");

assert.deepEqual(manifest.web_accessible_resources, [{
  resources: ["styles/tokens.css", "styles/composer.css", "assets/fonts/*.woff2"],
  matches: ["<all_urls>"]
}], "web-accessible resources changed; expose only composer CSS and fonts");

const expectedIcons = { 16: "icons/icon-16.png", 32: "icons/icon-32.png", 48: "icons/icon-48.png", 128: "icons/icon-128.png" };
assert.deepEqual(manifest.icons, expectedIcons, "manifest must declare all required store/runtime icon sizes");
for (const [size, file] of Object.entries(expectedIcons)) {
  const png = await readFile(path.join(auditRoot, file));
  assert.equal(png.toString("ascii", 1, 4), "PNG", `${file} must be a PNG`);
  assert.equal(png.readUInt32BE(16), Number(size), `${file} has the wrong width`);
  assert.equal(png.readUInt32BE(20), Number(size), `${file} has the wrong height`);
}

for (const file of RELEASE_FILES) await stat(path.join(auditRoot, file));

const htmlFiles = RELEASE_FILES.filter((file) => file.endsWith(".html"));
for (const file of htmlFiles) {
  const html = await readText(file);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i, `${file} must not contain inline scripts`);
  assert.doesNotMatch(html, /<(?:script|link)[^>]+(?:src|href)=["']https?:/i, `${file} must not load remote code or styles`);
}

const javascriptFiles = RELEASE_FILES.filter((file) => file.endsWith(".js"));
const releaseFileSet = new Set(RELEASE_FILES);
for (const file of javascriptFiles) {
  const javascript = await readText(file);
  assert.doesNotMatch(javascript, /\beval\s*\(|\bnew\s+Function\s*\(/, `${file} must not evaluate strings as code`);
  assert.doesNotMatch(javascript, /https?:\/\/[^\s"'`]+\.(?:m?js|wasm)(?:[?#]|$)/i, `${file} must not reference remotely hosted code`);
  for (const specifier of staticModuleSpecifiers(javascript)) {
    if (!specifier.startsWith(".")) continue;
    const importedFile = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
    assert.ok(
      releaseFileSet.has(importedFile),
      `${file} imports ${specifier}, but ${importedFile} is missing from the release allowlist`
    );
  }
}

assert.ok(!manifest.permissions.includes("unlimitedStorage"), "capture retention must remain bounded without unlimitedStorage");

const productConfig = await readText("dist/product-config.js");
const optionsHtml = await readText("options/options.html");
const sidepanelHtml = await readText("sidepanel/index.html");
assert.match(optionsHtml, /src=["']\.\.\/dist\/options\.js["']/, "options must load its generated bundle");
assert.match(sidepanelHtml, /src=["']\.\.\/dist\/content\.js["']/, "side panel must load the generated content bundle");
assert.match(sidepanelHtml, /src=["']\.\.\/dist\/sidepanel\.js["']/, "side panel must load its generated module bundle");
assert.match(optionsHtml, /<details[^>]+id=["']advanced-setup["'][^>]+hidden/, "Advanced setup must be hidden until local-build configuration explicitly enables it");
const clientId = productConfig.match(/["']?notionClientId["']?\s*:\s*(["'])(.*?)\1/)?.[2] || "";
const brokerUrl = productConfig.match(/["']?oauthBrokerUrl["']?\s*:\s*(["'])(.*?)\1/)?.[2] || "";
if (strictPackage) {
  assert.ok(clientId && !/replace|example|your_/i.test(clientId), "packaged OAuth client ID is not configured");
  const broker = new URL(brokerUrl);
  assert.equal(broker.protocol, "https:", "packaged OAuth broker must use HTTPS");
  assert.ok(!broker.username && !broker.password && !broker.search && !broker.hash, "OAuth broker URL must not contain credentials, query, or fragment");
  assert.deepEqual(manifest.optional_host_permissions, [`${broker.origin}/*`], "packaged broker permission must be narrowed to its exact origin");

  const actualFiles = await walkFiles(auditRoot);
  assert.deepEqual(actualFiles, [...RELEASE_FILES].sort(), "staged package contains an unexpected or missing file");
  assert.ok(!actualFiles.some((file) => file.endsWith(".ts") || file.endsWith(".map")), "staged package must not contain TypeScript or source maps");
} else if (!clientId || !brokerUrl) {
  console.warn("Release configuration pending: production OAuth values are intentionally supplied only while packaging.");
}

console.log(`${strictPackage ? "Packaged extension" : "Release source"} audit passed (${RELEASE_FILES.length} allowlisted files).`);

async function walkFiles(root: string, relative = ""): Promise<string[]> {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const next = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...await walkFiles(root, next));
    else if (entry.isFile()) files.push(next);
  }
  return files.sort();
}

function staticModuleSpecifiers(source: string): string[] {
  const specifiers = [];
  const declarations = /\b(?:import|export)\s+(?:[^"'`;]*?\s+from\s+)?["']([^"']+)["']/g;
  const dynamicImports = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const pattern of [declarations, dynamicImports]) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier) specifiers.push(specifier);
    }
  }
  return specifiers;
}
