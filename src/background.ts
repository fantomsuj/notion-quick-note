// @ts-nocheck
import {
  createQuickNotesDatabase,
  findManagedCaptureById,
  findManagedQuickNotesDatabase,
  loadRemoteNote,
  migrateManagedQuickNotesDatabase,
  notionBlocksFromDocument,
  NotionApiError,
  searchDestinations,
  sendCapture,
  updateRemoteNote,
  validateDestinationHealth
} from "./notion.js";
import {
  MANAGED_DATABASE_SCHEMA_VERSION,
  MAX_CAPTURE_CHARACTERS,
  MAX_CAPTURE_TITLE_CHARACTERS
} from "./constants.js";
import { createAccessTokenRefresher, revokeAccessToken } from "./oauth.js";
import { PRODUCT_CONFIG } from "./product-config.js";
import { createDatabaseProvisioner } from "./provisioning.js";
import { DEFAULT_SETTINGS, migrateLegacyOAuthCredentials } from "./settings.js";
import {
  badgeForState,
  DELIVERY_STATES,
  normalizeSources
} from "./capture-store.js";
import { createIncognitoCapturePersistence, createRegularCapturePersistence } from "./capture-persistence.js";
import { createDeliveryQueue } from "./capture-queue.js";
import { createRecoveryExport } from "./capture-export.js";
import { createContentRuntimeLoader } from "./content-loader.js";
import { assertNever, isRuntimeRequest, type RuntimeRequest } from "./contracts.js";

const DELIVERY_ALARM = "notion-quick-note-delivery";
const BROWSER_SESSION_KEY = "notionQuickNoteBrowserSessionV1";
const ACTIVE_SURFACE_KEY = "notionQuickNoteActiveSurfaceV2";
let activeInitialization;
let initializationComplete = false;
const isIncognito = Boolean(chrome.extension?.inIncognitoContext);
const captureStorage = isIncognito ? chrome.storage.session : chrome.storage.local;
const captureRepository = isIncognito
  ? createIncognitoCapturePersistence({ storage: captureStorage })
  : createRegularCapturePersistence({ storage: captureStorage, indexedDB });
captureRepository.setChangeHandler(handleCaptureRepositoryChange);

const refreshStoredTokenInternal = createAccessTokenRefresher({
  loadSettings: getSettings,
  saveSettings: (values) => chrome.storage.local.set(values),
  brokerUrlForSettings: (settings) => PRODUCT_CONFIG.oauthBrokerUrl || settings.oauthBrokerUrl
});

async function refreshStoredToken(settings) {
  try {
    return await refreshStoredTokenInternal(settings);
  } catch (error) {
    const deviceProofUnavailable = error?.code === "oauth_device_unavailable"
      || error?.code === "device_proof_invalid"
      || /secure device (?:storage|cryptography)|invalid proof signature/i.test(String(error?.message || ""));
    if (!isIncognito || !deviceProofUnavailable) throw error;
    const mapped = new Error("Open Quick Note in a regular window to renew the Notion connection. This Incognito capture will remain saved for this session.");
    mapped.status = 401;
    mapped.code = "oauth_device_unavailable";
    throw mapped;
  }
}

const databaseProvisioner = createDatabaseProvisioner({
  loadSettings: getSettings,
  saveSettings: (values) => chrome.storage.local.set(values),
  api: {
    create: (settings, marker) => createQuickNotesDatabase({ token: settings.token, marker }),
    recover: (settings, marker, allowAnyMarker) => findManagedQuickNotesDatabase({ token: settings.token, marker, allowAnyMarker }),
    migrate: (settings, marker) => migrateManagedQuickNotesDatabase({ token: settings.token, settings, marker })
  }
});

const deliveryQueue = createDeliveryQueue({
  repository: captureRepository,
  getConnection: currentConnection,
  deliver: deliverRecord,
  findExisting: findExistingRecord,
  onChanged: updateQueueSurfaces
});
const ensureContentRuntime = createContentRuntimeLoader({ tabs: chrome.tabs, scripting: chrome.scripting });

void initializeWorker();

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: "notion-quick-note-selection",
    title: "Save selection to Notion Quick Note",
    contexts: ["selection"]
  });
  if (reason === "install") await chrome.runtime.openOptionsPage();
  await initializeWorker();
  await provisionDatabaseWhenReady();
});

chrome.runtime.onStartup.addListener(() => {
  void initializeWorker().then(provisionDatabaseWhenReady);
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (changes.token || changes.destinationId || changes.connectionId) {
    void provisionDatabaseWhenReady().finally(() => deliveryQueue.drain());
  }
  if (["token", "destinationId", "destinationName", "includeSource", "aiEnabled", "aiSuggestTitle", "aiExtractTodos"].some((key) => changes[key])) {
    void broadcastQuickSettings();
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === DELIVERY_ALARM) void deliveryQueue.drain();
});

chrome.action.onClicked.addListener((tab) => openQuickNote(tab));

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-quick-note") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await openQuickNote(tab);
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "notion-quick-note-selection") return;
  await openQuickNote(tab, info.selectionText || "");
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  if (!isRuntimeRequest(message)) {
    sendResponse({ ok: false, error: "Malformed Quick Note message.", code: "invalid_runtime_message" });
    return false;
  }
  handleMessage(message, sender).then(
    (value) => sendResponse(value),
    (error) => sendResponse(errorResponse(error))
  );
  return true;
});

