import type {
  CaptureDraft,
  CaptureRecord,
  CaptureContext,
  DeliveryState,
  EditorNode,
  RuntimeRequest,
  RuntimeResponse,
  RuntimeResponseMap,
  WorkerToPanelMessage
} from "../src/contracts.js";
import { isRecord } from "../src/contracts.js";
import { clearTerminalDraft, composerNavigationForDraft, routeShowComposer, shouldRegisterPanel } from "../src/panel-lifecycle.js";
import { sendRuntimeRequest } from "../src/runtime-message.js";

const params = new URLSearchParams(location.search);
let requestedDraftId = params.get("draft") || "";
const requestedTabId = Number(params.get("tab"));
let activity: RuntimeResponseMap["LIST_CAPTURE_ACTIVITY"] | null = null;
let activeDraft: CaptureDraft | null = null;
let activeTabId = Number.isInteger(requestedTabId) && requestedTabId > 0 ? requestedTabId : null;
let pendingActiveContext: { type: "ACTIVE_PAGE_CONTEXT"; tabId: number; page: CaptureContext } | null = null;
const DRAFT_PREVIEW_CHARACTERS = 600;
const CAPTURE_PREVIEW_CHARACTERS = 180;

window.__notionQuickNoteOnTerminal = (event) => {
  activeDraft = clearTerminalDraft(activeDraft, event);
  if (requestedDraftId === event.draftId) requestedDraftId = "";
};

const panelWindow = await chrome.windows.getCurrent();
const panelWindowId = panelWindow.id;
const panelPort = shouldRegisterPanel(params)
  ? chrome.runtime.connect({ name: "notion-quick-note-panel" })
  : null;
if (panelPort && panelWindowId !== undefined) panelPort.postMessage({ type: "REGISTER_PANEL", windowId: panelWindowId });
let workerNavigationHandled = false;
panelPort?.onMessage.addListener((message: unknown) => {
  if (!isWorkerToPanelMessage(message)) return;
  if (message.type === "ACTIVE_PAGE_CONTEXT") {
    activeTabId = message.tabId;
    pendingActiveContext = message;
    applyActiveContext();
    return;
  }
  workerNavigationHandled = true;
  if (message.type === "SHOW_ACTIVITY") {
    selectView("activity");
    return;
  }
  void showComposer(message).catch((error: unknown) => {
    showToast(errorMessage(error) || "Couldn’t open that draft.", "error");
  });
});

if (activeTabId === null && panelWindowId !== undefined) {
  const [activeTab] = await chrome.tabs.query({ active: true, windowId: panelWindowId });
  activeTabId = activeTab?.id ?? null;
}

document.querySelectorAll<HTMLButtonElement>(".tabs button").forEach((button) => {
  button.addEventListener("click", () => selectView(button.dataset.view === "activity" ? "activity" : "compose"));
});
element<HTMLButtonElement>(".settings").addEventListener("click", () => send({ type: "OPEN_SETTINGS" }));
element<HTMLButtonElement>(".compose-button").addEventListener("click", () => openComposer());
element<HTMLButtonElement>(".clear-history").addEventListener("click", clearDeliveredHistory);
element<HTMLDetailsElement>(".storage-recovery").addEventListener("toggle", (event) => {
  if ((event.currentTarget as HTMLDetailsElement).open) void loadDiagnostics();
});
document.querySelectorAll<HTMLButtonElement>("[data-export]").forEach((button) => {
  button.addEventListener("click", () => exportRecovery(button.dataset.export === "markdown" ? "markdown" : "json"));
});
let activityRefreshTimer: ReturnType<typeof setTimeout> | undefined;
chrome.storage.onChanged.addListener(scheduleActivityRefresh);
chrome.runtime.onMessage.addListener((message: unknown) => {
  if (isRecord(message) && message.type === "CAPTURE_ACTIVITY_CHANGED") scheduleActivityRefresh();
});

