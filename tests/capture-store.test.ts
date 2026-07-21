import assert from "node:assert/strict";
import test from "node:test";
import {
  addContextToDraft,
  badgeForState,
  CaptureStorageError,
  createCaptureRepository,
  detachActiveDrafts,
  DELIVERY_STATES,
  emptyCaptureState,
  migrateCaptureStateV1,
  normalizeCaptureState,
  normalizeDraft,
  normalizeRecord,
  normalizeSources,
  pruneCaptureState,
  recoverInterruptedRecords
} from "../src/capture-store.js";
import type { CaptureDraft, CaptureRecord, KeyValueStoragePort } from "../src/contracts.js";

function must<T>(value: T | null | undefined, label: string): T {
  assert.ok(value, label);
  return value;
}

test("corrupted and unsupported persisted state versions fail closed", () => {
  assert.deepEqual(normalizeCaptureState(null), emptyCaptureState());
  assert.deepEqual(normalizeCaptureState({ version: 999, drafts: { hostile: { id: "hostile" } } }), emptyCaptureState());
  assert.deepEqual(normalizeCaptureState({ version: 2, drafts: "not-an-object", captures: [] }), emptyCaptureState());
});

test("unsupported explicit draft and capture versions are rejected instead of rewritten as v2", () => {
  const document = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Body" }] }] };
  const unsupportedDraft = { version: 999, id: "future-draft", doc: document };
  const unsupportedRecord = {
    version: 999,
    id: "future-capture",
    status: DELIVERY_STATES.pending,
    capture: { document: { doc: document } }
  };

  assert.equal(normalizeDraft(unsupportedDraft), null);
  assert.equal(normalizeRecord(unsupportedRecord), null);

  const state = normalizeCaptureState({
    version: 2,
    activeDraftId: "future-draft",
    drafts: { "future-draft": unsupportedDraft },
    captures: { "future-capture": unsupportedRecord }
  });
  assert.deepEqual(state, emptyCaptureState());
});

test("non-record persisted draft and capture entries fail closed", () => {
  const invalidValues = [null, "corrupt", 42, true, [], ["not", "a", "record"]];
  for (const value of invalidValues) {
    assert.equal(normalizeDraft(value), null);
    assert.equal(normalizeRecord(value), null);
  }

  const state = normalizeCaptureState({
    version: 2,
    activeDraftId: "null",
    drafts: Object.fromEntries(invalidValues.map((value, index) => [`draft-${index}`, value])),
    captures: Object.fromEntries(invalidValues.map((value, index) => [`capture-${index}`, value]))
  });

  assert.deepEqual(state, emptyCaptureState());
});

test("missing-version and known v1 persisted items still migrate to v2", () => {
  const document = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Legacy body" }] }] };
  const state = normalizeCaptureState({
    version: 2,
    activeDraftId: "unversioned",
    drafts: {
      unversioned: { id: "unversioned", doc: document },
      v1: { version: 1, id: "v1", doc: document }
    },
    captures: {
      unversioned: { id: "unversioned", status: DELIVERY_STATES.pending, capture: { document: { doc: document } } },
      v1: { version: 1, id: "v1", status: DELIVERY_STATES.pending, capture: { document: { doc: document } } }
    }
  });

  assert.deepEqual(Object.values(state.drafts).map((draft) => draft.version), [2, 2]);
  assert.deepEqual(Object.values(state.captures).map((record) => record.version), [2, 2]);
  assert.equal(state.activeDraftId, "unversioned");
});

function memoryStorage(): KeyValueStoragePort & { values: Record<string, unknown> } {
  const values: Record<string, unknown> = {};
  return {
    values,
    async get(key?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>> {
      if (typeof key === "string") return { [key]: values[key] };
      return structuredClone(values);
    },
    async set(next: Record<string, unknown>): Promise<void> { Object.assign(values, structuredClone(next)); },
    async remove(keys: string | string[]): Promise<void> {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key];
    }
  };
}

test("one active draft follows explicit invocations across tabs and enqueue atomically replaces it", async () => {
  const storage = memoryStorage();
  let id = 0;
  const repository = createCaptureRepository({ storage, uuid: () => `id-${++id}`, now: () => 100 });
  const context = { title: "Article", url: "https://example.com", selection: "Selected" };
  const first = await repository.getOrCreateDraft({ tabId: 7, context });
  const resumed = await repository.getOrCreateDraft({ tabId: 9, context: { title: "Changed", url: "https://second.example/path" } });
  assert.equal(resumed.id, first.id);
  assert.equal(resumed.context.title, "Article");
  assert.equal(resumed.tabId, 9);
  assert.deepEqual(resumed.sources.map((source) => source.url), ["https://example.com/", "https://second.example/path"]);

  const record = await repository.enqueue({
    draftId: first.id,
    capture: { document: { doc: first.doc } },
    context,
    destination: { managedDestination: true },
    connectionId: "connection",
    status: DELIVERY_STATES.pending
  });
  const state = await repository.load();
  assert.equal(state.drafts[first.id], undefined);
  assert.equal(state.activeDraftId, "");
  assert.equal(must(state.captures[record.id], "enqueued capture").capture.captureId, record.id);

  const repeated = await repository.enqueue({
    draftId: first.id,
    capture: { document: { doc: first.doc } },
    context,
    destination: { managedDestination: true },
    connectionId: "connection",
    status: DELIVERY_STATES.pending
  });
  assert.equal(repeated.id, record.id);
  assert.equal(Object.keys((await repository.load()).captures).length, 1);
});

