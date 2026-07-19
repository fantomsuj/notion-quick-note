import test from "node:test";
import assert from "node:assert/strict";
import { buildCaptureRequest, normalizeNotionId, sendCapture } from "../src/notion.js";

test("extracts compact IDs from Notion URLs", () => {
  assert.equal(
    normalizeNotionId("https://www.notion.so/My-Inbox-1234567890abcdef1234567890abcdef?pvs=4"),
    "1234567890abcdef1234567890abcdef"
  );
});

test("builds an append request for a running notes page", () => {
  const request = buildCaptureRequest(
    { destinationType: "page", destinationId: "1234567890abcdef1234567890abcdef" },
    { text: "Remember the quiet details", pageTitle: "An essay", url: "https://example.com", includeSource: true },
    new Date("2026-07-18T12:00:00Z")
  );

  assert.equal(request.method, "PATCH");
  assert.match(request.path, /\/v1\/blocks\/1234567890abcdef1234567890abcdef\/children/);
  assert.equal(request.body.children[0].type, "heading_3");
  assert.equal(request.body.children.at(-1).type, "divider");
});

test("builds a data source page with the configured title property", () => {
  const request = buildCaptureRequest(
    { destinationType: "database", destinationId: "abc", titleProperty: "Note" },
    { text: "A useful thought\nwith details", selection: "Quoted idea", includeSource: false }
  );

  assert.equal(request.path, "/v1/pages");
  assert.equal(request.body.parent.type, "data_source_id");
  assert.equal(request.body.properties.Note.title[0].text.content, "A useful thought");
  assert.equal(request.body.children[0].type, "quote");
});

test("resolves a database URL to its first data source before saving", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.includes("/data_sources/")) return response(404, { message: "not a data source" });
    if (url.includes("/databases/")) return response(200, { data_sources: [{ id: "resolved-source" }] });
    return response(200, { id: "created" });
  };

  await sendCapture({
    token: "secret",
    settings: { destinationType: "database", destinationId: "database-id", titleProperty: "Name" },
    capture: { text: "Test note", includeSource: false },
    fetchImpl
  });

  const finalBody = JSON.parse(calls.at(-1).options.body);
  assert.equal(finalBody.parent.data_source_id, "resolved-source");
});

function response(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return payload; }
  };
}
