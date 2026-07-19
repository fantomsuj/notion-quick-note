import {
  MANAGED_DATABASE_SCHEMA_VERSION,
  MAX_CAPTURE_CHARACTERS,
  MAX_CAPTURE_TITLE_CHARACTERS
} from "./constants.js";

export const NOTION_API_VERSION = "2026-03-11";
export const NOTION_REQUEST_TIMEOUT_MS = 15_000;
export const MANAGED_DATABASE_NAME = "Quick Notes";
export { MANAGED_DATABASE_SCHEMA_VERSION } from "./constants.js";
export const MANAGED_DATABASE_DESCRIPTION_PREFIX = `Notion Quick Note · schema=${MANAGED_DATABASE_SCHEMA_VERSION} · provision=`;

const MANAGED_PROPERTIES = Object.freeze({
  captureId: { name: "Capture ID", type: "rich_text", schema: { rich_text: {} } },
  sourceUrl: { name: "Source URL", type: "url", schema: { url: {} } },
  sourceDomain: { name: "Source Domain", type: "rich_text", schema: { rich_text: {} } },
  capturedAt: { name: "Captured At", type: "created_time", schema: { created_time: {} } }
});

export class NotionApiError extends Error {
  constructor(message, { status = 0, code = "", retryAfter = 0 } = {}) {
    super(message);
    this.name = "NotionApiError";
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

export function normalizeNotionId(value = "") {
  const input = value.trim();
  const compact = input.match(/[0-9a-f]{32}/i)?.[0];
  if (compact) return compact;

  const dashed = input.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0];
  return dashed ? dashed.replaceAll("-", "") : input;
}

const MAX_TEXT_CONTENT = 2000;
const MAX_RICH_TEXT_ITEMS = 100;
const MAX_BLOCK_CHILDREN = 100;
const MAX_BLOCKS_PER_PAYLOAD = 1000;

function richText(content, link) {
  return splitTextContent(content).map((part) => ({
    type: "text",
    text: {
      content: part,
      ...(link ? { link: { url: link } } : {})
    }
  }));
}

function captureTitle(capture) {
  const explicit = capture.document?.title?.trim();
  const firstLine = explicit || firstDocumentText(capture.document?.doc) || (capture.text || "").trim().split("\n")[0];
  return Array.from(firstLine || capture.pageTitle || "Quick note")
    .slice(0, MAX_CAPTURE_TITLE_CHARACTERS)
    .join("");
}

function contentBlocks(capture) {
  const blocks = capture.document?.doc
    ? notionBlocksFromDocument(capture.document.doc)
    : legacyContentBlocks(capture);

  blocks.push(...sourceBlocks(capture));
  return blocks;
}

function captureSources(capture = {}) {
  if (!capture.includeSource) return [];
  const values = Array.isArray(capture.sources) && capture.sources.length
    ? capture.sources
    : capture.url ? [{ title: capture.pageTitle || capture.url, url: capture.url }] : [];
  const seen = new Set();
  return values.flatMap((value) => {
    try {
      const url = new URL(String(value?.url || ""));
      if (!/^https?:$/.test(url.protocol)) return [];
      url.hash = "";
      if (seen.has(url.href)) return [];
      seen.add(url.href);
      return [{ title: String(value.title || url.hostname).slice(0, 1000), url: url.href }];
    } catch {
      return [];
    }
  }).slice(0, 20);
}

function sourceBlocks(capture) {
  const sources = captureSources(capture);
  if (!sources.length) return [];
  return [{
    object: "block",
    type: "toggle",
    toggle: {
      rich_text: richText("Sources"),
      children: sources.map((source) => notionTextBlock("bulleted_list_item", richText(source.title, source.url)))
    }
  }];
}

function legacyContentBlocks(capture) {
  const blocks = [];
  if (capture.selection?.trim()) blocks.push(notionTextBlock("quote", richText(capture.selection.trim())));
  for (const paragraph of (capture.text || "").trim().split(/\n{2,}/).filter(Boolean)) {
    blocks.push(notionTextBlock("paragraph", richText(paragraph)));
  }
  return blocks;
}

export function plainTextFromCapture(capture = {}) {
  if (capture.document?.doc) return documentText(capture.document.doc);
  return [capture.selection, capture.text].filter(Boolean).join("\n").trim();
}

export function notionBlocksFromDocument(doc) {
  if (!doc || doc.type !== "doc") return [];
  const blocks = (doc.content || []).flatMap((node) => notionBlocksFromNode(node));
  validateBlocks(blocks);
  return blocks;
}

function notionBlocksFromNode(node) {
  switch (node.type) {
    case "paragraph":
      return [notionTextBlock("paragraph", inlineRichText(node.content))];
    case "heading": {
      const level = Math.min(3, Math.max(1, Number(node.attrs?.level) || 1));
      return [notionTextBlock(`heading_${level}`, inlineRichText(node.content), { is_toggleable: false })];
    }
    case "bulletList":
      return listBlocks(node, "bulleted_list_item");
    case "orderedList":
      return listBlocks(node, "numbered_list_item");
    case "taskList":
      return (node.content || []).map((item) => listItemBlock(item, "to_do", { checked: Boolean(item.attrs?.checked) }));
    case "blockquote":
      return quoteBlocks(node);
    case "toggleBlock":
      return [notionTextBlock("toggle", inlineRichText(node.content))];
    case "codeBlock":
      return [notionTextBlock("code", richText(documentText(node)), { language: notionCodeLanguage(node.attrs?.language) })];
    case "horizontalRule":
      return [{ object: "block", type: "divider", divider: {} }];
    default:
      return (node.content || []).flatMap((child) => notionBlocksFromNode(child));
  }
}

function listBlocks(node, type) {
  const format = node.attrs?.type === "a" || node.attrs?.type === "A"
    ? "letters"
    : node.attrs?.type === "i" || node.attrs?.type === "I" ? "roman" : "numbers";
  return (node.content || []).map((item, index) => listItemBlock(item, type, type === "numbered_list_item" && index === 0
    ? { list_start_index: Number(node.attrs?.start) || 1, list_format: format }
    : {}));
}

function listItemBlock(item, type, attributes = {}) {
  const content = item.content || [];
  const firstTextBlock = content.find((child) => child.type === "paragraph") || content[0];
  const childNodes = firstTextBlock ? content.filter((child) => child !== firstTextBlock) : content;
  const children = childNodes.flatMap((child) => notionBlocksFromNode(child));
  return notionTextBlock(type, inlineRichText(firstTextBlock?.content), {
    ...attributes,
    ...(children.length ? { children } : {})
  });
}

function quoteBlocks(node) {
  const content = node.content || [];
  if (!content.length) return [notionTextBlock("quote", [])];
  const [first, ...rest] = content;
  const children = rest.flatMap((child) => notionBlocksFromNode(child));
  return [notionTextBlock("quote", inlineRichText(first.content), children.length ? { children } : {})];
}

function notionTextBlock(type, richTextItems, attributes = {}) {
  return { object: "block", type, [type]: { rich_text: richTextItems, ...attributes } };
}

function inlineRichText(nodes = []) {
  const runs = [];
  for (const node of nodes || []) {
    if (node.type === "hardBreak") {
      addRichTextRun(runs, "\n", [], "");
      continue;
    }
    if (node.type !== "text" || !node.text) continue;
    const linkMark = node.marks?.find((mark) => mark.type === "link");
    addRichTextRun(runs, node.text, node.marks || [], linkMark?.attrs?.href || "");
  }

  const items = runs.flatMap((run) => splitTextContent(run.text).map((content) => ({
    type: "text",
    text: { content, ...(run.href ? { link: { url: run.href } } : {}) },
    annotations: run.annotations
  })));
  if (items.length > MAX_RICH_TEXT_ITEMS) {
    throw new Error("This block contains too many formatting changes. Simplify its formatting before saving.");
  }
  return items;
}

function addRichTextRun(runs, text, marks, href) {
  const markNames = new Set(marks.map((mark) => mark.type));
  const color = marks.find((mark) => mark.type === "notionColor")?.attrs?.color || "default";
  const annotations = {
    bold: markNames.has("bold"),
    italic: markNames.has("italic"),
    strikethrough: markNames.has("strike"),
    underline: markNames.has("underline"),
    code: markNames.has("code"),
    color: notionAnnotationColor(color)
  };
  const previous = runs.at(-1);
  if (previous && previous.href === href && sameAnnotations(previous.annotations, annotations)) previous.text += text;
  else runs.push({ text, href, annotations });
}

function sameAnnotations(left, right) {
  return Object.keys(left).every((key) => left[key] === right[key]);
}

function splitTextContent(content = "") {
  const characters = Array.from(content);
  const chunks = [];
  for (let index = 0; index < characters.length; index += MAX_TEXT_CONTENT) {
    chunks.push(characters.slice(index, index + MAX_TEXT_CONTENT).join(""));
  }
  return chunks;
}

function documentText(node) {
  if (!node) return "";
  if (node.type === "text") return node.text || "";
  if (node.type === "hardBreak") return "\n";
  return (node.content || []).map(documentText).filter(Boolean).join(node.type === "doc" ? "\n" : "").trim();
}

function firstDocumentText(node) {
  return documentText(node).trim().split("\n")[0] || "";
}

function notionCodeLanguage(language) {
  const supported = new Set(["bash", "c", "c++", "c#", "css", "diff", "docker", "go", "graphql", "html", "java", "javascript", "json", "kotlin", "latex", "markdown", "mermaid", "php", "plain text", "python", "r", "ruby", "rust", "shell", "sql", "swift", "typescript", "xml", "yaml"]);
  return supported.has(language) ? language : "plain text";
}

function validateBlocks(blocks) {
  let total = 0;
  const visit = (items, depth = 0) => {
    if (items.length > MAX_BLOCK_CHILDREN) throw new Error("Quick Note supports up to 100 blocks in one section.");
    if (depth > 2) throw new Error("Notion supports two nested list levels per quick capture. Reduce the nesting before saving.");
    for (const block of items) {
      total += 1;
      const children = block[block.type]?.children || [];
      if (children.length) visit(children, depth + 1);
    }
  };
  visit(blocks);
  if (total > MAX_BLOCKS_PER_PAYLOAD) throw new Error("This note contains too many blocks for one capture.");
}

export function buildCaptureRequest(settings, capture, now = new Date()) {
  const destinationId = normalizeNotionId(settings.destinationId);
  if (!destinationId) throw new Error("Choose a Notion destination in Settings.");
  const plainText = plainTextFromCapture(capture);
  if (!plainText) throw new Error("Write something before saving.");
  if (Array.from(plainText).length > MAX_CAPTURE_CHARACTERS) throw new Error("Quick Notes can contain up to 8,000 characters.");

  const children = contentBlocks(capture);

  if (settings.destinationType === "database") {
    const properties = databaseCaptureProperties(settings, capture);
    return {
      path: "/v1/pages",
      method: "POST",
      body: {
        parent: { type: "data_source_id", data_source_id: destinationId },
        properties,
        children: validateTopLevelChildren(children)
      }
    };
  }

  return {
    path: `/v1/blocks/${destinationId}/children`,
    method: "PATCH",
    body: {
      children: validateTopLevelChildren([
        {
          object: "block",
          type: "heading_3",
          heading_3: {
            rich_text: richText(captureTitle(capture)),
            is_toggleable: false
          }
        },
        ...children,
        {
          object: "block",
          type: "paragraph",
          paragraph: {
            rich_text: richText(`Captured ${now.toLocaleString()}`),
            color: "gray"
          }
        },
        { object: "block", type: "divider", divider: {} }
      ])
    }
  };
}

function validateTopLevelChildren(children) {
  validateBlocks(children);
  if (children.length > MAX_BLOCK_CHILDREN) {
    throw new Error("This quick note has too many top-level blocks. Combine a few lines before saving.");
  }
  return children;
}

export function normalizeSourceDomain(value = "") {
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol)) return "";
    return url.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function managedDatabaseDescription(marker) {
  return `${MANAGED_DATABASE_DESCRIPTION_PREFIX}${marker}`;
}