test("blank and title-only composers stay transient until their body contains text", async () => {
  const repository = createCaptureRepository({ storage: memoryStorage(), uuid: () => "generated", now: () => 100 });
  const transient = await repository.getOrCreateDraft({
    tabId: 1,
    context: { title: "Source", url: "https://source.example" },
    draftId: "candidate"
  });
  assert.equal(transient.id, "candidate");
  assert.deepEqual((await repository.load()).drafts, {});

  const titleOnly = await repository.upsertDraft({ ...transient, title: "A title without a body" }, transient.revision);
  assert.equal(titleOnly, null);
  assert.deepEqual((await repository.load()).drafts, {});

  const stored = must(await repository.upsertDraft({
    ...transient,
    title: "A real draft",
    doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Body text" }] }] }
  }, 0), "stored draft");
  assert.equal(stored.id, "candidate");
  assert.equal((await repository.load()).activeDraftId, "candidate");

  const cleared = await repository.upsertDraft({
    ...stored,
    title: "This title does not retain the draft",
    doc: { type: "doc", content: [{ type: "paragraph" }] }
  }, stored.revision);
  assert.equal(cleared, null);
  assert.deepEqual((await repository.load()).drafts, {});
});

test("captured selections are durable immediately", async () => {
  const repository = createCaptureRepository({ storage: memoryStorage(), uuid: () => "selection" });
  const draft = await repository.getOrCreateDraft({ context: { selection: "Selected body" } });
  assert.equal(must((await repository.load()).drafts[draft.id], "durable selection").id, "selection");
});

test("serialized state recovery cannot overwrite a capture enqueued concurrently", async () => {
  const repository = createCaptureRepository({ storage: memoryStorage(), uuid: () => "capture" });
  let releaseRecovery: () => void = () => undefined;
  const recovery = repository.updateState(async () => {
    await new Promise<void>((resolve) => { releaseRecovery = resolve; });
  });
  const enqueue = repository.enqueue({
    capture: { document: { doc: { type: "doc", content: [] } } },
    context: {},
    destination: null,
    connectionId: "",
    status: DELIVERY_STATES.blockedSetup
  });
  await new Promise((resolve) => setImmediate(resolve));
  releaseRecovery();
  await Promise.all([recovery, enqueue]);
  assert.ok((await repository.load()).captures.capture);
});

test("retention never purges unresolved captures and recovers interrupted sends safely", () => {
  const state = emptyCaptureState();
  state.captures.pending = must(normalizeRecord({ id: "pending", status: DELIVERY_STATES.pending, updatedAt: 0 }), "pending fixture");
  state.captures.old = must(normalizeRecord({ id: "old", status: DELIVERY_STATES.delivered, updatedAt: 0 }), "delivered fixture");
  state.captures.managed = must(normalizeRecord({ id: "managed", status: DELIVERY_STATES.sending, destination: { managedDestination: true }, updatedAt: 0 }), "managed fixture");
  state.captures.manual = must(normalizeRecord({ id: "manual", status: DELIVERY_STATES.sending, destination: { managedDestination: false }, updatedAt: 0 }), "manual fixture");

  recoverInterruptedRecords(state, true, 500);
  assert.equal(must(state.captures.managed, "managed capture").status, DELIVERY_STATES.pending);
  assert.equal(must(state.captures.manual, "manual capture").status, DELIVERY_STATES.uncertain);
  pruneCaptureState(state, 31 * 24 * 60 * 60 * 1000);
  assert.equal(state.captures.old, undefined);
  assert.ok(state.captures.pending);
  assert.deepEqual(badgeForState(state), { text: "!", color: "#d70015" });
});

test("a new browser session preserves the global active draft", () => {
  const state = emptyCaptureState();
  state.drafts.draft = must(normalizeDraft({ id: "draft", updatedAt: 1 }), "draft fixture");
  state.activeDraftId = "draft";
  detachActiveDrafts(state);
  assert.equal(state.activeDraftId, "draft");
  assert.ok(state.drafts.draft);
});