async function handleMessage(message: RuntimeRequest, sender: chrome.runtime.MessageSender) {
  await initializeWorker();
  switch (message.type) {
    case "GET_QUICK_SETTINGS": {
      return quickSettings(await getSettings());
    }
    case "GET_OR_CREATE_DRAFT":
      return { ok: true, draft: await getOrCreateDraft(message, sender) };
    case "UPSERT_DRAFT": {
      const draft = await captureRepository.upsertDraft(validateDraft(message.draft, sender), message.expectedRevision);
      return { ok: true, draft, discarded: !draft };
    }
    case "DISCARD_DRAFT":
      return { ok: true, discarded: await captureRepository.discardDraft(requiredId(message.id)) };
    case "ENQUEUE_CAPTURE":
    case "SAVE_CAPTURE":
      return enqueueCapture(message, sender);
    case "GET_CAPTURE_STATUS":
      return getCaptureStatus(message);
    case "LIST_CAPTURE_ACTIVITY":
      return { ok: true, ...(await captureActivity()) };
    case "LIST_RECENT_NOTES":
      return { ok: true, notes: await recentNotes(message.query, message.limit) };
    case "LOAD_RECENT_NOTE":
      return loadRecentNote(message, sender);
    case "CONVERT_EDIT_TO_NEW_DRAFT":
      return { ok: true, draft: await captureRepository.convertEditDraftToNew(requiredId(message.id)) };
    case "ACTIVATE_DRAFT":
      return { ok: true, draft: await captureRepository.activateDraft(requiredId(message.id), { returnDraftId: message.returnDraftId }) };
    case "RELEASE_COMPOSER_SURFACE":
      return releaseComposerSurface(message.sessionId, sender.tab?.id);
    case "GET_PANEL_DRAFT":
      return { ok: true, draft: await getPanelDraft(message, sender) };
    case "RETRY_CAPTURE":
      return { ok: true, record: await deliveryQueue.retry(requiredId(message.id), { force: Boolean(message.force) }) };
    case "RETARGET_CAPTURE":
      return { ok: true, record: await deliveryQueue.retry(requiredId(message.id), { force: Boolean(message.force), retarget: true }) };
    case "MARK_CAPTURE_DELIVERED":
      return { ok: true, record: await deliveryQueue.markDelivered(requiredId(message.id), message.remote) };
    case "DELETE_CAPTURE":
      return deleteCapture(message.id);
    case "DELETE_DELIVERED_HISTORY":
      return deleteDeliveredHistory();
    case "GET_STORAGE_DIAGNOSTICS":
      return { ok: true, diagnostics: await storageDiagnostics() };
    case "EXPORT_CAPTURE_RECOVERY":
      return { ok: true, export: await exportCaptureRecovery(message.format) };
    case "OPEN_CAPTURE_RESULT":
      return openCaptureResult(message.id);
    case "OPEN_ACTIVITY":
      return openActivity(sender.tab);
    case "OPEN_COMPOSER_FALLBACK":
      return openSavedDraftFallback(message.draftId, sender.tab);
    case "SEARCH_DESTINATIONS":
      return { ok: true, destinations: await findDestinations(message.query || "") };
    case "VALIDATE_DESTINATION":
      return validateDestinationSelection(message.destination);
    case "ENSURE_DEFAULT_DATABASE":
      return { ok: true, ...(await ensureDefaultDatabase()) };
    case "GET_PENDING_COUNT":
      return { ok: true, count: (await captureRepository.listCaptures()).filter((record) => record.status !== DELIVERY_STATES.delivered).length };
    case "DISCONNECT_NOTION":
      return disconnectNotion(Boolean(message.confirmed));
    case "VALIDATE_CONNECTION":
      return validateConnection();
    case "OPEN_SETTINGS":
      await chrome.runtime.openOptionsPage();
      return { ok: true };
    default:
      return assertNever(message);
  }
}

function initializeWorker() {
  if (initializationComplete) return Promise.resolve();
  if (!activeInitialization) {
    activeInitialization = runInitialization().then(() => {
      initializationComplete = true;
    }).finally(() => {
      activeInitialization = undefined;
    });
  }
  return activeInitialization;
}

async function runInitialization() {
  await migrateLegacyOAuthCredentials(chrome.storage.local);
  await Promise.all([
    setTrustedAccess(chrome.storage.local),
    setTrustedAccess(chrome.storage.session)
  ]);
  if (!isIncognito) {
    const session = await chrome.storage.session.get(BROWSER_SESSION_KEY);
    if (!session[BROWSER_SESSION_KEY]) {
      await chrome.storage.session.set({ [BROWSER_SESSION_KEY]: crypto.randomUUID() });
    }
  }
  await captureRepository.ready();
  await captureRepository.maintain({ recoverInterrupted: true });
  if (!isIncognito && typeof navigator.storage?.persist === "function") {
    await navigator.storage.persist().catch(() => false);
  }
  await updateQueueSurfaces();
  void deliveryQueue.drain();
}

async function setTrustedAccess(area) {
  try {
    await area.setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" });
  } catch (error) {
    console.warn("Could not restrict Quick Note storage access", error);
  }
}

async function getSettings() {
  return { ...DEFAULT_SETTINGS, ...(await chrome.storage.local.get(DEFAULT_SETTINGS)) };
}