export function buildQuickNotesDatabaseRequest(name = MANAGED_DATABASE_NAME, marker = "") {
  const databaseName = name.trim() || MANAGED_DATABASE_NAME;
  const description = managedDatabaseDescription(marker);
  return {
    path: "/v1/databases",
    method: "POST",
    body: {
      parent: { type: "workspace", workspace: true },
      title: richText(databaseName),
      description: richText(description),
      icon: { type: "emoji", emoji: "📝" },
      is_inline: false,
      initial_data_source: {
        properties: {
          Name: { title: {} },
          [MANAGED_PROPERTIES.captureId.name]: MANAGED_PROPERTIES.captureId.schema,
          [MANAGED_PROPERTIES.sourceUrl.name]: MANAGED_PROPERTIES.sourceUrl.schema,
          [MANAGED_PROPERTIES.sourceDomain.name]: MANAGED_PROPERTIES.sourceDomain.schema,
          [MANAGED_PROPERTIES.capturedAt.name]: MANAGED_PROPERTIES.capturedAt.schema
        }
      }
    }
  };
}

export async function createQuickNotesDatabase({ token, name = MANAGED_DATABASE_NAME, marker = "", fetchImpl = fetch }) {
  if (!token) throw new Error("Connect Notion first.");
  const request = buildQuickNotesDatabaseRequest(name, marker);
  const payload = await notionRequest(token, request.path, request, fetchImpl);

  const dataSourceId = payload.data_sources?.[0]?.id;
  if (!dataSourceId) {
    throw new Error("Notion created the database but did not return its data source. Choose it from the destination list.");
  }

  return loadManagedDestination({
    token,
    databaseId: payload.id,
    dataSourceId,
    marker,
    fallbackDatabase: payload,
    fetchImpl
  });
}