activity = await loadActivity();
if (requestedDraftId) activeDraft = activity?.drafts.find((draft) => draft.id === requestedDraftId) || null;
if (params.get("view") === "activity") selectView("activity");
else if (params.has("view") && !workerNavigationHandled) {
  selectView("compose");
  await openComposer();
}

function selectView(view: "compose" | "activity") {
  document.querySelectorAll<HTMLButtonElement>(".tabs button").forEach((button) => {
    button.setAttribute("aria-selected", String(button.dataset.view === view));
  });
  document.querySelectorAll<HTMLElement>("[data-panel]").forEach((panel) => { panel.hidden = panel.dataset.panel !== view; });
  if (view === "activity") {
    window.__notionQuickNoteSuspend?.();
    void loadActivity();
  } else {
    window.__notionQuickNoteResume?.();
  }
}

function scheduleActivityRefresh() {
  if (element<HTMLElement>('[data-panel="activity"]').hidden) return;
  clearTimeout(activityRefreshTimer);
  activityRefreshTimer = setTimeout(() => {
    activityRefreshTimer = undefined;
    void loadActivity();
    if (element<HTMLDetailsElement>(".storage-recovery").open) void loadDiagnostics();
  }, 120);
}

async function openComposer(draft: CaptureDraft | null = activeDraft): Promise<void> {
  if (!draft) {
    const request: Extract<RuntimeRequest, { type: "GET_PANEL_DRAFT" }> = {
      type: "GET_PANEL_DRAFT",
      ...(requestedDraftId ? { draftId: requestedDraftId } : {}),
      ...(activeTabId === null ? {} : { tabId: activeTabId })
    };
    const response = await send(request);
    if (!response?.ok) return showToast(response?.error || "Couldn’t prepare a draft.", "error");
    draft = response.draft;
  }
  await mountComposer(draft);
  activeDraft = draft;
  applyActiveContext();
}

async function mountComposer(draft: CaptureDraft, replaceWithoutPersist = false): Promise<void> {
  await window.__notionQuickNoteOpen?.({
    draft,
    page: draft.context,
    draftId: draft.id,
    tabId: draft.tabId,
    sessionId: draft.sessionId,
    revision: draft.revision,
    replaceWithoutPersist
  });
}

async function showComposer(message: Extract<WorkerToPanelMessage, { type: "SHOW_COMPOSER" }>): Promise<void> {
  if (message.tabId !== undefined) activeTabId = message.tabId;
  selectView("compose");
  activeDraft = await routeShowComposer<CaptureDraft>({
    activeDraft,
    message,
    loadDraft: async () => {
      const request: Extract<RuntimeRequest, { type: "GET_PANEL_DRAFT" }> = {
        type: "GET_PANEL_DRAFT",
        ...(message.draftId ? { draftId: message.draftId } : {}),
        ...(activeTabId === null ? {} : { tabId: activeTabId })
      };
      const response = await send(request);
      if (!response.ok) throw new Error(response.error || "Couldn’t prepare a draft.");
      return response.draft;
    },
    openDraft: mountComposer,
    activateDraft: async (draft) => {
      const response = await send({ type: "ACTIVATE_DRAFT", id: draft.id });
      if (!response.ok) throw new Error(response.error || "Couldn’t activate that draft.");
      return response.draft;
    },
    syncDraft: (draft) => mountComposer(draft, true),
    refreshDraft: async (draft) => {
      const response = await send({ type: "GET_PANEL_DRAFT", draftId: draft.id });
      if (!response.ok) throw new Error(response.error || "Couldn’t restore the current draft.");
      return response.draft;
    },
    restoreDraft: async (draft) => {
      activeDraft = draft;
      await mountComposer(draft, true);
    }
  });
  applyActiveContext();
}

function applyActiveContext() {
  if (!pendingActiveContext || !window.__notionQuickNoteUpdateContext) return;
  window.__notionQuickNoteUpdateContext({
    page: pendingActiveContext.page,
    tabId: pendingActiveContext.tabId,
    explicit: Boolean(pendingActiveContext.page.selection)
  });
  pendingActiveContext = null;
}

