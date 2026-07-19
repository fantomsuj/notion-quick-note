import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCaptureRequest,
  buildQuickNotesDatabaseRequest,
  createQuickNotesDatabase,
  findManagedCaptureById,
  findManagedQuickNotesDatabase,
  loadRemoteNote,
  migrateManagedQuickNotesDatabase,
  normalizeNotionId,
  normalizeSourceDomain,
  notionBlocksFromDocument,
  notionDocumentFromBlocks,
  NotionConflictError,
  NotionApiError,
  notionRequest,
  plainTextFromCapture,
  refreshManagedDestination,
  searchDestinations,
  searchRecentPages,
  sendCapture,
  updateRemoteNote,
  validateDestinationHealth
} from "../src/notion.js";

test("maps live Notion blocks back to editable Tiptap nodes and locks unsupported blocks in place", () => {
  const mapped = notionDocumentFromBlocks([
    { id: "p", type: "paragraph", paragraph: { rich_text: [{ plain_text: "Hello\nworld", annotations: { bold: true, color: "blue" }, href: "https://example.com" }] } },
    { id: "h", type: "heading_2", heading_2: { rich_text: [{ plain_text: "Heading" }] } },
    { id: "todo", type: "to_do", to_do: { checked: true, rich_text: [{ plain_text: "Done" }] } },
    { id: "image", type: "image", image: { external: { url: "https://example.com/image.png" } } },
    { id: "quote", type: "quote", quote: { rich_text: [{ plain_text: "After image" }] } },
    { id: "sources", type: "toggle", toggle: { rich_text: [{ plain_text: "Sources" }], children: [{ id: "source", type: "bulleted_list_item", bulleted_list_item: { rich_text: [{ plain_text: "Example", href: "https://example.com" }] } }] } }
  ]);
  assert.deepEqual(mapped.doc.content.map((node) => node.type), ["paragraph", "heading", "taskList", "notionBlock", "blockquote"]);
  assert.equal(mapped.doc.content[0].content[1].type, "hardBreak");
  assert.deepEqual(mapped.doc.content[0].content[0].marks.map((mark) => mark.type), ["bold", "notionColor", "link"]);
  assert.equal(notionBlocksFromDocument(mapped.doc)[0].paragraph.rich_text[0].annotations.color, "blue");
  assert.equal(mapped.doc.content[3].attrs.remoteId, "image");
  assert.equal(mapped.sources[0].url, "https://example.com");
});

test("nested structures that cannot round-trip are represented as one locked placeholder", () => {
  const mapped = notionDocumentFromBlocks([{
    id: "callout-parent",
    type: "callout",
    has_children: true,
    callout: {
      rich_text: [{ plain_text: "Important" }],
      children: [{ id: "nested", type: "paragraph", paragraph: { rich_text: [{ plain_text: "Nested" }] } }]
    }
  }]);
  assert.equal(mapped.doc.content[0].type, "notionBlock");
  assert.equal(mapped.doc.content[0].attrs.remoteId, "callout-parent");

  const list = notionDocumentFromBlocks([{
    id: "list-parent",
    type: "bulleted_list_item",
    bulleted_list_item: {
      rich_text: [{ plain_text: "Parent" }],
      children: [{ id: "nested-image", type: "image", image: { external: { url: "https://example.com/image.png" } } }]
    }
  }]);
  assert.equal(list.doc.content[0].type, "notionBlock");
  assert.equal(list.doc.content[0].attrs.remoteId, "list-parent");
});