export async function findManagedQuickNotesDatabase({ token, marker = "", allowAnyMarker = false, fetchImpl = fetch }) {
  if (!token) throw new Error("Connect Notion first.");
  let startCursor;
  do {
    const payload = await notionRequest(token, "/v1/search", {
      method: "POST",
      body: {
        query: MANAGED_DATABASE_NAME,
        filter: { property: "object", value: "data_source" },
        sort: { direction: "descending", timestamp: "last_edited_time" },
        page_size: 100,
        ...(startCursor ? { start_cursor: startCursor } : {})
      }
    }, fetchImpl);

    const candidates = (payload.results || [])
      .filter((item) => !item.in_trash && item.object === "data_source" && plainText(item.title) === MANAGED_DATABASE_NAME)
      .sort((left, right) => Date.parse(right.created_time || 0) - Date.parse(left.created_time || 0));

    for (const candidate of candidates) {
      const databaseId = candidate.parent?.database_id || candidate.database_id;
      if (!databaseId) continue;
      const database = await retrieveDatabase({ token, databaseId, fetchImpl });
      const description = plainText(database.description);
      const recoveredMarker = markerFromDescription(description);
      if (!recoveredMarker || (!allowAnyMarker && recoveredMarker !== marker)) continue;

      const dataSource = await retrieveDataSource({ token, dataSourceId: candidate.id, fetchImpl });
      if (!hasManagedSchema(dataSource.properties)) continue;
      return managedDestination(database, dataSource, recoveredMarker);
    }
    startCursor = payload.has_more ? payload.next_cursor : undefined;
  } while (startCursor);
  return null;
}

export async function migrateManagedQuickNotesDatabase({ token, settings, marker, fetchImpl = fetch }) {
  if (!token) throw new Error("Connect Notion first.");
  let dataSource = await retrieveDataSource({ token, dataSourceId: settings.destinationId, fetchImpl });
  const databaseId = settings.destinationDatabaseId || dataSource.parent?.database_id || dataSource.database_id;
  if (!databaseId) throw new Error("Could not find the parent Quick Notes database.");
  const database = await retrieveDatabase({ token, databaseId, fetchImpl });

  const additions = missingManagedProperties(dataSource.properties);
  if (Object.keys(additions).length) {
    dataSource = await notionRequest(token, `/v1/data_sources/${normalizeNotionId(dataSource.id)}`, {
      method: "PATCH",
      body: { properties: additions }
    }, fetchImpl);
  }

  await notionRequest(token, `/v1/databases/${normalizeNotionId(databaseId)}`, {
    method: "PATCH",
    body: { description: richText(managedDatabaseDescription(marker)) }
  }, fetchImpl);

  const refreshedDatabase = { ...database, description: richText(managedDatabaseDescription(marker)) };
  return managedDestination(refreshedDatabase, dataSource, marker);
}

