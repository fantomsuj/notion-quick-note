import {
  MANAGED_DATABASE_SCHEMA_VERSION,
  MAX_CAPTURE_CHARACTERS,
  MAX_CAPTURE_TITLE_CHARACTERS
} from "./constants.js";
import type { CaptureDestination, CaptureSource, EditorMark, EditorNode, RemoteTarget, Settings, SyncJournal, TreeWriteJournal } from "./contracts.js";
import {
  appendBlockTree,
  NotionTreeWriteReviewError,
  type NotionAppendPosition,
  type NotionRemoteBlock,
  type NotionTreeRequestPort,
  type NotionWriteBlock
} from "./notion-tree-writer.js";

type NotionFetchPort = (input: string, init?: RequestInit) => Promise<Response>;

type JsonObject = Record<string, unknown>;
type NotionBlockType = string;

interface RichTextItem {
  type?: string;
  plain_text?: string;
  href?: string | null;
  text?: { content?: string; link?: { url?: string } | null };
  annotations?: {
    bold?: boolean; italic?: boolean; strikethrough?: boolean; underline?: boolean; code?: boolean; color?: string;
  };
}

interface NotionProperty {
  id?: string;
  name?: string;
  type?: string;
  title?: RichTextItem[];
}

interface NotionWriteProperty {
  title?: RichTextItem[];
  rich_text?: RichTextItem[];
  url?: string | null;
}

interface NotionBlockAttributes {
  rich_text?: RichTextItem[];
  children?: NotionEntity[];
  checked?: boolean;
  language?: string;
  list_start_index?: number;
  list_format?: string;
  url?: string;
  is_toggleable?: boolean;
  color?: string;
}

interface NotionEntity {
  [key: string]: unknown;
  id?: string;
  object?: string;
  type?: string;
  url?: string;
  title?: RichTextItem[];
  description?: RichTextItem[];
  results?: NotionEntity[];
  data_sources?: NotionEntity[];
  properties?: Record<string, NotionProperty>;
  parent?: { database_id?: string };
  database_id?: string;
  icon?: { type?: string; emoji?: string };
  has_more?: boolean;
  next_cursor?: string | null;
  has_children?: boolean;
  in_trash?: boolean;
  archived?: boolean;
  created_time?: string;
  last_edited_time?: string;
  message?: string;
  toggle?: NotionBlockAttributes;
  paragraph?: NotionBlockAttributes;
  heading_1?: NotionBlockAttributes;
  heading_2?: NotionBlockAttributes;
  heading_3?: NotionBlockAttributes;
  bulleted_list_item?: NotionBlockAttributes;
  numbered_list_item?: NotionBlockAttributes;
  to_do?: NotionBlockAttributes;
  quote?: NotionBlockAttributes;
  code?: NotionBlockAttributes;
  divider?: NotionBlockAttributes;
  bookmark?: { url?: string };
}

interface CaptureInput {
  document?: { version?: number; title?: string; doc?: EditorNode };
  selection?: string;
  text?: string;
  url?: string;
  pageTitle?: string;
  includeSource?: boolean;
  sources?: Array<Partial<CaptureSource>>;
  captureId?: string;
}

interface SourceLink {
  title: string;
  url: string;
  selection?: string;
  capturedAt?: number;
}

interface RichTextRun {
  text: string;
  href: string;
  annotations: Record<string, boolean | string>;
}

interface RequestDescription {
  method?: string;
  body?: unknown;
}

interface NotionRequestOptions {
  token: string;
  fetchImpl?: NotionFetchPort;
}

interface NotionApiErrorOptions {
  status?: number;
  code?: string;
  retryAfter?: number;
}

type NotionSettingsInput = Omit<Partial<Settings>, "destinationProperties"> & {
  destinationProperties?: Record<string, { id?: string; name?: string; type?: string }>;
};

interface RemoteInput {
  kind?: "page" | "section" | "legacy_section";
  id?: string;
  pageId?: string;
  url?: string;
  blockIds?: string[];
  previousSiblingId?: string;
  titlePropertyId?: string;
  fingerprint?: string;
}

interface NoteRecordInput {
  connectionId?: string;
  remote?: RemoteInput;
  syncJournal?: SyncJournal | null;
  pendingCapture?: CaptureInput;
  syncedCapture?: CaptureInput;
  capture?: CaptureInput;
  destination?: Partial<CaptureDestination>;
}

interface UpdateJournal {
  phase?: string;
  insertedSegments?: Record<string, string[]>;
  archivedIds?: string[];
}

