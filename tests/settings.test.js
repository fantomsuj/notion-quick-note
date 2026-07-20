import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { DEFAULT_SETTINGS } from "../src/settings.js";

test("AI actions default on but retain master and per-feature controls", async () => {
  assert.equal(DEFAULT_SETTINGS.aiEnabled, true);
  assert.equal(DEFAULT_SETTINGS.aiSuggestTitle, true);
  assert.equal(DEFAULT_SETTINGS.aiExtractTodos, true);

  const html = await readFile(new URL("../options/options.html", import.meta.url), "utf8");
  const script = await readFile(new URL("../options/options.js", import.meta.url), "utf8");
  for (const id of ["ai-enabled", "ai-suggest-title", "ai-extract-todos"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  for (const key of ["aiEnabled", "aiSuggestTitle", "aiExtractTodos"]) assert.match(script, new RegExp(key));
  assert.match(script, /chrome\.storage\.local\.set\(\{ aiEnabled:/);
  assert.match(script, /chrome\.storage\.local\.set\(\{ \[key\]:/);
});
