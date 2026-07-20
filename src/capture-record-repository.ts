import {
  addContextToDraft,
  CAPTURE_DRAFT_VERSION,
  CAPTURE_RECORD_VERSION,
  CaptureStorageError,
  DELIVERY_STATES,
  emptyCaptureState,
  hasDraftBody,
  normalizeDraft,
  normalizeEditorNode,
  normalizeRecord,
  normalizeSources,
  selectionDocument,
  sourceFromContext
} from "./capture-store.js";
import type {
  CaptureBackend,
  CaptureBackendTransaction,
  CaptureChangeEvent,
  CaptureChangeHandler,
  CaptureDestination,
  CaptureDocument,
  CaptureDraft,
  CaptureRecord,
  CaptureRecordUpdate,
  CaptureState,
  Clock,
  DeliveryState,
  EditorNode,
  RemoteTarget,
  StorageMetadata,
  UUIDFactory
} from "./contracts.js";
import { isRecord } from "./contracts.js";

export const CAPTURE_INDEX_VERSION = 3;
export const CAPTURE_META_KEY = "state";

export function emptyCaptureMeta(): StorageMetadata {
  return {
    key: CAPTURE_META_KEY,
    version: CAPTURE_INDEX_VERSION,
    activeDraftId: "",
    migrationStatus: "pending",
    migrationError: "",
    lastMaintenanceAt: 0
  };
}

function compactRemoteId(value: unknown = ""): string {
  return String(value || "").replaceAll("-", "").toLowerCase();
}

interface RecordRepositoryOptions {
  backend: CaptureBackend;
  now?: Clock;
  uuid?: UUIDFactory;
}

interface EditDraftRequest {
  recordId: string;
  title: string;
  doc: unknown;
  sources?: unknown;
  remote?: unknown;
  baseFingerprint?: string;
  returnDraftId?: string;
  tabId?: number | null;
  sessionId?: string;
  replace?: boolean;
}

interface EnqueueRequest {
  draftId?: string;
  capture: unknown;
  context?: unknown;
  destination: CaptureDestination | null;
  connectionId?: string;
  status: DeliveryState;
  incognito?: boolean;
}

interface ImportRemoteCaptureRequest {
  pageId: string;
  title?: string;
  url?: string;
  connectionId?: string;
  destination?: CaptureDestination | null;
  remote?: unknown;
  document?: unknown;
}

