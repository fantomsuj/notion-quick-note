import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import vm from "node:vm";

const budgetBytes = 450_000;
const bundleUrl = new URL("../dist/content.js", import.meta.url);
const { size } = await stat(bundleUrl);
const bundle = await readFile(bundleUrl, "utf8");

new vm.Script(bundle, { filename: "dist/content.js" });
assert.doesNotMatch(bundle, /^\s*import(?:\s|\{|\*)/m, "dist/content.js must not contain top-level imports");

const background = await readFile(new URL("../src/background.ts", import.meta.url), "utf8");
const contentLoader = await readFile(new URL("../src/content-loader.ts", import.meta.url), "utf8");
const removedSurfacePattern = new RegExp(["chrome\\.side", "Panel", "|panel", "Coordinator", "|side", "panel\\/"].join(""));
assert.doesNotMatch(background, removedSurfacePattern, "the background must not retain Side Panel architecture");
assert.match(background, /content(?:Runtime)?Loader|ensureContentRuntime/, "the background must use the content runtime loader");
assert.match(background, /(?:chrome\.)?scripting\s*\.\s*executeScript/, "the background must inject the composer after a user gesture");
assert.match(contentLoader, /files:\s*\[\s*["']dist\/content\.js["']/, "the loader must inject the packaged content bundle");

if (size > budgetBytes) {
  throw new Error(`dist/content.js is ${size.toLocaleString()} bytes; the production budget is ${budgetBytes.toLocaleString()} bytes.`);
}

console.log(`Bundle size: ${size.toLocaleString()} / ${budgetBytes.toLocaleString()} bytes`);