export async function refreshManagedDestination({ token, settings, fetchImpl = fetch }) {
  const dataSource = await retrieveDataSource({ token, dataSourceId: settings.destinationId, fetchImpl });
  const databaseId = settings.destinationDatabaseId || dataSource.parent?.database_id || dataSource.database_id;
  const database = databaseId
    ? await retrieveDatabase({ token, databaseId, fetchImpl })
    : { id: "", title: richText(settings.destinationName), url: settings.destinationUrl || "" };
  return managedDestination(
    database,
    dataSource,
    settings.destinationMarker || markerFromDescription(plainText(database.description)),
    settings.destinationProperties
  );
}

export async function retrieveDatabase({ token, databaseId, fetchImpl = fetch }) {
  return notionRequest(token, `/v1/databases/${normalizeNotionId(databaseId)}`, { method: "GET" }, fetchImpl);
}

export async function retrieveDataSource({ token, dataSourceId, fetchImpl = fetch }) {
  return notionRequest(token, `/v1/data_sources/${normalizeNotionId(dataSourceId)}`, { method: "GET" }, fetchImpl);
}

export async function validateDestinationHealth({ token, settings, fetchImpl = fetch }) {
  if (!token || !settings?.destinationId) throw new Error("Connect Notion and choose a destination.");
  if (settings.destinationType === "database") {
    const dataSourceId = settings.managedDestination
      ? settings.destinationId
      : await resolveDataSourceId(token, settings.destinationId, fetchImpl);
    const dataSource = await retrieveDataSource({ token, dataSourceId, fetchImpl });
    if (dataSource.in_trash) throw new NotionApiError("The selected database is in the trash.", { status: 403, code: "destination_trashed" });
    return { ok: true, id: dataSource.id };
  }
  const block = await notionRequest(token, `/v1/blocks/${normalizeNotionId(settings.destinationId)}`, { method: "GET" }, fetchImpl);
  if (block.in_trash || block.archived) throw new NotionApiError("The selected page is unavailable.", { status: 403, code: "destination_unavailable" });
  return { ok: true, id: block.id };
}

export async function sendCapture({ token, settings, capture, fetchImpl = fetch }) {
  if (!token) throw new Error("Connect Notion in Settings first.");
  const resolvedSettings = settings.destinationType === "database"
    ? {
        ...settings,
        destinationId: settings.managedDestination
          ? settings.destinationId
          : await resolveDataSourceId(token, settings.destinationId, fetchImpl)
      }
    : settings;
  const request = buildCaptureRequest(resolvedSettings, capture);
  return notionRequest(token, request.path, request, fetchImpl);
}

export class NotionConflictError extends NotionApiError {
  constructor(message = "This note changed in Notion after it was opened. Your local edit is preserved.") {
    super(message, { status: 409, code: "remote_conflict" });
    this.name = "NotionConflictError";
  }
}

export async function loadRemoteNote({ token, record, fetchImpl = fetch }) {
  const remote = record?.remote || {};
  if (!remote.id && !remote.pageId) throw new NotionApiError("This older capture can only be opened in Notion.", { status: 400, code: "remote_edit_unavailable" });
  if (remote.kind === "legacy_section") throw new NotionApiError("This older running-page capture can only be opened in Notion.", { status: 400, code: "remote_edit_unavailable" });

  const pageId = normalizeNotionId(remote.pageId || remote.id);
  const [page, allBlocks] = await Promise.all([
    notionRequest(token, `/v1/pages/${pageId}`, {}, fetchImpl),
    retrieveBlockTree({ token, blockId: pageId, fetchImpl })
  ]);
  if (page.in_trash) throw new NotionApiError("This note is in the Notion trash.", { status: 404, code: "object_not_found" });

  let blocks = allBlocks;
  let previousSiblingId = "";
  if (remote.kind === "section") {
    const journalIds = Object.values(record.syncJournal?.insertedSegments || {}).flat();
    const tracked = new Set([...(remote.blockIds || []), ...journalIds]);
    blocks = allBlocks.filter((block) => tracked.has(block.id));
    if (!blocks.length) throw new NotionApiError("This note section is no longer available in the running page.", { status: 404, code: "section_not_found" });
    const firstIndex = allBlocks.findIndex((block) => block.id === blocks[0].id);
    previousSiblingId = firstIndex > 0 ? allBlocks[firstIndex - 1].id : "";
  }
  const trackedBlocks = blocks;

  let title = pageTitle(page);
  if (remote.kind === "section" && blocks[0]?.type === "heading_3") {
    title = blockPlainText(blocks[0]) || title;
    blocks = blocks.slice(1);
  }
  if (remote.kind === "section" && blocks.at(-1)?.type === "divider") blocks = blocks.slice(0, -1);
  if (remote.kind === "section" && /^Captured |^Updated /.test(blockPlainText(blocks.at(-1)))) blocks = blocks.slice(0, -1);

  const recordSources = captureSources(record.pendingCapture || record.syncedCapture || record.capture);
  const legacySourceUrls = new Set(recordSources.map((source) => source.url));
  blocks = blocks.filter((block) => !(block.type === "bookmark" && legacySourceUrls.has(block.bookmark?.url)));
  const mapped = notionDocumentFromBlocks(blocks);
  const sources = mapped.sources.length ? mapped.sources : recordSources;
  const fingerprint = remote.kind === "section" ? sectionFingerprint(blocks) : String(page.last_edited_time || "");
  const titlePropertyId = Object.values(page.properties || {}).find((property) => property.type === "title")?.id || "title";
  return {
    title,
    doc: mapped.doc,
    sources,
    baseFingerprint: fingerprint,
    remote: {
      ...remote,
      kind: remote.kind || "page",
      id: remote.id || page.id,
      pageId,
      url: remote.url || page.url || "",
      blockIds: remote.kind === "section" ? blocks.map((block) => block.id) : allBlocks.map((block) => block.id),
      previousSiblingId,
      titlePropertyId,
      fingerprint
    },
    _blocks: blocks,
    _trackedBlocks: trackedBlocks,
    _allBlocks: allBlocks
  };
}

