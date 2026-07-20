// @ts-nocheck
import assert from "node:assert/strict";
import test from "node:test";
import { createDeliveryQueue, classifyDeliveryError } from "../src/capture-queue.js";
import { createCaptureRepository, DELIVERY_STATES } from "../src/capture-store.js";

function repositoryFixture(now) {
  const values = {};
  let id = 0;
  const storage = {
    async get(key) { return { [key]: values[key] }; },
    async set(next) { Object.assign(values, structuredClone(next)); }
  };
  return createCaptureRepository({ storage, now, uuid: () => `capture-${++id}` });
}

async function enqueue(repository, overrides = {}) {
  return repository.enqueue({
    capture: { document: { doc: { type: "doc", content: [] } } },
    context: {},
    destination: { managedDestination: true, destinationName: "Quick Notes" },
    connectionId: "connection-1",
    status: DELIVERY_STATES.pending,
    ...overrides
  });
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
  const stored = (await repository.load()).captures[record.id];
  assert.equal(deliveries, 1);
  assert.equal(stored.status, DELIVERY_STATES.pending);
  assert.equal(stored.nextAttemptAt, timestamp + 7_000);
});

test("independent drainers atomically claim one due capture only once", async () => {
  const repository = repositoryFixture(() => 1_500);
  const record = await enqueue(repository);
  let deliveries = 0;
  let releaseDelivery;
  const deliveryGate = new Promise((resolve) => { releaseDelivery = resolve; });
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

  const stored = await repository.getCapture(record.id);
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

  const result = await queue.attempt(record.id);

  assert.equal(result.status, DELIVERY_STATES.pending);
  assert.equal(result.remote, null);
  assert.equal(result.lastError.kind, "ambiguous_managed");
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
  assert.equal((await managedRepository.load()).captures[managed.id].status, DELIVERY_STATES.delivered);

  const manualRepository = repositoryFixture(() => timestamp);
  const manual = await enqueue(manualRepository, { destination: { managedDestination: false } });
  const manualQueue = createDeliveryQueue({
    repository: manualRepository,
    now: () => timestamp,
    getConnection: async () => ({ configured: true, connectionId: "connection-1" }),
    deliver: async () => { throw Object.assign(new Error("Network lost"), { code: "network_error" }); }
  });
  await manualQueue.attempt(manual.id);
  assert.equal((await manualRepository.load()).captures[manual.id].status, DELIVERY_STATES.uncertain);
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
  const stored = await repository.getCapture(record.id);

  assert.equal(stored.status, DELIVERY_STATES.pending);
  assert.notEqual(stored.status, DELIVERY_STATES.sending);
  assert.notEqual(stored.status, DELIVERY_STATES.delivered);
  assert.equal(stored.lastError.kind, "ambiguous_managed");
});

test("retarget without setup clears the old binding so completed setup can adopt it", async () => {
  let timestamp = 3_000;
  let connection = { configured: false };
  const repository = repositoryFixture(() => timestamp);
  const record = await enqueue(repository, { status: DELIVERY_STATES.blockedDestination });
  const queue = createDeliveryQueue({
    repository,
    now: () => timestamp,
    getConnection: async () => connection,
    deliver: async () => ({ id: "remote" })
  });
  await queue.retry(record.id, { retarget: true });
  let stored = (await repository.load()).captures[record.id];
  assert.equal(stored.connectionId, "");
  assert.equal(stored.status, DELIVERY_STATES.blockedSetup);

  connection = { configured: true, connectionId: "connection-2", destination: { managedDestination: true } };
  await queue.bindUnconfiguredCaptures();
  stored = (await repository.load()).captures[record.id];
  assert.equal(stored.connectionId, "connection-2");
  assert.equal(stored.status, DELIVERY_STATES.pending);
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
  assert.equal(state.captures[matching.id].status, DELIVERY_STATES.pending);
  assert.equal(state.captures[different.id].status, DELIVERY_STATES.blockedAuth);
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
  assert.equal((await repository.load()).captures[stale.id].status, DELIVERY_STATES.delivered);
  assert.equal(deliveries, 2);
});

test("delivery classification distinguishes auth, destination, retryable, and ambiguous failures", () => {
  assert.equal(classifyDeliveryError({ status: 401 }).status, DELIVERY_STATES.blockedAuth);
  assert.equal(classifyDeliveryError({ status: 403 }).status, DELIVERY_STATES.blockedDestination);
  assert.equal(classifyDeliveryError({ status: 429 }).status, DELIVERY_STATES.pending);
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
