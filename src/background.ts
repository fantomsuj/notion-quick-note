import {
  createQuickNotesDatabase,
  findManagedCaptureById,
  findManagedQuickNotesDatabase,
  loadRemoteNote,
  migrateManagedQuickNotesDatabase,
  normalizeNotionId,
  notionBlocksFromDocument,
  NotionApiError,
  searchDestinations,
  searchRecentPages,
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
import { createDatabaseProvisioner, type ManagedDestination, type ProvisioningSettings } from "./provisioning.js";
import { DEFAULT_SETTINGS, migrateLegacyOAuthCredentials, normalizeSettings } from "./settings.js";
import {
  badgeForState,
  DELIVERY_STATES,
  normalizeDismissedSourceUrls,
  normalizeSources
} from "./capture-store.js";
import { createIncognitoCapturePersistence, createRegularCapturePersistence } from "./capture-persistence.js";
import { createDeliveryQueue } from "./capture-queue.js";
import { createRecoveryExport } from "./capture-export.js";
import {
  assertNever,
  isRecord,
  isRuntimeRequest,
  type CaptureChangeEvent,
  type CaptureContext,
  type CaptureDestination,
  type CaptureDraft,
  type CaptureDraftInput,
  type CapturePayload,
  type CaptureRecord,
  type CaptureSource,
  type CaptureState,
  type Destination,
  type EditorNode,
  type KeyValueStoragePort,
  type RemoteTarget,
  type RecentItem,
  type RuntimeRequest,
  type RuntimeResponse,
  type Settings,
  type SyncJournal
} from "./contracts.js";
import { createContentRuntimeLoader } from "./content-loader.js";
import { createSerializedOperationQueue } from "./serialized-operation-queue.js";
import { quickSettingsResponse, requiredCaptureRecordResponse, validatedRuntimeResponse } from "./background-dispatch.js";
import { logDiagnostic, logDiagnosticError } from "./diagnostics.js";
import { createUnavailableNotice } from "./unavailable-notice.js";

const DELIVERY_ALARM = "notion-quick-note-delivery";
const BROWSER_SESSION_KEY = "notionQuickNoteBrowserSessionV1";
const ACTIVE_SURFACE_KEY = "notionQuickNoteActiveSurfaceV2";
const showUnavailableNotice = createUnavailableNotice(chrome.notifications);
let activeInitialization: Promise<void> | undefined;
let initializationComplete = false;
const isIncognito = Boolean(chrome.extension?.inIncognitoContext);
const captureStorage = isIncognito ? chrome.storage.session : chrome.storage.local;
const captureRepository = isIncognito
  ? createIncognitoCapturePersistence({ storage: captureStorage })
  : createRegularCapturePersistence({ storage: captureStorage, indexedDB });
captureRepository.setChangeHandler(handleCaptureRepositoryChange);

const refreshStoredTokenInternal = createAccessTokenRefresher<Settings & Record<string, unknown>>({
  loadSettings: async () => ({ ...(await getSettings()) }),
  saveSettings: (values) => chrome.storage.local.set(values),
  brokerUrlForSettings: (settings) => PRODUCT_CONFIG.oauthBrokerUrl || String(settings.oauthBrokerUrl || "")
});

async function refreshStoredToken(settings: Settings): Promise<Settings> {
  try {
    return await refreshStoredTokenInternal({ ...settings });
  } catch (error: unknown) {
    const detail = errorRecord(error);
    const deviceProofUnavailable = detail.code === "oauth_device_unavailable"
      || detail.code === "device_proof_invalid"
      || /secure device (?:storage|cryptography)|invalid proof signature/i.test(String(detail.message || ""));
    if (!isIncognito || !deviceProofUnavailable) throw error;
    const mapped = new NotionApiError("Open Quick Note in a regular window to renew the Notion connection. This Incognito capture will remain saved for this session.", { status: 401, code: "oauth_device_unavailable" });
    throw mapped;
  }
}

const databaseProvisioner = createDatabaseProvisioner({
  loadSettings: async () => provisioningSettings(await getSettings()),
  saveSettings: (values) => chrome.storage.local.set(values),
  api: {
    create: async (settings, marker) => managedDestination(await createQuickNotesDatabase({ token: requiredToken(settings.token), marker })),
    recover: async (settings, marker, allowAnyMarker) => {
      const destination = await findManagedQuickNotesDatabase({ token: requiredToken(settings.token), marker, allowAnyMarker });
      return destination ? managedDestination(destination) : null;
    },
    migrate: async (settings, marker) => managedDestination(await migrateManagedQuickNotesDatabase({ token: requiredToken(settings.token), settings: notionSettings(settings), marker }))
  }
});

const deliveryQueue = createDeliveryQueue({
  repository: captureRepository,
  getConnection: currentConnection,
  deliver: async (record) => {
    const connection = await currentConnection();
    if (!connection.configured) throw new Error("Connect Notion before delivering captures.");
    return deliverRecord(record, connection);
  },
  findExisting: async (record) => {
    const connection = await currentConnection();
    return connection.configured ? findExistingRecord(record, connection) : null;
  },
  onChanged: updateQueueSurfaces
});
const ensureContentRuntime = createContentRuntimeLoader({ tabs: chrome.tabs, scripting: chrome.scripting });
const enqueueComposerOperation = createSerializedOperationQueue();
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

chrome.action.onClicked.addListener((tab) => {
  logDiagnostic("worker.toolbar.click", {
    tabId: tab.id,
    windowId: tab.windowId
  });
  void openQuickNote(tab);
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-quick-note") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await openQuickNote(tab);
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "notion-quick-note-selection") return;
  await openQuickNote(tab, info.selectionText || "");
});

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
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

