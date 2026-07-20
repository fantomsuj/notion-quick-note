import assert from "node:assert/strict";
import test from "node:test";
import {
  badgeForState,
  CaptureStorageError,
  createCaptureRepository,
  detachActiveDrafts,
  DELIVERY_STATES,
  emptyCaptureState,
  migrateCaptureStateV1,
  normalizeSources,
  pruneCaptureState,
  recoverInterruptedRecords
} from "../src/capture-store.js";

function memoryStorage() {
  const values = {};
  return {
    values,
    async get(key) { return { [key]: values[key] }; },
    async set(next) { Object.assign(values, structuredClone(next)); }
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
  assert.equal(state.captures[record.id].capture.captureId, record.id);

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

  const stored = await repository.upsertDraft({
    ...transient,
    title: "A real draft",
    doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Body text" }] }] }
  }, 0);
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
  assert.equal((await repository.load()).drafts[draft.id].id, "selection");
});

test("serialized state recovery cannot overwrite a capture enqueued concurrently", async () => {
  const repository = createCaptureRepository({ storage: memoryStorage(), uuid: () => "capture" });
  let releaseRecovery;
  const recovery = repository.updateState(async () => {
    await new Promise((resolve) => { releaseRecovery = resolve; });
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
  state.captures.pending = { id: "pending", status: DELIVERY_STATES.pending, updatedAt: 0 };
  state.captures.old = { id: "old", status: DELIVERY_STATES.delivered, updatedAt: 0 };
  state.captures.managed = { id: "managed", status: DELIVERY_STATES.sending, destination: { managedDestination: true }, updatedAt: 0 };
  state.captures.manual = { id: "manual", status: DELIVERY_STATES.sending, destination: { managedDestination: false }, updatedAt: 0 };

  recoverInterruptedRecords(state, true, 500);
  assert.equal(state.captures.managed.status, DELIVERY_STATES.pending);
  assert.equal(state.captures.manual.status, DELIVERY_STATES.uncertain);
  pruneCaptureState(state, 31 * 24 * 60 * 60 * 1000);
  assert.equal(state.captures.old, undefined);
  assert.ok(state.captures.pending);
  assert.deepEqual(badgeForState(state), { text: "!", color: "#d70015" });
});

test("a new browser session preserves the global active draft", () => {
  const state = emptyCaptureState();
  state.drafts.draft = { id: "draft", updatedAt: 1 };
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
  assert.equal(state.drafts.newer.sources[0].url, "https://two.example/");
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
  assert.equal((await repository.load()).drafts.draft.title, "Newer");
  assert.equal(saved.revision, handedOff.revision + 1);
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
  assert.equal((await repository.load()).drafts.draft.doc.content[0].content[0].text, "Newer body");
  assert.ok(newer.revision > initial.revision);
});

test("clearing an active edit reactivates its stashed draft", async () => {
  const repository = createCaptureRepository({ storage: memoryStorage(), uuid: () => "stashed", now: () => 100 });
  const stashed = await repository.getOrCreateDraft({ context: { selection: "Stashed body" } });
  const edit = await repository.upsertDraft({
    id: "edit",
    mode: "edit",
    targetRecordId: "capture",
    returnDraftId: stashed.id,
    doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Edited body" }] }] }
  }, 0);
  const activeEdit = await repository.activateDraft(edit.id);
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
    (error) => error.code === "stale_draft"
  );
});

test("sources normalize, deduplicate fragments, preserve the primary, and cap at 20", () => {
  const sources = normalizeSources(Array.from({ length: 24 }, (_, index) => ({
    title: `Source ${index}`,
    url: index === 1 ? "https://example.com/#other" : index === 0 ? "https://example.com/#first" : `https://example.com/${index}`
  })));
  assert.equal(sources.length, 20);
  assert.equal(sources[0].title, "Source 0");
  assert.equal(sources[0].url, "https://example.com/");
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
    remote: { kind: "page", id: "page", pageId: "page", fingerprint: "fingerprint" }
  });
  const stashed = await repository.getOrCreateDraft({ context: { url: "https://stashed.example", selection: "Work in progress" }, sessionId: "stashed" });
  const edit = await repository.createEditDraft({
    recordId: record.id,
    title: "Saved",
    doc: originalDraft.doc,
    sources: originalDraft.sources,
    remote: { kind: "page", id: "page", pageId: "page" },
    baseFingerprint: "fingerprint",
    returnDraftId: stashed.id,
    sessionId: "edit"
  });
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
  assert.equal(state.captures[record.id].pendingCapture.captureId, record.id);
  assert.equal(state.activeDraftId, stashed.id);
});

test("imported Notion pages reuse a delivered capture keyed by remote page id", async () => {
  const storage = memoryStorage();
  let id = 0;
  const repository = createCaptureRepository({ storage, uuid: () => `id-${++id}`, now: () => 100 });
  const first = await repository.ensureImportedRemoteCapture({
    pageId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    title: "Spec",
    url: "https://www.notion.so/Spec",
    connectionId: "connection",
    destination: { destinationType: "page", destinationName: "Spec" }
  });
  const again = await repository.ensureImportedRemoteCapture({
    pageId: "aaaaaaaabbbbccccddddeeeeeeeeeeee",
    title: "Spec updated",
    url: "https://www.notion.so/Spec-updated"
  });
  const found = await repository.findCaptureByRemotePageId("AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE");
  assert.equal(first.id, again.id);
  assert.equal(found.id, first.id);
  assert.equal(again.status, DELIVERY_STATES.delivered);
  assert.equal(again.remote.kind, "page");
  assert.equal(again.remote.url, "https://www.notion.so/Spec-updated");
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
