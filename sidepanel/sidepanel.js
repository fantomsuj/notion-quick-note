const params = new URLSearchParams(location.search);
const requestedDraftId = params.get("draft") || "";
const requestedTabId = params.get("tab") || "";
let activity = null;
let activeDraft = null;
const DRAFT_PREVIEW_CHARACTERS = 600;
const CAPTURE_PREVIEW_CHARACTERS = 180;

document.querySelectorAll(".tabs button").forEach((button) => {
  button.addEventListener("click", () => selectView(button.dataset.view));
});
document.querySelector(".settings").addEventListener("click", () => send({ type: "OPEN_SETTINGS" }));
document.querySelector(".compose-button").addEventListener("click", () => openComposer());
document.querySelector(".clear-history").addEventListener("click", clearDeliveredHistory);
document.querySelector(".storage-recovery").addEventListener("toggle", (event) => {
  if (event.currentTarget.open) void loadDiagnostics();
});
document.querySelectorAll("[data-export]").forEach((button) => {
  button.addEventListener("click", () => exportRecovery(button.dataset.export));
});
let activityRefreshTimer;
chrome.storage.onChanged.addListener(scheduleActivityRefresh);
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "CAPTURE_ACTIVITY_CHANGED") scheduleActivityRefresh();
});

await loadActivity();
if (requestedDraftId) activeDraft = activity?.drafts.find((draft) => draft.id === requestedDraftId) || null;
if (params.get("view") === "activity") selectView("activity");
else {
  selectView("compose");
  if (requestedDraftId) await openComposer();
}

function selectView(view) {
  document.querySelectorAll(".tabs button").forEach((button) => {
    button.setAttribute("aria-selected", String(button.dataset.view === view));
  });
  document.querySelectorAll("[data-panel]").forEach((panel) => { panel.hidden = panel.dataset.panel !== view; });
  if (view === "activity") void loadActivity();
}

function scheduleActivityRefresh() {
  if (document.querySelector('[data-panel="activity"]').hidden) return;
  clearTimeout(activityRefreshTimer);
  activityRefreshTimer = setTimeout(() => {
    activityRefreshTimer = undefined;
    void loadActivity();
    if (document.querySelector(".storage-recovery").open) void loadDiagnostics();
  }, 120);
}

async function openComposer(draft = activeDraft) {
  if (!draft) {
    const response = await send({ type: "GET_PANEL_DRAFT", tabId: requestedTabId, draftId: requestedDraftId });
    if (!response?.ok) return showToast(response?.error || "Couldn’t prepare a draft.", "error");
    draft = response.draft;
  }
  activeDraft = draft;
  window.__notionQuickNoteOpen?.({ page: draft.context, draftId: draft.id, tabId: draft.tabId, sessionId: draft.sessionId, revision: draft.revision });
}

async function loadActivity() {
  const response = await send({ type: "LIST_CAPTURE_ACTIVITY" });
  const status = document.querySelector(".activity-status");
  if (!response?.ok) {
    status.hidden = false;
    status.textContent = response?.error || "Couldn’t load local activity.";
    return;
  }
  activity = response;
  status.hidden = true;
  document.querySelector(".activity-content").hidden = false;
  document.querySelector(".privacy-note").hidden = !response.incognito;
  document.querySelector(".draft-count").textContent = String(response.drafts.length);
  document.querySelector(".queue-count").textContent = String(response.queued.length);
  renderList(document.querySelector(".draft-list"), response.drafts, draftCard, "No local drafts");
  renderList(document.querySelector(".queue-list"), response.queued, captureCard, "Everything is delivered");
  renderList(document.querySelector(".delivered-list"), response.delivered, captureCard, "No recent deliveries");
  document.querySelector(".delivered-group").hidden = !response.delivered.length;
  const attention = response.queued.filter((record) => ["blocked_setup", "blocked_auth", "blocked_destination", "blocked_conflict", "uncertain"].includes(record.status)).length;
  const localCount = response.drafts.length + response.queued.length;
  const badge = document.querySelector(".note-count");
  badge.hidden = localCount === 0;
  badge.textContent = String(localCount);
  badge.dataset.tone = attention ? "attention" : "local";
  badge.setAttribute("aria-label", `${localCount} local ${localCount === 1 ? "note" : "notes"}`);
}

function renderList(container, items, factory, emptyText) {
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

function draftCard(draft) {
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
    activeDraft = draft;
    selectView("compose");
    void openComposer(draft);
  });
  addAction(card, "Discard", async () => {
    const response = await send({ type: "DISCARD_DRAFT", id: draft.id });
    if (response?.ok) await loadActivity();
    else showToast(response?.error || "Couldn’t discard this draft.", "error");
  });
  return card;
}

function captureCard(record) {
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
    addAction(card, record.status === "blocked_auth" ? "Reconnect" : "Connect", () => send({ type: "OPEN_SETTINGS" }));
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
    addAction(card, "Mark delivered", () => act({ type: "MARK_CAPTURE_DELIVERED", id: record.id }));
    addAction(card, "Retry anyway", async () => {
      if (!confirm("Notion may already contain this capture. Retry anyway and accept the duplicate risk?")) return;
      await act({ type: "RETRY_CAPTURE", id: record.id, force: true });
    });
  } else if (record.status !== "blocked_setup") {
    addAction(card, "Retry", () => act({ type: "RETRY_CAPTURE", id: record.id }));
  }
  return card;
}

