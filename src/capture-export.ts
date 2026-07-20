import { DELIVERY_STATES, normalizeSources } from "./capture-store.js";
import { normalizeDraft, normalizeEditorNode, normalizeRecord } from "./capture-store.js";
import type { CaptureDraft, CaptureRecord, CaptureSource, EditorNode, JsonValue } from "./contracts.js";
import { isRecord } from "./contracts.js";

interface RecoveryExportOptions {
  drafts?: unknown[];
  captures?: unknown[];
  profile?: string;
  format: "json" | "markdown";
  now?: Date;
}

interface RecoveryPayload {
  format: "notion-quick-note-recovery";
  version: 1;
  exportedAt: string;
  profile: string;
  drafts: CaptureDraft[];
  queued: CaptureRecord[];
  delivered: CaptureRecord[];
}

interface RecoveryFile {
  filename: string;
  mimeType: "application/json" | "text/markdown";
  content: string;
}

interface NoteView {
  title: string;
  metadata: string[];
  sources: CaptureSource[];
  body: string;
}

export function createRecoveryExport({ drafts = [], captures = [], profile = "regular", format, now = new Date() }: RecoveryExportOptions): RecoveryFile {
  const normalizedDrafts = drafts.map((draft) => normalizeDraft(draft)).filter((draft): draft is CaptureDraft => draft !== null);
  const normalizedCaptures = captures.map((capture) => normalizeRecord(capture)).filter((capture): capture is CaptureRecord => capture !== null);
  const queued = normalizedCaptures.filter((record) => record.status !== DELIVERY_STATES.delivered);
  const delivered = normalizedCaptures.filter((record) => record.status === DELIVERY_STATES.delivered);
  const exportedAt = now.toISOString();
  const payload: RecoveryPayload = {
    format: "notion-quick-note-recovery",
    version: 1,
    exportedAt,
    profile,
    drafts: normalizedDrafts,
    queued,
    delivered
  };
  const stamp = exportedAt.replace(/[:.]/g, "-");
  if (format === "json") {
    return {
      filename: `notion-quick-note-recovery-${stamp}.json`,
      mimeType: "application/json",
      content: `${JSON.stringify(sanitizeRecoveryValue(payload), null, 2)}\n`
    };
  }
  if (format === "markdown") {
    return {
      filename: `notion-quick-note-recovery-${stamp}.md`,
      mimeType: "text/markdown",
      content: recoveryMarkdown(payload)
    };
  }
  throw new Error("Choose JSON or Markdown for the recovery export.");
}

export function recoveryMarkdown(payload: RecoveryPayload): string {
  const lines: string[] = [
    "# Notion Quick Note recovery export",
    "",
    `Exported: ${payload.exportedAt}`,
    `Profile: ${payload.profile}`,
    ""
  ];
  appendGroup(lines, "Drafts", payload.drafts, draftView);
  appendGroup(lines, "Needs delivery", payload.queued, captureView);
  appendGroup(lines, "Saved to Notion", payload.delivered, captureView);
  return `${lines.join("\n").trimEnd()}\n`;
}

export function documentToMarkdown(doc: unknown): string {
  const normalized = normalizeEditorNode(doc);
  return (normalized.content || []).map((node) => blockMarkdown(node, 0)).filter(Boolean).join("\n\n").trim();
}

function appendGroup<T>(lines: string[], title: string, records: T[], view: (record: T) => NoteView): void {
  lines.push(`## ${title}`, "");
  if (!records.length) {
    lines.push("_None_", "");
    return;
  }
  for (const record of records) {
    const note = view(record);
    lines.push(`### ${escapeHeading(note.title || "Untitled note")}`, "");
    for (const item of note.metadata) lines.push(`- ${item}`);
    if (note.sources.length) {
      lines.push("- Sources:");
      for (const source of note.sources) {
        const label = escapeInline(source.title || source.url || "Attached source");
        lines.push(`  - ${source.url ? `[${label}](${escapeUrl(source.url)})` : label}`);
      }
    }
    lines.push("");
    lines.push(note.body || "_No recoverable body text_", "", "---", "");
  }
}

function draftView(draft: CaptureDraft): NoteView {
  return {
    title: draft.title || firstText(draft.doc),
    metadata: [
      "Status: Draft",
      `Updated: ${isoDate(draft.updatedAt)}`,
      draft.context?.title ? `Source page: ${escapeInline(draft.context.title)}` : ""
    ].filter((item): item is string => Boolean(item)),
    sources: normalizeSources(draft.sources || []),
    body: documentToMarkdown(draft.doc)
  };
}

function captureView(record: CaptureRecord): NoteView {
  const capture = record.pendingCapture || record.syncedCapture || record.capture;
  return {
    title: capture.document?.title || firstText(capture.document?.doc),
    metadata: [
      `Status: ${escapeInline(record.status || "unknown")}`,
      `Updated: ${isoDate(record.updatedAt)}`,
      record.destination?.destinationName ? `Destination: ${escapeInline(record.destination.destinationName)}` : "",
      record.lastError?.message ? `Delivery error: ${escapeInline(record.lastError.message)}` : "",
      record.remote?.url ? `Notion URL: ${record.remote.url}` : ""
    ].filter((item): item is string => Boolean(item)),
    sources: normalizeSources(capture.sources || []),
    body: documentToMarkdown(capture.document?.doc)
  };
}