async function loadActivity(): Promise<RuntimeResponseMap["LIST_CAPTURE_ACTIVITY"] | null> {
  const response = await send({ type: "LIST_CAPTURE_ACTIVITY" });
  const status = element<HTMLElement>(".activity-status");
  if (!response?.ok) {
    status.hidden = false;
    status.textContent = response?.error || "Couldn’t load local activity.";
    return null;
  }
  activity = response;
  status.hidden = true;
  element<HTMLElement>(".activity-content").hidden = false;
  element<HTMLElement>(".privacy-note").hidden = !response.incognito;
  element(".draft-count").textContent = String(response.drafts.length);
  element(".queue-count").textContent = String(response.queued.length);
  renderList(element(".draft-list"), response.drafts, draftCard, "No local drafts");
  renderList(element(".queue-list"), response.queued, captureCard, "Everything is delivered");
  renderList(element(".delivered-list"), response.delivered, captureCard, "No recent deliveries");
  element<HTMLElement>(".delivered-group").hidden = !response.delivered.length;
  const attention = response.queued.filter((record) => ["blocked_setup", "blocked_auth", "blocked_destination", "blocked_conflict", "uncertain"].includes(record.status)).length;
  const localCount = response.drafts.length + response.queued.length;
  const badge = element<HTMLElement>(".note-count");
  badge.hidden = localCount === 0;
  badge.textContent = String(localCount);
  badge.dataset.tone = attention ? "attention" : "local";
  badge.setAttribute("aria-label", `${localCount} local ${localCount === 1 ? "note" : "notes"}`);
  return response;
}

function renderList<T>(container: HTMLElement, items: T[], factory: (item: T) => HTMLElement, emptyText: string): void {
  container.replaceChildren();
  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = emptyText;
    container.append(empty);
    return;
  }
  container.append(...items.map(factory));
}

function draftCard(draft: CaptureDraft): HTMLElement {
  const note = notePresentation(draft.title, draft.doc, "Untitled draft", DRAFT_PREVIEW_CHARACTERS, true);
  const card = baseCard({
    title: note.title,
    preview: note.preview,
    fullPreview: note.fullPreview,
    previewLines: 6,
    meta: `Saved locally · ${draft.context?.title || "Closed tab"} · ${relativeTime(draft.updatedAt)}`,
    status: "draft"
  });
  addAction(card, "Resume", () => {
    void showComposer(composerNavigationForDraft(draft)).catch((error: unknown) => {
      showToast(errorMessage(error) || "Couldn’t resume that draft.", "error");
    });
  });
  addAction(card, "Discard", async () => {
    let discarded = false;
    let failure = "";
    try {
      await window.__notionQuickNotePrepareDiscard?.(draft.id);
      const response = await send({ type: "DISCARD_DRAFT", id: draft.id });
      discarded = Boolean(response.ok && response.discarded);
      if (!discarded) failure = response.ok ? "Couldn’t discard this draft." : response.error;
      if (!discarded) {
        const check = await send({ type: "GET_PANEL_DRAFT", draftId: draft.id });
        discarded = !check.ok && check.code === "draft_not_found";
      }
    } catch (error) {
      failure = errorMessage(error);
    } finally {
      window.__notionQuickNoteFinishDiscard?.(draft.id, discarded);
    }
    if (discarded) {
      activeDraft = clearTerminalDraft(activeDraft, { draftId: draft.id, reason: "discarded" });
      await loadActivity();
    } else showToast(failure || "Couldn’t discard this draft.", "error");
  });
  return card;
}