export async function updateRemoteNote({ token, record, capture, baseFingerprint, journal = {}, onJournal = async () => {}, fetchImpl = fetch }) {
  const loaded = await loadRemoteNote({ token, record, fetchImpl });
  const started = Object.keys(journal.insertedSegments || {}).length > 0 || (journal.archivedIds || []).length > 0;
  if (!started && baseFingerprint && loaded.baseFingerprint !== baseFingerprint) throw new NotionConflictError();

  const remote = loaded.remote;
  const placeholderIds = new Set(opaqueBlockIds(capture.document?.doc));
  const insertedIds = new Set(Object.values(journal.insertedSegments || {}).flat());
  const oldEditableIds = loaded._trackedBlocks
    .filter((block) => !placeholderIds.has(block.id) && !insertedIds.has(block.id))
    .map((block) => block.id);
  const segments = editableSegments(capture.document?.doc);
  const sources = sourceBlocks(capture);
  if (sources.length) {
    if (!segments.length) segments.push({ afterId: "", blocks: [] });
    segments.at(-1).blocks.push(...sources);
  }
  if (remote.kind === "section") {
    const wrapperStart = {
      object: "block",
      type: "heading_3",
      heading_3: { rich_text: richText(captureTitle(capture)), is_toggleable: false }
    };
    if (!segments.length) segments.push({ afterId: "", blocks: [] });
    segments[0].blocks.unshift(wrapperStart);
    segments.at(-1).blocks.push(
      notionTextBlock("paragraph", richText(`Updated ${new Date().toLocaleString()}`), { color: "gray" }),
      { object: "block", type: "divider", divider: {} }
    );
  }

  const nextJournal = {
    phase: journal.phase || "inserting",
    insertedSegments: { ...(journal.insertedSegments || {}) },
    archivedIds: [...(journal.archivedIds || [])]
  };
  for (let index = 0; index < segments.length; index += 1) {
    if (nextJournal.insertedSegments[index]) continue;
    const segment = segments[index];
    if (!segment.blocks.length) {
      nextJournal.insertedSegments[index] = [];
      await onJournal(nextJournal);
      continue;
    }
    const afterId = segment.afterId || (index === 0 ? remote.previousSiblingId : "");
    const result = await notionRequest(token, `/v1/blocks/${normalizeNotionId(remote.pageId)}/children`, {
      method: "PATCH",
      body: {
        children: validateTopLevelChildren(segment.blocks),
        position: afterId
          ? { type: "after_block", after_block: { id: normalizeNotionId(afterId) } }
          : { type: "start" }
      }
    }, fetchImpl);
    nextJournal.insertedSegments[index] = (result.results || []).map((block) => block.id).filter(Boolean);
    await onJournal(nextJournal);
  }

  nextJournal.phase = "archiving";
  await onJournal(nextJournal);
  for (const id of oldEditableIds) {
    if (nextJournal.archivedIds.includes(id)) continue;
    await notionRequest(token, `/v1/blocks/${normalizeNotionId(id)}`, { method: "DELETE" }, fetchImpl);
    nextJournal.archivedIds.push(id);
    await onJournal(nextJournal);
  }

  if (remote.kind === "page") {
    await notionRequest(token, `/v1/pages/${normalizeNotionId(remote.pageId)}`, {
      method: "PATCH",
      body: {
        properties: {
          [remote.titlePropertyId || record.destination?.titleProperty || "title"]: { title: richText(captureTitle(capture)) },
          ...managedSourceProperties(record.destination, capture)
        }
      }
    }, fetchImpl);
  }

  nextJournal.phase = "complete";
  await onJournal(nextJournal);
  const createdIds = segments.flatMap((_, index) => nextJournal.insertedSegments[index] || []);
  const finalPage = await notionRequest(token, `/v1/pages/${normalizeNotionId(remote.pageId)}`, {}, fetchImpl);
  return {
    ...remote,
    id: remote.id || finalPage.id,
    url: remote.url || finalPage.url || "",
    blockIds: remote.kind === "section" ? orderedRemoteIds(capture.document?.doc, nextJournal.insertedSegments) : [],
    fingerprint: remote.kind === "section" ? `updated:${finalPage.last_edited_time || Date.now()}:${createdIds.join(",")}` : String(finalPage.last_edited_time || "")
  };
}

export function notionDocumentFromBlocks(blocks = []) {
  const content = [];
  const sources = [];
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (isSourcesBlock(block)) {
      sources.push(...sourcesFromBlock(block));
      continue;
    }
    if ((block.type === "bulleted_list_item" || block.type === "numbered_list_item") && isSafelyEditableListBlock(block)) {
      const type = block.type;
      const items = [];
      while (blocks[index]?.type === type && isSafelyEditableListBlock(blocks[index])) {
        items.push(listNodeFromBlock(blocks[index], type));
        index += 1;
      }
      index -= 1;
      content.push({
        type: type === "bulleted_list_item" ? "bulletList" : "orderedList",
        ...(type === "numbered_list_item" ? { attrs: { start: Number(block[type]?.list_start_index || 1), type: block[type]?.list_format === "letters" ? "a" : block[type]?.list_format === "roman" ? "i" : "1" } } : {}),
        content: items
      });
      continue;
    }
    content.push(notionNodeFromBlock(block));
  }
  return { doc: { type: "doc", content: content.length ? content : [{ type: "paragraph" }] }, sources };
}

