import assert from "node:assert/strict";
import test from "node:test";
import { createLegacyGraphBackend } from "../src/capture-legacy-backend.js";
import { createDeliveryQueue, classifyDeliveryError } from "../src/capture-queue.js";
import { createRecordCaptureRepository } from "../src/capture-record-repository.js";
import { DELIVERY_STATES } from "../src/capture-store.js";
import type { CaptureDestination, CaptureRecord, CaptureRepositoryPort, Clock, DeliveryState, TreeWriteJournal } from "../src/contracts.js";

type TestRepository = ReturnType<typeof createRecordCaptureRepository> & CaptureRepositoryPort;
type TestConnection =
  | { configured: false; connectionId?: string; destination?: CaptureDestination | null }
  | { configured: true; connectionId: string; destination?: CaptureDestination | null };

function repositoryFixture(now: Clock): TestRepository {
  const values: Record<string, unknown> = {};
  let id = 0;
  const storage = {
    async get(key?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>> {
      if (typeof key === "string") return { [key]: values[key] };
      return structuredClone(values);
    },
    async set(next: Record<string, unknown>): Promise<void> { Object.assign(values, structuredClone(next)); },
    async remove(keys: string | string[]): Promise<void> {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key];
    }
  };
  return createRecordCaptureRepository({
    backend: createLegacyGraphBackend({ storage }),
    now,
    uuid: () => `capture-${++id}`
  });
}

async function enqueue(
  repository: TestRepository,
  overrides: { destination?: CaptureDestination; connectionId?: string; status?: DeliveryState } = {}
): Promise<CaptureRecord> {
  return repository.enqueue({
    capture: { document: { doc: { type: "doc", content: [] } } },
    context: {},
    destination: { managedDestination: true, destinationName: "Quick Notes" },
    connectionId: "connection-1",
    status: DELIVERY_STATES.pending,
    ...overrides
  });
}

function must<T>(value: T | null | undefined, label: string): T {
  assert.ok(value, label);
  return value;
}

function treeWrite(overrides: Partial<TreeWriteJournal> = {}): TreeWriteJournal {
  return {
    version: 1,
    phase: "writing",
    connectionId: "connection-1",
    destinationType: "page",
    destinationParentId: "original-page",
    pageId: "original-page",
    operationTimestamp: "2026-07-21T12:00:00.000Z",
    groups: {},
    archivedBlockIds: [],
    ...overrides
  };
}

test("queue honors Retry-After and serializes concurrent drains", async () => {
  let timestamp = 1_000;
  const repository = repositoryFixture(() => timestamp);
  const record = await enqueue(repository);
  let deliveries = 0;
  const queue = createDeliveryQueue({
    repository,
    now: () => timestamp,
    getConnection: async () => ({ configured: true, connectionId: "connection-1" }),
    deliver: async () => {
      deliveries += 1;
      throw Object.assign(new Error("Slow down"), { status: 429, retryAfter: 7 });
    }
  });
  await Promise.all([queue.drain(), queue.drain()]);
  const stored = must((await repository.load()).captures[record.id], "queued capture");
  assert.equal(deliveries, 1);
  assert.equal(stored.status, DELIVERY_STATES.pending);
  assert.equal(stored.nextAttemptAt, timestamp + 7_000);
});