function captureCard(record: CaptureRecord): HTMLElement {
  const capture = record.pendingCapture || record.syncedCapture || record.capture;
  const note = notePresentation(capture?.document?.title, capture?.document?.doc, "Untitled note", CAPTURE_PREVIEW_CHARACTERS);
  const card = baseCard({
    title: note.title,
    preview: note.preview,
    previewLines: 2,
    meta: `${stateLabel(record.status)} · ${record.destination?.destinationName || "Waiting for setup"} · ${relativeTime(record.updatedAt)}`,
    error: record.lastError?.message || "",
    status: record.status
  });
  if (record.status === "delivered") {
    addAction(card, "Open in Notion", () => act({ type: "OPEN_CAPTURE_RESULT", id: record.id }));
    addAction(card, "Delete local history", () => act({ type: "DELETE_CAPTURE", id: record.id }));
    return card;
  }
  if (["blocked_setup", "blocked_auth"].includes(record.status)) {
    addAction(card, record.status === "blocked_auth" ? "Reconnect" : "Connect", async () => { await send({ type: "OPEN_SETTINGS" }); });
  }
  if (["blocked_destination", "blocked_auth"].includes(record.status)) {
    addAction(card, "Retarget", () => act({ type: "RETARGET_CAPTURE", id: record.id }));
  }
  if (record.status === "blocked_conflict") {
    addAction(card, "Review local edit", async () => {
      const response = await send({ type: "LOAD_RECENT_NOTE", id: record.id });
      if (!response?.ok) return showToast(response?.error || "Couldn’t load the preserved edit.", "error");
      activeDraft = response.draft;
      selectView("compose");
      await openComposer(response.draft);
    });
    if (record.remote?.url) addAction(card, "Open in Notion", () => act({ type: "OPEN_CAPTURE_RESULT", id: record.id }));
    return card;
  }
  if (record.status === "uncertain") {
    if (record.remote) addAction(card, "Mark delivered", () => act({ type: "MARK_CAPTURE_DELIVERED", id: record.id, remote: record.remote! }));
    addAction(card, "Retry anyway", async () => {
      if (!confirm("Notion may already contain this capture. Retry anyway and accept the duplicate risk?")) return;
      await act({ type: "RETRY_CAPTURE", id: record.id, force: true });
    });
  } else if (record.status !== "blocked_setup") {
    addAction(card, "Retry", () => act({ type: "RETRY_CAPTURE", id: record.id }));
  }
  return card;
}

interface CardOptions {
  title: string;
  preview?: string;
  fullPreview?: string;
  previewLines?: number;
  meta: string;
  error?: string;
  status: DeliveryState | "draft";
}

function baseCard({ title, preview = "", fullPreview = "", previewLines = 0, meta, error = "", status }: CardOptions): HTMLElement {
  const card = document.createElement("article");
  card.className = "card";
  const top = document.createElement("div");
  top.className = "card-top";
  const dot = document.createElement("span");
  dot.className = `state-dot ${statusClass(status)}`;
  const copy = document.createElement("div");
  copy.className = "card-copy";
  const heading = document.createElement("h3");
  heading.className = "card-title";
  heading.textContent = title;
  const metadata = document.createElement("p");
  metadata.className = "card-meta";
  metadata.textContent = meta;
  copy.append(heading);
  if (preview) {
    const excerpt = document.createElement("p");
    excerpt.className = "card-preview";
    excerpt.style.setProperty("--preview-lines", String(previewLines));
    excerpt.textContent = preview;
    copy.append(excerpt);
    if (fullPreview) {
      excerpt.id = `note-preview-${crypto.randomUUID()}`;
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "card-preview-toggle";
      toggle.textContent = "Show more";
      toggle.setAttribute("aria-expanded", "false");
      toggle.setAttribute("aria-controls", excerpt.id);
      toggle.hidden = true;
      toggle.addEventListener("click", () => {
        const expanded = toggle.getAttribute("aria-expanded") === "true";
        toggle.setAttribute("aria-expanded", String(!expanded));
        toggle.textContent = expanded ? "Show more" : "Show less";
        excerpt.textContent = expanded ? preview : fullPreview;
        excerpt.dataset.expanded = String(!expanded);
      });
      copy.append(toggle);
      requestAnimationFrame(() => {
        toggle.hidden = fullPreview === preview && excerpt.scrollHeight <= excerpt.clientHeight + 1;
      });
    }
  }
  copy.append(metadata);
  if (error) {
    const message = document.createElement("p");
    message.className = "card-error";
    message.textContent = error;
    copy.append(message);
  }
  top.append(dot, copy);
  const actions = document.createElement("div");
  actions.className = "card-actions";
  card.append(top, actions);
  return card;
}