test("live update detects a remote fingerprint mismatch before the first mutation", async () => {
  const methods = [];
  const fetchImpl = async (url, options = {}) => {
    methods.push(options.method || "GET");
    if (url.includes("/pages/page")) return response(200, {
      id: "page",
      url: "https://notion.so/page",
      last_edited_time: "new-fingerprint",
      properties: { Name: { id: "title", type: "title", title: [{ plain_text: "Remote" }] } }
    });
    if (url.includes("/blocks/page/children")) return response(200, {
      results: [{ id: "paragraph", type: "paragraph", paragraph: { rich_text: [{ plain_text: "Remote body" }] } }],
      has_more: false
    });
    throw new Error(`Unexpected ${url}`);
  };
  await assert.rejects(
    updateRemoteNote({
      token: "token",
      record: { remote: { kind: "page", id: "page", pageId: "page", fingerprint: "old-fingerprint" } },
      capture: { document: { title: "Local", doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Local body" }] }] } } },
      baseFingerprint: "old-fingerprint",
      fetchImpl
    }),
    (error) => error instanceof NotionConflictError && error.code === "remote_conflict"
  );
  assert.deepEqual(methods, ["GET", "GET"]);
});

test("an interrupted update journal resumes without duplicating or archiving inserted replacements", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, method: options.method || "GET" });
    if (url.includes("/blocks/page/children")) return response(200, {
      results: [
        { id: "inserted", type: "paragraph", paragraph: { rich_text: [{ plain_text: "Replacement" }] } },
        { id: "old", type: "paragraph", paragraph: { rich_text: [{ plain_text: "Old" }] } }
      ],
      has_more: false
    });
    if (url.includes("/blocks/old") && options.method === "DELETE") return response(200, { id: "old", in_trash: true });
    if (url.includes("/pages/page")) return response(200, {
      id: "page",
      url: "https://notion.so/page",
      last_edited_time: "fingerprint",
      properties: { Name: { id: "title", type: "title", title: [{ plain_text: "Note" }] } }
    });
    throw new Error(`Unexpected ${options.method || "GET"} ${url}`);
  };
  await updateRemoteNote({
    token: "token",
    record: { remote: { kind: "page", id: "page", pageId: "page" } },
    capture: { document: { title: "Note", doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Replacement" }] }] } } },
    journal: { phase: "inserting", insertedSegments: { 0: ["inserted"] }, archivedIds: [] },
    fetchImpl
  });
  assert.equal(calls.filter((call) => call.url.includes("/children") && call.method === "PATCH").length, 0);
  assert.ok(calls.some((call) => call.url.includes("/blocks/old") && call.method === "DELETE"));
  assert.ok(!calls.some((call) => call.url.includes("/blocks/inserted") && call.method === "DELETE"));
});

test("older running-page captures without tracked block IDs stay open-only", async () => {
  await assert.rejects(
    loadRemoteNote({ token: "token", record: { remote: { kind: "legacy_section", id: "page" } }, fetchImpl: async () => response(500, {}) }),
    (error) => error instanceof NotionApiError && error.code === "remote_edit_unavailable"
  );
});

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

test("maps Tiptap blocks, nesting, to-dos, toggles, code, and dividers to native Notion blocks", () => {
  const blocks = notionBlocksFromDocument({
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "Body" }] },
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Section" }] },
      {
        type: "bulletList",
        content: [{
          type: "listItem",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "Parent" }] },
            { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Child" }] }] }] }
          ]
        }]
      },
      {
        type: "orderedList",
        attrs: { start: 3, type: "a" },
        content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Third" }] }] }]
      },
      {
        type: "taskList",
        content: [{ type: "taskItem", attrs: { checked: true }, content: [{ type: "paragraph", content: [{ type: "text", text: "Done" }] }] }]
      },
      { type: "blockquote", content: [{ type: "paragraph", content: [{ type: "text", text: "Quoted" }] }] },
      { type: "toggleBlock", attrs: { open: false }, content: [{ type: "text", text: "Details" }] },
      { type: "codeBlock", attrs: { language: "javascript" }, content: [{ type: "text", text: "const answer = 42;" }] },
      { type: "horizontalRule" }
    ]
  });

  assert.deepEqual(blocks.map((block) => block.type), [
    "paragraph", "heading_2", "bulleted_list_item", "numbered_list_item", "to_do", "quote", "toggle", "code", "divider"
  ]);
  assert.equal(blocks[2].bulleted_list_item.children[0].type, "bulleted_list_item");
  assert.equal(blocks[3].numbered_list_item.list_start_index, 3);
  assert.equal(blocks[3].numbered_list_item.list_format, "letters");
  assert.equal(blocks[4].to_do.checked, true);
  assert.equal(blocks[6].toggle.rich_text[0].text.content, "Details");
  assert.equal(blocks[7].code.language, "javascript");
});

