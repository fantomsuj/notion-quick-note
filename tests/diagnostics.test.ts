import assert from "node:assert/strict";
import test from "node:test";
import { serializeDiagnostic } from "../src/diagnostics.js";

test("diagnostics serialize readable errors and retain only safe context", () => {
  const error = Object.assign(new Error("Draft unavailable"), { code: "missing_draft", stack: "Error: Draft unavailable\n  at test" });
  const diagnostic = JSON.parse(serializeDiagnostic("composer.draft.failed", {
    tabId: 12,
    url: "https://private.example",
    title: "Private page",
    pageTitle: "Private page title",
    selection: "Private selection",
    body: "Private note",
    noteContent: "Private note content"
  }, error));

  assert.deepEqual(diagnostic, {
    event: "composer.draft.failed",
    tabId: 12,
    error: {
      name: "Error",
      message: "Draft unavailable",
      code: "missing_draft",
      stack: "Error: Draft unavailable\n  at test"
    }
  });
});