test("v1 migration chooses the newest non-empty active draft and keeps every other draft", () => {
  const state = migrateCaptureStateV1({
    version: 1,
    drafts: {
      empty: { id: "empty", updatedAt: 30, doc: { type: "doc", content: [{ type: "paragraph" }] } },
      older: { id: "older", updatedAt: 10, context: { url: "https://one.example" }, doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "One" }] }] } },
      newer: { id: "newer", updatedAt: 20, context: { url: "https://two.example" }, doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Two" }] }] } }
    },
    activeDraftByTab: { 1: "older", 2: "newer", 3: "empty" },
    captures: {}
  });
  assert.equal(state.activeDraftId, "newer");
  assert.deepEqual(Object.keys(state.drafts).sort(), ["newer", "older"]);
  assert.equal(must(must(state.drafts.newer, "newer draft").sources[0], "newer source").url, "https://two.example/");
});

test("stale revisions cannot overwrite a newer cross-tab autosave", async () => {
  const repository = createCaptureRepository({ storage: memoryStorage(), uuid: () => "draft", now: () => 100 });
  const draft = await repository.getOrCreateDraft({ tabId: 1, context: { url: "https://one.example", selection: "Body" }, sessionId: "one" });
  const handedOff = await repository.getOrCreateDraft({ tabId: 2, context: { url: "https://two.example" }, sessionId: "two" });
  const saved = await repository.upsertDraft({ ...handedOff, title: "Newer" }, handedOff.revision);
  await assert.rejects(
    repository.upsertDraft({ ...draft, title: "Stale" }, draft.revision),
    (error) => error instanceof CaptureStorageError && error.code === "stale_draft"
  );
  assert.equal(must((await repository.load()).drafts.draft, "saved draft").title, "Newer");
  assert.equal(must(saved, "newer saved draft").revision, handedOff.revision + 1);
});

test("a stale blank autosave cannot delete newer body content", async () => {
  const repository = createCaptureRepository({ storage: memoryStorage(), uuid: () => "draft", now: () => 100 });
  const initial = await repository.getOrCreateDraft({ context: { selection: "Initial body" } });
  const newer = await repository.upsertDraft({
    ...initial,
    doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Newer body" }] }] }
  }, initial.revision);
  await assert.rejects(
    repository.upsertDraft({ ...initial, doc: { type: "doc", content: [{ type: "paragraph" }] } }, initial.revision),
    (error) => error instanceof CaptureStorageError && error.code === "stale_draft"
  );
  const persisted = must((await repository.load()).drafts.draft, "persisted newer draft");
  assert.equal(must(must(persisted.doc.content?.[0], "paragraph").content?.[0], "text").text, "Newer body");
  assert.ok(must(newer, "newer draft").revision > initial.revision);
});

test("clearing an active edit reactivates its stashed draft", async () => {
  const repository = createCaptureRepository({ storage: memoryStorage(), uuid: () => "stashed", now: () => 100 });
  const stashed = await repository.getOrCreateDraft({ context: { selection: "Stashed body" } });
  const edit = must(await repository.upsertDraft({
    ...stashed,
    id: "edit",
    mode: "edit",
    targetRecordId: "capture",
    returnDraftId: stashed.id,
    revision: 0,
    doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Edited body" }] }] }
  }, 0), "edit draft");
  const activeEdit = must(await repository.activateDraft(edit.id), "active edit");
  await repository.upsertDraft({ ...activeEdit, doc: { type: "doc", content: [{ type: "paragraph" }] } }, activeEdit.revision);
  const state = await repository.load();
  assert.equal(state.drafts.edit, undefined);
  assert.equal(state.activeDraftId, stashed.id);
});

test("a new composer session advances the revision even when the source URL is unchanged", async () => {
  const repository = createCaptureRepository({ storage: memoryStorage(), uuid: () => "draft", now: () => 100 });
  const first = await repository.getOrCreateDraft({ tabId: 1, context: { url: "https://same.example", selection: "Body" }, sessionId: "old" });
  const handedOff = await repository.getOrCreateDraft({ tabId: 2, context: { url: "https://same.example", selection: "Body" }, sessionId: "new" });
  assert.ok(handedOff.revision > first.revision);
  await assert.rejects(
    repository.upsertDraft({ ...first, title: "Old surface" }, first.revision),
    (error) => error instanceof CaptureStorageError && error.code === "stale_draft"
  );
});

test("sources normalize, deduplicate fragments, preserve the primary, and cap at 20", () => {
  const sources = normalizeSources(Array.from({ length: 24 }, (_, index) => ({
    title: `Source ${index}`,
    url: index === 1 ? "https://example.com/#other" : index === 0 ? "https://example.com/#first" : `https://example.com/${index}`
  })));
  assert.equal(sources.length, 20);
  assert.equal(must(sources[0], "primary source").title, "Source 0");
  assert.equal(must(sources[0], "primary source").url, "https://example.com/");
});