function isSafelyEditableListBlock(block = {}) {
  if (!["bulleted_list_item", "numbered_list_item"].includes(block.type)) return false;
  return (block[block.type]?.children || []).every((child) => {
    if (["bulleted_list_item", "numbered_list_item"].includes(child.type)) return isSafelyEditableListBlock(child);
    const attrs = child[child.type] || {};
    return ["paragraph", "heading_1", "heading_2", "heading_3", "to_do", "quote", "toggle", "code", "divider"].includes(child.type)
      && !(attrs.children || []).length;
  });
}

async function retrieveBlockTree({ token, blockId, fetchImpl }) {
  const results = [];
  let cursor = "";
  do {
    const query = new URLSearchParams({ page_size: "100" });
    if (cursor) query.set("start_cursor", cursor);
    const page = await notionRequest(token, `/v1/blocks/${normalizeNotionId(blockId)}/children?${query}`, {}, fetchImpl);
    for (const block of page.results || []) {
      if (block.has_children) {
        const children = await retrieveBlockTree({ token, blockId: block.id, fetchImpl });
        block[block.type] = { ...(block[block.type] || {}), children };
      }
      results.push(block);
    }
    cursor = page.has_more ? page.next_cursor || "" : "";
  } while (cursor);
  return results;
}

function notionNodeFromBlock(block = {}) {
  const attrs = block[block.type] || {};
  if ((attrs.children || []).length) return opaqueNode(block);
  const inline = inlineNodesFromRichText(attrs.rich_text || []);
  if (block.type === "paragraph") return { type: "paragraph", ...(inline.length ? { content: inline } : {}) };
  if (/^heading_[1-3]$/.test(block.type)) return { type: "heading", attrs: { level: Number(block.type.at(-1)) }, ...(inline.length ? { content: inline } : {}) };
  if (block.type === "to_do") return { type: "taskList", content: [{ type: "taskItem", attrs: { checked: Boolean(attrs.checked) }, content: [{ type: "paragraph", ...(inline.length ? { content: inline } : {}) }] }] };
  if (block.type === "quote") return { type: "blockquote", content: [{ type: "paragraph", ...(inline.length ? { content: inline } : {}) }] };
  if (block.type === "toggle" && !(attrs.children || []).length) return { type: "toggleBlock", attrs: { open: true }, ...(inline.length ? { content: inline } : {}) };
  if (block.type === "code") return { type: "codeBlock", attrs: { language: attrs.language || "plain text" }, ...(inline.length ? { content: inline } : {}) };
  if (block.type === "divider") return { type: "horizontalRule" };
  return opaqueNode(block);
}

function listNodeFromBlock(block, type) {
  const attrs = block[type] || {};
  const children = notionDocumentFromBlocks(attrs.children || []).doc.content;
  return {
    type: "listItem",
    content: [{ type: "paragraph", content: inlineNodesFromRichText(attrs.rich_text || []) }, ...children.filter((node) => node.type !== "paragraph" || node.content?.length)]
  };
}

function opaqueNode(block) {
  return { type: "notionBlock", attrs: { remoteId: String(block.id || ""), remoteType: String(block.type || "unsupported"), label: blockLabel(block) } };
}

function inlineNodesFromRichText(items = []) {
  const nodes = [];
  for (const item of items) {
    const text = item.plain_text ?? item.text?.content ?? "";
    if (!text) continue;
    const marks = [];
    if (item.annotations?.bold) marks.push({ type: "bold" });
    if (item.annotations?.italic) marks.push({ type: "italic" });
    if (item.annotations?.strikethrough) marks.push({ type: "strike" });
    if (item.annotations?.underline) marks.push({ type: "underline" });
    if (item.annotations?.code) marks.push({ type: "code" });
    if (item.annotations?.color && item.annotations.color !== "default") marks.push({ type: "notionColor", attrs: { color: notionAnnotationColor(item.annotations.color) } });
    const href = item.href || item.text?.link?.url;
    if (href) marks.push({ type: "link", attrs: { href, target: "_blank", rel: "noopener noreferrer nofollow", class: null } });
    const parts = String(text).split("\n");
    parts.forEach((part, index) => {
      if (index) nodes.push({ type: "hardBreak" });
      if (part) nodes.push({ type: "text", text: part, ...(marks.length ? { marks } : {}) });
    });
  }
  return nodes;
}

function notionAnnotationColor(value = "default") {
  const colors = new Set([
    "default", "gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red",
    "gray_background", "brown_background", "orange_background", "yellow_background", "green_background",
    "blue_background", "purple_background", "pink_background", "red_background"
  ]);
  return colors.has(value) ? value : "default";
}

function editableSegments(doc) {
  const segments = [];
  let current = { afterId: "", blocks: [] };
  for (const node of doc?.content || []) {
    if (node.type === "notionBlock") {
      if (current.blocks.length) segments.push(current);
      current = { afterId: node.attrs?.remoteId || "", blocks: [] };
      continue;
    }
    current.blocks.push(...notionBlocksFromDocument({ type: "doc", content: [node] }));
  }
  if (current.blocks.length) segments.push(current);
  return segments;
}

function opaqueBlockIds(doc) {
  return (doc?.content || []).filter((node) => node.type === "notionBlock").map((node) => node.attrs?.remoteId).filter(Boolean);
}

function orderedRemoteIds(doc, insertedSegments) {
  const ids = [];
  let segmentIndex = 0;
  let hasEditable = false;
  for (const node of doc?.content || []) {
    if (node.type === "notionBlock") {
      if (hasEditable) ids.push(...(insertedSegments[segmentIndex++] || []));
      ids.push(node.attrs?.remoteId);
      hasEditable = false;
    } else {
      hasEditable = true;
    }
  }
  if (hasEditable || insertedSegments[segmentIndex]) ids.push(...(insertedSegments[segmentIndex] || []));
  for (let index = segmentIndex + 1; insertedSegments[index]; index += 1) ids.push(...insertedSegments[index]);
  return ids.filter(Boolean);
}

