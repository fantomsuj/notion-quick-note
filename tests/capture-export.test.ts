import assert from "node:assert/strict";
import test from "node:test";
import { createRecoveryExport, documentToMarkdown } from "../src/capture-export.js";
import type { EditorNode } from "../src/contracts.js";

test("JSON recovery export is versioned, complete, and strips credential-shaped fields", () => {
  const result = createRecoveryExport({
    format: "json",
    now: new Date("2026-07-19T12:00:00.000Z"),
    drafts: [{ id: "draft", title: "Local", token: "secret", doc: paragraph("Draft body") }],
    captures: [
      { id: "queued", status: "blocked_setup", refreshToken: "secret", pendingCapture: { document: { doc: paragraph("Queued") } } },
      { id: "saved", status: "delivered", syncedCapture: { document: { doc: paragraph("Saved") } } }
    ]
  });
  const payload = JSON.parse(result.content);
  assert.equal(payload.format, "notion-quick-note-recovery");
  assert.equal(payload.version, 1);
  assert.equal(payload.drafts[0].token, undefined);
  assert.equal(payload.queued[0].refreshToken, undefined);
  assert.equal(payload.delivered[0].id, "saved");
  assert.match(result.filename, /\.json$/);
});

test("Markdown recovery export preserves supported blocks and labels opaque Notion blocks", () => {
  const doc = {
    type: "doc",
    content: [
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Heading", marks: [{ type: "bold" }] }] },
      { type: "taskList", content: [{ type: "taskItem", attrs: { checked: true }, content: [{ type: "paragraph", content: [{ type: "text", text: "Done" }] }] }] },
      { type: "codeBlock", attrs: { language: "js" }, content: [{ type: "text", text: "const x = 1;" }] },
      { type: "notionBlock", attrs: { label: "Synced database" } }
    ]
  };
  const markdown = documentToMarkdown(doc);
  assert.match(markdown, /## \*\*Heading\*\*/);
  assert.match(markdown, /- \[x\] Done/);
  assert.match(markdown, /```js\nconst x = 1;/);
  assert.match(markdown, /Unsupported Notion block: Synced database/);

  const result = createRecoveryExport({
    format: "markdown",
    profile: "incognito",
    now: new Date("2026-07-19T12:00:00.000Z"),
    drafts: [{
      id: "draft",
      title: "Readable",
      doc,
      sources: [{ title: "Source", url: "https://example.com" }]
    }],
    captures: []
  });
  assert.match(result.content, /Profile: incognito/);
  assert.match(result.content, /\[Source\]\(https:\/\/example.com\/\)/);
  assert.match(result.filename, /\.md$/);
});

function paragraph(text: string): EditorNode {
  return { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] };
}