test("preserves mixed inline annotations, links, hard breaks, and merges equivalent runs", () => {
  const [paragraph] = notionBlocksFromDocument({
    type: "doc",
    content: [{
      type: "paragraph",
      content: [
        { type: "text", text: "Bold ", marks: [{ type: "bold" }] },
        { type: "text", text: "together", marks: [{ type: "bold" }] },
        { type: "text", text: " and linked", marks: [{ type: "italic" }, { type: "underline" }, { type: "strike" }, { type: "code" }, { type: "link", attrs: { href: "https://example.com" } }] },
        { type: "hardBreak" },
        { type: "text", text: "next line" }
      ]
    }]
  });
  const runs = paragraph.paragraph.rich_text;

  assert.equal(runs.length, 3);
  assert.equal(runs[0].text.content, "Bold together");
  assert.equal(runs[0].annotations.bold, true);
  assert.deepEqual(runs[1].text.link, { url: "https://example.com" });
  assert.deepEqual(runs[1].annotations, {
    bold: false,
    italic: true,
    strikethrough: true,
    underline: true,
    code: true,
    color: "default"
  });
  assert.equal(runs[2].text.content, "\nnext line");
});

test("splits rich text at 2,000 Unicode characters without splitting emoji", () => {
  const text = "🙂".repeat(2001);
  const [paragraph] = notionBlocksFromDocument({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }]
  });
  const runs = paragraph.paragraph.rich_text;
  assert.equal(runs.length, 2);
  assert.equal(Array.from(runs[0].text.content).length, 2000);
  assert.equal(Array.from(runs[1].text.content).length, 1);
});

test("uses the full first formatted block as the title and appends source metadata", () => {
  const capture = {
    document: {
      version: 1,
      title: "",
      doc: {
        type: "doc",
        content: [{
          type: "paragraph",
          content: [
            { type: "text", text: "Hello " },
            { type: "text", text: "world", marks: [{ type: "bold" }] }
          ]
        }]
      }
    },
    pageTitle: "Source page",
    url: "https://example.com/article",
    includeSource: true
  };
  const request = buildCaptureRequest({ destinationType: "database", destinationId: "source", titleProperty: "Name" }, capture);
  assert.equal(request.body.properties.Name.title[0].text.content, "Hello world");
  assert.equal(request.body.children.at(-1).type, "toggle");
  assert.equal(plainTextFromCapture(capture), "Hello world");
});