function blockMarkdown(node: EditorNode | undefined, depth: number): string {
  switch (node?.type) {
    case "paragraph": return inlineMarkdown(node.content);
    case "heading": return `${"#".repeat(Math.min(6, Math.max(1, Number(node.attrs?.level) || 1)))} ${inlineMarkdown(node.content)}`;
    case "blockquote": return blockquoteMarkdown(node, depth);
    case "bulletList": return listMarkdown(node, "-", depth);
    case "orderedList": return listMarkdown(node, "ordered", depth);
    case "taskList": return taskListMarkdown(node, depth);
    case "codeBlock": return `\`\`\`${String(node.attrs?.language || "").replace(/`/g, "")}\n${rawText(node)}\n\`\`\``;
    case "horizontalRule": return "---";
    case "toggleBlock": return `<details>\n<summary>${inlineMarkdown(node.content)}</summary>\n</details>`;
    case "notionBlock": return `> [Unsupported Notion block: ${escapeInline(node.attrs?.label || node.attrs?.remoteType || "unknown")}]`;
    default: return (node?.content || []).map((child) => blockMarkdown(child, depth)).filter(Boolean).join("\n\n");
  }
}

function blockquoteMarkdown(node: EditorNode, depth: number): string {
  return (node.content || []).map((child) => blockMarkdown(child, depth)).join("\n")
    .split("\n").map((line) => `> ${line}`).join("\n");
}

function listMarkdown(node: EditorNode, marker: "-" | "ordered", depth: number): string {
  const start = Number(node.attrs?.start) || 1;
  return (node.content || []).map((item, index) => {
    const prefix = marker === "ordered" ? `${start + index}.` : marker;
    return listItemMarkdown(item, prefix, depth);
  }).join("\n");
}

function taskListMarkdown(node: EditorNode, depth: number): string {
  return (node.content || []).map((item) => listItemMarkdown(item, `- [${item.attrs?.checked ? "x" : " "}]`, depth)).join("\n");
}

function listItemMarkdown(item: EditorNode, prefix: string, depth: number): string {
  const [first, ...rest] = item.content || [];
  const indent = "  ".repeat(depth);
  const firstLine = first?.type === "paragraph" ? inlineMarkdown(first.content) : blockMarkdown(first, depth + 1);
  const nested = rest.map((child) => blockMarkdown(child, depth + 1)).filter(Boolean)
    .map((value) => value.split("\n").map((line) => `${indent}  ${line}`).join("\n"));
  return [`${indent}${prefix} ${firstLine || ""}`.trimEnd(), ...nested].join("\n");
}

function inlineMarkdown(nodes: EditorNode[] = []): string {
  return nodes.map((node) => {
    if (node.type === "hardBreak") return "  \n";
    if (node.type !== "text") return "";
    let value = escapeInline(node.text || "");
    const marks = new Set((node.marks || []).map((mark) => mark.type));
    if (marks.has("code")) value = `\`${value.replace(/`/g, "\\`")}\``;
    if (marks.has("bold")) value = `**${value}**`;
    if (marks.has("italic")) value = `_${value}_`;
    if (marks.has("strike")) value = `~~${value}~~`;
    if (marks.has("underline")) value = `<u>${value}</u>`;
    const link = (node.marks || []).find((mark) => mark.type === "link")?.attrs?.href;
    if (link) value = `[${value}](${escapeUrl(link)})`;
    return value;
  }).join("");
}

function sanitizeRecoveryValue(value: unknown): JsonValue {
  if (Array.isArray(value)) return value.map(sanitizeRecoveryValue);
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (!isRecord(value)) return null;
  const blocked = new Set(["token", "refreshToken", "accessToken", "clientSecret", "oauthClientId"]);
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !blocked.has(key))
    .map(([key, child]) => [key, sanitizeRecoveryValue(child)]));
}

function firstText(node: EditorNode): string {
  return rawText(node).trim().split("\n")[0] || "Untitled note";
}

function rawText(node: EditorNode | undefined): string {
  if (!node) return "";
  if (node.type === "text") return node.text || "";
  if (node.type === "hardBreak") return "\n";
  return (node.content || []).map(rawText).join(node.type === "doc" ? "\n" : "");
}

function escapeHeading(value: unknown): string {
  return String(value || "").replace(/[\r\n]+/g, " ").replace(/#/g, "\\#").trim();
}

function escapeInline(value: unknown): string {
  return String(value || "").replace(/[\r\n]+/g, " ").replace(/([\\`*_[\]<>])/g, "\\$1");
}

function escapeUrl(value: unknown): string {
  return String(value || "").replace(/[()\s]/g, (character) => encodeURIComponent(character));
}

function isoDate(value: unknown): string {
  const date = new Date(Number(value || 0));
  return Number.isNaN(date.valueOf()) ? "Unknown" : date.toISOString();
}