interface EditableSegment {
  afterId: string;
  blocks: NotionEntity[];
}

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
  readonly status: number;
  readonly code: string;
  readonly retryAfter: number;
  timeout?: boolean;
  retryable?: boolean;

  constructor(message: string, { status = 0, code = "", retryAfter = 0 }: NotionApiErrorOptions = {}) {
    super(message);
    this.name = "NotionApiError";
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

export function normalizeNotionId(value = ""): string {
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

function richText(content: string, link = ""): RichTextItem[] {
  return splitTextContent(content).map((part) => ({
    type: "text",
    text: {
      content: part,
      ...(link ? { link: { url: link } } : {})
    }
  }));
}

function captureTitle(capture: CaptureInput): string {
  const explicit = capture.document?.title?.trim();
  const firstLine = explicit || firstDocumentText(capture.document?.doc) || (capture.text || "").trim().split("\n")[0];
  return Array.from(firstLine || capture.pageTitle || "Quick note")
    .slice(0, MAX_CAPTURE_TITLE_CHARACTERS)
    .join("");
}

function contentBlocks(capture: CaptureInput): NotionEntity[] {
  const blocks = capture.document?.doc
    ? notionBlocksFromDocument(capture.document.doc)
    : legacyContentBlocks(capture);

  blocks.push(...sourceBlocks(capture));
  return blocks;
}

function captureSources(capture: CaptureInput = {}): SourceLink[] {
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

function sourceBlocks(capture: CaptureInput): NotionEntity[] {
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

function legacyContentBlocks(capture: CaptureInput): NotionEntity[] {
  const blocks: NotionEntity[] = [];
  if (capture.selection?.trim()) blocks.push(notionTextBlock("quote", richText(capture.selection.trim())));
  for (const paragraph of (capture.text || "").trim().split(/\n{2,}/).filter(Boolean)) {
    blocks.push(notionTextBlock("paragraph", richText(paragraph)));
  }
  return blocks;
}

export function plainTextFromCapture(capture: CaptureInput = {}): string {
  if (capture.document?.doc) return documentText(capture.document.doc);
  return [capture.selection, capture.text].filter(Boolean).join("\n").trim();
}

export function notionBlocksFromDocument(doc: EditorNode | undefined): NotionEntity[] {
  if (!doc || doc.type !== "doc") return [];
  const blocks = (doc.content || []).flatMap((node) => notionBlocksFromNode(node));
  validateBlocks(blocks);
  return blocks;
}

function notionBlocksFromNode(node: EditorNode): NotionEntity[] {
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

function listBlocks(node: EditorNode, type: NotionBlockType): NotionEntity[] {
  const format = node.attrs?.type === "a" || node.attrs?.type === "A"
    ? "letters"
    : node.attrs?.type === "i" || node.attrs?.type === "I" ? "roman" : "numbers";
  return (node.content || []).map((item, index) => listItemBlock(item, type, type === "numbered_list_item" && index === 0
    ? { list_start_index: Number(node.attrs?.start) || 1, list_format: format }
    : {}));
}

function listItemBlock(item: EditorNode, type: NotionBlockType, attributes: JsonObject = {}): NotionEntity {
  const content = item.content || [];
  const firstTextBlock = content.find((child) => child.type === "paragraph") || content[0];
  const childNodes = firstTextBlock ? content.filter((child) => child !== firstTextBlock) : content;
  const children = childNodes.flatMap((child) => notionBlocksFromNode(child));
  return notionTextBlock(type, inlineRichText(firstTextBlock?.content), {
    ...attributes,
    ...(children.length ? { children } : {})
  });
}

function quoteBlocks(node: EditorNode): NotionEntity[] {
  const content = node.content || [];
  if (!content.length) return [notionTextBlock("quote", [])];
  const [first, ...rest] = content;
  if (!first) return [notionTextBlock("quote", [])];
  const children = rest.flatMap((child) => notionBlocksFromNode(child));
  return [notionTextBlock("quote", inlineRichText(first.content), children.length ? { children } : {})];
}

function notionTextBlock(type: NotionBlockType, richTextItems: RichTextItem[], attributes: JsonObject = {}): NotionEntity {
  return { object: "block", type, [type]: { rich_text: richTextItems, ...attributes } };
}

function inlineRichText(nodes: EditorNode[] = []): RichTextItem[] {
  const runs: RichTextRun[] = [];
  for (const node of nodes || []) {
    if (node.type === "hardBreak") {
      addRichTextRun(runs, "\n", [], "");
      continue;
    }
    if (node.type !== "text" || !node.text) continue;
    const linkMark = node.marks?.find((mark) => mark.type === "link");
    const href = linkMark?.attrs?.href;
    addRichTextRun(runs, node.text, node.marks || [], typeof href === "string" ? href : "");
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

function addRichTextRun(runs: RichTextRun[], text: string, marks: EditorMark[], href: string): void {
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

function sameAnnotations(left: Record<string, boolean | string>, right: Record<string, boolean | string>): boolean {
  return Object.keys(left).every((key) => left[key] === right[key]);
}

function splitTextContent(content = ""): string[] {
  const characters = Array.from(content);
  const chunks = [];
  for (let index = 0; index < characters.length; index += MAX_TEXT_CONTENT) {
    chunks.push(characters.slice(index, index + MAX_TEXT_CONTENT).join(""));
  }
  return chunks;
}

function documentText(node: EditorNode | undefined): string {
  if (!node) return "";
  if (node.type === "text") return node.text || "";
  if (node.type === "hardBreak") return "\n";
  return (node.content || []).map(documentText).filter(Boolean).join(node.type === "doc" ? "\n" : "").trim();
}

function firstDocumentText(node: EditorNode | undefined): string {
  return documentText(node).trim().split("\n")[0] || "";
}

function notionCodeLanguage(language: unknown): string {
  const supported = new Set(["bash", "c", "c++", "c#", "css", "diff", "docker", "go", "graphql", "html", "java", "javascript", "json", "kotlin", "latex", "markdown", "mermaid", "php", "plain text", "python", "r", "ruby", "rust", "shell", "sql", "swift", "typescript", "xml", "yaml"]);
  return typeof language === "string" && supported.has(language) ? language : "plain text";
}

function validateBlocks(blocks: NotionEntity[]): void {
  let total = 0;
  const visit = (items: NotionEntity[]): void => {
    if (items.length > MAX_BLOCK_CHILDREN) throw new Error("Quick Note supports up to 100 blocks in one section.");
    for (const block of items) {
      total += 1;
      const children = blockAttributes(block).children || [];
      if (children.length) visit(children);
    }
  };
  visit(blocks);
  if (total > MAX_BLOCKS_PER_PAYLOAD) throw new Error("This note contains too many blocks for one capture.");
}

export function buildCaptureRequest(settings: NotionSettingsInput, capture: CaptureInput, now = new Date()): {
  path: string;
  method: string;
  body: {
    parent?: { type: string; data_source_id: string };
    properties?: Record<string, NotionWriteProperty>;
    children: NotionEntity[];
  };
} {
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

function validateTopLevelChildren(children: NotionEntity[]): NotionEntity[] {
  validateBlocks(children);
  if (children.length > MAX_BLOCK_CHILDREN) {
    throw new Error("This quick note has too many top-level blocks. Combine a few lines before saving.");
  }
  return children;
}

export function normalizeSourceDomain(value = ""): string {
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol)) return "";
    return url.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function managedDatabaseDescription(marker: string): string {
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

export async function createQuickNotesDatabase({ token, name = MANAGED_DATABASE_NAME, marker = "", fetchImpl = fetch }: NotionRequestOptions & { name?: string; marker?: string }) {
  if (!token) throw new Error("Connect Notion first.");
  const request = buildQuickNotesDatabaseRequest(name, marker);
  const payload = await notionRequest(token, request.path, request, fetchImpl);

  const dataSources = notionEntityArray(payload, "data_sources");
  const databaseId = Reflect.get(payload, "id");
  const dataSourceId = dataSources?.[0] ? Reflect.get(dataSources[0], "id") : undefined;
  if (!isNonEmptyString(databaseId) || !isNonEmptyString(dataSourceId)) {
    throw invalidSuccessResponse("Notion created the database but returned incomplete destination details.");
  }

  return loadManagedDestination({
    token,
    databaseId,
    dataSourceId,
    marker,
    fallbackDatabase: payload,
    fetchImpl
  });
}

export async function findManagedQuickNotesDatabase({ token, marker = "", allowAnyMarker = false, fetchImpl = fetch }: NotionRequestOptions & { marker?: string; allowAnyMarker?: boolean }) {
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

    const results = requiredEntityArray(payload, "results", "Notion returned an incomplete search response.");
    const pagination = paginationEnvelope(payload, "Notion returned a malformed search pagination response.");
    validateSearchResults(results);
    const candidates = results
      .filter((item) => !item.in_trash && item.object === "data_source" && plainText(item.title) === MANAGED_DATABASE_NAME)
      .sort((left, right) => Date.parse(right.created_time || "") - Date.parse(left.created_time || ""));

    for (const candidate of candidates) {
      const databaseId = parentDatabaseId(candidate);
      if (!databaseId) continue;
      const database = await retrieveDatabase({ token, databaseId, fetchImpl });
      const description = plainText(database.description);
      const recoveredMarker = markerFromDescription(description);
      if (!recoveredMarker || (!allowAnyMarker && recoveredMarker !== marker)) continue;

      if (!candidate.id) continue;
      const dataSource = await retrieveDataSource({ token, dataSourceId: candidate.id, fetchImpl });
      const properties = notionPropertyMap(dataSource);
      if (!properties || !hasManagedSchema(properties)) continue;
      return managedDestination(database, dataSource, recoveredMarker);
    }
    startCursor = pagination.hasMore ? pagination.nextCursor || undefined : undefined;
  } while (startCursor);
  return null;
}

export async function migrateManagedQuickNotesDatabase({ token, settings, marker, fetchImpl = fetch }: NotionRequestOptions & { settings: NotionSettingsInput; marker: string }) {
  if (!token) throw new Error("Connect Notion first.");
  if (!settings.destinationId) throw new Error("Could not find the Quick Notes data source.");
  let dataSource = await retrieveDataSource({ token, dataSourceId: settings.destinationId, fetchImpl });
  const dataSourceProperties = notionPropertyMap(dataSource);
  if (!dataSourceProperties) throw invalidSuccessResponse("Notion returned an incomplete data source response.");
  const databaseId = settings.destinationDatabaseId || parentDatabaseId(dataSource);
  if (!databaseId) throw new Error("Could not find the parent Quick Notes database.");
  const database = await retrieveDatabase({ token, databaseId, fetchImpl });

  const additions = missingManagedProperties(dataSourceProperties);
  if (Object.keys(additions).length) {
    dataSource = await notionRequest(token, `/v1/data_sources/${normalizeNotionId(dataSource.id)}`, {
      method: "PATCH",
      body: { properties: additions }
    }, fetchImpl);
    if (!isNonEmptyString(Reflect.get(dataSource, "id")) || !notionPropertyMap(dataSource)) {
      throw invalidSuccessResponse("Notion returned an incomplete updated data source response.");
    }
  }

  await notionRequest(token, `/v1/databases/${normalizeNotionId(databaseId)}`, {
    method: "PATCH",
    body: { description: richText(managedDatabaseDescription(marker)) }
  }, fetchImpl);

  const refreshedDatabase = { ...database, description: richText(managedDatabaseDescription(marker)) };
  return managedDestination(refreshedDatabase, dataSource, marker);
}

export async function refreshManagedDestination({ token, settings, fetchImpl = fetch }: NotionRequestOptions & { settings: NotionSettingsInput }) {
  if (!settings.destinationId) throw new Error("Could not find the Quick Notes data source.");
  const dataSource = await retrieveDataSource({ token, dataSourceId: settings.destinationId, fetchImpl });
  if (!notionPropertyMap(dataSource)) throw invalidSuccessResponse("Notion returned an incomplete data source response.");
  const databaseId = settings.destinationDatabaseId || parentDatabaseId(dataSource);
  const database = databaseId
    ? await retrieveDatabase({ token, databaseId, fetchImpl })
    : { id: "", title: richText(settings.destinationName || MANAGED_DATABASE_NAME), url: settings.destinationUrl || "" };
  return managedDestination(
    database,
    dataSource,
    settings.destinationMarker || markerFromDescription(plainText(database.description)),
    settings.destinationProperties
  );
}

export async function retrieveDatabase({ token, databaseId, fetchImpl = fetch }: NotionRequestOptions & { databaseId: string }): Promise<NotionEntity> {
  const payload = await notionRequest(token, `/v1/databases/${normalizeNotionId(databaseId)}`, { method: "GET" }, fetchImpl);
  if (!isValidDatabase(payload)) throw invalidSuccessResponse("Notion returned an incomplete database response.");
  return payload;
}

export async function retrieveDataSource({ token, dataSourceId, fetchImpl = fetch }: NotionRequestOptions & { dataSourceId: string }): Promise<NotionEntity> {
  const payload = await notionRequest(token, `/v1/data_sources/${normalizeNotionId(dataSourceId)}`, { method: "GET" }, fetchImpl);
  if (!isNonEmptyString(Reflect.get(payload, "id"))) throw invalidSuccessResponse("Notion returned an incomplete data source response.");
  parentDatabaseId(payload);
  return payload;
}

export async function validateDestinationHealth({ token, settings, fetchImpl = fetch }: NotionRequestOptions & { settings: NotionSettingsInput }) {
  if (!token || !settings?.destinationId) throw new Error("Connect Notion and choose a destination.");
  if (settings.destinationType === "database") {
    const dataSourceId = settings.managedDestination
      ? settings.destinationId
      : await resolveDataSourceId(token, settings.destinationId, fetchImpl);
    const dataSource = await retrieveDataSource({ token, dataSourceId, fetchImpl });
    validateDestinationAvailability(dataSource, ["in_trash"], "Notion returned an incomplete data source response.");
    if (dataSource.in_trash) throw new NotionApiError("The selected database is in the trash.", { status: 403, code: "destination_trashed" });
    return { ok: true, id: dataSource.id };
  }
  const block = await notionRequest(token, `/v1/blocks/${normalizeNotionId(settings.destinationId)}`, { method: "GET" }, fetchImpl);
  validateDestinationAvailability(block, ["in_trash", "archived"], "Notion returned an incomplete page response.");
  if (block.in_trash || block.archived) throw new NotionApiError("The selected page is unavailable.", { status: 403, code: "destination_unavailable" });
  return { ok: true, id: block.id };
}

export async function sendCapture({
  token,
  settings,
  capture,
  connectionId = "",
  journal = {},
  onJournal = async () => undefined,
  fetchImpl = fetch,
  now = () => new Date()
}: NotionRequestOptions & {
  settings: NotionSettingsInput;
  capture: CaptureInput;
  connectionId?: string;
  journal?: SyncJournal;
  onJournal?: (journal: SyncJournal) => Promise<void>;
  now?: () => Date;
}): Promise<RemoteTarget> {
  if (!token) throw new Error("Connect Notion in Settings first.");
  if (!settings.destinationId) throw new Error("Choose a Notion destination in Settings.");
  const resolvedSettings = settings.destinationType === "database"
    ? {
        ...settings,
        destinationId: settings.managedDestination
          ? settings.destinationId
          : await resolveDataSourceId(token, settings.destinationId, fetchImpl)
      }
    : settings;
  const destinationParentId = normalizeNotionId(resolvedSettings.destinationId || settings.destinationId);
  const destinationType = resolvedSettings.destinationType === "database" ? "database" : "page";
  const existingTree = journal.treeWrite;
  if (existingTree && (existingTree.connectionId !== connectionId
    || existingTree.destinationType !== destinationType
    || normalizeNotionId(existingTree.destinationParentId) !== destinationParentId)) {
    throw new NotionTreeIdentityError();
  }

  let treeWrite: TreeWriteJournal = existingTree ? cloneTreeWrite(existingTree) : {
    version: 1,
    phase: destinationType === "database" ? "creating_page" : "writing",
    connectionId,
    destinationType,
    destinationParentId,
    ...(destinationType === "page" ? {
      pageId: destinationParentId,
      ...(resolvedSettings.destinationUrl ? { pageUrl: resolvedSettings.destinationUrl } : {})
    } : {}),
    operationTimestamp: now().toISOString(),
    groups: {},
    archivedBlockIds: []
  };
  const persistTree = async (next: TreeWriteJournal): Promise<void> => {
    treeWrite = cloneTreeWrite(next);
    await onJournal({ ...journal, treeWrite: cloneTreeWrite(next) });
  };
  if (!existingTree) await persistTree(treeWrite);

  const built = buildCaptureRequest({ ...resolvedSettings, destinationId: destinationParentId }, capture, new Date(treeWrite.operationTimestamp));
  let pageId = treeWrite.pageId || "";
  let pageUrl = treeWrite.pageUrl || resolvedSettings.destinationUrl || "";
  let createdFingerprint = "";

  if (destinationType === "database" && !pageId) {
    if (resolvedSettings.managedDestination && capture.captureId) {
      const existing = await findManagedCaptureById({ token, settings: resolvedSettings, captureId: capture.captureId, fetchImpl });
      if (existing) {
        pageId = existing.id;
        pageUrl = existing.url;
      }
    }
    if (!pageId) {
      let created: NotionEntity;
      try {
        created = await notionRequest(token, "/v1/pages", {
          method: "POST",
          body: {
            parent: built.body.parent,
            properties: built.body.properties
          }
        }, fetchImpl);
      } catch (error) {
        if (!resolvedSettings.managedDestination && isAmbiguousNotionMutation(error)) {
          throw new NotionTreeWriteReviewError("Notion may have created this database page. Review the destination before retrying.");
        }
        throw error;
      }
      const id = Reflect.get(created, "id");
      const url = Reflect.get(created, "url");
      const lastEditedTime = Reflect.get(created, "last_edited_time");
      if (!isNonEmptyString(id) || !isNonEmptyString(url) || !isNonEmptyString(lastEditedTime)) {
        throw invalidSuccessResponse("Notion returned incomplete created page details.");
      }
      pageId = id;
      pageUrl = url;
      createdFingerprint = lastEditedTime;
    }
    treeWrite = { ...treeWrite, phase: "writing", pageId, pageUrl };
    await persistTree(treeWrite);
  }

  const blocks = destinationType === "database"
    ? contentBlocks(capture)
    : [
        {
          object: "block",
          type: "heading_3",
          heading_3: { rich_text: richText(captureTitle(capture)), is_toggleable: false }
        },
        ...contentBlocks(capture),
        notionTextBlock("paragraph", richText(`Captured ${new Date(treeWrite.operationTimestamp).toLocaleString()}`), { color: "gray" }),
        { object: "block", type: "divider", divider: {} }
      ];
  validateTopLevelChildren(blocks);
  const written = await appendBlockTree({
    parentId: pageId || destinationParentId,
    blocks: blocks as NotionWriteBlock[],
    namespace: destinationType === "database" ? "capture/content" : "capture/section",
    journal: treeWrite,
    onProgress: persistTree,
    request: notionTreeRequestPort(token, fetchImpl),
    reconcileMissingGroups: Boolean(existingTree)
  });
  treeWrite = written.journal;

  if (destinationType === "database") {
    const finalPage = await notionRequest(token, `/v1/pages/${normalizeNotionId(pageId)}`, {}, fetchImpl);
    if (!isValidFinalPage(finalPage)) throw invalidSuccessResponse("Notion returned incomplete final page details.");
    treeWrite = { ...treeWrite, phase: "complete" };
    await persistTree(treeWrite);
    return {
      kind: "page",
      id: pageId,
      pageId,
      url: pageUrl || String(finalPage.url || ""),
      blockIds: [],
      fingerprint: String(finalPage.last_edited_time || createdFingerprint)
    };
  }

  treeWrite = { ...treeWrite, phase: "complete" };
  await persistTree(treeWrite);
  return {
    kind: "section",
    id: destinationParentId,
    pageId: destinationParentId,
    url: pageUrl,
    blockIds: written.rootBlockIds,
    fingerprint: written.rootBlockIds.join("|")
  };
}

class NotionTreeIdentityError extends NotionApiError {
  constructor() {
    super("This delivery journal belongs to a different Notion destination.", { status: 409, code: "tree_write_destination_changed" });
    this.name = "NotionTreeIdentityError";
  }
}

function cloneTreeWrite(journal: TreeWriteJournal): TreeWriteJournal {
  return {
    ...journal,
    groups: Object.fromEntries(Object.entries(journal.groups).map(([path, ids]) => [path, [...ids]])),
    archivedBlockIds: [...journal.archivedBlockIds]
  };
}

function notionTreeRequestPort(token: string, fetchImpl: NotionFetchPort): NotionTreeRequestPort {
  return {
    appendChildren: async (parentId: string, children: NotionWriteBlock[], position?: NotionAppendPosition) => {
      const result = await notionRequest(token, `/v1/blocks/${normalizeNotionId(parentId)}/children`, {
        method: "PATCH",
        body: { children, ...(position ? { position } : {}) }
      }, fetchImpl);
      const blocks = requiredEntityArray(result, "results", "Notion returned incomplete inserted block details.");
      return requiredEntityIds(blocks, "Notion returned an inserted block without an ID.").map((id) => ({ id }));
    },
    retrieveChildren: async (parentId: string): Promise<NotionRemoteBlock[]> => retrieveDirectChildren({ token, blockId: parentId, fetchImpl }),
    isAmbiguousMutation: (error: unknown): boolean => {
      if (!(error instanceof NotionApiError)) return false;
      return error.code !== "invalid_response"
        && (error.timeout === true || error.code === "network_error" || error.status >= 500);
    }
  };
}

async function retrieveDirectChildren({ token, blockId, fetchImpl }: NotionRequestOptions & { blockId: string }): Promise<NotionRemoteBlock[]> {
  const results: NotionRemoteBlock[] = [];
  let cursor = "";
  do {
    const query = new URLSearchParams({ page_size: "100" });
    if (cursor) query.set("start_cursor", cursor);
    const page = await notionRequest(token, `/v1/blocks/${normalizeNotionId(blockId)}/children?${query}`, {}, fetchImpl);
    const blocks = requiredEntityArray(page, "results", "Notion returned an incomplete block list.");
    const pagination = paginationEnvelope(page, "Notion returned a malformed block pagination response.");
    if (!blocks.every(isValidBlock)) throw invalidSuccessResponse("Notion returned an incomplete block response.");
    results.push(...blocks);
    cursor = pagination.hasMore ? pagination.nextCursor || "" : "";
  } while (cursor);
  return results;
}

function captureRemoteTarget(result: NotionEntity, settings: NotionSettingsInput): RemoteTarget {
  if (settings.destinationType === "database") {
    const id = Reflect.get(result, "id");
    const url = Reflect.get(result, "url");
    const lastEditedTime = Reflect.get(result, "last_edited_time");
    if (!isNonEmptyString(id) || !isNonEmptyString(url) || !isNonEmptyString(lastEditedTime)) {
      throw invalidSuccessResponse("Notion returned incomplete created page details.");
    }
    return {
      kind: "page",
      id,
      pageId: id,
      url,
      blockIds: [],
      fingerprint: lastEditedTime
    };
  }

  const blocks = requiredEntityArray(result, "results", "Notion returned incomplete inserted block details.");
  const blockIds = requiredEntityIds(blocks, "Notion returned incomplete inserted block details.");
  for (const block of blocks) {
    const lastEditedTime = Reflect.get(block, "last_edited_time");
    if (lastEditedTime !== undefined && typeof lastEditedTime !== "string") {
      throw invalidSuccessResponse("Notion returned malformed inserted block details.");
    }
  }
  const pageId = settings.destinationId || "";
  return {
    kind: "section",
    id: pageId,
    pageId,
    url: settings.destinationUrl || "",
    blockIds,
    fingerprint: blocks.map((block) => `${block.id}:${block.last_edited_time || ""}:0`).join("|")
  };
}

export class NotionConflictError extends NotionApiError {
  constructor(message = "This note changed in Notion after it was opened. Your local edit is preserved.") {
    super(message, { status: 409, code: "remote_conflict" });
    this.name = "NotionConflictError";
  }
}

export async function loadRemoteNote({ token, record, fetchImpl = fetch }: NotionRequestOptions & { record: NoteRecordInput }) {
  const remote = record?.remote || {};
  if (!remote.id && !remote.pageId) throw new NotionApiError("This older capture can only be opened in Notion.", { status: 400, code: "remote_edit_unavailable" });
  if (remote.kind === "legacy_section") throw new NotionApiError("This older running-page capture can only be opened in Notion.", { status: 400, code: "remote_edit_unavailable" });

  const pageId = normalizeNotionId(remote.pageId || remote.id);
  const [page, allBlocks] = await Promise.all([
    notionRequest(token, `/v1/pages/${pageId}`, {}, fetchImpl),
    retrieveBlockTree({ token, blockId: pageId, fetchImpl })
  ]);
  if (!isValidPage(page)) throw invalidSuccessResponse("Notion returned an incomplete page response.");
  if (page.in_trash) throw new NotionApiError("This note is in the Notion trash.", { status: 404, code: "object_not_found" });

  let blocks = allBlocks;
  let previousSiblingId = "";
  if (remote.kind === "section") {
    const journalIds = [
      ...Object.values(record.syncJournal?.insertedSegments || {}).flat(),
      ...Object.values(record.syncJournal?.treeWrite?.groups || {}).flat()
    ];
    const tracked = new Set([...(remote.blockIds || []), ...journalIds]);
    blocks = allBlocks.filter((block) => typeof block.id === "string" && tracked.has(block.id));
    if (!blocks.length) throw new NotionApiError("This note section is no longer available in the running page.", { status: 404, code: "section_not_found" });
    const firstBlock = blocks[0];
    const firstIndex = allBlocks.findIndex((block) => block.id === firstBlock?.id);
    previousSiblingId = firstIndex > 0 ? allBlocks[firstIndex - 1]?.id || "" : "";
  }
  const trackedBlocks = blocks;

  let title = pageTitle(page);
  if (remote.kind === "section" && blocks[0]?.type === "heading_3") {
    title = blockPlainText(blocks[0]) || title;
    blocks = blocks.slice(1);
  }
  if (remote.kind === "section" && blocks.at(-1)?.type === "divider") blocks = blocks.slice(0, -1);
  if (remote.kind === "section" && /^Captured |^Updated /.test(blockPlainText(blocks.at(-1)))) blocks = blocks.slice(0, -1);

  const recordSources = captureSources(record.pendingCapture || record.syncedCapture || record.capture || {});
  const legacySourceUrls = new Set(recordSources.map((source) => source.url));
  blocks = blocks.filter((block) => !(block.type === "bookmark" && typeof block.bookmark?.url === "string" && legacySourceUrls.has(block.bookmark.url)));
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
      blockIds: (remote.kind === "section" ? blocks : allBlocks).map((block) => block.id).filter((id): id is string => Boolean(id)),
      previousSiblingId,
      titlePropertyId,
      fingerprint
    },
    _blocks: blocks,
    _trackedBlocks: trackedBlocks,
    _allBlocks: allBlocks
  };
}

export async function updateRemoteNote(options: NotionRequestOptions & {
  record: NoteRecordInput;
  capture: CaptureInput;
  baseFingerprint?: string;
  journal?: SyncJournal;
  onJournal?: (journal: SyncJournal & { phase: string }) => Promise<void>;
  now?: () => Date;
}): Promise<RemoteTarget> {
  const journal = options.journal || {};
  if (journal.insertedSegments && !journal.treeWrite) {
    const legacy = await updateRemoteNoteLegacy({
      ...options,
      journal: {
        ...(typeof journal.phase === "string" ? { phase: journal.phase } : {}),
        insertedSegments: journal.insertedSegments,
        ...(journal.archivedIds ? { archivedIds: journal.archivedIds } : {})
      },
      onJournal: options.onJournal
        ? async (next) => options.onJournal?.(next)
        : async () => undefined
    });
    return { ...legacy, id: legacy.id || legacy.pageId };
  }
  return updateRemoteNoteTree(options);
}

async function updateRemoteNoteLegacy({ token, record, capture, baseFingerprint, journal = {}, onJournal = async () => {}, fetchImpl = fetch }: NotionRequestOptions & {
  record: NoteRecordInput;
  capture: CaptureInput;
  baseFingerprint?: string;
  journal?: UpdateJournal;
  onJournal?: (journal: Required<UpdateJournal>) => Promise<void>;
}) {
  const loaded = await loadRemoteNote({ token, record, fetchImpl });
  const started = Object.keys(journal.insertedSegments || {}).length > 0 || (journal.archivedIds || []).length > 0;
  if (!started && baseFingerprint && loaded.baseFingerprint !== baseFingerprint) throw new NotionConflictError();

  const remote = loaded.remote;
  const placeholderIds = new Set(opaqueBlockIds(capture.document?.doc));
  const insertedIds = new Set(Object.values(journal.insertedSegments || {}).flat());
  const oldEditableIds = loaded._trackedBlocks
    .filter((block) => typeof block.id === "string" && !placeholderIds.has(block.id) && !insertedIds.has(block.id))
    .map((block) => block.id)
    .filter((id): id is string => typeof id === "string");
  const segments = editableSegments(capture.document?.doc);
  const sources = sourceBlocks(capture);
  if (sources.length) {
    if (!segments.length) segments.push({ afterId: "", blocks: [] });
    segments.at(-1)?.blocks.push(...sources);
  }
  if (remote.kind === "section") {
    const wrapperStart = {
      object: "block",
      type: "heading_3",
      heading_3: { rich_text: richText(captureTitle(capture)), is_toggleable: false }
    };
    if (!segments.length) segments.push({ afterId: "", blocks: [] });
    segments[0]?.blocks.unshift(wrapperStart);
    segments.at(-1)?.blocks.push(
      notionTextBlock("paragraph", richText(`Updated ${new Date().toLocaleString()}`), { color: "gray" }),
      { object: "block", type: "divider", divider: {} }
    );
  }

  const nextJournal: Required<UpdateJournal> = {
    phase: journal.phase || "inserting",
    insertedSegments: { ...(journal.insertedSegments || {}) },
    archivedIds: [...(journal.archivedIds || [])]
  };
  for (let index = 0; index < segments.length; index += 1) {
    if (nextJournal.insertedSegments[index]) continue;
    const segment = segments[index];
    if (!segment) continue;
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
    const insertedBlocks = requiredEntityArray(result, "results", "Notion returned incomplete inserted block details.");
    const insertedBlockIds = requiredEntityIds(insertedBlocks, "Notion returned an inserted block without an ID.");
    nextJournal.insertedSegments[index] = insertedBlockIds;
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
    await notionRequest(token, `/v1/pages/${normalizeNotionId(remote.pageId || loaded.remote.pageId)}`, {
      method: "PATCH",
      body: {
        properties: {
          [remote.titlePropertyId || record.destination?.titleProperty || "title"]: { title: richText(captureTitle(capture)) },
          ...managedSourceProperties(record.destination, capture)
        }
      }
    }, fetchImpl);
  }

  const createdIds = segments.flatMap((_, index) => nextJournal.insertedSegments[index] || []);
  const finalPage = await notionRequest(token, `/v1/pages/${normalizeNotionId(remote.pageId || loaded.remote.pageId)}`, {}, fetchImpl);
  if (!isValidFinalPage(finalPage)) throw invalidSuccessResponse("Notion returned incomplete final page details.");
  nextJournal.phase = "complete";
  await onJournal(nextJournal);
  return {
    ...remote,
    id: remote.id || finalPage.id,
    url: remote.url || finalPage.url || "",
    blockIds: remote.kind === "section" ? orderedRemoteIds(capture.document?.doc, nextJournal.insertedSegments) : [],
    fingerprint: remote.kind === "section" ? `updated:${finalPage.last_edited_time || Date.now()}:${createdIds.join(",")}` : String(finalPage.last_edited_time || "")
  };
}

async function updateRemoteNoteTree({
  token,
  record,
  capture,
  baseFingerprint,
  journal = {},
  onJournal = async () => undefined,
  fetchImpl = fetch,
  now = () => new Date()
}: NotionRequestOptions & {
  record: NoteRecordInput;
  capture: CaptureInput;
  baseFingerprint?: string;
  journal?: SyncJournal;
  onJournal?: (journal: SyncJournal & { phase: string }) => Promise<void>;
  now?: () => Date;
}): Promise<RemoteTarget> {
  const loaded = await loadRemoteNote({ token, record, fetchImpl });
  const currentTree = journal.treeWrite;
  const hasMutationEvidence = Boolean(currentTree && (
    Object.values(currentTree.groups).some((ids) => ids.length > 0)
    || currentTree.archivedBlockIds.length > 0
  ));
  if (!hasMutationEvidence && baseFingerprint && loaded.baseFingerprint !== baseFingerprint) throw new NotionConflictError();

  const remote = loaded.remote;
  const destinationType: TreeWriteJournal["destinationType"] = remote.kind === "section"
    ? "page"
    : record.destination?.destinationType === "database" ? "database" : "page";
  const destinationParentId = normalizeNotionId(record.destination?.destinationId || remote.pageId);
  if (currentTree && (currentTree.connectionId !== (record.connectionId || "")
    || currentTree.destinationType !== destinationType
    || normalizeNotionId(currentTree.destinationParentId) !== destinationParentId
    || normalizeNotionId(currentTree.pageId || "") !== normalizeNotionId(remote.pageId))) {
    throw new NotionTreeIdentityError();
  }

  let treeWrite: TreeWriteJournal = currentTree ? cloneTreeWrite(currentTree) : {
    version: 1,
    phase: "writing",
    connectionId: record.connectionId || "",
    destinationType,
    destinationParentId,
    pageId: normalizeNotionId(remote.pageId),
    ...(remote.url ? { pageUrl: remote.url } : {}),
    operationTimestamp: now().toISOString(),
    groups: {},
    archivedBlockIds: []
  };
  const persistTree = async (next: TreeWriteJournal): Promise<void> => {
    treeWrite = cloneTreeWrite(next);
    await onJournal({ ...journal, phase: next.phase, treeWrite: cloneTreeWrite(next) });
  };
  if (!currentTree) await persistTree(treeWrite);

  const segments = replacementTreeSegments(capture, remote.kind, treeWrite.operationTimestamp);
  if (treeWrite.phase === "complete") {
    return {
      ...remote,
      id: remote.id || remote.pageId,
      blockIds: remote.kind === "section" ? orderedTreeRemoteIds(capture.document?.doc, treeWrite.groups, segments) : [],
      fingerprint: loaded.baseFingerprint
    };
  }

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (!segment?.blocks.length) continue;
    const afterId = segment.afterId || (index === 0 ? remote.previousSiblingId : "");
    const rootPosition: NotionAppendPosition = afterId
      ? { type: "after_block", after_block: { id: normalizeNotionId(afterId) } }
      : { type: "start" };
    const written = await appendBlockTree({
      parentId: normalizeNotionId(remote.pageId),
      blocks: segment.blocks as NotionWriteBlock[],
      rootPosition,
      namespace: `update/segment/${index}`,
      journal: treeWrite,
      onProgress: persistTree,
      request: notionTreeRequestPort(token, fetchImpl),
      reconcileMissingGroups: Boolean(currentTree)
    });
    treeWrite = written.journal;
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

  if (treeWrite.phase !== "archiving") {
    treeWrite = { ...treeWrite, phase: "archiving" };
    await persistTree(treeWrite);
  }
  const placeholderIds = new Set(opaqueBlockIds(capture.document?.doc));
  const replacementRootIds = new Set(Object.entries(treeWrite.groups)
    .filter(([path]) => path.startsWith("update/segment/") && path.split("/").length === 3)
    .flatMap(([, ids]) => ids));
  const oldEditableIds = loaded._trackedBlocks
    .filter((block) => typeof block.id === "string" && !placeholderIds.has(block.id) && !replacementRootIds.has(block.id))
    .map((block) => block.id)
    .filter((id): id is string => typeof id === "string");

  for (const id of oldEditableIds) {
    if (treeWrite.archivedBlockIds.includes(id)) continue;
    try {
      await notionRequest(token, `/v1/blocks/${normalizeNotionId(id)}`, { method: "DELETE" }, fetchImpl);
    } catch (error) {
      if (!isAmbiguousNotionMutation(error)) throw error;
      const retrieved = await notionRequest(token, `/v1/blocks/${normalizeNotionId(id)}`, {}, fetchImpl);
      if (retrieved.in_trash !== true) {
        throw new NotionTreeWriteReviewError("Notion may not have archived an old note block. Review the note before retrying.");
      }
    }
    treeWrite = { ...treeWrite, archivedBlockIds: [...treeWrite.archivedBlockIds, id] };
    await persistTree(treeWrite);
  }

  const finalPage = await notionRequest(token, `/v1/pages/${normalizeNotionId(remote.pageId)}`, {}, fetchImpl);
  if (!isValidFinalPage(finalPage)) throw invalidSuccessResponse("Notion returned incomplete final page details.");
  treeWrite = { ...treeWrite, phase: "complete" };
  await persistTree(treeWrite);
  const rootIds = Object.entries(treeWrite.groups)
    .filter(([path]) => path.startsWith("update/segment/") && path.split("/").length === 3)
    .flatMap(([, ids]) => ids);
  return {
    ...remote,
    id: remote.id || String(finalPage.id || ""),
    url: remote.url || String(finalPage.url || ""),
    blockIds: remote.kind === "section" ? orderedTreeRemoteIds(capture.document?.doc, treeWrite.groups, segments) : [],
    fingerprint: remote.kind === "section"
      ? `updated:${finalPage.last_edited_time || treeWrite.operationTimestamp}:${rootIds.join(",")}`
      : String(finalPage.last_edited_time || "")
  };
}

export function notionDocumentFromBlocks(blocks: NotionEntity[] = []): { doc: EditorNode; sources: CaptureSource[] } {
  const content: EditorNode[] = [];
  const sources: CaptureSource[] = [];
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (!block) continue;
    if (isSourcesBlock(block)) {
      sources.push(...sourcesFromBlock(block));
      continue;
    }
    if (isListBlockType(block.type) && isSafelyEditableListBlock(block)) {
      const type = block.type;
      const items: EditorNode[] = [];
      while (blocks[index]?.type === type) {
        const currentBlock = blocks[index];
        if (!currentBlock || !isSafelyEditableListBlock(currentBlock)) break;
        items.push(listNodeFromBlock(currentBlock, type));
        index += 1;
      }
      index -= 1;
      content.push({
        type: type === "bulleted_list_item" ? "bulletList" : type === "numbered_list_item" ? "orderedList" : "taskList",
        ...(type === "numbered_list_item" ? { attrs: { start: Number(blockAttributes(block).list_start_index || 1), type: blockAttributes(block).list_format === "letters" ? "a" : blockAttributes(block).list_format === "roman" ? "i" : "1" } } : {}),
        content: items
      });
      continue;
    }
    content.push(notionNodeFromBlock(block));
  }
  return { doc: { type: "doc", content: content.length ? content : [{ type: "paragraph" }] }, sources };
}

function isSafelyEditableListBlock(block: NotionEntity = {}): boolean {
  if (!isListBlockType(block.type)) return false;
  return (blockAttributes(block).children || []).every((child) => {
    if (isListBlockType(child.type)) return isSafelyEditableListBlock(child);
    const attrs = blockAttributes(child);
    return ["paragraph", "heading_1", "heading_2", "heading_3", "quote", "toggle", "code", "divider"].includes(child.type || "")
      && !(attrs.children || []).length;
  });
}

function isListBlockType(type: unknown): type is "bulleted_list_item" | "numbered_list_item" | "to_do" {
  return type === "bulleted_list_item" || type === "numbered_list_item" || type === "to_do";
}

async function retrieveBlockTree({ token, blockId, fetchImpl }: NotionRequestOptions & { blockId: string }): Promise<NotionEntity[]> {
  const results: NotionEntity[] = [];
  let cursor = "";
  do {
    const query = new URLSearchParams({ page_size: "100" });
    if (cursor) query.set("start_cursor", cursor);
    const page = await notionRequest(token, `/v1/blocks/${normalizeNotionId(blockId)}/children?${query}`, {}, fetchImpl);
    const blocks = requiredEntityArray(page, "results", "Notion returned an incomplete block list.");
    const pagination = paginationEnvelope(page, "Notion returned a malformed block pagination response.");
    for (const block of blocks) {
      if (!isValidBlock(block)) {
        throw invalidSuccessResponse("Notion returned an incomplete block response.");
      }
      if (block.has_children) {
        if (!block.id) throw invalidSuccessResponse("Notion returned a child block without an ID.");
        const children = await retrieveBlockTree({ token, blockId: block.id, ...(fetchImpl ? { fetchImpl } : {}) });
        block[String(block.type)] = { ...blockAttributes(block), children };
      }
      results.push(block);
    }
    cursor = pagination.hasMore ? pagination.nextCursor || "" : "";
  } while (cursor);
  return results;
}

function notionNodeFromBlock(block: NotionEntity = {}): EditorNode {
  const attrs = blockAttributes(block);
  if ((attrs.children || []).length) return opaqueNode(block);
  const inline = inlineNodesFromRichText(attrs.rich_text || []);
  if (block.type === "paragraph") return { type: "paragraph", ...(inline.length ? { content: inline } : {}) };
  if (/^heading_[1-3]$/.test(block.type || "")) return { type: "heading", attrs: { level: Number(block.type?.at(-1)) }, ...(inline.length ? { content: inline } : {}) };
  if (block.type === "to_do") return { type: "taskList", content: [{ type: "taskItem", attrs: { checked: Boolean(attrs.checked) }, content: [{ type: "paragraph", ...(inline.length ? { content: inline } : {}) }] }] };
  if (block.type === "quote") return { type: "blockquote", content: [{ type: "paragraph", ...(inline.length ? { content: inline } : {}) }] };
  if (block.type === "toggle" && !(attrs.children || []).length) return { type: "toggleBlock", attrs: { open: true }, ...(inline.length ? { content: inline } : {}) };
  if (block.type === "code") return { type: "codeBlock", attrs: { language: attrs.language || "plain text" }, ...(inline.length ? { content: inline } : {}) };
  if (block.type === "divider") return { type: "horizontalRule" };
  return opaqueNode(block);
}

function listNodeFromBlock(block: NotionEntity, type: "bulleted_list_item" | "numbered_list_item" | "to_do"): EditorNode {
  const attrs = blockAttributes(block);
  const children = notionDocumentFromBlocks(attrs.children || []).doc.content || [];
  return {
    type: type === "to_do" ? "taskItem" : "listItem",
    ...(type === "to_do" ? { attrs: { checked: Boolean(attrs.checked) } } : {}),
    content: [{ type: "paragraph", content: inlineNodesFromRichText(attrs.rich_text || []) }, ...children.filter((node) => node.type !== "paragraph" || node.content?.length)]
  };
}

function opaqueNode(block: NotionEntity): EditorNode {
  return { type: "notionBlock", attrs: { remoteId: String(block.id || ""), remoteType: String(block.type || "unsupported"), label: blockLabel(block) } };
}

function inlineNodesFromRichText(items: RichTextItem[] = []): EditorNode[] {
  const nodes: EditorNode[] = [];
  for (const item of items) {
    const text = item.plain_text ?? item.text?.content ?? "";
    if (!text) continue;
    const marks: EditorMark[] = [];
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

function notionAnnotationColor(value: unknown = "default"): string {
  const colors = new Set([
    "default", "gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red",
    "gray_background", "brown_background", "orange_background", "yellow_background", "green_background",
    "blue_background", "purple_background", "pink_background", "red_background"
  ]);
  return typeof value === "string" && colors.has(value) ? value : "default";
}

function editableSegments(doc: EditorNode | undefined): EditableSegment[] {
  const segments: EditableSegment[] = [];
  let current: EditableSegment = { afterId: "", blocks: [] };
  for (const node of doc?.content || []) {
    if (node.type === "notionBlock") {
      if (current.blocks.length) segments.push(current);
      current = { afterId: typeof node.attrs?.remoteId === "string" ? node.attrs.remoteId : "", blocks: [] };
      continue;
    }
    current.blocks.push(...notionBlocksFromDocument({ type: "doc", content: [node] }));
  }
  if (current.blocks.length) segments.push(current);
  return segments;
}

function replacementTreeSegments(capture: CaptureInput, remoteKind: RemoteTarget["kind"], operationTimestamp: string): EditableSegment[] {
  const segments: EditableSegment[] = [];
  let current: EditableSegment = { afterId: "", blocks: [] };
  if (remoteKind === "section") {
    current.blocks.push({
      object: "block",
      type: "heading_3",
      heading_3: { rich_text: richText(captureTitle(capture)), is_toggleable: false }
    });
  }

  for (const node of capture.document?.doc?.content || []) {
    if (node.type === "notionBlock") {
      if (current.blocks.length) segments.push(current);
      current = { afterId: typeof node.attrs?.remoteId === "string" ? node.attrs.remoteId : "", blocks: [] };
      continue;
    }
    current.blocks.push(...notionBlocksFromDocument({ type: "doc", content: [node] }));
  }
  current.blocks.push(...sourceBlocks(capture));
  if (remoteKind === "section") {
    current.blocks.push(
      notionTextBlock("paragraph", richText(`Updated ${new Date(operationTimestamp).toLocaleString()}`), { color: "gray" }),
      { object: "block", type: "divider", divider: {} }
    );
  }
  if (current.blocks.length) segments.push(current);
  return segments;
}

function opaqueBlockIds(doc: EditorNode | undefined): string[] {
  return (doc?.content || []).filter((node) => node.type === "notionBlock").map((node) => node.attrs?.remoteId).filter((id): id is string => typeof id === "string" && Boolean(id));
}

function orderedRemoteIds(doc: EditorNode | undefined, insertedSegments: Record<string, string[]>): string[] {
  const ids: Array<string | undefined> = [];
  let segmentIndex = 0;
  let hasEditable = false;
  for (const node of doc?.content || []) {
    if (node.type === "notionBlock") {
      if (hasEditable) ids.push(...(insertedSegments[segmentIndex++] || []));
      ids.push(typeof node.attrs?.remoteId === "string" ? node.attrs.remoteId : undefined);
      hasEditable = false;
    } else {
      hasEditable = true;
    }
  }
  if (hasEditable || insertedSegments[segmentIndex]) ids.push(...(insertedSegments[segmentIndex] || []));
  for (let index = segmentIndex + 1; insertedSegments[index]; index += 1) ids.push(...(insertedSegments[index] || []));
  return ids.filter((id): id is string => Boolean(id));
}

function orderedTreeRemoteIds(doc: EditorNode | undefined, groups: Record<string, string[]>, segments: EditableSegment[]): string[] {
  const rootsByAnchor = new Map<string, string[]>();
  segments.forEach((segment, index) => {
    rootsByAnchor.set(segment.afterId, [...(rootsByAnchor.get(segment.afterId) || []), ...(groups[`update/segment/${index}`] || [])]);
  });
  const placeholders = (doc?.content || [])
    .filter((node) => node.type === "notionBlock")
    .map((node) => typeof node.attrs?.remoteId === "string" ? node.attrs.remoteId : "")
    .filter(Boolean);
  if (!placeholders.length) return rootsByAnchor.get("") || [];

  const ids: string[] = [...(rootsByAnchor.get("") || [])];
  for (const placeholder of placeholders) {
    ids.push(placeholder);
    ids.push(...(rootsByAnchor.get(placeholder) || []));
  }
  return ids;
}

function isAmbiguousNotionMutation(error: unknown): boolean {
  return error instanceof NotionApiError
    && error.code !== "invalid_response"
    && (error.timeout === true || error.code === "network_error" || error.status >= 500);
}

function managedSourceProperties(destination: Partial<CaptureDestination> = {}, capture: CaptureInput = {}): Record<string, unknown> {
  if (!destination.managedDestination) return {};
  const primary = captureSources(capture)[0];
  const properties: Record<string, unknown> = {};
  const sourceUrlKey = propertyKey(destination.destinationProperties?.sourceUrl);
  const sourceDomainKey = propertyKey(destination.destinationProperties?.sourceDomain);
  if (sourceUrlKey) properties[sourceUrlKey] = { url: primary?.url || null };
  if (sourceDomainKey) properties[sourceDomainKey] = { rich_text: primary?.url ? richText(normalizeSourceDomain(primary.url)) : [] };
  return properties;
}

function pageTitle(page: NotionEntity = {}): string {
  const property = Object.values(page.properties || {}).find((value) => value.type === "title");
  return plainText(property?.title || []) || "Untitled";
}

function blockPlainText(block: NotionEntity = {}): string {
  return plainText(blockAttributes(block).rich_text || []);
}

function blockLabel(block: NotionEntity): string {
  return blockPlainText(block) || String(block.type || "Unsupported block").replaceAll("_", " ");
}

function isSourcesBlock(block: NotionEntity = {}): boolean {
  return block.type === "toggle" && blockPlainText(block).trim().toLowerCase() === "sources";
}

function sourcesFromBlock(block: NotionEntity = {}): CaptureSource[] {
  return (block.toggle?.children || []).flatMap((child) => {
    const rich = blockAttributes(child).rich_text || [];
    const href = rich.find((item) => item.href || item.text?.link?.url)?.href || rich.find((item) => item.text?.link?.url)?.text?.link?.url;
    return href ? [{ title: plainText(rich) || href, url: href, selection: "", capturedAt: Date.now() }] : [];
  });
}

function sectionFingerprint(blocks: NotionEntity[] = []): string {
  return blocks.map((block) => `${block.id}:${block.last_edited_time || ""}:${block.in_trash ? 1 : 0}`).join("|");
}

export async function findManagedCaptureById({ token, settings, captureId, fetchImpl = fetch }: NotionRequestOptions & { settings: NotionSettingsInput; captureId: string }) {
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
      page_size: 2
    }
  }, fetchImpl);
  const results = requiredEntityArray(payload, "results", "Notion returned an incomplete query response.");
  if (results.length > 1) throw new NotionTreeWriteReviewError("More than one managed Notion page has this capture ID. Review the duplicates before retrying.");
  const page = results[0];
  if (!page) return null;
  const id = Reflect.get(page, "id");
  const url = Reflect.get(page, "url");
  if (!isNonEmptyString(id) || (url !== undefined && typeof url !== "string")) {
    throw invalidSuccessResponse("Notion returned an incomplete capture query result.");
  }
  return { id, url: url || "" };
}

export async function searchDestinations({ token, query = "", fetchImpl = fetch }: NotionRequestOptions & { query?: string }) {
  if (!token) throw new Error("Connect Notion first.");
  const payload = await notionRequest(token, "/v1/search", {
    method: "POST",
    body: {
      ...(query.trim() ? { query: query.trim() } : {}),
      sort: { direction: "descending", timestamp: "last_edited_time" },
      page_size: 100
    }
  }, fetchImpl);

  const results = requiredEntityArray(payload, "results", "Notion returned an incomplete search response.");
  validateSearchResults(results);
  return results
    .filter((item) => !item.in_trash && (item.object === "page" || item.object === "data_source"))
    .map(destinationFromNotion)
    .filter((item) => item.name);
}

export async function searchRecentPages({ token, query = "", limit = 8, fetchImpl = fetch }: NotionRequestOptions & { query?: string; limit?: number }) {
  if (!token) throw new Error("Connect Notion first.");
  const pageSize = Math.max(1, Math.min(Number(limit) || 8, 25));
  const payload = await notionRequest(token, "/v1/search", {
    method: "POST",
    body: {
      ...(query.trim() ? { query: query.trim() } : {}),
      filter: { value: "page", property: "object" },
      sort: { direction: "descending", timestamp: "last_edited_time" },
      page_size: Math.min(100, Math.max(pageSize * 2, 20))
    }
  }, fetchImpl);

  const results = requiredEntityArray(payload, "results", "Notion returned an incomplete search response.");
  validateSearchResults(results);
  return results
    .filter((item) => item.object === "page" && !item.in_trash && !item.archived)
    .map((item) => {
      const titleProperty = Object.values(item.properties || {}).find((property) => property.type === "title");
      const lastEditedTime = item.last_edited_time || "";
      return {
        pageId: normalizeNotionId(item.id),
        title: plainText(titleProperty?.title) || "Untitled page",
        url: item.url || "",
        icon: notionIcon(item.icon, "↳"),
        lastEditedTime,
        updatedAt: lastEditedTime ? Date.parse(lastEditedTime) || 0 : 0
      };
    })
    .filter((item) => item.pageId)
    .slice(0, pageSize);
}

function destinationFromNotion(item: NotionEntity) {
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

function plainText(items: RichTextItem[] = []): string {
  return items.map((item) => item.plain_text || item.text?.content || "").join("").trim();
}

function notionIcon(icon: NotionEntity["icon"], fallback: string): string {
  if (icon?.type === "emoji" && icon.emoji) return icon.emoji;
  return fallback;
}

function notionHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Notion-Version": NOTION_API_VERSION,
    "Content-Type": "application/json"
  };
}

function notionApiError(response: Response, payload: unknown): NotionApiError {
  const details = isNotionEntity(payload) ? payload : {};
  const code = Reflect.get(details, "code");
  return new NotionApiError(typeof details.message === "string" ? details.message : `Notion returned ${response.status}.`, {
    status: response.status,
    code: typeof code === "string" ? code : "",
    retryAfter: Number(response.headers?.get?.("Retry-After") || 0)
  });
}

export async function notionRequest(token: string, path: string, { method = "GET", body }: RequestDescription = {}, fetchImpl: NotionFetchPort = fetch, timeoutMs = NOTION_REQUEST_TIMEOUT_MS): Promise<NotionEntity> {
  let response: Response;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    response = await fetchImpl(`https://api.notion.com${path}`, {
      method,
      headers: notionHeaders(token),
      signal: controller.signal,
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
  } catch (error: unknown) {
    if (controller.signal.aborted || errorName(error) === "AbortError") {
      const timeout = new NotionApiError("Notion took too long to respond. Delivery will retry safely.", {
        status: 408,
        code: "notion_timeout"
      });
      timeout.timeout = true;
      timeout.retryable = true;
      throw timeout;
    }
    throw new NotionApiError(errorMessage(error, "Could not reach Notion."), { code: "network_error" });
  } finally {
    clearTimeout(timer);
  }

  const payload: unknown = await response.json().catch(() => ({}));
  if (!response.ok) throw notionApiError(response, payload);
  if (!isNotionEntity(payload)) throw invalidSuccessResponse("Notion returned a malformed success response.");
  return payload;
}

function databaseCaptureProperties(settings: NotionSettingsInput, capture: CaptureInput): Record<string, NotionWriteProperty> {
  const managed = Boolean(settings.managedDestination);
  const propertyMap = settings.destinationProperties || {};
  const titleKey = managed
    ? propertyKey(propertyMap.title, settings.titleProperty || "Name")
    : settings.titleProperty?.trim() || "Name";
  const properties: Record<string, NotionWriteProperty> = {
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

function propertyKey(property: { id?: string; name?: string } | undefined, fallback = ""): string {
  return property?.id || property?.name || fallback;
}

async function loadManagedDestination({ token, databaseId, dataSourceId, marker, fallbackDatabase, fetchImpl }: NotionRequestOptions & { databaseId: string; dataSourceId: string; marker: string; fallbackDatabase: NotionEntity }) {
  const [database, dataSource] = await Promise.all([
    retrieveDatabase({ token, databaseId, ...(fetchImpl ? { fetchImpl } : {}) }).catch(() => fallbackDatabase),
    retrieveDataSource({ token, dataSourceId, ...(fetchImpl ? { fetchImpl } : {}) })
  ]);
  if (!notionPropertyMap(dataSource)) throw invalidSuccessResponse("Notion returned an incomplete data source response.");
  return managedDestination(database, dataSource, marker);
}

function managedDestination(database: NotionEntity = {}, dataSource: NotionEntity = {}, marker = "", previousProperties: Record<string, { id?: string; name?: string }> = {}) {
  const destinationProperties = managedPropertyMap(dataSource.properties || {}, previousProperties);
  return {
    id: dataSource.id || "",
    databaseId: database.id || parentDatabaseId(dataSource) || "",
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

function managedPropertyMap(schema: Record<string, NotionProperty>, previous: Record<string, { id?: string; name?: string }> = {}) {
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

function findPreviousProperty(properties: Array<Required<Pick<NotionProperty, "id" | "name" | "type">>>, previous: { id?: string; name?: string } | undefined, type: string) {
  if (!previous?.id) return null;
  return properties.find((property) => property.id === previous.id && property.type === type) || null;
}

function schemaEntries(schema: Record<string, NotionProperty> = {}): Array<Required<Pick<NotionProperty, "id" | "name" | "type">>> {
  return Object.entries(schema).map(([key, property]) => ({
    id: property.id || "",
    name: property.name || key,
    type: property.type || Object.keys(property).find((candidate) => candidate !== "id" && candidate !== "name") || ""
  }));
}

function findManagedProperty(properties: Array<Required<Pick<NotionProperty, "id" | "name" | "type">>>, definition: { name: string; type: string }) {
  return properties.find((property) => property.name === definition.name && property.type === definition.type)
    || properties.find((property) => property.name.startsWith(`${definition.name} (Quick Note`) && property.type === definition.type)
    || null;
}

function hasManagedSchema(schema: Record<string, NotionProperty>): boolean {
  const map = managedPropertyMap(schema);
  return Boolean(map.title && map.captureId && map.sourceUrl && map.sourceDomain && map.capturedAt);
}

function missingManagedProperties(schema: Record<string, NotionProperty> = {}): Record<string, unknown> {
  const entries = schemaEntries(schema);
  const additions: Record<string, unknown> = {};
  for (const definition of Object.values(MANAGED_PROPERTIES)) {
    if (findManagedProperty(entries, definition)) continue;
    const name = uniqueManagedPropertyName(entries, definition.name);
    additions[name] = definition.schema;
    entries.push({ id: "", name, type: definition.type });
  }
  return additions;
}

function uniqueManagedPropertyName(properties: Array<{ name: string }>, desiredName: string): string {
  if (!properties.some((property) => property.name === desiredName)) return desiredName;
  let suffix = 1;
  let candidate = `${desiredName} (Quick Note)`;
  while (properties.some((property) => property.name === candidate)) {
    suffix += 1;
    candidate = `${desiredName} (Quick Note ${suffix})`;
  }
  return candidate;
}

function markerFromDescription(description = ""): string {
  if (!description.startsWith(MANAGED_DATABASE_DESCRIPTION_PREFIX)) return "";
  return description.slice(MANAGED_DATABASE_DESCRIPTION_PREFIX.length).trim();
}

async function resolveDataSourceId(token: string, value: string, fetchImpl: NotionFetchPort): Promise<string> {
  const id = normalizeNotionId(value);
  const headers = { Authorization: `Bearer ${token}`, "Notion-Version": NOTION_API_VERSION };

  const direct = await fetchImpl(`https://api.notion.com/v1/data_sources/${id}`, { headers });
  if (direct.ok) return id;

  const database = await fetchImpl(`https://api.notion.com/v1/databases/${id}`, { headers });
  if (!database.ok) return id;
  const payload: unknown = await database.json();
  if (!isNotionEntity(payload)) throw invalidSuccessResponse("Notion returned an incomplete database response.");
  const dataSources = notionEntityArray(payload, "data_sources");
  if (!dataSources) throw invalidSuccessResponse("Notion returned an incomplete database response.");
  const firstId = dataSources[0] ? Reflect.get(dataSources[0], "id") : undefined;
  if (firstId !== undefined && !isNonEmptyString(firstId)) throw invalidSuccessResponse("Notion returned an invalid data source ID.");
  return firstId || id;
}

function isNotionEntity(value: unknown): value is NotionEntity {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function notionEntityArray(entity: NotionEntity, key: string): NotionEntity[] | null {
  const value = Reflect.get(entity, key);
  return Array.isArray(value) && value.every(isNotionEntity) ? value : null;
}

function requiredEntityArray(entity: NotionEntity, key: string, message: string): NotionEntity[] {
  const values = notionEntityArray(entity, key);
  if (!values) throw invalidSuccessResponse(message);
  return values;
}

function requiredEntityIds(entities: NotionEntity[], message: string): string[] {
  const ids: string[] = [];
  for (const entity of entities) {
    const id = Reflect.get(entity, "id");
    if (!isNonEmptyString(id)) throw invalidSuccessResponse(message);
    ids.push(id);
  }
  return ids;
}

function paginationEnvelope(entity: NotionEntity, message: string): { hasMore: boolean; nextCursor: string | null | undefined } {
  const hasMore = Reflect.get(entity, "has_more");
  const nextCursor = Reflect.get(entity, "next_cursor");
  if ((hasMore !== undefined && typeof hasMore !== "boolean")
    || (nextCursor !== undefined && nextCursor !== null && typeof nextCursor !== "string")) {
    throw invalidSuccessResponse(message);
  }
  return { hasMore: hasMore === true, nextCursor };
}

function validateDestinationAvailability(entity: NotionEntity, fields: Array<"archived" | "in_trash">, message: string): void {
  if (!isNonEmptyString(Reflect.get(entity, "id"))) throw invalidSuccessResponse(message);
  for (const key of fields) {
    const value = Reflect.get(entity, key);
    if (value !== undefined && typeof value !== "boolean") throw invalidSuccessResponse(message);
  }
}

function notionPropertyMap(entity: NotionEntity): Record<string, NotionProperty> | null {
  const value = Reflect.get(entity, "properties");
  if (!isNotionEntity(value)) return null;
  for (const property of Object.values(value)) {
    if (!isNotionEntity(property)) return null;
    for (const key of ["id", "name", "type"] as const) {
      const field = Reflect.get(property, key);
      if (field !== undefined && typeof field !== "string") return null;
    }
  }
  return value;
}

function notionPagePropertyMap(entity: NotionEntity): Record<string, NotionProperty> | null {
  const properties = notionPropertyMap(entity);
  if (!properties) return null;
  for (const property of Object.values(properties)) {
    if (property.type === "title" && (!Array.isArray(property.title) || !property.title.every(isRichTextItem))) return null;
  }
  return properties;
}

function parentDatabaseId(entity: NotionEntity): string | undefined {
  const parent = Reflect.get(entity, "parent");
  if (parent !== undefined) {
    if (!isNotionEntity(parent)) throw invalidSuccessResponse("Notion returned a malformed parent database reference.");
    const parentId = Reflect.get(parent, "database_id");
    if (parentId !== undefined) {
      if (!isNonEmptyString(parentId)) throw invalidSuccessResponse("Notion returned a malformed parent database reference.");
      return parentId;
    }
  }

  const fallbackId = Reflect.get(entity, "database_id");
  if (fallbackId === undefined) return undefined;
  if (!isNonEmptyString(fallbackId)) throw invalidSuccessResponse("Notion returned a malformed parent database reference.");
  return fallbackId;
}

function validateSearchResults(results: NotionEntity[]): void {
  for (const item of results) {
    if (!isNonEmptyString(Reflect.get(item, "id")) || !isNonEmptyString(Reflect.get(item, "object"))) {
      throw invalidSuccessResponse("Notion returned an incomplete search item.");
    }
    for (const key of ["url", "created_time", "last_edited_time"] as const) {
      const value = Reflect.get(item, key);
      if (value !== undefined && typeof value !== "string") throw invalidSuccessResponse("Notion returned a malformed search item.");
    }
    for (const key of ["in_trash", "archived"] as const) {
      const value = Reflect.get(item, key);
      if (value !== undefined && typeof value !== "boolean") throw invalidSuccessResponse("Notion returned a malformed search item.");
    }
    if (item.title !== undefined && (!Array.isArray(item.title) || !item.title.every(isRichTextItem))) {
      throw invalidSuccessResponse("Notion returned a malformed search title.");
    }
    const propertiesValid = item.object === "page" ? notionPagePropertyMap(item) : notionPropertyMap(item);
    if (item.properties !== undefined && !propertiesValid) {
      throw invalidSuccessResponse("Notion returned malformed search properties.");
    }
    if (item.object === "data_source") parentDatabaseId(item);
  }
}

function isValidDatabase(entity: NotionEntity): boolean {
  if (!isNonEmptyString(Reflect.get(entity, "id"))) return false;
  for (const key of ["title", "description"] as const) {
    const value = Reflect.get(entity, key);
    if (value !== undefined && (!Array.isArray(value) || !value.every(isRichTextItem))) return false;
  }
  return entity.url === undefined || typeof entity.url === "string";
}

function isValidPage(entity: NotionEntity): boolean {
  if (!isNonEmptyString(Reflect.get(entity, "id"))) return false;
  const properties = Reflect.get(entity, "properties");
  if (properties !== undefined && !notionPagePropertyMap(entity)) return false;
  const url = Reflect.get(entity, "url");
  const lastEditedTime = Reflect.get(entity, "last_edited_time");
  return (url === undefined || typeof url === "string")
    && (lastEditedTime === undefined || typeof lastEditedTime === "string");
}

function isValidFinalPage(entity: NotionEntity): boolean {
  return isNonEmptyString(Reflect.get(entity, "id"))
    && isNonEmptyString(Reflect.get(entity, "last_edited_time"))
    && isNonEmptyString(Reflect.get(entity, "url"));
}

function isValidBlock(entity: NotionEntity): boolean {
  const type = Reflect.get(entity, "type");
  if (!isNonEmptyString(Reflect.get(entity, "id")) || !isNonEmptyString(type)) return false;
  for (const key of ["has_children", "in_trash"] as const) {
    const value = Reflect.get(entity, key);
    if (value !== undefined && typeof value !== "boolean") return false;
  }
  const lastEditedTime = Reflect.get(entity, "last_edited_time");
  if (lastEditedTime !== undefined && typeof lastEditedTime !== "string") return false;
  const attributes = Reflect.get(entity, type);
  if (!isNotionEntity(attributes)) return false;
  const richText = Reflect.get(attributes, "rich_text");
  const children = Reflect.get(attributes, "children");
  const checked = Reflect.get(attributes, "checked");
  const language = Reflect.get(attributes, "language");
  const listStartIndex = Reflect.get(attributes, "list_start_index");
  const listFormat = Reflect.get(attributes, "list_format");
  return (richText === undefined || (Array.isArray(richText) && richText.every(isRichTextItem)))
    && (children === undefined || (Array.isArray(children) && children.every(isValidBlock)))
    && (checked === undefined || typeof checked === "boolean")
    && (language === undefined || typeof language === "string")
    && (listStartIndex === undefined || (typeof listStartIndex === "number" && Number.isFinite(listStartIndex)))
    && (listFormat === undefined || typeof listFormat === "string");
}

function isRichTextItem(value: unknown): value is RichTextItem {
  if (!isNotionEntity(value)) return false;
  const type = Reflect.get(value, "type");
  const plainText = Reflect.get(value, "plain_text");
  const href = Reflect.get(value, "href");
  const text = Reflect.get(value, "text");
  const annotations = Reflect.get(value, "annotations");
  const mention = Reflect.get(value, "mention");
  const equation = Reflect.get(value, "equation");
  return (type === undefined || typeof type === "string")
    && (plainText === undefined || typeof plainText === "string")
    && (href === undefined || href === null || typeof href === "string")
    && isValidRichTextText(text)
    && isValidAnnotations(annotations)
    && (mention === undefined || isNotionEntity(mention))
    && isValidEquation(equation);
}

function isValidRichTextText(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isNotionEntity(value)) return false;
  const content = Reflect.get(value, "content");
  const link = Reflect.get(value, "link");
  if (content !== undefined && typeof content !== "string") return false;
  if (link === undefined || link === null) return true;
  if (!isNotionEntity(link)) return false;
  const url = Reflect.get(link, "url");
  return typeof url === "string" || url === null;
}

function isValidAnnotations(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isNotionEntity(value)) return false;
  for (const key of ["bold", "italic", "strikethrough", "underline", "code"] as const) {
    const field = Reflect.get(value, key);
    if (field !== undefined && typeof field !== "boolean") return false;
  }
  const color = Reflect.get(value, "color");
  return color === undefined || typeof color === "string";
}

function isValidEquation(value: unknown): boolean {
  if (value === undefined) return true;
  return isNotionEntity(value) && typeof Reflect.get(value, "expression") === "string";
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim());
}

function blockAttributes(block: NotionEntity): NotionBlockAttributes {
  const value = block.type ? block[block.type] : undefined;
  return isNotionEntity(value) ? value : {};
}

function invalidSuccessResponse(message: string): NotionApiError {
  return new NotionApiError(message, { status: 502, code: "invalid_response" });
}

function errorName(error: unknown): string {
  return isNotionEntity(error) && typeof error.name === "string" ? error.name : "";
}

function errorMessage(error: unknown, fallback: string): string {
  return isNotionEntity(error) && typeof error.message === "string" && error.message ? error.message : fallback;
}