function quickSettings(settings) {
  return {
    destinationName: settings.destinationName,
    includeSource: settings.includeSource,
    aiEnabled: settings.aiEnabled,
    aiSuggestTitle: settings.aiSuggestTitle,
    aiExtractTodos: settings.aiExtractTodos,
    connected: Boolean(settings.token),
    configured: Boolean(settings.token && settings.destinationId)
  };
}

async function broadcastQuickSettings() {
  const message = { type: "QUICK_SETTINGS_CHANGED", settings: quickSettings(await getSettings()) };
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map((tab) => tab.id
    ? chrome.tabs.sendMessage(tab.id, message).catch(() => undefined)
    : undefined));
}

function destinationSnapshot(settings) {
  if (!settings.destinationId) return null;
  return {
    destinationId: settings.destinationId,
    destinationDatabaseId: settings.destinationDatabaseId,
    destinationName: settings.destinationName,
    destinationUrl: settings.destinationUrl,
    destinationType: settings.destinationType,
    titleProperty: settings.titleProperty,
    managedDestination: Boolean(settings.managedDestination),
    destinationSchemaVersion: Number(settings.destinationSchemaVersion || 0),
    destinationMarker: settings.destinationMarker,
    destinationProperties: settings.destinationProperties || {},
    destinationConnectionId: settings.destinationConnectionId || settings.connectionId
  };
}

async function currentConnection() {
  const settings = await getSettings();
  return {
    configured: Boolean(settings.token && settings.destinationId),
    token: settings.token,
    connectionHandle: settings.connectionHandle,
    connectionId: settings.connectionId || settings.workspaceId || "",
    destination: destinationSnapshot(settings),
    settings
  };
}

async function enqueueCapture(message, sender) {
  const capture = validateCapture(message.capture);
  const connection = await currentConnection();
  const draftId = message.draftId || "";
  const draft = draftId ? await captureRepository.getDraft(draftId) : null;
  const context = draft?.context || validateContext(message.context || {
    title: capture.pageTitle,
    url: capture.url,
    selection: capture.selection || ""
  });
  const preparedCapture = {
    ...capture,
    sources: draft?.sources?.length ? draft.sources : capture.sources,
    url: notionSourceUrl(draft?.sources?.[0]?.url || context.url, capture.includeSource)
  };
  const status = connection.configured ? DELIVERY_STATES.pending : DELIVERY_STATES.blockedSetup;
  const record = draft?.mode === "edit" && draft.targetRecordId
    ? await captureRepository.enqueueUpdate({
        draftId,
        recordId: draft.targetRecordId,
        capture: preparedCapture,
        baseFingerprint: draft.baseFingerprint,
        status
      })
    : await captureRepository.enqueue({
        draftId,
        capture: preparedCapture,
        context,
        destination: connection.configured ? connection.destination : null,
        connectionId: connection.configured ? connection.connectionId : "",
        status,
        incognito: isIncognito
      });
  await updateQueueSurfaces();
  if (connection.configured) void deliveryQueue.drain();
  else void openActivity(sender.tab);
  return { ok: true, accepted: true, record: captureStatusRecord(record) };
}

async function getCaptureStatus(message) {
  const id = String(message.id || message.captureId || "");
  const draftId = String(message.draftId || "");
  if (!id && !draftId) throw new Error("Capture ID or draft ID is required.");
  const record = id
    ? await captureRepository.getCapture(id)
    : await captureRepository.findCaptureByDraftId(draftId);
  return { ok: true, record: captureStatusRecord(record) };
}

function captureStatusRecord(record) {
  if (!record) return null;
  return {
    id: record.id,
    draftId: record.draftId,
    status: record.status,
    updatedAt: record.updatedAt,
    nextAttemptAt: record.nextAttemptAt,
    attemptCount: record.attemptCount,
    lastError: record.lastError,
    remote: record.remote,
    destination: record.destination ? {
      destinationName: record.destination.destinationName,
      destinationUrl: record.destination.destinationUrl,
      managedDestination: Boolean(record.destination.managedDestination)
    } : null
  };
}

function validateCapture(capture = {}) {
  const doc = capture.document?.doc;
  if (!doc || doc.type !== "doc") throw new Error("Quick Note received an invalid document.");
  notionBlocksFromDocument(doc);
  const characters = Array.from(documentText(doc)).length;
  if (!characters) throw new Error("Write something before saving.");
  if (characters > MAX_CAPTURE_CHARACTERS) throw new Error("Quick Notes can contain up to 8,000 characters.");
  return {
    document: {
      version: Number(capture.document.version || 1),
      title: truncateCharacters(capture.document.title, MAX_CAPTURE_TITLE_CHARACTERS),
      doc
    },
    pageTitle: String(capture.pageTitle || "").slice(0, 1000),
    url: String(capture.url || ""),
    includeSource: capture.includeSource !== false,
    sources: normalizeSources(capture.sources || []),
    selection: String(capture.selection || "")
  };
}

function validateDraft(draft = {}, sender) {
  if (!draft.id) throw new Error("Draft ID is required.");
  if (!draft.doc || draft.doc.type !== "doc") throw new Error("Draft content is invalid.");
  return {
    id: String(draft.id),
    tabId: sender.tab?.id ?? draft.tabId ?? null,
    context: validateContext(draft.context),
    mode: draft.mode === "edit" ? "edit" : "new",
    targetRecordId: String(draft.targetRecordId || ""),
    sources: normalizeSources(draft.sources || []),
    revision: Number(draft.revision || 1),
    sessionId: String(draft.sessionId || ""),
    returnDraftId: String(draft.returnDraftId || ""),
    remote: draft.remote || null,
    baseFingerprint: String(draft.baseFingerprint || ""),
    title: truncateCharacters(draft.title, MAX_CAPTURE_TITLE_CHARACTERS),
    includeSource: draft.includeSource !== false,
    doc: draft.doc
  };
}

