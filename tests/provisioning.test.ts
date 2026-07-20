// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";
import { createDatabaseProvisioner, ProvisioningPendingError } from "../src/provisioning.js";

test("coalesces concurrent provisioning into one database creation", async () => {
  const harness = createHarness();
  let release;
  harness.api.create = async (_settings, marker) => new Promise((resolve) => {
    assert.equal(harness.state.databaseProvisioning.status, "creating");
    assert.equal(harness.state.databaseProvisioning.marker, marker);
    release = () => resolve(destination());
  });
  const provisioner = harness.provisioner();

  const first = provisioner.ensure();
  const second = provisioner.ensure();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(release);
  release();
  const [left, right] = await Promise.all([first, second]);

  assert.equal(harness.calls.create, 1);
  assert.equal(left.outcome, "created");
  assert.deepEqual(left, right);
});

test("recovers a marked database before attempting creation", async () => {
  const harness = createHarness({
    connectionId: "connection",
    databaseProvisioning: {
      connectionId: "connection",
      marker: "persisted-marker",
      status: "recovering",
      startedAt: 100,
      lastAttemptAt: 0
    }
  });
  harness.api.recover = async (_settings, marker) => {
    assert.equal(marker, "persisted-marker");
    return destination({ marker });
  };

  const result = await harness.provisioner().ensure();
  assert.equal(result.outcome, "reused");
  assert.equal(harness.calls.create, 0);
  assert.equal(harness.state.destinationId, "data-source-id");
  assert.equal(harness.state.databaseProvisioning, null);
});

test("recovers after an uncertain create response without posting twice", async () => {
  const harness = createHarness();
  let recoveries = 0;
  harness.api.recover = async (_settings, marker) => {
    recoveries += 1;
    return recoveries >= 2 ? destination({ marker }) : null;
  };
  harness.api.create = async () => {
    const error = new Error("Gateway timed out");
    error.status = 503;
    throw error;
  };

  const result = await harness.provisioner().ensure();
  assert.equal(result.outcome, "reused");
  assert.equal(harness.calls.create, 1);
  assert.equal(harness.calls.wait, 1);
});

test("keeps a recent uncertain attempt pending instead of creating a duplicate", async () => {
  const harness = createHarness({
    connectionId: "connection",
    databaseProvisioning: {
      connectionId: "connection",
      marker: "pending-marker",
      status: "uncertain",
      startedAt: 100,
      lastAttemptAt: 900
    }
  }, { now: 1000 });

  await assert.rejects(harness.provisioner().ensure(), ProvisioningPendingError);
  assert.equal(harness.calls.create, 0);
  assert.equal(harness.calls.recover, 4);
});

test("migrates only an existing automatically managed destination", async () => {
  const harness = createHarness({
    connectionId: "connection",
    destinationId: "legacy-source",
    destinationDatabaseId: "legacy-database",
    destinationType: "database",
    destinationName: "Quick Notes",
    destinationSchemaVersion: 0
  });

  const result = await harness.provisioner().ensure();
  assert.equal(result.outcome, "migrated");
  assert.equal(harness.calls.migrate, 1);
  assert.equal(harness.state.destinationSchemaVersion, 3);
});

test("does not save a provisioned destination after the Notion connection changes", async () => {
  const harness = createHarness({ connectionId: "connection-1" });
  let release;
  harness.api.create = async () => new Promise((resolve) => {
    release = () => resolve(destination());
  });

  const pending = harness.provisioner().ensure();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(release);

  harness.state.connectionId = "connection-2";
  release();

  await assert.rejects(pending, (error) => {
    assert.equal(error.code, "connection_changed");
    assert.equal(error.status, 409);
    return true;
  });
  assert.equal(harness.state.destinationId, undefined);
});

test("leaves an existing manual destination unchanged", async () => {
  const harness = createHarness({
    connectionId: "connection",
    destinationId: "manual-source",
    destinationType: "database",
    destinationName: "My Notes",
    destinationSchemaVersion: 0
  });

  const result = await harness.provisioner().ensure();
  assert.equal(result.outcome, "existing");
  assert.equal(harness.calls.migrate, 0);
  assert.equal(harness.calls.create, 0);
});

function createHarness(initial = {}, { now = 1000 } = {}) {
  const state = { token: "secret", ...initial };
  const calls = { create: 0, recover: 0, migrate: 0, wait: 0 };
  const publicApi = {
    async create(_settings, marker) {
      return destination({ marker });
    },
    async recover() {
      return null;
    },
    async migrate(_settings, marker) {
      return destination({ marker });
    }
  };

  return {
    state,
    calls,
    api: publicApi,
    provisioner() {
      const countedApi = {};
      for (const method of ["create", "recover", "migrate"]) {
        countedApi[method] = (...args) => {
          calls[method] += 1;
          return publicApi[method](...args);
        };
      }
      return createDatabaseProvisioner({
        loadSettings: async () => ({ ...state }),
        saveSettings: async (values) => Object.assign(state, values),
        api: countedApi,
        uuid: () => "generated-marker",
        now: () => now,
        wait: async () => { calls.wait += 1; },
        recoveryDelays: [1, 2, 3]
      });
    }
  };
}

function destination(overrides = {}) {
  return {
    id: "data-source-id",
    databaseId: "database-id",
    type: "database",
    name: "Quick Notes",
    titleProperty: "Name",
    url: "https://notion.so/database-id",
    managedDestination: true,
    schemaVersion: 3,
    marker: "marker",
    properties: { title: { id: "title", name: "Name", type: "title" } },
    ...overrides
  };
}