async function handleMessage(message: RuntimeRequest, sender: chrome.runtime.MessageSender): Promise<RuntimeResponse<RuntimeRequest>> {
  await initializeWorker();
  const response: unknown = await (async () => {
    switch (message.type) {
    case "GET_QUICK_SETTINGS": {
      return quickSettingsResponse(quickSettings(await getSettings()));
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
      return { ok: true, ...(await listRecentItems(message.query, message.limit)) };
    case "LOAD_RECENT_NOTE":
      return loadRecentNote(message, sender);
    case "LOAD_NOTION_PAGE":
      return loadNotionPage(message, sender);
    case "CONVERT_EDIT_TO_NEW_DRAFT":
      return { ok: true, draft: await captureRepository.convertEditDraftToNew(requiredId(message.id)) };
    case "ACTIVATE_DRAFT":
      return { ok: true, draft: await captureRepository.activateDraft(requiredId(message.id), { ...(message.returnDraftId === undefined ? {} : { returnDraftId: message.returnDraftId }) }) };
    case "RELEASE_COMPOSER_SURFACE":
      return releaseComposerSurface(message.sessionId, sender.tab?.id);
    case "RETRY_CAPTURE":
      return requiredCaptureRecordResponse(message.type, deliveryQueue.retry(requiredId(message.id), { force: Boolean(message.force) }));
    case "RETARGET_CAPTURE":
      return requiredCaptureRecordResponse(message.type, deliveryQueue.retry(requiredId(message.id), { force: Boolean(message.force), retarget: true }));
    case "MARK_CAPTURE_DELIVERED":
      return requiredCaptureRecordResponse(message.type, deliveryQueue.markDelivered(requiredId(message.id), message.remote));
    case "DELETE_CAPTURE":
      return deleteCapture(message.id);
    case "DELETE_DELIVERED_HISTORY":
      return deleteDeliveredHistory();
    case "GET_STORAGE_DIAGNOSTICS":
      return { ok: true, diagnostics: await storageDiagnostics() };
    case "EXPORT_CAPTURE_RECOVERY":
      return { ok: true, export: await exportCaptureRecovery(message.format) };
    case "OPEN_CAPTURE_RESULT":
      return openCaptureResult(message.id, message.url);
    case "OPEN_ACTIVITY":
      return openActivity(sender.tab);
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
  })();
  return validatedRuntimeResponse(message, response);
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

async function setTrustedAccess(area: KeyValueStoragePort & { setAccessLevel?: (options: { accessLevel: "TRUSTED_CONTEXTS" }) => Promise<void> }): Promise<void> {
  try {
    await area.setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" });
  } catch (error) {
    console.warn("Could not restrict Quick Note storage access", error);
  }
}

async function getSettings(): Promise<Settings> {
  return normalizeSettings(await chrome.storage.local.get(DEFAULT_SETTINGS));
}

function quickSettings(settings: Settings) {
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

function destinationSnapshot(settings: Settings): CaptureDestination | null {
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

type BackgroundConnection = {
  configured: true;
  token: string;
  connectionHandle: string;
  connectionId: string;
  destination: CaptureDestination | null;
  settings: Settings;
} | {
  configured: false;
  token: string;
  connectionHandle: string;
  connectionId: string;
  destination: CaptureDestination | null;
  settings: Settings;
};

async function currentConnection(): Promise<BackgroundConnection> {
  const settings = await getSettings();
  const configured = Boolean(settings.token && settings.destinationId);
  const connection = {
    token: settings.token,
    connectionHandle: settings.connectionHandle,
    connectionId: settings.connectionId || settings.workspaceId || "",
    destination: destinationSnapshot(settings),
    settings
  };
  return configured ? { configured: true, ...connection } : { configured: false, ...connection };
}

type EnqueueRequest = Extract<RuntimeRequest, { type: "ENQUEUE_CAPTURE" | "SAVE_CAPTURE" }>;

async function enqueueCapture(message: EnqueueRequest, sender: chrome.runtime.MessageSender) {
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

async function getCaptureStatus(message: Extract<RuntimeRequest, { type: "GET_CAPTURE_STATUS" }>) {
  const id = String(message.id || "");
  const draftId = String(message.draftId || "");
  if (!id && !draftId) throw new Error("Capture ID or draft ID is required.");
  const record = id
    ? await captureRepository.getCapture(id)
    : await captureRepository.findCaptureByDraftId(draftId);
  return { ok: true, record: captureStatusRecord(record) };
}

function captureStatusRecord(record: CaptureRecord | null) {
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

type CaptureRequestPayload = EnqueueRequest["capture"];
interface ValidatedCapture {
  document: CapturePayload["document"];
  pageTitle: string;
  url: string;
  includeSource: boolean;
  sources: CaptureSource[];
  selection: string;
}

function validateCapture(capture: CaptureRequestPayload): ValidatedCapture {
  const doc = capture.document?.doc;
  if (!doc || doc.type !== "doc") throw new Error("Quick Note received an invalid document.");
  notionBlocksFromDocument(doc);
  const characters = Array.from(documentText(doc)).length;
  if (!characters) throw new Error("Write something before saving.");
  if (characters > MAX_CAPTURE_CHARACTERS) throw new Error("Quick Notes can contain up to 8,000 characters.");
  return {
    document: {
      version: 1,
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

function validateDraft(draft: CaptureDraftInput, sender: chrome.runtime.MessageSender): CaptureDraft {
  if (!draft.id) throw new Error("Draft ID is required.");
  if (!draft.doc || draft.doc.type !== "doc") throw new Error("Draft content is invalid.");
  return {
    version: 2,
    id: String(draft.id),
    tabId: sender.tab?.id ?? draft.tabId ?? null,
    context: validateContext(draft.context),
    mode: draft.mode === "edit" ? "edit" : "new",
    targetRecordId: String(draft.targetRecordId || ""),
    sources: normalizeSources(draft.sources || []),
    dismissedSourceUrls: normalizeDismissedSourceUrls(draft.dismissedSourceUrls),
    revision: Number(draft.revision || 1),
    sessionId: String(draft.sessionId || ""),
    returnDraftId: String(draft.returnDraftId || ""),
    remote: draft.remote || null,
    baseFingerprint: String(draft.baseFingerprint || ""),
    title: truncateCharacters(draft.title, MAX_CAPTURE_TITLE_CHARACTERS),
    includeSource: draft.includeSource !== false,
    doc: draft.doc,
    createdAt: Number(draft.createdAt || Date.now()),
    updatedAt: Number(draft.updatedAt || Date.now())
  };
}

function validateContext(context: Partial<CaptureContext> = {}): CaptureContext {
  return {
    version: 1,
    title: String(context.title || "").slice(0, 1000),
    url: String(context.url || "").slice(0, 10000),
    selection: truncateCharacters(context.selection, MAX_CAPTURE_CHARACTERS),
    capturedAt: Number(context.capturedAt || Date.now()),
    frameUrl: String(context.frameUrl || "").slice(0, 10000)
  };
}

async function getOrCreateDraft(message: Extract<RuntimeRequest, { type: "GET_OR_CREATE_DRAFT" }>, sender: chrome.runtime.MessageSender): Promise<CaptureDraft> {
  const context = validateContext(message.context || {});
  const tabId = sender.tab?.id ?? message.tabId ?? null;
  const existing = await captureRepository.getOrCreateDraft({
    tabId,
    context,
    includeSource: message.includeSource !== false,
    ...(message.sessionId === undefined ? {} : { sessionId: message.sessionId }),
    ...(message.draftId === undefined ? {} : { draftId: message.draftId })
  });
  if (!context.url) return existing;

  const legacyKey = `draft:${context.url}`;
  const legacy: unknown = (await chrome.storage.session.get(legacyKey))[legacyKey];
  if (legacy === undefined || existing.updatedAt !== existing.createdAt) return existing;
  const migrated = await captureRepository.upsertDraft({
    ...existing,
    title: isRecord(legacy) && typeof legacy.title === "string" ? legacy.title : "",
    includeSource: isRecord(legacy) ? legacy.includeSource !== false : message.includeSource !== false,
    doc: isRecord(legacy) && isRecord(legacy.doc) && legacy.doc.type === "doc" ? normalizeEditorDocument(legacy.doc) : paragraphDocument(typeof legacy === "string" ? legacy : "")
  }, existing.revision);
  await chrome.storage.session.remove(legacyKey);
  if (!migrated) throw new Error("Quick Note could not migrate the saved draft.");
  return migrated;
}

async function deliverRecord(record: CaptureRecord, connection: Extract<BackgroundConnection, { configured: true }>): Promise<RemoteTarget> {
  let settings = { ...connection.settings, ...record.destination };
  let token = connection.token;
  let refreshedToken = false;
  let refreshedSchema = false;
  while (true) {
    try {
      if (record.operation === "update") {
        const latest = await captureRepository.getCapture(record.id) || record;
        if (!latest.pendingCapture) throw new Error("The pending edit is missing its capture payload.");
        return normalizeRemoteTarget(await updateRemoteNote({
          token,
          record: notionRecord(latest),
          capture: notionCapture(latest.pendingCapture),
          baseFingerprint: latest.baseFingerprint,
          journal: latest.syncJournal || {},
          onJournal: async (syncJournal: SyncJournal) => { await captureRepository.updateCapture(record.id, { syncJournal }); }
        }));
      }
      const remote = await sendCapture({ token, settings, capture: record.pendingCapture || record.capture });
      if (!isIncognito) {
        await chrome.storage.local.set({
          lastCapture: { savedAt: new Date().toISOString(), destinationName: settings.destinationName }
        });
      }
      return remote;
    } catch (error: unknown) {
      if (isUnauthorized(error) && connection.connectionHandle && !refreshedToken) {
        let refreshed;
        try {
          refreshed = await refreshStoredToken({ ...connection.settings, token });
        } catch (refreshError: unknown) {
          const detail = errorRecord(refreshError);
          throw new NotionApiError(String(detail.message || "Reconnect Notion to deliver this capture."), { status: 401, code: String(detail.code || "refresh_failed") });
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
        const normalizedDestination = managedDestination(destination);
        settings = { ...settings, ...destinationToSettings(normalizedDestination) };
        await chrome.storage.local.set(destinationToSettings(normalizedDestination));
        refreshedSchema = true;
        continue;
      }
      const detail = errorRecord(error);
      if (detail.code === "network_error" && typeof navigator !== "undefined") detail.offline = navigator.onLine === false;
      throw error;
    }
  }
}

async function findExistingRecord(record: CaptureRecord, connection: Extract<BackgroundConnection, { configured: true }>): Promise<RemoteTarget | null> {
  if (!record.destination?.managedDestination) return null;
  try {
    const existing = await findManagedCaptureById({
      token: connection.token,
      settings: record.destination,
      captureId: record.id
    });
    return existing ? normalizeRemoteTarget(existing) : null;
  } catch (error: unknown) {
    if (!isUnauthorized(error) || !connection.connectionHandle) throw error;
    let refreshed;
    try {
      refreshed = await refreshStoredToken(connection.settings);
    } catch (refreshError: unknown) {
      const detail = errorRecord(refreshError);
      throw new NotionApiError(String(detail.message || "Reconnect Notion to verify this capture."), { status: 401, code: String(detail.code || "refresh_failed") });
    }
    connection.token = refreshed.token;
    connection.settings = refreshed;
    const existing = await findManagedCaptureById({
      token: refreshed.token,
      settings: record.destination,
      captureId: record.id
    });
    return existing ? normalizeRemoteTarget(existing) : null;
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

async function listRecentItems(query = "", limit = 5): Promise<{ drafts: RecentItem[]; notes: RecentItem[]; notionPages: RecentItem[]; notionError: string }> {
  const needle = String(query || "").trim();
  const searching = Boolean(needle);
  const localLimit = Math.max(1, Math.min(Number(limit) || 5, searching ? 100 : 5));
  const draftLimit = searching ? 20 : 5;
  const notionLimit = searching ? 10 : 5;
  const [drafts, notes] = await Promise.all([
    recentDrafts(needle, draftLimit),
    recentNotes(needle, localLimit)
  ]);
  const localPageIds = new Set(
    notes
      .map((note) => normalizeNotionId(note.remotePageId || ""))
      .filter(Boolean)
  );
  let notionPages: RecentItem[] = [];
  let notionError = "";
  try {
    notionPages = await recentNotionPages(needle, notionLimit, localPageIds);
  } catch (error: unknown) {
    notionError = errorMessage(error) || "Notion recent pages are unavailable.";
  }
  return { drafts, notes, notionPages, notionError };
}

async function recentDrafts(query = "", limit = 5): Promise<RecentItem[]> {
  const needle = String(query || "").trim().toLowerCase();
  return (await captureRepository.listDrafts())
    .filter((draft) => documentText(draft.doc).trim())
    .filter((draft) => {
      if (!needle) return true;
      return [
        draft.title,
        documentText(draft.doc),
        ...(draft.sources || []).flatMap((source) => [source.title, source.url])
      ].join(" ").toLowerCase().includes(needle);
    })
    .sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0))
    .slice(0, Math.max(1, Math.min(Number(limit) || 5, 20)))
    .map(recentDraftSummary);
}

async function recentNotes(query = "", limit = 5): Promise<RecentItem[]> {
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

async function recentNotionPages(query = "", limit = 5, excludePageIds: Set<string> = new Set()): Promise<RecentItem[]> {
  const settings = await getSettings();
  if (!settings.token) return [];
  let pages;
  try {
    pages = await searchRecentPages({ token: settings.token, query, limit: Math.max(limit + excludePageIds.size, limit) });
  } catch (error) {
    if (!(error instanceof NotionApiError) || error.status !== 401 || !settings.connectionHandle) throw error;
    const refreshed = await refreshStoredToken(settings);
    pages = await searchRecentPages({ token: refreshed.token, query, limit: Math.max(limit + excludePageIds.size, limit) });
  }
  return pages
    .filter((page) => !excludePageIds.has(page.pageId))
    .slice(0, Math.max(1, Math.min(Number(limit) || 5, 10)))
    .map((page) => ({
      id: page.pageId,
      source: "notion",
      pageId: page.pageId,
      title: page.title || "Untitled page",
      preview: "",
      destinationName: "Notion",
      status: "notion",
      updatedAt: page.updatedAt || 0,
      remoteUrl: page.url || "",
      remotePageId: page.pageId,
      editable: true,
      icon: page.icon || "↳"
    }));
}

function recentDraftSummary(draft: CaptureDraft): RecentItem {
  const explicitTitle = String(draft.title || "").trim();
  const body = documentText(draft.doc).trim();
  const lines = body.split("\n").map((line) => line.trim()).filter(Boolean);
  const preview = (explicitTitle ? body : lines.slice(1).join(" ")).replace(/\s+/g, " ").trim();
  return {
    id: draft.id,
    source: "draft",
    title: explicitTitle || lines[0] || "Untitled draft",
    preview: truncateCharacters(preview, 180),
    sources: normalizeSources(draft.sources || []),
    destinationName: draft.mode === "edit" ? "Editing in Quick Note" : "Local draft",
    status: "draft",
    mode: draft.mode === "edit" ? "edit" : "new",
    updatedAt: draft.updatedAt,
    remoteUrl: draft.remote?.url || "",
    editable: true
  };
}

function recentNoteSummary(record: CaptureRecord): RecentItem {
  const capture = record.pendingCapture || record.syncedCapture || record.capture || {};
  const explicitTitle = String(capture.document?.title || "").trim();
  const body = documentText(capture.document?.doc).trim();
  const lines = body.split("\n").map((line) => line.trim()).filter(Boolean);
  const preview = (explicitTitle ? body : lines.slice(1).join(" ")).replace(/\s+/g, " ").trim();
  return {
    id: record.id,
    source: record.importedFromNotion ? "notion-local" : "note",
    title: explicitTitle || lines[0] || "Untitled note",
    preview: truncateCharacters(preview, 180),
    sources: normalizeSources(capture.sources || []),
    destinationName: record.destination?.destinationName || "Notion",
    status: record.status,
    updatedAt: record.updatedAt,
    remoteUrl: record.remote?.url || record.destination?.destinationUrl || "",
    remotePageId: normalizeNotionId(record.remote?.pageId || record.remote?.id || ""),
    editable: Boolean(record.remote?.kind === "page" || record.remote?.kind === "section")
  };
}

type LoadRecentRequest = Extract<RuntimeRequest, { type: "LOAD_RECENT_NOTE" }>;
type LoadNotionRequest = Extract<RuntimeRequest, { type: "LOAD_NOTION_PAGE" }>;

async function loadRecentNote(message: LoadRecentRequest, sender: chrome.runtime.MessageSender) {
  const id = requiredId(message.id);
  const record = await captureRepository.getCapture(id);
  if (!record) throw new Error("That recent note is no longer stored locally.");
  return hydrateEditDraftFromRecord(record, message, sender);
}

async function loadNotionPage(message: LoadNotionRequest, sender: chrome.runtime.MessageSender) {
  const pageId = normalizeNotionId(requiredId(message.pageId));
  if (!pageId) throw new Error("A Notion page ID is required.");
  const connection = await currentConnection();
  if (!connection.token) throw new Error("Reconnect Notion before opening a Notion page.");
  const existing = await captureRepository.findCaptureByRemotePageId(pageId);
  if (existing && (existing.status === DELIVERY_STATES.delivered || existing.status === DELIVERY_STATES.blockedConflict)) {
    return hydrateEditDraftFromRecord(existing, { ...message, id: existing.id }, sender);
  }

  const placeholder = await captureRepository.ensureImportedRemoteCapture({
    pageId,
    title: String(message.title || "").trim(),
    url: String(message.url || "").trim(),
    connectionId: connection.connectionId || "",
    destination: {
      destinationId: pageId,
      destinationName: String(message.title || "").trim() || "Notion page",
      destinationUrl: String(message.url || "").trim(),
      destinationType: "page",
      titleProperty: "title",
      managedDestination: false
    },
    remote: {
      kind: "page",
      id: pageId,
      pageId,
      url: String(message.url || "").trim(),
      blockIds: [],
      fingerprint: ""
    }
  });
  if (!placeholder) throw new Error("Quick Note could not prepare this Notion page.");

  return hydrateEditDraftFromRecord(placeholder, { ...message, id: placeholder.id, reloadLatest: true }, sender);
}

interface HydrationRequest {
  id: string;
  tabId?: number;
  sessionId?: string;
  reloadLatest?: boolean;
}

async function hydrateEditDraftFromRecord(record: CaptureRecord, message: HydrationRequest, sender: chrome.runtime.MessageSender) {
  const id = record.id;
  const activeDraft = await captureRepository.getActiveDraft();
  const returnDraftId = activeDraft?.mode === "edit" && activeDraft.targetRecordId === id
    ? activeDraft.returnDraftId || ""
    : activeDraft?.id || "";
  let loaded;
  const pendingConflict = record.status === DELIVERY_STATES.blockedConflict && !message.reloadLatest ? record.pendingCapture : null;
  const usePendingConflict = Boolean(pendingConflict);
  if (pendingConflict) {
    loaded = {
      title: pendingConflict.document.title || "",
      doc: pendingConflict.document.doc,
      sources: normalizeSources(pendingConflict.sources || []),
      remote: record.remote,
      baseFingerprint: record.baseFingerprint || record.remote?.fingerprint || ""
    };
  } else {
    const connection = await currentConnection();
    if (!connection.token) throw new Error("Reconnect Notion before editing a recent note.");
    if (record.connectionId && record.connectionId !== connection.connectionId) {
      throw new Error("Reconnect the Notion workspace that owns this note.");
    }
    try {
      loaded = await loadRemoteNote({ token: connection.token, record: notionRecord(record) });
    } catch (error) {
      if (!isUnauthorized(error) || !connection.connectionHandle) throw error;
      const refreshed = await refreshStoredToken(connection.settings);
      loaded = await loadRemoteNote({ token: refreshed.token, record: notionRecord(record) });
    }
    if (!record.remote?.fingerprint || message.reloadLatest) {
      await captureRepository.updateCapture(id, {
        remote: normalizeRemoteTarget(loaded.remote),
        syncedCapture: {
          ...(record.syncedCapture || record.capture || {}),
          document: {
            version: 1,
            title: loaded.title,
            doc: loaded.doc
          },
          sources: normalizeSources(loaded.sources),
          includeSource: loaded.sources.length > 0
        },
        destination: record.destination || {
          destinationId: loaded.remote.pageId,
          destinationName: loaded.title || "Notion page",
          destinationUrl: loaded.remote.url || "",
          destinationType: "page",
          titleProperty: "title",
          managedDestination: false
        },
        baseFingerprint: loaded.baseFingerprint
      });
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

async function deleteCapture(id: string) {
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
    typeof navigator.storage?.estimate === "function" ? navigator.storage.estimate().catch((): StorageEstimate => ({})) : {},
    typeof navigator.storage?.persisted === "function" ? navigator.storage.persisted().catch(() => false) : false
  ]);
  const storageEstimate: StorageEstimate = estimate;
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
      usedBytes: Number(storageEstimate.usage || 0),
      quotaBytes: Number(storageEstimate.quota || 0)
    }
  };
}

async function exportCaptureRecovery(format: "json" | "markdown") {
  const [drafts, captures] = await Promise.all([
    captureRepository.listDrafts(),
    captureRepository.listCaptures()
  ]);
  return createRecoveryExport({
    drafts: drafts.sort((left, right) => right.updatedAt - left.updatedAt),
    captures: captures.sort((left, right) => right.updatedAt - left.updatedAt),
    profile: isIncognito ? "incognito" : "regular",
    format
  });
}

async function openCaptureResult(id: string, explicitUrl = "") {
  const directUrl = String(explicitUrl || "").trim();
  if (directUrl) {
    if (!/^https:\/\/([\w-]+\.)*notion\.(so|site)\//i.test(directUrl)) {
      throw new Error("Only Notion links can be opened from Recent.");
    }
    await chrome.tabs.create({ url: directUrl });
    return { ok: true };
  }
  const record = await captureRepository.getCapture(requiredId(id));
  const url = record?.remote?.url || record?.destination?.destinationUrl;
  if (!url || !/^https:\/\//.test(url)) throw new Error("No Notion link is available for this capture.");
  await chrome.tabs.create({ url });
  return { ok: true };
}

async function handleCaptureRepositoryChange(event: CaptureChangeEvent): Promise<void> {
  if (event.structural) {
    if (event.kind !== "maintenance") await captureRepository.maintain({ recoverInterrupted: false });
    await updateQueueSurfaces();
  }
  chrome.runtime.sendMessage({ type: "CAPTURE_ACTIVITY_CHANGED", kind: event.kind }).catch(() => undefined);
}

async function updateQueueSurfaces() {
  const records = await captureRepository.listCaptures();
  const state: CaptureState = { version: 2, drafts: {}, activeDraftId: "", captures: Object.fromEntries(records.map((record) => [record.id, record])) };
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

async function findDestinations(query: string): Promise<Destination[]> {
  let settings = await getSettings();
  try {
    return (await searchDestinations({ token: settings.token, query })).map(normalizeDestination).filter((item): item is Destination => item !== null);
  } catch (error) {
    if (!(error instanceof NotionApiError) || error.status !== 401 || !settings.connectionHandle) throw error;
    settings = await refreshStoredToken(settings);
    return (await searchDestinations({ token: settings.token, query })).map(normalizeDestination).filter((item): item is Destination => item !== null);
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

async function validateDestinationSelection(destination: Destination) {
  const settings = await getSettings();
  if (!settings.token) return { ok: false, ready: false, error: "Reconnect Notion before choosing a destination.", reconnect: true };
  const destinationType: "page" | "database" = destination.type === "page" ? "page" : "database";
  const candidate = {
    destinationId: String(destination.id || ""),
    destinationType,
    titleProperty: String(destination.titleProperty || "Name"),
    managedDestination: false,
    destinationProperties: settings.destinationProperties
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

function destinationErrorResponse(error: unknown) {
  const response = errorResponse(error);
  const detail = errorRecord(error);
  if (Number(detail.status || 0) === 403 || Number(detail.status || 0) === 404) {
    response.kind = "capability";
    response.error = "Quick Note cannot access this destination. Reshare it with the integration and make sure the integration has Insert Content capability.";
  }
  return response;
}

async function disconnectNotion(confirmed: boolean) {
  const records = await captureRepository.listCaptures();
  const state: CaptureState = { version: 2, drafts: {}, activeDraftId: "", captures: Object.fromEntries(records.map((record) => [record.id, record])) };
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
      lastError: { kind: "auth", message: "Reconnect or retarget this capture to deliver it." }
    });
  }
  await updateQueueSurfaces();
  return { ok: true, warning };
}

async function openQuickNote(tab: chrome.tabs.Tab | undefined, forcedSelection = "") {
  if (tab?.id === undefined || !supportsOverlay(tab.url) || isPdfUrl(tab.url)) {
    if (tab?.id !== undefined) await markOverlayUnavailable(tab.id, "Quick Note can only open on regular web pages, not browser pages or PDFs.");
    return { ok: false, surface: "unavailable" };
  }
  const eligibleTab = tab as chrome.tabs.Tab & { id: number };

  let context: CaptureContext;
  try {
    context = await collectCaptureContext(eligibleTab, forcedSelection);
    await ensureContentRuntime(eligibleTab.id);
  } catch (error) {
    await markOverlayUnavailable(eligibleTab.id, errorMessage(error) || "Quick Note could not open on this page.");
    return { ok: false, surface: "unavailable" };
  }

  return enqueueComposerOperation(() => openQuickNoteSurface(eligibleTab, context));
}

async function openQuickNoteSurface(tab: chrome.tabs.Tab & { id: number }, context: CaptureContext) {
  const surfaces = await composerSurfaces();
  const activeSurface = surfaces[String(tab.id)];
  if (activeSurface?.tabId === tab.id) {
    const surface = await chrome.tabs.sendMessage(tab.id, { type: "QUICK_NOTE_PING" }).catch(() => null) as { open?: boolean; sessionId?: string } | null;
    if (surface?.open && surface.sessionId === activeSurface.sessionId) {
      await chrome.tabs.sendMessage(tab.id, {
        type: "TOGGLE_QUICK_NOTE",
        page: context,
        draftId: activeSurface.draftId,
        tabId: tab.id,
        sessionId: activeSurface.sessionId
      });
      return { ok: true, surface: "overlay" };
    }
    delete surfaces[String(tab.id)];
    await saveComposerSurfaces(surfaces);
  }

  try {
    const sessionId = crypto.randomUUID();
    const draft = await captureRepository.getOrCreateDraft({
      tabId: tab.id,
      context,
      includeSource: (await getSettings()).includeSource,
      sessionId
    });
    surfaces[String(tab.id)] = { tabId: tab.id, draftId: draft.id, sessionId, context };
    await saveComposerSurfaces(surfaces);
    await chrome.tabs.sendMessage(tab.id, {
      type: "TOGGLE_QUICK_NOTE",
      page: context,
      draftId: draft.id,
      tabId: tab.id,
      sessionId,
      revision: draft.revision
    });
    await clearOverlayUnavailable(tab.id);
    return { ok: true, surface: "overlay" };
  } catch (error) {
    await markOverlayUnavailable(tab.id, errorMessage(error) || "Quick Note could not open on this page.");
    return { ok: false, surface: "unavailable" };
  }
}

interface ActiveComposerSurface {
  tabId: number;
  draftId: string;
  sessionId: string;
  context?: CaptureContext;
}

function storedComposerSurface(value: unknown): ActiveComposerSurface | null {
  if (!isRecord(value) || !Number.isInteger(value.tabId) || typeof value.draftId !== "string" || typeof value.sessionId !== "string") return null;
  return {
    tabId: Number(value.tabId),
    draftId: value.draftId,
    sessionId: value.sessionId,
    ...(isStoredCaptureContext(value.context) ? { context: value.context } : {})
  };
}

async function composerSurfaces(): Promise<Record<string, ActiveComposerSurface>> {
  const value: unknown = (await chrome.storage.session.get(ACTIVE_SURFACE_KEY))[ACTIVE_SURFACE_KEY];
  const legacy = storedComposerSurface(value);
  if (legacy) return { [String(legacy.tabId)]: legacy };
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .map(([tabId, surface]) => [tabId, storedComposerSurface(surface)] as const)
    .filter((entry): entry is [string, ActiveComposerSurface] => entry[1] !== null));
}

async function saveComposerSurfaces(surfaces: Record<string, ActiveComposerSurface>): Promise<void> {
  if (Object.keys(surfaces).length) await chrome.storage.session.set({ [ACTIVE_SURFACE_KEY]: surfaces });
  else await chrome.storage.session.remove(ACTIVE_SURFACE_KEY);
}

function isStoredCaptureContext(value: unknown): value is CaptureContext {
  return isRecord(value)
    && value.version === 1
    && typeof value.title === "string"
    && typeof value.url === "string"
    && typeof value.selection === "string"
    && typeof value.capturedAt === "number"
    && (value.frameUrl === undefined || typeof value.frameUrl === "string");
}

async function releaseComposerSurface(sessionId: string, tabId?: number): Promise<{ ok: true }> {
  return enqueueComposerOperation(async () => {
    const surfaces = await composerSurfaces();
    const matching = Object.entries(surfaces).find(([, surface]) => surface.sessionId === sessionId && (tabId === undefined || surface.tabId === tabId));
    if (matching) {
      delete surfaces[matching[0]];
      await saveComposerSurfaces(surfaces);
    }
    return { ok: true };
  });
}

async function collectCaptureContext(tab: chrome.tabs.Tab, forcedSelection = ""): Promise<CaptureContext> {
  if (tab.id === undefined) throw new Error("No active page is available for Quick Note.");
  interface PageProbe { title: string; url: string; frameUrl: string; selection: string; focused: boolean }
  const frames = await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    func: () => ({
      title: window.top === window ? document.title : "",
      url: window.top === window ? location.href : "",
      frameUrl: location.href,
      selection: window.getSelection()?.toString().trim() || "",
      focused: document.hasFocus()
    })
  }) as Array<{ frameId: number; result?: PageProbe }>;
  const top: PageProbe = frames.find((frame) => frame.frameId === 0)?.result || { title: "", url: "", frameUrl: "", selection: "", focused: false };
  const focused = frames.find((frame) => frame.result?.focused && frame.result?.selection)
    || frames.find((frame) => frame.result?.selection)
    || null;
  return validateContext({
    title: top.title || tab.title || "Current tab",
    url: top.url || tab.url || "",
    frameUrl: focused?.result?.frameUrl || top.url || tab.url || "",
    selection: forcedSelection || focused?.result?.selection || top.selection || ""
  });
}

function supportsOverlay(url = ""): boolean {
  try {
    return ["http:", "https:", "file:"].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

function isPdfUrl(url = ""): boolean {
  try {
    return new URL(url).pathname.toLowerCase().endsWith(".pdf");
  } catch {
    return false;
  }
}

async function markOverlayUnavailable(tabId: number, detail: string): Promise<void> {
  await Promise.all([
    chrome.action.setBadgeText({ tabId, text: "!" }),
    chrome.action.setBadgeBackgroundColor({ tabId, color: "#b3261e" }),
    chrome.action.setTitle({ tabId, title: `Quick Note unavailable: ${detail}` }),
    showUnavailableNotice(tabId, detail)
  ]);
}

async function clearOverlayUnavailable(tabId: number): Promise<void> {
  await Promise.all([
    chrome.action.setBadgeText({ tabId, text: "" }),
    chrome.action.setTitle({ tabId, title: "Open Notion Quick Note" })
  ]);
}

async function openActivity(_tab: chrome.tabs.Tab | undefined) {
  await chrome.tabs.create({ url: chrome.runtime.getURL("options/options.html#activity") });
  return { ok: true };
}

function notionSourceUrl(url: string, includeSource: boolean): string {
  if (!includeSource) return "";
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.pathname.toLowerCase().endsWith(".pdf")) return "";
    return parsed.href;
  } catch {
    return "";
  }
}

function destinationToSettings(destination: ManagedDestination) {
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

function isUnauthorized(error: unknown): error is NotionApiError {
  return error instanceof NotionApiError && error.status === 401;
}

function isManagedSchemaError(error: unknown, settings: Settings): error is NotionApiError {
  return settings.managedDestination && error instanceof NotionApiError && error.status === 400 && error.code === "validation_error";
}

function errorResponse(error: unknown) {
  const detail = errorRecord(error);
  return {
    ok: false,
    error: errorMessage(error),
    status: Number(detail.status || 0),
    code: String(detail.code || ""),
    kind: errorKind(error),
    retryAfter: Number(detail.retryAfter || 0),
    reconnect: detail.status === 401
  };
}

function errorKind(error: unknown): string {
  const detail = errorRecord(error);
  if (detail.code === "provisioning_uncertain") return "recovering";
  if (detail.status === 401) return "authentication";
  if (detail.status === 403 || detail.status === 404) return "capability";
  if (detail.status === 429) return "rate_limited";
  if (!detail.status || Number(detail.status) >= 500) return "transient";
  return "generic";
}

function unresolvedCount(state: CaptureState): number {
  return Object.values(state.captures).filter((record) => record.status !== DELIVERY_STATES.delivered).length;
}

function requiredId(value: unknown): string {
  if (typeof value !== "string" || !value) throw new Error("Capture ID is required.");
  return value;
}

function documentText(node: EditorNode | undefined): string {
  if (!node) return "";
  if (node.type === "text") return node.text || "";
  if (node.type === "hardBreak") return "\n";
  return (node.content || []).map(documentText).join(node.type === "doc" ? "\n" : "").trim();
}

function paragraphDocument(text: string): EditorNode {
  return { type: "doc", content: [{ type: "paragraph", ...(text ? { content: [{ type: "text", text }] } : {}) }] };
}

function truncateCharacters(value: unknown, limit: number): string {
  return Array.from(String(value || "")).slice(0, limit).join("");
}

function provisioningSettings(settings: Settings): ProvisioningSettings {
  return { ...settings };
}

function notionSettings(settings: ProvisioningSettings): Omit<ProvisioningSettings, "databaseProvisioning"> {
  const { databaseProvisioning: _databaseProvisioning, ...rest } = settings;
  return rest;
}

function requiredToken(value: string | undefined): string {
  if (!value) throw new Error("Connect Notion first.");
  return value;
}

function managedDestination(value: unknown): ManagedDestination {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.databaseId !== "string"
    || typeof value.name !== "string" || typeof value.titleProperty !== "string"
    || typeof value.schemaVersion !== "number" || typeof value.marker !== "string") {
    throw new Error("Notion returned an invalid managed destination.");
  }
  const properties: Record<string, { id: string; name: string }> = {};
  if (isRecord(value.properties)) {
    for (const [name, property] of Object.entries(value.properties)) {
      if (isRecord(property) && typeof property.id === "string") {
        properties[name] = { id: property.id, name: typeof property.name === "string" ? property.name : name };
      }
    }
  }
  return {
    id: value.id,
    databaseId: value.databaseId,
    type: "database",
    name: value.name,
    url: typeof value.url === "string" ? value.url : "",
    icon: typeof value.icon === "string" ? value.icon : "",
    titleProperty: value.titleProperty,
    managedDestination: true,
    schemaVersion: value.schemaVersion,
    marker: value.marker,
    properties
  };
}

function normalizeEditorDocument(value: Record<string, unknown>): EditorNode {
  return {
    type: typeof value.type === "string" ? value.type : "doc",
    ...(typeof value.text === "string" ? { text: value.text } : {}),
    ...(Array.isArray(value.content) ? {
      content: value.content.filter(isRecord).map(normalizeEditorDocument)
    } : {})
  };
}

function normalizeRemoteTarget(value: unknown): RemoteTarget {
  if (!isRecord(value)) throw new Error("Notion returned an invalid remote target.");
  const kind = value.kind === "section" || value.kind === "legacy_section" ? value.kind : "page";
  const pageId = typeof value.pageId === "string" ? value.pageId : "";
  return {
    kind,
    id: typeof value.id === "string" ? value.id : pageId,
    pageId,
    url: typeof value.url === "string" ? value.url : "",
    blockIds: Array.isArray(value.blockIds) ? value.blockIds.filter((id): id is string => typeof id === "string") : [],
    fingerprint: typeof value.fingerprint === "string" ? value.fingerprint : "",
    ...(typeof value.lastEditedTime === "string" ? { lastEditedTime: value.lastEditedTime } : {})
  };
}

function notionCapture(capture: CapturePayload) {
  return {
    document: capture.document,
    captureId: capture.captureId,
    sources: capture.sources,
    includeSource: capture.includeSource
  };
}

function notionRecord(record: CaptureRecord) {
  return {
    capture: notionCapture(record.capture),
    ...(record.remote ? { remote: record.remote } : {}),
    ...(record.syncJournal ? { syncJournal: record.syncJournal } : {}),
    ...(record.pendingCapture ? { pendingCapture: notionCapture(record.pendingCapture) } : {}),
    ...(record.syncedCapture ? { syncedCapture: notionCapture(record.syncedCapture) } : {}),
    ...(record.destination ? { destination: record.destination } : {})
  };
}

function normalizeDestination(value: unknown): Destination | null {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id
    || (value.type !== "page" && value.type !== "database") || typeof value.name !== "string") return null;
  return {
    id: value.id,
    type: value.type,
    name: value.name,
    ...(typeof value.databaseId === "string" ? { databaseId: value.databaseId } : {}),
    ...(typeof value.url === "string" ? { url: value.url } : {}),
    ...(typeof value.icon === "string" ? { icon: value.icon } : {}),
    ...(typeof value.titleProperty === "string" ? { titleProperty: value.titleProperty } : {}),
    ...(typeof value.managedDestination === "boolean" ? { managedDestination: value.managedDestination } : {}),
    ...(typeof value.schemaVersion === "number" ? { schemaVersion: value.schemaVersion } : {}),
    ...(typeof value.marker === "string" ? { marker: value.marker } : {})
  };
}

function errorRecord(error: unknown): Record<string, unknown> {
  if (isRecord(error)) return error;
  if (error instanceof Error) {
    return { name: error.name, message: error.message, cause: error.cause ?? null };
  }
  return {};
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || "Unknown error");
}