export function createRecordCaptureRepository({ backend, now = () => Date.now(), uuid = () => crypto.randomUUID() }: RecordRepositoryOptions) {
  let changeHandler: CaptureChangeHandler = async () => undefined;

  async function transaction<T>(stores: Parameters<CaptureBackend["transaction"]>[0], mode: Parameters<CaptureBackend["transaction"]>[1], callback: (transaction: CaptureBackendTransaction) => Promise<T> | T): Promise<T> {
    try {
      return await backend.transaction(stores, mode, callback);
    } catch (error: unknown) {
      if (error instanceof CaptureStorageError) throw error;
      if (isRecord(error) && error.name === "QuotaExceededError") {
        throw new CaptureStorageError("Quick Note local storage is full. Remove old drafts or delivered history before saving.", "capture_storage_full");
      }
      throw new CaptureStorageError(errorMessage(error, "Quick Note could not store this capture locally."));
    }
  }

  async function changed(kind: CaptureChangeEvent["kind"], detail: Omit<CaptureChangeEvent, "kind"> = {}): Promise<void> {
    const event = { kind, ...detail };
    await Promise.resolve(globalThis.__notionQuickNoteCaptureCheckpoint?.(event));
    await Promise.resolve(changeHandler(event)).catch(() => undefined);
  }

  async function metaIn(tx: CaptureBackendTransaction): Promise<StorageMetadata> {
    return { ...emptyCaptureMeta(), ...(await tx.getMeta()) };
  }

  const repository = {
    backendName: backend.name,
    setChangeHandler(handler: CaptureChangeHandler) {
      changeHandler = typeof handler === "function" ? handler : async () => undefined;
    },
    async load() {
      return transaction(["meta", "drafts", "captures"], "readonly", async (tx) => {
        const [meta, drafts, captures] = await Promise.all([metaIn(tx), tx.getAllDrafts(), tx.getAllCaptures()]);
        const state: CaptureState = {
          version: 2,
          drafts: Object.fromEntries(drafts.map((draft) => [draft.id, normalizeDraft(draft)])),
          activeDraftId: drafts.some((draft) => draft.id === meta.activeDraftId) ? meta.activeDraftId : "",
          captures: Object.fromEntries(captures.map((record) => [record.id, normalizeRecord(record)]))
        };
        return state;
      });
    },
    async importState(state: CaptureState | null | undefined, metaUpdates: Partial<StorageMetadata> = {}) {
      const normalized = state || emptyCaptureState();
      await transaction(["meta", "drafts", "captures"], "readwrite", async (tx) => {
        await tx.clearDrafts();
        await tx.clearCaptures();
        for (const draft of Object.values(normalized.drafts || {})) {
          if (hasDraftBody(draft)) await tx.putDraft(normalizeDraft(draft));
        }
        for (const record of Object.values(normalized.captures || {})) await tx.putCapture(normalizeRecord(record));
        await tx.putMeta({
          ...emptyCaptureMeta(),
          activeDraftId: normalized.drafts?.[normalized.activeDraftId] ? normalized.activeDraftId : "",
          ...metaUpdates
        });
      });
      await changed("import", { structural: true });
      return repository.load();
    },
    async save(state: CaptureState) {
      return repository.importState(state);
    },
    async updateState(callback: (state: CaptureState) => void | Promise<void>) {
      const state = await repository.load();
      await callback(state);
      return repository.importState(state);
    },
    async getMeta() {
      return transaction(["meta"], "readonly", metaIn);
    },
    async updateMeta(updates: Partial<StorageMetadata>) {
      return transaction(["meta"], "readwrite", async (tx) => {
        const meta: StorageMetadata = { ...(await metaIn(tx)), ...updates, key: "state" };
        await tx.putMeta(meta);
        return meta;
      });
    },
    async getDraft(id: string) {
      const draft = await transaction(["drafts"], "readonly", (tx) => tx.getDraft(String(id || "")));
      return draft ? normalizeDraft(draft) : null;
    },
    async getActiveDraft() {
      return transaction(["meta", "drafts"], "readonly", async (tx) => {
        const meta = await metaIn(tx);
        const draft = meta.activeDraftId ? await tx.getDraft(meta.activeDraftId) : null;
        return draft ? normalizeDraft(draft) : null;
      });
    },
    async getCapture(id: string) {
      const record = await transaction(["captures"], "readonly", (tx) => tx.getCapture(String(id || "")));
      return record ? normalizeRecord(record) : null;
    },
    async findCaptureByDraftId(draftId: string) {
      const record = await transaction(["captures"], "readonly", (tx) => tx.findCaptureByDraftId(String(draftId || "")));
      return record ? normalizeRecord(record) : null;
    },
    async listDrafts() {
      const drafts = await transaction(["drafts"], "readonly", (tx) => tx.getAllDrafts());
      return drafts;
    },
    async listCaptures({ statuses }: { statuses?: DeliveryState[] } = {}) {
      const records = await transaction(["captures"], "readonly", (tx) => tx.getAllCaptures());
      const allowed = statuses?.length ? new Set(statuses) : null;
      return records.filter((record) => !allowed || allowed.has(record.status));
    },
    async listDueCaptures(timestamp = now()) {
      const records = await transaction(["captures"], "readonly", (tx) => tx.getDueCaptures(timestamp));
      return records.sort((left, right) => left.createdAt - right.createdAt);
    },
    async countByStatus() {
      const records = await repository.listCaptures();
      return records.reduce<Partial<Record<DeliveryState, number>>>((counts, record) => {
        counts[record.status] = (counts[record.status] || 0) + 1;
        return counts;
      }, {});
    },
    async getOrCreateDraft({ tabId, context, includeSource = true, sessionId = "", draftId = "" }: { tabId?: number | null; context?: unknown; includeSource?: boolean; sessionId?: string; draftId?: string }) {
      let structural = false;
      const result = await transaction(["meta", "drafts"], "readwrite", async (tx) => {
        const meta = await metaIn(tx);
        const requestedId = String(draftId || "");
        const requested = requestedId ? await tx.getDraft(requestedId) : null;
        const active = !requested && meta.activeDraftId ? await tx.getDraft(meta.activeDraftId) : null;
        if (requested || active) {
          const existing = requested || active;
          const next = addContextToDraft(existing, context, now());
          const sessionChanged = Boolean(sessionId && sessionId !== next.sessionId);
          next.tabId = tabId ?? next.tabId ?? null;
          next.sessionId = sessionId || next.sessionId || "";
          if (sessionChanged) {
            next.revision = Number(next.revision || 0) + 1;
            next.updatedAt = now();
          }
          await tx.putDraft(next);
          if (meta.activeDraftId !== next.id) {
            meta.activeDraftId = next.id;
            await tx.putMeta(meta);
            structural = true;
          }
          return next;
        }
        const id = requestedId || uuid();
        const timestamp = now();
        const source = sourceFromContext(context);
        const draft = requireDraft({
          version: CAPTURE_DRAFT_VERSION,
          id,
          tabId: tabId ?? null,
          context,
          mode: "new",
          targetRecordId: "",
          sources: source ? [source] : [],
          revision: 1,
          sessionId: sessionId || "",
          returnDraftId: "",
          title: "",
          includeSource,
          doc: selectionDocument(source?.selection || ""),
          createdAt: timestamp,
          updatedAt: timestamp
        });
        if (hasDraftBody(draft)) {
          await tx.putDraft(draft);
          meta.activeDraftId = id;
          await tx.putMeta(meta);
          structural = true;
        }
        return draft;
      });
      await changed("draft", { structural, id: result.id });
      return result;
    },
    async upsertDraft(draft: CaptureDraft, expectedRevision?: number) {
      let structural = false;
      const result = await transaction(["meta", "drafts"], "readwrite", async (tx) => {
        if (!draft?.id) throw new CaptureStorageError("Draft ID is required.", "invalid_draft");
        const meta = await metaIn(tx);
        const existing = await tx.getDraft(draft.id);
        const staleRevision = expectedRevision !== undefined && Number(expectedRevision) !== Number(existing?.revision || 0);
        const staleSession = Boolean(draft.sessionId && existing?.sessionId && draft.sessionId !== existing.sessionId);
        if (existing && (staleRevision || staleSession)) {
          throw new CaptureStorageError("This note was updated in another tab. Reload the latest copy to continue.", "stale_draft");
        }
        const next = requireDraft({
          ...(existing || {}),
          ...draft,
          version: CAPTURE_DRAFT_VERSION,
          mode: draft.mode === "edit" ? "edit" : existing?.mode || "new",
          targetRecordId: String(draft.targetRecordId ?? existing?.targetRecordId ?? ""),
          sources: normalizeSources(draft.sources ?? existing?.sources ?? [sourceFromContext(draft.context || existing?.context)].filter(Boolean)),
          revision: Number(existing?.revision || 0) + 1,
          createdAt: existing?.createdAt || now(),
          updatedAt: now()
        });
        if (!hasDraftBody(next)) {
          if (existing) {
            await tx.deleteDraft(next.id);
            structural = true;
          }
          if (meta.activeDraftId === next.id) {
            meta.activeDraftId = next.returnDraftId && await tx.getDraft(next.returnDraftId) ? next.returnDraftId : "";
            await tx.putMeta(meta);
            structural = true;
          }
          return null;
        }
        await tx.putDraft(next);
        if (!existing) structural = true;
        if (!meta.activeDraftId) {
          structural = true;
          meta.activeDraftId = next.id;
          await tx.putMeta(meta);
        }
        return next;
      });
      await changed("draft", { structural, id: draft.id });
      return result;
    },
    async activateDraft(id: string, { returnDraftId = "" }: { returnDraftId?: string } = {}) {
      const result = await transaction(["meta", "drafts"], "readwrite", async (tx) => {
        const draft = await tx.getDraft(id);
        if (!draft) return null;
        const meta = await metaIn(tx);
        if (returnDraftId && returnDraftId !== id) draft.returnDraftId = returnDraftId;
        draft.updatedAt = now();
        draft.revision = Number(draft.revision || 0) + 1;
        meta.activeDraftId = id;
        await tx.putDraft(draft);
        await tx.putMeta(meta);
        return normalizeDraft(draft);
      });
      if (result) await changed("draft", { structural: true, id });
      return result;
    },
    async createEditDraft({ recordId, title, doc, sources, remote, baseFingerprint, returnDraftId = "", tabId = null, sessionId = "", replace = false }: EditDraftRequest) {
      let created = false;
      const result = await transaction(["meta", "drafts", "captures"], "readwrite", async (tx) => {
        const record = await tx.getCapture(recordId);
        if (!record) return null;
        const meta = await metaIn(tx);
        const drafts = await tx.getAllDrafts();
        const existing = drafts.find((draft) => draft.mode === "edit" && draft.targetRecordId === recordId);
        if (existing) {
          if (replace) Object.assign(existing, { title, doc, sources: normalizeSources(sources), remote, baseFingerprint });
          existing.returnDraftId = returnDraftId || existing.returnDraftId || "";
          existing.tabId = tabId;
          existing.sessionId = sessionId || existing.sessionId || "";
          existing.updatedAt = now();
          existing.revision = Number(existing.revision || 0) + 1;
          meta.activeDraftId = existing.id;
          await tx.putDraft(existing);
          await tx.putMeta(meta);
          return normalizeDraft(existing);
        }
        const timestamp = now();
        const normalizedSources = normalizeSources(sources);
        const draft = requireDraft({
          id: uuid(), tabId, mode: "edit", targetRecordId: recordId, returnDraftId, sessionId,
          title, doc, sources: normalizedSources, remote, baseFingerprint,
          includeSource: normalizedSources.length > 0, createdAt: timestamp, updatedAt: timestamp,
          revision: 1, context: normalizedSources[0] || record.context || {}
        });
        await tx.putDraft(draft);
        meta.activeDraftId = draft.id;
        await tx.putMeta(meta);
        created = true;
        return draft;
      });
      if (result) await changed("draft", { structural: true, created, id: result.id });
      return result;
    },
    async convertEditDraftToNew(id: string) {
      const result = await transaction(["meta", "drafts"], "readwrite", async (tx) => {
        const draft = await tx.getDraft(id);
        if (!draft) return null;
        const meta = await metaIn(tx);
        Object.assign(draft, { mode: "new", targetRecordId: "", remote: null, baseFingerprint: "", updatedAt: now() });
        draft.revision = Number(draft.revision || 0) + 1;
        meta.activeDraftId = id;
        await tx.putDraft(draft);
        await tx.putMeta(meta);
        return normalizeDraft(draft);
      });
      if (result) await changed("draft", { structural: true, id });
      return result;
    },
    async discardDraft(id: string) {
      const discarded = await transaction(["meta", "drafts"], "readwrite", async (tx) => {
        const draft = await tx.getDraft(id);
        if (!draft) return false;
        const meta = await metaIn(tx);
        await tx.deleteDraft(id);
        if (meta.activeDraftId === id) {
          meta.activeDraftId = draft.returnDraftId && await tx.getDraft(draft.returnDraftId) ? draft.returnDraftId : "";
          await tx.putMeta(meta);
        }
        return true;
      });
      if (discarded) await changed("draft", { structural: true, id });
      return discarded;
    },
    async enqueue({ draftId, capture, context, destination, connectionId, status, incognito = false }: EnqueueRequest) {
      const result = await transaction(["meta", "drafts", "captures"], "readwrite", async (tx) => {
        const existing = draftId ? await tx.findCaptureByDraftId(draftId) : null;
        if (existing) return normalizeRecord(existing);
        const id = uuid();
        const timestamp = now();
        const captureValue = isRecord(capture) ? capture : {};
        const record = requireRecord({
          version: CAPTURE_RECORD_VERSION, id, draftId: draftId || "", scope: incognito ? "incognito" : "regular", status,
          capture: { ...captureValue, captureId: id }, syncedCapture: null, pendingCapture: { ...captureValue, captureId: id },
          operation: "create", syncJournal: null, context, destination, connectionId: connectionId || "",
          createdAt: timestamp, updatedAt: timestamp, attemptCount: 0, firstAttemptAt: 0, lastAttemptAt: 0,
          nextAttemptAt: status === DELIVERY_STATES.pending ? timestamp : 0, lastError: null, remote: null, forceRetry: false
        });
        const meta = await metaIn(tx);
        const draft = draftId ? await tx.getDraft(draftId) : null;
        await tx.putCapture(record);
        if (draft) {
          await tx.deleteDraft(draft.id);
          if (meta.activeDraftId === draftId) {
            meta.activeDraftId = draft.returnDraftId && await tx.getDraft(draft.returnDraftId) ? draft.returnDraftId : "";
            await tx.putMeta(meta);
          }
        }
        return record;
      });
      await changed("capture", { structural: true, id: result.id, record: result });
      return result;
    },
    async enqueueUpdate({ draftId, recordId, capture, baseFingerprint, status }: { draftId: string; recordId: string; capture: unknown; baseFingerprint?: string; status: DeliveryState }) {
      const result = await transaction(["meta", "drafts", "captures"], "readwrite", async (tx) => {
        const record = await tx.getCapture(recordId);
        if (!record) throw new CaptureStorageError("The recent note is no longer available locally.", "missing_capture");
        const draft = await tx.getDraft(draftId);
        const captureValue = isRecord(capture) ? capture : {};
        const next = requireRecord({
          ...record,
          pendingCapture: { ...captureValue, captureId: record.capture.captureId || record.id },
          operation: "update", baseFingerprint: baseFingerprint || draft?.baseFingerprint || "", syncJournal: null,
          status, nextAttemptAt: status === DELIVERY_STATES.pending ? now() : 0, lastError: null, updatedAt: now()
        });
        await tx.putCapture(next);
        if (draft) {
          const meta = await metaIn(tx);
          await tx.deleteDraft(draftId);
          if (meta.activeDraftId === draftId) {
            meta.activeDraftId = draft.returnDraftId && await tx.getDraft(draft.returnDraftId) ? draft.returnDraftId : "";
            await tx.putMeta(meta);
          }
        }
        return next;
      });
      await changed("capture", { structural: true, id: result.id, record: result });
      return result;
    },
    async updateCapture(id: string, updates: CaptureRecordUpdate) {
      let statusChanged = false;
      const result = await transaction(["captures"], "readwrite", async (tx) => {
        const existing = await tx.getCapture(id);
        if (!existing) return null;
        statusChanged = updates.status !== undefined && updates.status !== existing.status;
        const next = requireRecord({ ...existing, ...updates, updatedAt: now() });
        await tx.putCapture(next);
        return next;
      });
      if (result) await changed("capture", { structural: statusChanged, id, record: result });
      return result;
    },
    async claimCapture(id: string, timestamp = now()) {
      const result = await transaction(["captures"], "readwrite", async (tx) => {
        const existing = await tx.getCapture(id);
        if (!existing || existing.status !== DELIVERY_STATES.pending || existing.nextAttemptAt > timestamp) return null;
        const claimed = requireRecord({
          ...existing,
          status: DELIVERY_STATES.sending,
          firstAttemptAt: existing.firstAttemptAt || timestamp,
          lastAttemptAt: timestamp,
          attemptCount: Number(existing.attemptCount || 0) + 1,
          nextAttemptAt: 0,
          lastError: null,
          forceRetry: false,
          updatedAt: timestamp
        });
        await tx.putCapture(claimed);
        return claimed;
      });
      if (result) await changed("capture", { structural: true, id, record: result });
      return result;
    },
    async removeCapture(id: string) {
      const removed = await transaction(["captures"], "readwrite", async (tx) => {
        if (!await tx.getCapture(id)) return false;
        await tx.deleteCapture(id);
        return true;
      });
      if (removed) await changed("capture", { structural: true, id });
      return removed;
    },
    async findCaptureByRemotePageId(pageId: string) {
      const needle = compactRemoteId(pageId);
      if (!needle) return null;
      const records = await this.listCaptures();
      return records.find((record) => {
        return compactRemoteId(record.remote?.pageId) === needle || compactRemoteId(record.remote?.id) === needle;
      }) || null;
    },
    async ensureImportedRemoteCapture({ pageId, title = "", url = "", connectionId = "", destination = null, remote = null, document = null }: ImportRemoteCaptureRequest) {
      const needle = compactRemoteId(pageId);
      if (!needle) throw new CaptureStorageError("A Notion page ID is required.", "invalid_remote_page");
      let created = false;
      const result = await transaction(["captures"], "readwrite", async (tx) => {
        const records = await tx.getAllCaptures();
        const existing = records.find((record) => {
          return compactRemoteId(record.remote?.pageId) === needle || compactRemoteId(record.remote?.id) === needle;
        });
        const timestamp = now();
        const captureDocument: CaptureDocument = {
          version: 1,
          title: String(title || "").trim(),
          doc: isRecord(document) && document.type === "doc" ? normalizeEditorNode(document) : selectionDocument()
        };
        const remoteValue = isRecord(remote) ? remote : {};
        const nextRemote: RemoteTarget = {
          kind: "page",
          id: compactRemoteId(remoteValue.id) || needle,
          pageId: compactRemoteId(remoteValue.pageId) || needle,
          url: typeof remoteValue.url === "string" ? remoteValue.url : url,
          blockIds: Array.isArray(remoteValue.blockIds) ? remoteValue.blockIds.map(String) : [],
          fingerprint: typeof remoteValue.fingerprint === "string" ? remoteValue.fingerprint : ""
        };
        if (existing) {
          if (existing.status === DELIVERY_STATES.delivered || existing.status === DELIVERY_STATES.blockedConflict) {
            const normalized = requireRecord({
              ...existing,
              remote: { ...(existing.remote || nextRemote), ...nextRemote, url: url || nextRemote.url },
              destination: existing.destination || destination,
              connectionId: existing.connectionId || connectionId,
              updatedAt: timestamp
            });
            await tx.putCapture(normalized);
            return normalized;
          }
          return normalizeRecord(existing);
        }
        const id = uuid();
        const capture = { document: captureDocument, captureId: id, sources: [], includeSource: false };
        const record = requireRecord({
          version: CAPTURE_RECORD_VERSION,
          id,
          draftId: "",
          scope: "regular",
          status: DELIVERY_STATES.delivered,
          capture,
          syncedCapture: capture,
          pendingCapture: null,
          operation: "",
          syncJournal: null,
          context: {},
          destination,
          connectionId: connectionId || "",
          createdAt: timestamp,
          updatedAt: timestamp,
          attemptCount: 0,
          firstAttemptAt: 0,
          lastAttemptAt: 0,
          nextAttemptAt: 0,
          lastError: null,
          remote: nextRemote,
          forceRetry: false,
          importedFromNotion: true
        });
        await tx.putCapture(record);
        created = true;
        return record;
      });
      if (result) await changed("capture", { structural: created, created, id: result.id, record: result });
      return result;
    },
    async maintain({ recoverInterrupted = true, force = false }: { recoverInterrupted?: boolean; force?: boolean } = {}) {
      const timestamp = now();
      const result = await transaction(["meta", "drafts", "captures"], "readwrite", async (tx) => {
        const meta = await metaIn(tx);
        const retentionDue = force || timestamp - Number(meta.lastMaintenanceAt || 0) >= 24 * 60 * 60 * 1000;
        let didChange = false;
        if (!recoverInterrupted && !retentionDue) return { changed: false, maintained: false, meta };
        const captures = await tx.getAllCaptures();
        if (recoverInterrupted) {
          for (const record of captures.filter((item) => item.status === DELIVERY_STATES.sending)) {
            record.status = record.destination?.managedDestination ? DELIVERY_STATES.pending : DELIVERY_STATES.uncertain;
            record.nextAttemptAt = record.status === DELIVERY_STATES.pending ? timestamp : 0;
            record.lastError = { kind: "interrupted", message: "Delivery was interrupted before Notion confirmed the result." };
            record.updatedAt = timestamp;
            await tx.putCapture(record);
            didChange = true;
          }
        }
        if (!retentionDue) return { changed: didChange, maintained: false, meta };
        const delivered = captures.filter((record) => record.status === DELIVERY_STATES.delivered)
          .sort((left, right) => right.updatedAt - left.updatedAt);
        for (const [index, record] of delivered.entries()) {
          if (index >= 100 || timestamp - record.updatedAt > 30 * 24 * 60 * 60 * 1000) {
            await tx.deleteCapture(record.id);
            didChange = true;
          }
        }
        const drafts = (await tx.getAllDrafts()).sort((left, right) => right.updatedAt - left.updatedAt);
        for (const [index, draft] of drafts.entries()) {
          if (!hasDraftBody(draft) || index >= 50 || timestamp - draft.updatedAt > 30 * 24 * 60 * 60 * 1000) {
            await tx.deleteDraft(draft.id);
            if (meta.activeDraftId === draft.id) meta.activeDraftId = "";
            didChange = true;
          }
        }
        meta.lastMaintenanceAt = timestamp;
        await tx.putMeta(meta);
        return { changed: didChange, maintained: true, meta };
      });
      if (result.changed || result.maintained) await changed("maintenance", { structural: true });
      return result;
    },
    async logicalBytes() {
      const state = await repository.load();
      return new TextEncoder().encode(JSON.stringify(state)).length;
    }
  };

  return repository;
}

function errorMessage(error: unknown, fallback: string): string {
  return isRecord(error) && typeof error.message === "string" ? error.message : fallback;
}

function requireDraft(value: unknown): CaptureDraft {
  const draft = normalizeDraft(value);
  if (!draft) throw new CaptureStorageError("This draft uses an unsupported storage version.", "unsupported_draft_version");
  return draft;
}

function requireRecord(value: unknown): CaptureRecord {
  const record = normalizeRecord(value);
  if (!record) throw new CaptureStorageError("This capture uses an unsupported storage version.", "unsupported_capture_version");
  return record;
}