function addAction(card: HTMLElement, label: string, handler: () => void | Promise<void>): void {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", handler);
  const actions = card.querySelector<HTMLElement>(".card-actions");
  if (!actions) throw new Error("Quick Note card actions are missing.");
  actions.append(button);
}

async function act<T extends RuntimeRequest>(message: T): Promise<void> {
  const response = await send(message);
  if (!response.ok) showToast("error" in response ? response.error : "That action didn’t complete.", "error");
  else await loadActivity();
}

async function clearDeliveredHistory() {
  if (!confirm("Delete all delivered capture history stored on this device? This does not delete pages from Notion.")) return;
  await act({ type: "DELETE_DELIVERED_HISTORY" });
}

async function loadDiagnostics() {
  const status = element<HTMLElement>(".diagnostics-status");
  const grid = element<HTMLElement>(".diagnostics-grid");
  status.textContent = "Checking storage…";
  status.dataset.tone = "";
  const response = await send({ type: "GET_STORAGE_DIAGNOSTICS" });
  if (!response?.ok) {
    grid.hidden = true;
    status.textContent = response?.error || "Couldn’t inspect local storage.";
    status.dataset.tone = "error";
    return;
  }
  const diagnostics = response.diagnostics;
  status.textContent = diagnostics.profile === "incognito" ? "Incognito session storage" : "Regular profile storage";
  grid.hidden = false;
  element(".capture-bytes").textContent = formatBytes(diagnostics.captureStorage.logicalBytes);
  element(".chrome-bytes").textContent = diagnostics.chromeStorage.quotaBytes
    ? `${formatBytes(diagnostics.chromeStorage.usedBytes)} of ${formatBytes(diagnostics.chromeStorage.quotaBytes)}`
    : formatBytes(diagnostics.chromeStorage.usedBytes);
  element(".origin-bytes").textContent = diagnostics.originStorage.quotaBytes
    ? `${formatBytes(diagnostics.originStorage.usedBytes)} of ${formatBytes(diagnostics.originStorage.quotaBytes)}`
    : "Unavailable";
  element(".record-counts").textContent = `${diagnostics.captureStorage.drafts} drafts · ${diagnostics.captureStorage.queued} queued · ${diagnostics.captureStorage.delivered} delivered`;
  element(".storage-health").textContent = diagnostics.migrationStatus === "warning"
    ? "Migration needs attention"
    : `${diagnostics.backend} · schema ${diagnostics.schemaVersion}`;
  element(".persistence-state").textContent = diagnostics.profile === "incognito"
    ? "Session only"
    : diagnostics.persistent ? "Granted" : "Browser managed";
  element(".maintenance-time").textContent = diagnostics.lastMaintenanceAt
    ? new Date(diagnostics.lastMaintenanceAt).toLocaleString()
    : "Not run yet";
  const note = element<HTMLElement>(".diagnostics-note");
  note.textContent = diagnostics.migrationError || (diagnostics.profile === "incognito"
    ? "These records are cleared when this Incognito extension session ends."
    : diagnostics.persistent ? "Chrome has granted persistent origin storage." : "Chrome manages IndexedDB persistence for this profile.");
  note.dataset.tone = diagnostics.migrationError ? "error" : "";
}