test("keeps explicit titles up to 200 Unicode characters without splitting emoji", () => {
  const title = "🙂".repeat(201);
  const request = buildCaptureRequest({
    destinationType: "database",
    destinationId: "source",
    titleProperty: "Name"
  }, {
    document: {
      version: 1,
      title,
      doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Body" }] }] }
    },
    includeSource: false
  });
  const storedTitle = request.body.properties.Name.title[0].text.content;
  assert.equal(Array.from(storedTitle).length, 200);
  assert.equal(storedTitle, "🙂".repeat(200));
  assert.doesNotMatch(storedTitle, /[\uD800-\uDFFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
});

test("validates capture and rich-text API limits before sending", () => {
  assert.throws(
    () => buildCaptureRequest(
      { destinationType: "database", destinationId: "source", titleProperty: "Name" },
      { text: "x".repeat(8001), includeSource: false }
    ),
    /8,000 characters/
  );

  const alternating = Array.from({ length: 101 }, (_, index) => ({
    type: "text",
    text: "x",
    ...(index % 2 ? { marks: [{ type: "bold" }] } : {})
  }));
  assert.throws(
    () => notionBlocksFromDocument({ type: "doc", content: [{ type: "paragraph", content: alternating }] }),
    /too many formatting changes/
  );
});

test("keeps manually selected database properties title-only when source is attached", () => {
  const request = buildCaptureRequest(
    { destinationType: "database", destinationId: "manual-source", titleProperty: "Note" },
    { text: "Manual note", url: "https://example.com/article", includeSource: true }
  );

  assert.deepEqual(Object.keys(request.body.properties), ["Note"]);
  assert.equal(request.body.children.at(-1).type, "toggle");
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

test("builds a workspace-level Quick Notes database with a title property", () => {
  const request = buildQuickNotesDatabaseRequest("Quick Notes", "marker-1");
  assert.equal(request.path, "/v1/databases");
  assert.equal(request.method, "POST");
  assert.equal(request.body.title[0].text.content, "Quick Notes");
  assert.deepEqual(request.body.initial_data_source.properties, {
    Name: { title: {} },
    "Capture ID": { rich_text: {} },
    "Source URL": { url: {} },
    "Source Domain": { rich_text: {} },
    "Captured At": { created_time: {} }
  });
  assert.deepEqual(request.body.parent, { type: "workspace", workspace: true });
  assert.equal(request.body.description[0].text.content, "Notion Quick Note · schema=3 · provision=marker-1");
});

test("creates a Quick Notes database and returns its managed data source destination", async () => {
  const calls = [];
  const destination = await createQuickNotesDatabase({
    token: "secret",
    marker: "marker-1",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith("/v1/databases")) return response(200, {
        id: "database-id",
        url: "https://notion.so/database-id",
        icon: { type: "emoji", emoji: "📝" },
        data_sources: [{ id: "data-source-id" }]
      });
      if (url.includes("/v1/databases/")) return response(200, {
        id: "database-id",
        title: [{ plain_text: "Quick Notes" }],
        url: "https://notion.so/database-id",
        icon: { type: "emoji", emoji: "📝" }
      });
      return response(200, managedDataSource());
    }
  });

  assert.equal(calls[0].url, "https://api.notion.com/v1/databases");
  assert.equal(calls[0].options.headers.Authorization, "Bearer secret");
  assert.deepEqual(JSON.parse(calls[0].options.body).parent, { type: "workspace", workspace: true });
  assert.equal(destination.id, "data-source-id");
  assert.equal(destination.databaseId, "database-id");
  assert.equal(destination.managedDestination, true);
  assert.equal(destination.schemaVersion, 3);
  assert.equal(destination.marker, "marker-1");
  assert.equal(destination.properties.sourceUrl.id, "source-url-id");
});

test("preserves Notion error details when automatic database creation fails", async () => {
  await assert.rejects(
    createQuickNotesDatabase({
      token: "secret",
      fetchImpl: async () => response(403, { code: "restricted_resource", message: "Missing insert capability" })
    }),
    (error) => error instanceof NotionApiError
      && error.status === 403
      && error.code === "restricted_resource"
  );
});

test("preserves Notion rate-limit timing for setup feedback", async () => {
  await assert.rejects(
    createQuickNotesDatabase({
      token: "secret",
      fetchImpl: async () => ({
        ...response(429, { code: "rate_limited", message: "Slow down" }),
        headers: { get: (name) => name === "Retry-After" ? "7" : null }
      })
    }),
    (error) => error instanceof NotionApiError
      && error.status === 429
      && error.code === "rate_limited"
      && error.retryAfter === 7
  );
});

test("aborts every Notion request at its deadline and marks the timeout retryable", async () => {
  await assert.rejects(
    notionRequest("secret", "/v1/search", { method: "POST", body: {} }, async (_url, options) => {
      await new Promise((resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
      });
    }, 5),
    (error) => error instanceof NotionApiError
      && error.status === 408
      && error.code === "notion_timeout"
      && error.timeout === true
      && error.retryable === true
  );
});

test("turns search results into page and database destinations", async () => {
  const destinations = await searchDestinations({
    token: "secret",
    fetchImpl: async () => response(200, {
      results: [
        {
          object: "page",
          id: "page-id",
          icon: { type: "emoji", emoji: "📥" },
          properties: { title: { type: "title", title: [{ plain_text: "Quick Inbox" }] } }
        },
        {
          object: "data_source",
          id: "source-id",
          title: [{ plain_text: "Reading Notes" }],
          properties: { Note: { name: "Note", type: "title", title: {} } }
        },
        {
          object: "page",
          id: "trashed-id",
          in_trash: true,
          properties: { title: { type: "title", title: [{ plain_text: "Trash" }] } }
        }
      ]
    })
  });

  assert.deepEqual(destinations, [
    { id: "page-id", type: "page", name: "Quick Inbox", titleProperty: "Name", icon: "📥", url: "" },
    { id: "source-id", type: "database", name: "Reading Notes", titleProperty: "Note", icon: "▦", url: "" }
  ]);
});

test("lists recently edited Notion pages and skips archived or trashed results", async () => {
  const calls = [];
  const pages = await searchRecentPages({
    token: "secret",
    limit: 2,
    fetchImpl: async (_url, options) => {
      calls.push(JSON.parse(options.body));
      return response(200, {
        results: [
          {
            object: "page",
            id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            url: "https://www.notion.so/Meeting-notes",
            last_edited_time: "2026-07-19T12:00:00.000Z",
            properties: { title: { type: "title", title: [{ plain_text: "Meeting notes" }] } }
          },
          {
            object: "page",
            id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            archived: true,
            last_edited_time: "2026-07-19T11:00:00.000Z",
            properties: { title: { type: "title", title: [{ plain_text: "Archived" }] } }
          },
          {
            object: "page",
            id: "cccccccccccccccccccccccccccccccc",
            in_trash: true,
            last_edited_time: "2026-07-19T10:00:00.000Z",
            properties: { title: { type: "title", title: [{ plain_text: "Trash" }] } }
          },
          {
            object: "page",
            id: "dddddddddddddddddddddddddddddddd",
            url: "https://www.notion.so/Spec",
            last_edited_time: "2026-07-18T09:00:00.000Z",
            icon: { type: "emoji", emoji: "📝" },
            properties: { Name: { type: "title", title: [{ plain_text: "Spec" }] } }
          },
          {
            object: "data_source",
            id: "source-id",
            title: [{ plain_text: "Should be filtered by request" }]
          }
        ]
      });
    }
  });

  assert.deepEqual(calls[0].filter, { value: "page", property: "object" });
  assert.deepEqual(calls[0].sort, { direction: "descending", timestamp: "last_edited_time" });
  assert.deepEqual(pages, [
    {
      pageId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      title: "Meeting notes",
      url: "https://www.notion.so/Meeting-notes",
      icon: "↳",
      lastEditedTime: "2026-07-19T12:00:00.000Z",
      updatedAt: Date.parse("2026-07-19T12:00:00.000Z")
    },
    {
      pageId: "dddddddddddddddddddddddddddddddd",
      title: "Spec",
      url: "https://www.notion.so/Spec",
      icon: "📝",
      lastEditedTime: "2026-07-18T09:00:00.000Z",
      updatedAt: Date.parse("2026-07-18T09:00:00.000Z")
    }
  ]);
});

test("validates selected page and database access and preserves permission failures", async () => {
  const page = await validateDestinationHealth({
    token: "secret",
    settings: { destinationType: "page", destinationId: "page-id" },
    fetchImpl: async () => response(200, { id: "page-id", archived: false, in_trash: false })
  });
  assert.equal(page.id, "page-id");

  const database = await validateDestinationHealth({
    token: "secret",
    settings: { destinationType: "database", destinationId: "source-id", managedDestination: true },
    fetchImpl: async () => response(200, { id: "source-id", in_trash: false })
  });
  assert.equal(database.id, "source-id");

  await assert.rejects(
    validateDestinationHealth({
      token: "secret",
      settings: { destinationType: "page", destinationId: "private-page" },
      fetchImpl: async () => response(403, { code: "restricted_resource", message: "Reshare this page" })
    }),
    (error) => error instanceof NotionApiError && error.status === 403 && error.code === "restricted_resource"
  );
});

test("populates managed source metadata using stable property IDs", () => {
  const request = buildCaptureRequest({
    destinationType: "database",
    destinationId: "source-id",
    managedDestination: true,
    destinationProperties: {
      title: { id: "title", name: "Renamed note", type: "title" },
      sourceUrl: { id: "source-url-id", name: "Renamed URL", type: "url" },
      sourceDomain: { id: "domain-id", name: "Renamed domain", type: "rich_text" }
    }
  }, {
    text: "Metadata note",
    url: "https://WWW.Example.com/path?q=1",
    includeSource: true
  });

  assert.equal(request.body.properties.title.title[0].text.content, "Metadata note");
  assert.equal(request.body.properties["source-url-id"].url, "https://www.example.com/path?q=1");
  assert.equal(request.body.properties["domain-id"].rich_text[0].text.content, "example.com");
  assert.equal(normalizeSourceDomain("chrome://extensions"), "");
});

test("writes and queries the managed Capture ID for deduplication", async () => {
  const request = buildCaptureRequest({
    destinationType: "database",
    destinationId: "source-id",
    managedDestination: true,
    destinationProperties: {
      title: { id: "title", name: "Name", type: "title" },
      captureId: { id: "capture-id", name: "Renamed Capture ID", type: "rich_text" }
    }
  }, { text: "Reliable note", captureId: "uuid-1", includeSource: false });
  assert.equal(request.body.properties["capture-id"].rich_text[0].text.content, "uuid-1");

  let queryBody;
  const existing = await findManagedCaptureById({
    token: "secret",
    captureId: "uuid-1",
    settings: {
      destinationId: "source-id",
      managedDestination: true,
      destinationProperties: { captureId: { id: "capture-id", name: "Renamed Capture ID", type: "rich_text" } }
    },
    fetchImpl: async (_url, options) => {
      queryBody = JSON.parse(options.body);
      return response(200, { results: [{ id: "page-id", url: "https://notion.so/page-id" }] });
    }
  });
  assert.deepEqual(queryBody.filter, { property: "capture-id", rich_text: { equals: "uuid-1" } });
  assert.deepEqual(existing, { id: "page-id", url: "https://notion.so/page-id" });
});

test("omits managed source metadata when attaching the page is disabled", () => {
  const request = buildCaptureRequest({
    destinationType: "database",
    destinationId: "source-id",
    managedDestination: true,
    destinationProperties: {
      title: { id: "title", name: "Name", type: "title" },
      sourceUrl: { id: "source-url-id", name: "Source URL", type: "url" }
    }
  }, { text: "Private note", url: "https://example.com", includeSource: false });
  assert.deepEqual(Object.keys(request.body.properties), ["title"]);
});

test("recovers only a marked exact-title database with the managed schema", async () => {
  const destination = await findManagedQuickNotesDatabase({
    token: "secret",
    marker: "wanted",
    fetchImpl: async (url) => {
      if (url.endsWith("/v1/search")) return response(200, {
        results: [
          { object: "data_source", id: "wrong-source", title: [{ plain_text: "Quick Notes" }], parent: { database_id: "wrong-db" } },
          { object: "data_source", id: "incompatible-source", title: [{ plain_text: "Quick Notes" }], parent: { database_id: "incompatible-db" } },
          { object: "data_source", id: "data-source-id", title: [{ plain_text: "Quick Notes" }], parent: { database_id: "database-id" } }
        ]
      });
      if (url.endsWith("/wrong-db")) return response(200, { id: "wrong-db", description: [{ plain_text: "Someone else's database" }] });
      if (url.endsWith("/incompatible-db")) return response(200, {
        id: "incompatible-db",
        description: [{ plain_text: "Notion Quick Note · schema=3 · provision=wanted" }]
      });
      if (url.endsWith("/incompatible-source")) return response(200, {
        id: "incompatible-source",
        properties: { Name: { id: "title", name: "Name", type: "title", title: {} } }
      });
      if (url.endsWith("/database-id")) return response(200, {
        id: "database-id",
        title: [{ plain_text: "Quick Notes" }],
        description: [{ plain_text: "Notion Quick Note · schema=3 · provision=wanted" }]
      });
      return response(200, managedDataSource());
    }
  });
  assert.equal(destination.databaseId, "database-id");
  assert.equal(destination.marker, "wanted");
});

test("paginates recovery before deciding to create another managed database", async () => {
  const searchBodies = [];
  const destination = await findManagedQuickNotesDatabase({
    token: "secret",
    marker: "wanted",
    fetchImpl: async (url, options = {}) => {
      if (url.endsWith("/v1/search")) {
        const body = JSON.parse(options.body);
        searchBodies.push(body);
        return body.start_cursor
          ? response(200, {
              has_more: false,
              next_cursor: null,
              results: [{
                object: "data_source",
                id: "data-source-id",
                title: [{ plain_text: "Quick Notes" }],
                parent: { database_id: "database-id" }
              }]
            })
          : response(200, { has_more: true, next_cursor: "page-2", results: [] });
      }
      if (url.endsWith("/database-id")) return response(200, {
        id: "database-id",
        title: [{ plain_text: "Quick Notes" }],
        description: [{ plain_text: "Notion Quick Note · schema=3 · provision=wanted" }]
      });
      return response(200, managedDataSource());
    }
  });

  assert.equal(searchBodies.length, 2);
  assert.equal(searchBodies[1].start_cursor, "page-2");
  assert.equal(destination.databaseId, "database-id");
});

test("migrates a managed database without overwriting wrong-type name collisions", async () => {
  let updateBody;
  const destination = await migrateManagedQuickNotesDatabase({
    token: "secret",
    marker: "migration-marker",
    settings: { destinationId: "data-source-id", destinationDatabaseId: "database-id" },
    fetchImpl: async (url, options = {}) => {
      if (url.includes("/data_sources/") && options.method === "GET") {
        return response(200, {
          id: "data-source-id",
          title: [{ plain_text: "Quick Notes" }],
          properties: {
            Name: { id: "title", name: "Name", type: "title", title: {} },
            "Source URL": { id: "wrong", name: "Source URL", type: "rich_text", rich_text: {} }
          }
        });
      }
      if (url.includes("/data_sources/") && options.method === "PATCH") {
        updateBody = JSON.parse(options.body);
        return response(200, managedDataSource({ sourceUrlName: "Source URL (Quick Note)" }));
      }
      return response(200, { id: "database-id", title: [{ plain_text: "Quick Notes" }], description: [] });
    }
  });

  assert.deepEqual(updateBody.properties["Source URL (Quick Note)"], { url: {} });
  assert.deepEqual(updateBody.properties["Source Domain"], { rich_text: {} });
  assert.deepEqual(updateBody.properties["Captured At"], { created_time: {} });
  assert.equal(destination.properties.sourceUrl.name, "Source URL (Quick Note)");
});

test("refreshes renamed managed properties by ID and respects deleted optional properties", async () => {
  const destination = await refreshManagedDestination({
    token: "secret",
    settings: {
      destinationId: "data-source-id",
      destinationDatabaseId: "database-id",
      destinationMarker: "marker",
      destinationProperties: {
        title: { id: "title" },
        sourceUrl: { id: "source-url-id" },
        sourceDomain: { id: "deleted-domain-id" }
      }
    },
    fetchImpl: async (url) => url.includes("/data_sources/")
      ? response(200, {
          id: "data-source-id",
          properties: {
            "My note": { id: "title", name: "My note", type: "title", title: {} },
            Link: { id: "source-url-id", name: "Link", type: "url", url: {} },
            "Captured At": { id: "captured-id", name: "Captured At", type: "created_time", created_time: {} }
          }
        })
      : response(200, { id: "database-id", title: [{ plain_text: "Quick Notes" }] })
  });

  assert.equal(destination.properties.title.name, "My note");
  assert.equal(destination.properties.sourceUrl.name, "Link");
  assert.equal(destination.properties.sourceDomain, null);
});

function response(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get() { return null; } },
    async json() { return payload; }
  };
}

function managedDataSource({ sourceUrlName = "Source URL" } = {}) {
  return {
    object: "data_source",
    id: "data-source-id",
    title: [{ plain_text: "Quick Notes" }],
    parent: { database_id: "database-id" },
    properties: {
      Name: { id: "title", name: "Name", type: "title", title: {} },
      "Capture ID": { id: "capture-id", name: "Capture ID", type: "rich_text", rich_text: {} },
      [sourceUrlName]: { id: "source-url-id", name: sourceUrlName, type: "url", url: {} },
      "Source Domain": { id: "domain-id", name: "Source Domain", type: "rich_text", rich_text: {} },
      "Captured At": { id: "captured-id", name: "Captured At", type: "created_time", created_time: {} }
    }
  };
}