function validateContext(context = {}) {
  return {
    version: 1,
    title: String(context.title || "").slice(0, 1000),
    url: String(context.url || "").slice(0, 10000),
    selection: truncateCharacters(context.selection, MAX_CAPTURE_CHARACTERS),
    capturedAt: Number(context.capturedAt || Date.now()),
    frameUrl: String(context.frameUrl || "").slice(0, 10000)
  };
}

async function getOrCreateDraft(message, sender) {
  const context = validateContext(message.context || {});
  const tabId = sender.tab?.id ?? message.tabId ?? null;
  const existing = await captureRepository.getOrCreateDraft({
    tabId,
    context,
    includeSource: message.includeSource !== false,
    sessionId: message.sessionId,
    draftId: message.draftId
  });
  if (!context.url) return existing;

  const legacyKey = `draft:${context.url}`;
  const legacy = (await chrome.storage.session.get(legacyKey))[legacyKey];
  if (legacy === undefined || existing.updatedAt !== existing.createdAt) return existing;
  const migrated = await captureRepository.upsertDraft({
    ...existing,
    title: typeof legacy === "object" ? legacy.title || "" : "",
    includeSource: typeof legacy === "object" ? legacy.includeSource !== false : message.includeSource !== false,
    doc: legacy?.doc?.type === "doc" ? legacy.doc : paragraphDocument(typeof legacy === "string" ? legacy : "")
  }, existing.revision);
  await chrome.storage.session.remove(legacyKey);
  return migrated;
}

async function getPanelDraft(message, sender) {
  let tab = sender.tab;
  const requestedTabId = Number(message.tabId);
  if (Number.isInteger(requestedTabId)) tab = await chrome.tabs.get(requestedTabId).catch(() => tab);
  if (!tab || tab.url?.startsWith(chrome.runtime.getURL(""))) {
    const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    tab = activeTab || tab;
  }
  const context = await collectCaptureContext(tab, "");
  return captureRepository.getOrCreateDraft({
    tabId: tab?.id ?? null,
    context,
    includeSource: (await getSettings()).includeSource,
    draftId: message.draftId
  });
}

async function deliverRecord(record, connection) {
  let settings = { ...connection.settings, ...record.destination };
  let token = connection.token;
  let refreshedToken = false;
  let refreshedSchema = false;
  while (true) {
    try {
      if (record.operation === "update") {
        const latest = await captureRepository.getCapture(record.id) || record;
        return await updateRemoteNote({
          token,
          record: latest,
          capture: latest.pendingCapture,
          baseFingerprint: latest.baseFingerprint,
          journal: latest.syncJournal || {},
          onJournal: (syncJournal) => captureRepository.updateCapture(record.id, { syncJournal })
        });
      }
      const result = await sendCapture({ token, settings, capture: record.pendingCapture || record.capture });
      if (!isIncognito) {
        await chrome.storage.local.set({
          lastCapture: { savedAt: new Date().toISOString(), destinationName: settings.destinationName }
        });
      }
      if (settings.destinationType === "database") {
        return {
          kind: "page",
          id: result.id || "",
          pageId: result.id || "",
          url: result.url || settings.destinationUrl || "",
          blockIds: [],
          fingerprint: String(result.last_edited_time || "")
        };
      }
      const blocks = (result.results || []).filter((block) => block.id);
      return {
        kind: "section",
        id: settings.destinationId,
        pageId: settings.destinationId,
        url: settings.destinationUrl || "",
        blockIds: blocks.map((block) => block.id),
        fingerprint: blocks.map((block) => `${block.id}:${block.last_edited_time || ""}:0`).join("|")
      };
    } catch (error) {
      if (isUnauthorized(error) && connection.connectionHandle && !refreshedToken) {
        let refreshed;
        try {
          refreshed = await refreshStoredToken({ ...connection.settings, token });
        } catch (error) {
          throw new NotionApiError(error.message || "Reconnect Notion to deliver this capture.", { status: 401, code: error.code || "refresh_failed" });
        }
        token = refreshed.token;
        refreshedToken = true;
        continue;
      }
      if (isManagedSchemaError(error, settings) && !refreshedSchema) {
        const destination = await migrateManagedQuickNotesDatabase({
          token,
          settings,
          marker: settings.destinationMarker || crypto.randomUUID()
        });
        settings = { ...settings, ...destinationToSettings(destination) };
        await chrome.storage.local.set(destinationToSettings(destination));
        refreshedSchema = true;
        continue;
      }
      if (error?.code === "network_error" && typeof navigator !== "undefined") error.offline = navigator.onLine === false;
      throw error;
    }
  }
}

async function findExistingRecord(record, connection) {
  if (!record.destination?.managedDestination) return null;
  try {
    return await findManagedCaptureById({
      token: connection.token,
      settings: record.destination,
      captureId: record.id
    });
  } catch (error) {
    if (!isUnauthorized(error) || !connection.connectionHandle) throw error;
    let refreshed;
    try {
      refreshed = await refreshStoredToken(connection.settings);
    } catch (error) {
      throw new NotionApiError(error.message || "Reconnect Notion to verify this capture.", { status: 401, code: error.code || "refresh_failed" });
    }
    connection.token = refreshed.token;
    connection.settings = refreshed;
    return findManagedCaptureById({
      token: refreshed.token,
      settings: record.destination,
      captureId: record.id
    });
  }
}