async function exportRecovery(format: "json" | "markdown"): Promise<void> {
  const button = element<HTMLButtonElement>(`[data-export="${format}"]`);
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "Preparing…";
  const response = await send({ type: "EXPORT_CAPTURE_RECOVERY", format });
  button.disabled = false;
  button.textContent = original;
  if (!response.ok) return showToast(response.error || "Couldn’t create the recovery export.", "error");
  const blob = new Blob([response.export.content], { type: `${response.export.mimeType};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = response.export.filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  showToast(`${format === "json" ? "JSON" : "Markdown"} recovery exported`, "success");
}

async function send<const T extends RuntimeRequest>(message: T): Promise<RuntimeResponse<T>> {
  try {
    return await sendRuntimeRequest(message);
  } catch (error: unknown) {
    return { ok: false, error: errorMessage(error) };
  }
}

function showToast(message: string, tone = ""): void {
  const toast = element<HTMLElement>(".toast");
  toast.textContent = message;
  toast.dataset.tone = tone;
  toast.hidden = false;
  setTimeout(() => { toast.hidden = true; }, 3500);
}

function notePresentation(title: unknown, doc: EditorNode | undefined, fallbackTitle: string, previewLimit: number, preserveParagraphs = false) {
  const explicitTitle = String(title || "").trim();
  const paragraphBody = normalizedDocumentText(doc);
  const lines = paragraphBody.split("\n").map((line) => line.trim()).filter(Boolean);
  const body = preserveParagraphs ? paragraphBody : paragraphBody.replace(/\s+/g, " ").trim();
  const previewBody = explicitTitle ? body : lines.slice(1).join(preserveParagraphs ? "\n" : " ");
  const fullPreview = preserveParagraphs ? previewBody : previewBody.replace(/\s+/g, " ").trim();
  return {
    title: explicitTitle || truncateCharacters(lines[0], 120) || fallbackTitle,
    preview: truncateCharacters(fullPreview, previewLimit),
    fullPreview
  };
}

function normalizedDocumentText(node: EditorNode | undefined): string {
  const text = documentText(node);
  return text
    .split(/\n+/)
    .map((line) => line.replace(/[\t ]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

function documentText(node: EditorNode | undefined): string {
  if (!node) return "";
  if (node.type === "text") return node.text || "";
  if (node.type === "hardBreak") return "\n";
  return (node.content || []).map(documentText).join(node.type === "doc" ? "\n" : "").trim();
}

function truncateCharacters(value: unknown, limit: number): string {
  const characters = Array.from(String(value || ""));
  return characters.length > limit ? `${characters.slice(0, limit).join("").trimEnd()}…` : characters.join("");
}

function relativeTime(timestamp: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - Number(timestamp || 0)) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function formatBytes(value: number): string {
  const bytes = Math.max(0, Number(value || 0));
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function stateLabel(status: DeliveryState): string {
  const labels: Record<DeliveryState, string> = {
    pending: "Queued",
    sending: "Sending",
    delivered: "Delivered",
    blocked_setup: "Connect required",
    blocked_auth: "Reconnect required",
    blocked_destination: "Destination needs attention",
    blocked_conflict: "Notion changed—review required",
    uncertain: "Review required"
  };
  return labels[status];
}

function statusClass(status: DeliveryState | "draft"): string {
  if (status === "delivered") return "delivered";
  if (status === "draft") return "draft";
  if (status === "uncertain") return "uncertain";
  if (String(status).startsWith("blocked")) return "blocked";
  return "";
}

function element<T extends HTMLElement = HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`Quick Note is missing required element: ${selector}`);
  return found;
}

function isCaptureContext(value: unknown): value is CaptureContext {
  return isRecord(value) && value.version === 1 && typeof value.title === "string" && typeof value.url === "string"
    && typeof value.selection === "string" && typeof value.capturedAt === "number";
}

function isActivePageContext(value: unknown): value is { type: "ACTIVE_PAGE_CONTEXT"; tabId: number; page: CaptureContext } {
  return isRecord(value) && value.type === "ACTIVE_PAGE_CONTEXT" && Number.isInteger(value.tabId) && isCaptureContext(value.page);
}

function isWorkerToPanelMessage(value: unknown): value is WorkerToPanelMessage {
  if (!isRecord(value)) return false;
  if (value.type === "SHOW_ACTIVITY") return true;
  if (value.type === "SHOW_COMPOSER") {
    return (value.draftId === undefined || typeof value.draftId === "string")
      && (value.tabId === undefined || Number.isInteger(value.tabId));
  }
  return isActivePageContext(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