test("automatic context respects draft-scoped source dismissals until explicit restore", () => {
  const draft = normalizeDraft({
    version: 2,
    id: "draft",
    sources: [],
    dismissedSourceUrls: ["https://example.com/article#old"],
    doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Body" }] }] }
  });
  assert.ok(draft);

  const automatic = addContextToDraft(
    draft,
    { title: "Article", url: "https://example.com/article#new" },
    200,
    { explicit: false }
  );
  assert.deepEqual(automatic.sources, []);
  assert.deepEqual(automatic.dismissedSourceUrls, ["https://example.com/article"]);

  const restored = addContextToDraft(
    automatic,
    { title: "Article", url: "https://example.com/article" },
    300,
    { explicit: true }
  );
  assert.deepEqual(restored.sources.map((source) => source.url), ["https://example.com/article"]);
  assert.deepEqual(restored.dismissedSourceUrls, []);
});

test("editing a recent note reuses its capture record and reactivates the stashed draft", async () => {
  const storage = memoryStorage();
  let id = 0;
  const repository = createCaptureRepository({ storage, uuid: () => `id-${++id}`, now: () => 100 });
  const originalDraft = await repository.getOrCreateDraft({ context: { url: "https://source.example", selection: "Saved body" }, sessionId: "original" });
  const record = await repository.enqueue({
    draftId: originalDraft.id,
    capture: { document: { title: "Saved", doc: originalDraft.doc }, sources: originalDraft.sources },
    context: originalDraft.context,
    destination: { destinationType: "database" },
    connectionId: "connection",
    status: DELIVERY_STATES.pending
  });
  await repository.updateCapture(record.id, {
    status: DELIVERY_STATES.delivered,
    syncedCapture: record.pendingCapture,
    pendingCapture: null,
    remote: { kind: "page", id: "page", url: "https://notion.so/page", pageId: "page", blockIds: [], fingerprint: "fingerprint" }
  });
  const stashed = await repository.getOrCreateDraft({ context: { url: "https://stashed.example", selection: "Work in progress" }, sessionId: "stashed" });
  const edit = must(await repository.createEditDraft({
    recordId: record.id,
    title: "Saved",
    doc: originalDraft.doc,
    sources: originalDraft.sources,
    remote: { kind: "page", id: "page", pageId: "page" },
    baseFingerprint: "fingerprint",
    returnDraftId: stashed.id,
    sessionId: "edit"
  }), "recent-note edit draft");
  const updated = await repository.enqueueUpdate({
    draftId: edit.id,
    recordId: record.id,
    capture: { document: { title: "Edited", doc: originalDraft.doc }, sources: originalDraft.sources },
    baseFingerprint: "fingerprint",
    status: DELIVERY_STATES.pending
  });
  const state = await repository.load();
  assert.equal(updated.id, record.id);
  assert.equal(Object.keys(state.captures).length, 1);
  assert.equal(must(must(state.captures[record.id], "updated capture").pendingCapture, "pending update").captureId, record.id);
  assert.equal(state.activeDraftId, stashed.id);
});

test("imported Notion pages reuse a delivered capture keyed by remote page id", async () => {
  const storage = memoryStorage();
  let id = 0;
  const repository = createCaptureRepository({ storage, uuid: () => `id-${++id}`, now: () => 100 });
  const first = must(await repository.ensureImportedRemoteCapture({
    pageId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    title: "Spec",
    url: "https://www.notion.so/Spec",
    connectionId: "connection",
    destination: { destinationType: "page", destinationName: "Spec" }
  }), "first imported capture");
  const again = must(await repository.ensureImportedRemoteCapture({
    pageId: "aaaaaaaabbbbccccddddeeeeeeeeeeee",
    title: "Spec updated",
    url: "https://www.notion.so/Spec-updated"
  }), "reused imported capture");
  const found = must(await repository.findCaptureByRemotePageId("AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE"), "found imported capture");
  assert.equal(first.id, again.id);
  assert.equal(found.id, first.id);
  assert.equal(again.status, DELIVERY_STATES.delivered);
  assert.equal(must(again.remote, "imported remote").kind, "page");
  assert.equal(must(again.remote, "imported remote").url, "https://www.notion.so/Spec-updated");
  assert.equal(again.importedFromNotion, true);
});

test("quota failure rejects the durable write instead of accepting a capture", async () => {
  const repository = createCaptureRepository({
    storage: memoryStorage(),
    softLimitBytes: 100,
    uuid: () => "draft-id"
  });
  await assert.rejects(
    repository.getOrCreateDraft({ tabId: 1, context: { selection: "x".repeat(200) } }),
    (error) => error instanceof CaptureStorageError && error.code === "capture_storage_full"
  );
});