async function captureActivity() {
  const records = (await captureRepository.listCaptures()).sort((left, right) => right.updatedAt - left.updatedAt);
  const drafts = (await captureRepository.listDrafts())
    .filter((draft) => documentText(draft.doc).trim())
    .sort((left, right) => right.updatedAt - left.updatedAt);
  return {
    incognito: isIncognito,
    drafts,
    queued: records.filter((record) => record.status !== DELIVERY_STATES.delivered),
    delivered: records.filter((record) => record.status === DELIVERY_STATES.delivered)
  };
}

async function recentNotes(query = "", limit = 5) {
  const needle = String(query || "").trim().toLowerCase();
  return (await captureRepository.listCaptures({ statuses: [DELIVERY_STATES.delivered, DELIVERY_STATES.blockedConflict] }))
    .filter((record) => record.status === DELIVERY_STATES.delivered || record.status === DELIVERY_STATES.blockedConflict)
    .filter((record) => {
      if (!needle) return true;
      const capture = record.pendingCapture || record.syncedCapture || record.capture || {};
      return [
        capture.document?.title,
        documentText(capture.document?.doc),
        record.destination?.destinationName,
        ...(capture.sources || []).flatMap((source) => [source.title, source.url])
      ].join(" ").toLowerCase().includes(needle);
    })
    .sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0))
    .slice(0, Math.max(1, Math.min(Number(limit) || 5, needle ? 100 : 5)))
    .map(recentNoteSummary);
}

function recentNoteSummary(record) {
  const capture = record.pendingCapture || record.syncedCapture || record.capture || {};
  const explicitTitle = String(capture.document?.title || "").trim();
  const body = documentText(capture.document?.doc).trim();
  const lines = body.split("\n").map((line) => line.trim()).filter(Boolean);
  const preview = (explicitTitle ? body : lines.slice(1).join(" ")).replace(/\s+/g, " ").trim();
  return {
    id: record.id,
    title: explicitTitle || lines[0] || "Untitled note",
    preview: truncateCharacters(preview, 180),
    sources: normalizeSources(capture.sources || []),
    destinationName: record.destination?.destinationName || "Notion",
    status: record.status,
    updatedAt: record.updatedAt,
    remoteUrl: record.remote?.url || record.destination?.destinationUrl || "",
    editable: Boolean(record.remote?.kind === "page" || record.remote?.kind === "section")
  };
}

async function loadRecentNote(message, sender) {
  const id = requiredId(message.id);
  const record = await captureRepository.getCapture(id);
  if (!record) throw new Error("That recent note is no longer stored locally.");
  const activeDraft = await captureRepository.getActiveDraft();
  const returnDraftId = activeDraft?.mode === "edit" && activeDraft.targetRecordId === id
    ? activeDraft.returnDraftId || ""
    : activeDraft?.id || "";
  let loaded;
  const usePendingConflict = record.status === DELIVERY_STATES.blockedConflict && !message.reloadLatest && record.pendingCapture;
  if (usePendingConflict) {
    loaded = {
      title: record.pendingCapture.document?.title || "",
      doc: record.pendingCapture.document?.doc,
      sources: normalizeSources(record.pendingCapture.sources || []),
      remote: record.remote,
      baseFingerprint: record.baseFingerprint || record.remote?.fingerprint || ""
    };
  } else {
    const connection = await currentConnection();
    if (!connection.configured) throw new Error("Reconnect Notion before editing a recent note.");
    if (record.connectionId && record.connectionId !== connection.connectionId) throw new Error("Reconnect the Notion workspace that owns this note.");
    try {
      loaded = await loadRemoteNote({ token: connection.token, record });
    } catch (error) {
      if (!isUnauthorized(error) || !connection.connectionHandle) throw error;
      const refreshed = await refreshStoredToken(connection.settings);
      loaded = await loadRemoteNote({ token: refreshed.token, record });
    }
  }
  const sessionId = String(message.sessionId || crypto.randomUUID());
  const draft = await captureRepository.createEditDraft({
    recordId: id,
    title: loaded.title,
    doc: loaded.doc,
    sources: loaded.sources,
    remote: loaded.remote,
    baseFingerprint: loaded.baseFingerprint,
    returnDraftId,
    tabId: sender.tab?.id ?? null,
    sessionId,
    replace: Boolean(message.reloadLatest)
  });
  return { ok: true, draft, returnDraftId, conflict: usePendingConflict };
}

async function deleteCapture(id) {
  const record = await captureRepository.getCapture(requiredId(id));
  if (!record) return { ok: true, deleted: false };
  if (record.status !== DELIVERY_STATES.delivered) throw new Error("Resolve or mark this capture delivered before deleting its local record.");
  const deleted = await captureRepository.removeCapture(id);
  await updateQueueSurfaces();
  return { ok: true, deleted };
}

async function deleteDeliveredHistory() {
  const delivered = await captureRepository.listCaptures({ statuses: [DELIVERY_STATES.delivered] });
  for (const record of delivered) await captureRepository.removeCapture(record.id);
  await updateQueueSurfaces();
  return { ok: true, deleted: delivered.length };
}