function baseCard({ title, preview = "", fullPreview = "", previewLines = 0, meta, error = "", status }) {
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

function addAction(card, label, handler) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", handler);
  card.querySelector(".card-actions").append(button);
}

async function act(message) {
  const response = await send(message);
  if (!response?.ok) showToast(response?.error || "That action didn’t complete.", "error");
  else await loadActivity();
}

async function clearDeliveredHistory() {
  if (!confirm("Delete all delivered capture history stored on this device? This does not delete pages from Notion.")) return;
  await act({ type: "DELETE_DELIVERED_HISTORY" });
}

async function loadDiagnostics() {
  const status = document.querySelector(".diagnostics-status");
  const grid = document.querySelector(".diagnostics-grid");
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
  document.querySelector(".capture-bytes").textContent = formatBytes(diagnostics.captureStorage.logicalBytes);
  document.querySelector(".chrome-bytes").textContent = diagnostics.chromeStorage.quotaBytes
    ? `${formatBytes(diagnostics.chromeStorage.usedBytes)} of ${formatBytes(diagnostics.chromeStorage.quotaBytes)}`
    : formatBytes(diagnostics.chromeStorage.usedBytes);
  document.querySelector(".origin-bytes").textContent = diagnostics.originStorage.quotaBytes
    ? `${formatBytes(diagnostics.originStorage.usedBytes)} of ${formatBytes(diagnostics.originStorage.quotaBytes)}`
    : "Unavailable";
  document.querySelector(".record-counts").textContent = `${diagnostics.captureStorage.drafts} drafts · ${diagnostics.captureStorage.queued} queued · ${diagnostics.captureStorage.delivered} delivered`;
  document.querySelector(".storage-health").textContent = diagnostics.migrationStatus === "warning"
    ? "Migration needs attention"
    : `${diagnostics.backend} · schema ${diagnostics.schemaVersion}`;
  document.querySelector(".persistence-state").textContent = diagnostics.profile === "incognito"
    ? "Session only"
    : diagnostics.persistent ? "Granted" : "Browser managed";
  document.querySelector(".maintenance-time").textContent = diagnostics.lastMaintenanceAt
    ? new Date(diagnostics.lastMaintenanceAt).toLocaleString()
    : "Not run yet";
  const note = document.querySelector(".diagnostics-note");
  note.textContent = diagnostics.migrationError || (diagnostics.profile === "incognito"
    ? "These records are cleared when this Incognito extension session ends."
    : diagnostics.persistent ? "Chrome has granted persistent origin storage." : "Chrome manages IndexedDB persistence for this profile.");
  note.dataset.tone = diagnostics.migrationError ? "error" : "";
}

async function exportRecovery(format) {
  const button = document.querySelector(`[data-export="${format}"]`);
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "Preparing…";
  const response = await send({ type: "EXPORT_CAPTURE_RECOVERY", format });
  button.disabled = false;
  button.textContent = original;
  if (!response?.ok || !response.export) return showToast(response?.error || "Couldn’t create the recovery export.", "error");
  const blob = new Blob([response.export.content], { type: `${response.export.mimeType};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = response.export.filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  showToast(`${format === "json" ? "JSON" : "Markdown"} recovery exported`, "success");
}

function send(message) {
  return chrome.runtime.sendMessage(message).catch((error) => ({ ok: false, error: error.message }));
}

function showToast(message, tone = "") {
  const toast = document.querySelector(".toast");
  toast.textContent = message;
  toast.dataset.tone = tone;
  toast.hidden = false;
  setTimeout(() => { toast.hidden = true; }, 3500);
}

function notePresentation(title, doc, fallbackTitle, previewLimit, preserveParagraphs = false) {
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

function normalizedDocumentText(node) {
  const text = documentText(node);
  return text
    .split(/\n+/)
    .map((line) => line.replace(/[\t ]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

function documentText(node) {
  if (!node) return "";
  if (node.type === "text") return node.text || "";
  if (node.type === "hardBreak") return "\n";
  return (node.content || []).map(documentText).join(node.type === "doc" ? "\n" : "").trim();
}

function truncateCharacters(value, limit) {
  const characters = Array.from(String(value || ""));
  return characters.length > limit ? `${characters.slice(0, limit).join("").trimEnd()}…` : characters.join("");
}

function relativeTime(timestamp) {
  const seconds = Math.max(0, Math.round((Date.now() - Number(timestamp || 0)) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function formatBytes(value) {
  const bytes = Math.max(0, Number(value || 0));
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function stateLabel(status) {
  return ({
    pending: "Queued",
    sending: "Sending",
    delivered: "Delivered",
    blocked_setup: "Connect required",
    blocked_auth: "Reconnect required",
    blocked_destination: "Destination needs attention",
    blocked_conflict: "Notion changed—review required",
    uncertain: "Review required"
  })[status] || "Draft";
}

function statusClass(status) {
  if (status === "delivered") return "delivered";
  if (status === "draft") return "draft";
  if (status === "uncertain") return "uncertain";
  if (String(status).startsWith("blocked")) return "blocked";
  return "";
}
