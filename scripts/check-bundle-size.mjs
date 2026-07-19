import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import vm from "node:vm";

const budgetBytes = 450_000;
const bundleUrl = new URL("../dist/content.js", import.meta.url);
const { size } = await stat(bundleUrl);
const bundle = await readFile(bundleUrl, "utf8");

new vm.Script(bundle, { filename: "dist/content.js" });
assert.doesNotMatch(bundle, /^\s*import(?:\s|\{|\*)/m, "dist/content.js must not contain top-level imports");

const loader = await readFile(new URL("../src/content-loader.js", import.meta.url), "utf8");
const background = await readFile(new URL("../src/background.js", import.meta.url), "utf8");
const bundlePath = loader.match(/QUICK_NOTE_BUNDLE\s*=\s*["']([^"']+)["']/)?.[1];
assert.equal(bundlePath, "dist/content.js", "content runtime bundle path changed unexpectedly");
const injectedFiles = [...`${loader}\n${background}`.matchAll(/files:\s*\[\s*([^\],\s]+)/g)]
  .map((match) => match[1]);
assert.deepEqual(injectedFiles, ["QUICK_NOTE_BUNDLE"], "runtime injection must use only dist/content.js");

if (size > budgetBytes) {
  throw new Error(`dist/content.js is ${size.toLocaleString()} bytes; the production budget is ${budgetBytes.toLocaleString()} bytes.`);
}

console.log(`Bundle size: ${size.toLocaleString()} / ${budgetBytes.toLocaleString()} bytes`);