async function storageDiagnostics() {
  const [drafts, captures, meta, logicalBytes] = await Promise.all([
    captureRepository.listDrafts(),
    captureRepository.listCaptures(),
    captureRepository.getMeta(),
    captureRepository.logicalBytes()
  ]);
  const area = isIncognito ? chrome.storage.session : chrome.storage.local;
  const [chromeBytes, estimate, persisted] = await Promise.all([
    typeof area.getBytesInUse === "function" ? area.getBytesInUse(null).catch(() => 0) : 0,
    typeof navigator.storage?.estimate === "function" ? navigator.storage.estimate().catch(() => ({})) : {},
    typeof navigator.storage?.persisted === "function" ? navigator.storage.persisted().catch(() => false) : false
  ]);
  return {
    profile: isIncognito ? "incognito" : "regular",
    backend: captureRepository.backendName,
    schemaVersion: Number(meta.version || 0),
    migrationStatus: captureRepository.migrationError ? "warning" : meta.migrationStatus || "unknown",
    migrationError: captureRepository.migrationError || meta.migrationError || "",
    lastMaintenanceAt: Number(meta.lastMaintenanceAt || 0),
    persistent: Boolean(persisted),
    chromeStorage: {
      area: isIncognito ? "session" : "local",
      usedBytes: Number(chromeBytes || 0),
      quotaBytes: Number(area.QUOTA_BYTES || 0)
    },
    captureStorage: {
      logicalBytes,
      drafts: drafts.length,
      queued: captures.filter((record) => record.status !== DELIVERY_STATES.delivered).length,
      delivered: captures.filter((record) => record.status === DELIVERY_STATES.delivered).length
    },
    originStorage: {
      usedBytes: Number(estimate?.usage || 0),
      quotaBytes: Number(estimate?.quota || 0)
    }
  };
}

async function exportCaptureRecovery(format) {
  const [drafts, captures] = await Promise.all([
    captureRepository.listDrafts(),
    captureRepository.listCaptures()
  ]);
  return createRecoveryExport({
    drafts: drafts.sort((left, right) => right.updatedAt - left.updatedAt),
    captures: captures.sort((left, right) => right.updatedAt - left.updatedAt),
    profile: isIncognito ? "incognito" : "regular",
    format: String(format || "")
  });
}