function managedSourceProperties(destination = {}, capture = {}) {
  if (!destination.managedDestination) return {};
  const primary = captureSources(capture)[0];
  const properties = {};
  const sourceUrlKey = propertyKey(destination.destinationProperties?.sourceUrl);
  const sourceDomainKey = propertyKey(destination.destinationProperties?.sourceDomain);
  if (sourceUrlKey) properties[sourceUrlKey] = { url: primary?.url || null };
  if (sourceDomainKey) properties[sourceDomainKey] = { rich_text: primary?.url ? richText(normalizeSourceDomain(primary.url)) : [] };
  return properties;
}

function pageTitle(page = {}) {
  const property = Object.values(page.properties || {}).find((value) => value.type === "title");
  return plainText(property?.title || []) || "Untitled";
}

function blockPlainText(block = {}) {
  return plainText(block[block.type]?.rich_text || []);
}

function blockLabel(block) {
  return blockPlainText(block) || String(block.type || "Unsupported block").replaceAll("_", " ");
}

function isSourcesBlock(block = {}) {
  return block.type === "toggle" && blockPlainText(block).trim().toLowerCase() === "sources";
}

function sourcesFromBlock(block = {}) {
  return (block.toggle?.children || []).flatMap((child) => {
    const rich = child[child.type]?.rich_text || [];
    const href = rich.find((item) => item.href || item.text?.link?.url)?.href || rich.find((item) => item.text?.link?.url)?.text?.link?.url;
    return href ? [{ title: plainText(rich) || href, url: href, selection: "", capturedAt: Date.now() }] : [];
  });
}

function sectionFingerprint(blocks = []) {
  return blocks.map((block) => `${block.id}:${block.last_edited_time || ""}:${block.in_trash ? 1 : 0}`).join("|");
}

export async function findManagedCaptureById({ token, settings, captureId, fetchImpl = fetch }) {
  if (!token || !settings?.managedDestination || !captureId) return null;
  const property = settings.destinationProperties?.captureId;
  const propertyName = property?.id || property?.name || MANAGED_PROPERTIES.captureId.name;
  const payload = await notionRequest(token, `/v1/data_sources/${normalizeNotionId(settings.destinationId)}/query`, {
    method: "POST",
    body: {
      filter: {
        property: propertyName,
        rich_text: { equals: captureId }
      },
      page_size: 1
    }
  }, fetchImpl);
  const page = payload.results?.[0];
  return page ? { id: page.id || "", url: page.url || "" } : null;
}

export async function searchDestinations({ token, query = "", fetchImpl = fetch }) {
  if (!token) throw new Error("Connect Notion first.");
  const payload = await notionRequest(token, "/v1/search", {
    method: "POST",
    body: {
      ...(query.trim() ? { query: query.trim() } : {}),
      sort: { direction: "descending", timestamp: "last_edited_time" },
      page_size: 100
    }
  }, fetchImpl);

  return (payload.results || [])
    .filter((item) => !item.in_trash && (item.object === "page" || item.object === "data_source"))
    .map(destinationFromNotion)
    .filter((item) => item.name);
}

function destinationFromNotion(item) {
  if (item.object === "data_source") {
    const titleProperty = Object.values(item.properties || {}).find((property) => property.type === "title");
    return {
      id: item.id,
      type: "database",
      name: plainText(item.title) || "Untitled database",
      titleProperty: titleProperty?.name || "Name",
      icon: notionIcon(item.icon, "▦"),
      url: item.url || ""
    };
  }

  const titleProperty = Object.values(item.properties || {}).find((property) => property.type === "title");
  return {
    id: item.id,
    type: "page",
    name: plainText(titleProperty?.title) || "Untitled page",
    titleProperty: "Name",
    icon: notionIcon(item.icon, "↳"),
    url: item.url || ""
  };
}

function plainText(items = []) {
  return items.map((item) => item.plain_text || item.text?.content || "").join("").trim();
}

function notionIcon(icon, fallback) {
  if (icon?.type === "emoji") return icon.emoji;
  return fallback;
}

function notionHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    "Notion-Version": NOTION_API_VERSION,
    "Content-Type": "application/json"
  };
}

function notionApiError(response, payload) {
  return new NotionApiError(payload.message || `Notion returned ${response.status}.`, {
    status: response.status,
    code: payload.code,
    retryAfter: Number(response.headers?.get?.("Retry-After") || 0)
  });
}