test("independent drainers atomically claim one due capture only once", async () => {
  const repository = repositoryFixture(() => 1_500);
  const record = await enqueue(repository);
  let deliveries = 0;
  let releaseDelivery: () => void = () => undefined;
  const deliveryGate = new Promise<void>((resolve) => { releaseDelivery = resolve; });
  const configuration = {
    repository,
    now: () => 1_500,
    getConnection: async () => ({ configured: true, connectionId: "connection-1" }),
    deliver: async () => {
      deliveries += 1;
      await deliveryGate;
      return { id: "remote-once" };
    }
  };
  const first = createDeliveryQueue(configuration);
  const second = createDeliveryQueue(configuration);

  const drains = Promise.all([first.drain(), second.drain()]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(deliveries, 1);
  releaseDelivery();
  await drains;

  const stored = must(await repository.getCapture(record.id), "delivered capture");
  assert.equal(stored.status, DELIVERY_STATES.delivered);
  assert.equal(stored.attemptCount, 1);
});

test("malformed remote delivery results stay queued instead of becoming delivered", async () => {
  const repository = repositoryFixture(() => 1_750);
  const record = await enqueue(repository);
  const queue = createDeliveryQueue({
    repository,
    now: () => 1_750,
    getConnection: async () => ({ configured: true, connectionId: "connection-1" }),
    deliver: async () => ({})
  });

  const result = must(await queue.attempt(record.id), "delivery result");

  assert.equal(result.status, DELIVERY_STATES.pending);
  assert.equal(result.remote, null);
  assert.equal(must(result.lastError, "delivery error").kind, "ambiguous_managed");
  assert.ok(result.nextAttemptAt > 1_750);
});

test("managed ambiguous delivery verifies before retry while manual delivery requires review", async () => {
  let timestamp = 2_000;
  const managedRepository = repositoryFixture(() => timestamp);
  const managed = await enqueue(managedRepository);
  const managedQueue = createDeliveryQueue({
    repository: managedRepository,
    now: () => timestamp,
    getConnection: async () => ({ configured: true, connectionId: "connection-1" }),
    deliver: async () => { throw Object.assign(new Error("Gateway"), { status: 502 }); },
    findExisting: async () => ({ id: "notion-page", url: "https://notion.so/page" })
  });
  await managedQueue.attempt(managed.id);
  assert.equal(must((await managedRepository.load()).captures[managed.id], "managed capture").status, DELIVERY_STATES.delivered);

  const manualRepository = repositoryFixture(() => timestamp);
  const manual = await enqueue(manualRepository, { destination: { managedDestination: false } });
  const manualQueue = createDeliveryQueue({
    repository: manualRepository,
    now: () => timestamp,
    getConnection: async () => ({ configured: true, connectionId: "connection-1" }),
    deliver: async () => { throw Object.assign(new Error("Network lost"), { code: "network_error" }); }
  });
  await manualQueue.attempt(manual.id);
  assert.equal(must((await manualRepository.load()).captures[manual.id], "manual capture").status, DELIVERY_STATES.uncertain);
});

test("malformed verification results cannot strand a claimed capture in sending", async () => {
  const repository = repositoryFixture(() => 2_500);
  const record = await enqueue(repository);
  const queue = createDeliveryQueue({
    repository,
    now: () => 2_500,
    getConnection: async () => ({ configured: true, connectionId: "connection-1" }),
    deliver: async () => { throw Object.assign(new Error("Gateway"), { status: 502 }); },
    findExisting: async () => ({})
  });

  await queue.attempt(record.id).catch(() => null);
  const stored = must(await repository.getCapture(record.id), "verified capture");

  assert.equal(stored.status, DELIVERY_STATES.pending);
  assert.notEqual(stored.status, DELIVERY_STATES.sending);
  assert.notEqual(stored.status, DELIVERY_STATES.delivered);
  assert.equal(must(stored.lastError, "verification error").kind, "ambiguous_managed");
});

test("retarget without setup clears the old binding so completed setup can adopt it", async () => {
  let timestamp = 3_000;
  let connection: TestConnection = { configured: false };
  const repository = repositoryFixture(() => timestamp);
  const record = await enqueue(repository, { status: DELIVERY_STATES.blockedDestination });
  const queue = createDeliveryQueue({
    repository,
    now: () => timestamp,
    getConnection: async () => connection,
    deliver: async () => ({ id: "remote" })
  });
  await queue.retry(record.id, { retarget: true });
  let stored = must((await repository.load()).captures[record.id], "retargeted capture");
  assert.equal(stored.connectionId, "");
  assert.equal(stored.status, DELIVERY_STATES.blockedSetup);

  connection = { configured: true, connectionId: "connection-2", destination: { managedDestination: true } };
  await queue.bindUnconfiguredCaptures();
  stored = must((await repository.load()).captures[record.id], "bound capture");
  assert.equal(stored.connectionId, "connection-2");
  assert.equal(stored.status, DELIVERY_STATES.pending);
});

test("manual destinations with tree journals retry ambiguous failures automatically", async () => {
  const repository = repositoryFixture(() => 3_500);
  const record = await enqueue(repository, { destination: { managedDestination: false, destinationId: "original-page", destinationType: "page" } });
  await repository.updateCapture(record.id, { syncJournal: { treeWrite: treeWrite() } });
  const queue = createDeliveryQueue({
    repository,
    now: () => 3_500,
    getConnection: async () => ({ configured: true, connectionId: "connection-1" }),
    deliver: async () => { throw Object.assign(new Error("Network lost"), { code: "network_error" }); }
  });
  const result = must(await queue.attempt(record.id), "tree retry result");
  assert.equal(result.status, DELIVERY_STATES.pending);
  assert.equal(result.lastError?.kind, "ambiguous_managed");
});

test("retarget refuses to reuse a journal after remote mutation evidence", async () => {
  const repository = repositoryFixture(() => 3_750);
  const destination = { managedDestination: false, destinationId: "original-page", destinationType: "page" } as const;
  const record = await enqueue(repository, { destination, status: DELIVERY_STATES.blockedDestination });
  await repository.updateCapture(record.id, {
    syncJournal: { treeWrite: treeWrite({ groups: { "capture/section": ["root-1"] } }) }
  });
  const queue = createDeliveryQueue({
    repository,
    now: () => 3_750,
    getConnection: async () => ({ configured: false }),
    deliver: async () => ({ id: "unused" })
  });
  const result = must(await queue.retry(record.id, { retarget: true }), "blocked retarget");
  assert.equal(result.status, DELIVERY_STATES.uncertain);
  assert.deepEqual(result.destination, destination);
  assert.deepEqual(result.syncJournal?.treeWrite?.groups, { "capture/section": ["root-1"] });
  assert.equal(result.lastError?.kind, "attention_required");
});

test("restored authorization resumes captures from the same connection only", async () => {
  const repository = repositoryFixture(() => 4_000);
  const matching = await enqueue(repository, { status: DELIVERY_STATES.blockedAuth });
  const different = await enqueue(repository, { status: DELIVERY_STATES.blockedAuth, connectionId: "other-connection" });
  const queue = createDeliveryQueue({
    repository,
    now: () => 4_000,
    getConnection: async () => ({ configured: true, connectionId: "connection-1", destination: { managedDestination: true } }),
    deliver: async () => ({ id: "remote" })
  });
  await queue.bindUnconfiguredCaptures();
  const state = await repository.load();
  assert.equal(must(state.captures[matching.id], "matching capture").status, DELIVERY_STATES.pending);
  assert.equal(must(state.captures[different.id], "different capture").status, DELIVERY_STATES.blockedAuth);
});

test("seven-day attention window starts with delivery and a forced retry bypasses it once", async () => {
  const sevenDays = 7 * 24 * 60 * 60 * 1000;
  let timestamp = sevenDays + 10;
  const repository = repositoryFixture(() => timestamp);
  const neverAttempted = await enqueue(repository);
  let deliveries = 0;
  const queue = createDeliveryQueue({
    repository,
    now: () => timestamp,
    getConnection: async () => ({ configured: true, connectionId: "connection-1" }),
    deliver: async () => ({ id: `remote-${++deliveries}` })
  });
  await queue.attempt(neverAttempted.id);
  assert.equal(deliveries, 1);

  const stale = await enqueue(repository);
  await repository.updateCapture(stale.id, {
    status: DELIVERY_STATES.uncertain,
    firstAttemptAt: 1,
    createdAt: 1
  });
  await queue.retry(stale.id, { force: true });
  await queue.drain();
  assert.equal(must((await repository.load()).captures[stale.id], "forced retry capture").status, DELIVERY_STATES.delivered);
  assert.equal(deliveries, 2);
});

test("delivery classification distinguishes auth, destination, retryable, and ambiguous failures", () => {
  assert.equal(classifyDeliveryError({ status: 401 }).status, DELIVERY_STATES.blockedAuth);
  assert.equal(classifyDeliveryError({ status: 403 }).status, DELIVERY_STATES.blockedDestination);
  assert.equal(classifyDeliveryError({ status: 429 }).status, DELIVERY_STATES.pending);
  assert.equal(classifyDeliveryError({ code: "tree_write_ambiguous" }, true).status, DELIVERY_STATES.uncertain);
  assert.equal(classifyDeliveryError({ offline: true }).status, DELIVERY_STATES.pending);
  assert.equal(classifyDeliveryError({ status: 404 }).status, DELIVERY_STATES.blockedDestination);
  assert.equal(classifyDeliveryError({ status: 409, code: "remote_conflict", name: "NotionConflictError" }).status, DELIVERY_STATES.blockedConflict);
  assert.equal(classifyDeliveryError({ status: 408 }, false).status, DELIVERY_STATES.uncertain);
  assert.equal(classifyDeliveryError({ status: 408 }, true).verify, true);
  assert.equal(classifyDeliveryError({ status: 500 }, false).status, DELIVERY_STATES.uncertain);
  assert.equal(classifyDeliveryError({ status: 500 }, true).verify, true);
});

test("managed timeouts verify and retry while manual timeouts require review", () => {
  const timeout = { status: 408, code: "notion_timeout", timeout: true };
  assert.deepEqual(classifyDeliveryError(timeout, true), {
    status: DELIVERY_STATES.pending,
    kind: "timeout",
    message: "Notion took too long. Delivery will be checked and retried automatically.",
    verify: true
  });
  assert.equal(classifyDeliveryError(timeout, false).status, DELIVERY_STATES.uncertain);
  assert.equal(classifyDeliveryError(timeout, false).kind, "timeout_manual");
});