async function openCaptureResult(id) {
  const record = await captureRepository.getCapture(requiredId(id));
  const url = record?.remote?.url || record?.destination?.destinationUrl;
  if (!url || !/^https:\/\//.test(url)) throw new Error("No Notion link is available for this capture.");
  await chrome.tabs.create({ url });
  return { ok: true };
}

async function handleCaptureRepositoryChange(event) {
  if (event.structural) {
    if (event.kind !== "maintenance") await captureRepository.maintain({ recoverInterrupted: false });
    await updateQueueSurfaces();
  }
  chrome.runtime.sendMessage({ type: "CAPTURE_ACTIVITY_CHANGED", kind: event.kind }).catch(() => undefined);
}

async function updateQueueSurfaces() {
  const records = await captureRepository.listCaptures();
  const state = { captures: Object.fromEntries(records.map((record) => [record.id, record])) };
  const badge = badgeForState(state);
  await Promise.all([
    chrome.action.setBadgeBackgroundColor({ color: badge.color }),
    chrome.action.setBadgeText({ text: badge.text })
  ]);
  const nextAttempt = records
    .filter((record) => record.status === DELIVERY_STATES.pending && record.nextAttemptAt > 0)
    .reduce((earliest, record) => earliest ? Math.min(earliest, record.nextAttemptAt) : record.nextAttemptAt, 0);
  await chrome.alarms.clear(DELIVERY_ALARM);
  if (nextAttempt) await chrome.alarms.create(DELIVERY_ALARM, { when: Math.max(Date.now() + 30_000, nextAttempt) });
}

async function findDestinations(query) {
  let settings = await getSettings();
  try {
    return await searchDestinations({ token: settings.token, query });
  } catch (error) {
    if (!(error instanceof NotionApiError) || error.status !== 401 || !settings.connectionHandle) throw error;
    settings = await refreshStoredToken(settings);
    return searchDestinations({ token: settings.token, query });
  }
}

async function ensureDefaultDatabase() {
  try {
    const result = await databaseProvisioner.ensure();
    void deliveryQueue.drain();
    return result;
  } catch (error) {
    const settings = await getSettings();
    if (!isUnauthorized(error) || !settings.connectionHandle) throw error;
    await refreshStoredToken(settings);
    const result = await databaseProvisioner.ensure();
    void deliveryQueue.drain();
    return result;
  }
}

async function provisionDatabaseWhenReady() {
  const settings = await getSettings();
  const legacyManagedDestination = Boolean(settings.destinationDatabaseId);
  const needsMigration = (settings.managedDestination || legacyManagedDestination)
    && Number(settings.destinationSchemaVersion || 0) < MANAGED_DATABASE_SCHEMA_VERSION;
  if (!settings.token || (settings.destinationId && !needsMigration)) return;
  try {
    await ensureDefaultDatabase();
  } catch (error) {
    console.warn("Could not create the default Quick Notes database", error);
  }
}

async function validateConnection() {
  const settings = await getSettings();
  if (!settings.token || !settings.destinationId) return { ok: false, ready: false, error: "Connect Notion and choose a destination." };
  try {
    if (settings.managedDestination && Number(settings.destinationSchemaVersion || 0) < MANAGED_DATABASE_SCHEMA_VERSION) {
      await ensureDefaultDatabase();
    } else {
      await validateDestinationHealth({ token: settings.token, settings });
    }
    return { ok: true, ready: true };
  } catch (error) {
    return { ...destinationErrorResponse(error), ready: false };
  }
}

async function validateDestinationSelection(destination = {}) {
  const settings = await getSettings();
  if (!settings.token) return { ok: false, ready: false, error: "Reconnect Notion before choosing a destination.", reconnect: true };
  const candidate = {
    ...settings,
    destinationId: String(destination.id || ""),
    destinationType: destination.type === "page" ? "page" : "database",
    titleProperty: String(destination.titleProperty || "Name"),
    managedDestination: false
  };
  try {
    await validateDestinationHealth({ token: settings.token, settings: candidate });
    return { ok: true, ready: true };
  } catch (error) {
    if (isUnauthorized(error) && settings.connectionHandle) {
      try {
        const refreshed = await refreshStoredToken(settings);
        await validateDestinationHealth({ token: refreshed.token, settings: candidate });
        return { ok: true, ready: true };
      } catch (refreshError) {
        return { ...destinationErrorResponse(refreshError), ready: false };
      }
    }
    return { ...destinationErrorResponse(error), ready: false };
  }
}

function destinationErrorResponse(error) {
  const response = errorResponse(error);
  if (Number(error?.status || 0) === 403 || Number(error?.status || 0) === 404) {
    response.kind = "capability";
    response.error = "Quick Note cannot access this destination. Reshare it with the integration and make sure the integration has Insert Content capability.";
  }
  return response;
}

async function disconnectNotion(confirmed) {
  const records = await captureRepository.listCaptures();
  const state = { captures: Object.fromEntries(records.map((record) => [record.id, record])) };
  const count = unresolvedCount(state);
  if (count && !confirmed) return { ok: false, requiresConfirmation: true, pendingCount: count };
  const settings = await getSettings();
  const brokerUrl = PRODUCT_CONFIG.oauthBrokerUrl || settings.oauthBrokerUrl;
  let warning = count ? `${count} capture${count === 1 ? " is" : "s are"} still stored locally and will require retargeting.` : "";
  if (settings.authType === "oauth" && settings.connectionHandle && brokerUrl) {
    try {
      await revokeAccessToken({ brokerUrl, connectionHandle: settings.connectionHandle, token: settings.token });
    } catch {
      warning = [warning, "Disconnected locally, but Notion could not confirm token revocation."].filter(Boolean).join(" ");
    }
  }
  await chrome.storage.local.remove([
    "token", "connectionHandle", "refreshToken", "workspaceId", "workspaceName", "workspaceIcon", "botId", "connectionId",
    "destinationId", "destinationDatabaseId", "destinationName", "destinationUrl", "destinationType",
    "titleProperty", "managedDestination", "destinationSchemaVersion", "destinationMarker",
    "destinationProperties", "destinationConnectionId", "databaseProvisioning", "onboardingComplete", "lastCapture"
  ]);
  for (const record of Object.values(state.captures).filter((item) => item.status !== DELIVERY_STATES.delivered)) {
    await captureRepository.updateCapture(record.id, {
      status: DELIVERY_STATES.blockedAuth,
      nextAttemptAt: 0,
      lastError: { kind: "disconnected", message: "Reconnect or retarget this capture to deliver it." }
    });
  }
  await updateQueueSurfaces();
  return { ok: true, warning };
}

async function openQuickNote(tab, forcedSelection = "") {
  if (!tab?.id) return openComposerTab(null, "compose");
  const context = await collectCaptureContext(tab, forcedSelection);
  const sessionId = crypto.randomUUID();
  const activeSurface = (await chrome.storage.session.get(ACTIVE_SURFACE_KEY))[ACTIVE_SURFACE_KEY];
  if (activeSurface?.tabId === tab.id) {
    try {
      const surface = await chrome.tabs.sendMessage(tab.id, { type: "QUICK_NOTE_PING" });
      if (!surface?.open || surface.sessionId !== activeSurface.sessionId) throw new Error("Stale composer surface");
      await chrome.tabs.sendMessage(tab.id, {
        type: "TOGGLE_QUICK_NOTE",
        page: context,
        draftId: activeSurface.draftId,
        tabId: tab.id,
        sessionId: activeSurface.sessionId
      });
      return;
    } catch {
      // The recorded surface is stale. Fall through and reopen the autosaved draft.
    }
  }
  if (activeSurface?.tabId && activeSurface.tabId !== tab.id) {
    await chrome.tabs.sendMessage(activeSurface.tabId, {
      type: "FLUSH_AND_CLOSE_QUICK_NOTE",
      sessionId: activeSurface.sessionId
    }).catch(() => undefined);
  }
  const draft = await captureRepository.getOrCreateDraft({
    tabId: tab.id,
    context,
    includeSource: (await getSettings()).includeSource,
    sessionId
  });
  await chrome.storage.session.set({ [ACTIVE_SURFACE_KEY]: { tabId: tab.id, draftId: draft.id, sessionId } });
  if (!supportsOverlay(tab.url) || isPdfUrl(tab.url)) return openComposerFallback(tab, draft, "compose");
  try {
    const message = { type: "TOGGLE_QUICK_NOTE", page: context, draftId: draft.id, tabId: tab.id, sessionId, revision: draft.revision };
    await ensureContentRuntime(tab.id);
    await chrome.tabs.sendMessage(tab.id, message);
  } catch (error) {
    console.warn("Quick Note overlay unavailable; using the side panel", error);
    await openComposerFallback(tab, draft, "compose");
  }
}

async function releaseComposerSurface(sessionId, tabId) {
  const current = (await chrome.storage.session.get(ACTIVE_SURFACE_KEY))[ACTIVE_SURFACE_KEY];
  if (current && (!sessionId || current.sessionId === sessionId) && (!tabId || current.tabId === tabId)) {
    await chrome.storage.session.remove(ACTIVE_SURFACE_KEY);
  }
  return { ok: true };
}

async function collectCaptureContext(tab, forcedSelection = "") {
  const fallback = validateContext({ title: tab?.title || "Current tab", url: tab?.url || "", selection: forcedSelection });
  if (!tab?.id || !supportsOverlay(tab.url) || isPdfUrl(tab.url)) return fallback;
  try {
    const frames = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: () => ({
        title: window.top === window ? document.title : "",
        url: window.top === window ? location.href : "",
        frameUrl: location.href,
        selection: window.getSelection()?.toString().trim() || "",
        focused: document.hasFocus()
      })
    });
    const top = frames.find((frame) => frame.frameId === 0)?.result || {};
    const focused = frames.find((frame) => frame.result?.focused && frame.result?.selection)?.result
      || frames.find((frame) => frame.result?.selection)?.result
      || {};
    return validateContext({
      title: top.title || fallback.title,
      url: top.url || fallback.url,
      frameUrl: focused.frameUrl || top.url || fallback.url,
      selection: forcedSelection || focused.selection || top.selection || ""
    });
  } catch {
    return fallback;
  }
}