export async function notionRequest(token, path, { method = "GET", body } = {}, fetchImpl = fetch, timeoutMs = NOTION_REQUEST_TIMEOUT_MS) {
  let response;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    response = await fetchImpl(`https://api.notion.com${path}`, {
      method,
      headers: notionHeaders(token),
      signal: controller.signal,
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
  } catch (error) {
    if (controller.signal.aborted || error?.name === "AbortError") {
      const timeout = new NotionApiError("Notion took too long to respond. Delivery will retry safely.", {
        status: 408,
        code: "notion_timeout"
      });
      timeout.timeout = true;
      timeout.retryable = true;
      throw timeout;
    }
    throw new NotionApiError(error.message || "Could not reach Notion.", { code: "network_error" });
  } finally {
    clearTimeout(timer);
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw notionApiError(response, payload);
  return payload;
}

function databaseCaptureProperties(settings, capture) {
  const managed = Boolean(settings.managedDestination);
  const propertyMap = settings.destinationProperties || {};
  const titleKey = managed
    ? propertyKey(propertyMap.title, settings.titleProperty || "Name")
    : settings.titleProperty?.trim() || "Name";
  const properties = {
    [titleKey]: { title: richText(captureTitle(capture)) }
  };

  if (managed && capture.captureId) {
    const captureIdKey = propertyKey(propertyMap.captureId, MANAGED_PROPERTIES.captureId.name);
    if (captureIdKey) properties[captureIdKey] = { rich_text: richText(capture.captureId) };
  }

  const primarySource = captureSources(capture)[0];
  const primaryUrl = primarySource?.url || capture.url;
  if (!managed || !capture.includeSource || !primaryUrl) return properties;
  const domain = normalizeSourceDomain(primaryUrl);
  if (!domain) return properties;

  const sourceUrlKey = propertyKey(propertyMap.sourceUrl);
  const sourceDomainKey = propertyKey(propertyMap.sourceDomain);
  if (sourceUrlKey) properties[sourceUrlKey] = { url: primaryUrl };
  if (sourceDomainKey) properties[sourceDomainKey] = { rich_text: richText(domain) };
  return properties;
}

function propertyKey(property, fallback = "") {
  return property?.id || property?.name || fallback;
}

async function loadManagedDestination({ token, databaseId, dataSourceId, marker, fallbackDatabase, fetchImpl }) {
  const [database, dataSource] = await Promise.all([
    retrieveDatabase({ token, databaseId, fetchImpl }).catch(() => fallbackDatabase),
    retrieveDataSource({ token, dataSourceId, fetchImpl })
  ]);
  return managedDestination(database, dataSource, marker);
}

function managedDestination(database = {}, dataSource = {}, marker = "", previousProperties = {}) {
  const destinationProperties = managedPropertyMap(dataSource.properties || {}, previousProperties);
  return {
    id: dataSource.id || "",
    databaseId: database.id || dataSource.parent?.database_id || "",
    type: "database",
    name: plainText(database.title) || plainText(dataSource.title) || MANAGED_DATABASE_NAME,
    titleProperty: destinationProperties.title?.name || "Name",
    icon: notionIcon(database.icon || dataSource.icon, "📝"),
    url: database.url || dataSource.url || "",
    managedDestination: true,
    schemaVersion: MANAGED_DATABASE_SCHEMA_VERSION,
    marker,
    properties: destinationProperties
  };
}

function managedPropertyMap(schema, previous = {}) {
  const properties = schemaEntries(schema);
  return {
    title: findPreviousProperty(properties, previous.title, "title")
      || properties.find((property) => property.type === "title")
      || null,
    captureId: findPreviousProperty(properties, previous.captureId, MANAGED_PROPERTIES.captureId.type)
      || findManagedProperty(properties, MANAGED_PROPERTIES.captureId),
    sourceUrl: findPreviousProperty(properties, previous.sourceUrl, MANAGED_PROPERTIES.sourceUrl.type)
      || findManagedProperty(properties, MANAGED_PROPERTIES.sourceUrl),
    sourceDomain: findPreviousProperty(properties, previous.sourceDomain, MANAGED_PROPERTIES.sourceDomain.type)
      || findManagedProperty(properties, MANAGED_PROPERTIES.sourceDomain),
    capturedAt: findPreviousProperty(properties, previous.capturedAt, MANAGED_PROPERTIES.capturedAt.type)
      || findManagedProperty(properties, MANAGED_PROPERTIES.capturedAt)
  };
}

function findPreviousProperty(properties, previous, type) {
  if (!previous?.id) return null;
  return properties.find((property) => property.id === previous.id && property.type === type) || null;
}

function schemaEntries(schema = {}) {
  return Object.entries(schema).map(([key, property]) => ({
    id: property.id || "",
    name: property.name || key,
    type: property.type || Object.keys(property).find((candidate) => candidate !== "id" && candidate !== "name") || ""
  }));
}

function findManagedProperty(properties, definition) {
  return properties.find((property) => property.name === definition.name && property.type === definition.type)
    || properties.find((property) => property.name.startsWith(`${definition.name} (Quick Note`) && property.type === definition.type)
    || null;
}

function hasManagedSchema(schema) {
  const map = managedPropertyMap(schema);
  return Boolean(map.title && map.captureId && map.sourceUrl && map.sourceDomain && map.capturedAt);
}

function missingManagedProperties(schema = {}) {
  const entries = schemaEntries(schema);
  const additions = {};
  for (const definition of Object.values(MANAGED_PROPERTIES)) {
    if (findManagedProperty(entries, definition)) continue;
    const name = uniqueManagedPropertyName(entries, definition.name);
    additions[name] = definition.schema;
    entries.push({ id: "", name, type: definition.type });
  }
  return additions;
}

function uniqueManagedPropertyName(properties, desiredName) {
  if (!properties.some((property) => property.name === desiredName)) return desiredName;
  let suffix = 1;
  let candidate = `${desiredName} (Quick Note)`;
  while (properties.some((property) => property.name === candidate)) {
    suffix += 1;
    candidate = `${desiredName} (Quick Note ${suffix})`;
  }
  return candidate;
}

function markerFromDescription(description = "") {
  if (!description.startsWith(MANAGED_DATABASE_DESCRIPTION_PREFIX)) return "";
  return description.slice(MANAGED_DATABASE_DESCRIPTION_PREFIX.length).trim();
}

async function resolveDataSourceId(token, value, fetchImpl) {
  const id = normalizeNotionId(value);
  const headers = { Authorization: `Bearer ${token}`, "Notion-Version": NOTION_API_VERSION };

  const direct = await fetchImpl(`https://api.notion.com/v1/data_sources/${id}`, { headers });
  if (direct.ok) return id;

  const database = await fetchImpl(`https://api.notion.com/v1/databases/${id}`, { headers });
  if (!database.ok) return id;
  const payload = await database.json();
  return payload.data_sources?.[0]?.id || id;
}