function supportsOverlay(url = "") {
  try {
    return ["http:", "https:", "file:"].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

function isPdfUrl(url = "") {
  try {
    return new URL(url).pathname.toLowerCase().endsWith(".pdf");
  } catch {
    return false;
  }
}

async function openComposerFallback(tab, draft, view) {
  const path = panelPath({ draftId: draft?.id || "", tabId: tab?.id, view });
  try {
    if (!tab?.id) throw new Error("No tab is available for a side panel.");
    await chrome.sidePanel.setOptions({ tabId: tab.id, path, enabled: true });
    await chrome.sidePanel.open({ tabId: tab.id });
    return { ok: true, surface: "side_panel" };
  } catch (error) {
    console.warn("Quick Note side panel unavailable; opening an extension tab", error);
    return openComposerTab(draft, view);
  }
}

async function openComposerTab(draft, view) {
  await chrome.tabs.create({ url: chrome.runtime.getURL(panelPath({ draftId: draft?.id || "", view })) });
  return { ok: true, surface: "tab" };
}

async function openActivity(tab) {
  return openComposerFallback(tab, null, "activity");
}

async function openSavedDraftFallback(draftId, tab) {
  const draft = await captureRepository.getDraft(String(draftId || ""));
  return openComposerFallback(tab, draft || null, draft ? "compose" : "activity");
}

function panelPath({ draftId = "", tabId = "", view = "compose" } = {}) {
  const query = new URLSearchParams({ view });
  if (draftId) query.set("draft", draftId);
  if (tabId !== "" && tabId !== undefined) query.set("tab", String(tabId));
  return `sidepanel/index.html?${query}`;
}

function notionSourceUrl(url, includeSource) {
  if (!includeSource) return "";
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.pathname.toLowerCase().endsWith(".pdf")) return "";
    return parsed.href;
  } catch {
    return "";
  }
}

function destinationToSettings(destination) {
  return {
    destinationId: destination.id,
    destinationDatabaseId: destination.databaseId,
    destinationName: destination.name,
    destinationUrl: destination.url || "",
    destinationType: destination.type,
    titleProperty: destination.titleProperty,
    managedDestination: true,
    destinationSchemaVersion: destination.schemaVersion,
    destinationMarker: destination.marker,
    destinationProperties: destination.properties
  };
}

function isUnauthorized(error) {
  return error instanceof NotionApiError && error.status === 401;
}

function isManagedSchemaError(error, settings) {
  return settings.managedDestination && error instanceof NotionApiError && error.status === 400 && error.code === "validation_error";
}

function errorResponse(error) {
  return {
    ok: false,
    error: error.message,
    status: error.status || 0,
    code: error.code || "",
    kind: errorKind(error),
    retryAfter: error.retryAfter || 0,
    reconnect: error.status === 401
  };
}

function errorKind(error) {
  if (error.code === "provisioning_uncertain") return "recovering";
  if (error.status === 401) return "authentication";
  if (error.status === 403 || error.status === 404) return "capability";
  if (error.status === 429) return "rate_limited";
  if (!error.status || error.status >= 500) return "transient";
  return "generic";
}

function unresolvedCount(state) {
  return Object.values(state.captures).filter((record) => record.status !== DELIVERY_STATES.delivered).length;
}

function requiredId(value) {
  if (typeof value !== "string" || !value) throw new Error("Capture ID is required.");
  return value;
}

function documentText(node) {
  if (!node) return "";
  if (node.type === "text") return node.text || "";
  if (node.type === "hardBreak") return "\n";
  return (node.content || []).map(documentText).join(node.type === "doc" ? "\n" : "").trim();
}

function paragraphDocument(text) {
  return { type: "doc", content: [{ type: "paragraph", ...(text ? { content: [{ type: "text", text }] } : {}) }] };
}

function truncateCharacters(value, limit) {
  return Array.from(String(value || "")).slice(0, limit).join("");
}
