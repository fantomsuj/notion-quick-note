// @ts-nocheck
import { MANAGED_DATABASE_SCHEMA_VERSION } from "./constants.js";

export class ProvisioningPendingError extends Error {
  constructor(message = "Notion may still be creating the database. Try again in a moment.") {
    super(message);
    this.name = "ProvisioningPendingError";
    this.code = "provisioning_uncertain";
    this.status = 0;
  }
}

export function createDatabaseProvisioner({
  loadSettings,
  saveSettings,
  api,
  uuid = () => crypto.randomUUID(),
  now = () => Date.now(),
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  recoveryDelays = [500, 1500, 3000],
  uncertainRetryAfterMs = 60000
}) {
  let activePromise;

  function ensure() {
    if (!activePromise) {
      activePromise = run().finally(() => {
        activePromise = undefined;
      });
    }
    return activePromise;
  }

  async function run() {
    let settings = await loadSettings();
    if (!settings.token) throw new Error("Connect Notion first.");

    const connectionId = settings.connectionId || uuid();
    if (!settings.connectionId) {
      await saveSettings({ connectionId });
      settings = { ...settings, connectionId };
    }

    if (settings.destinationId) {
      const isManaged = settings.managedDestination || Boolean(settings.destinationDatabaseId);
      const needsMigration = isManaged
        && Number(settings.destinationSchemaVersion || 0) < MANAGED_DATABASE_SCHEMA_VERSION;
      if (!needsMigration) {
        return { destination: destinationFromSettings(settings), outcome: "existing" };
      }

      const marker = settings.destinationMarker || uuid();
      const destination = await api.migrate(settings, marker);
      await saveDestination(destination, connectionId);
      return { destination, outcome: "migrated" };
    }

    let provisioning = settings.databaseProvisioning;
    const isFreshProvisioning = !provisioning || provisioning.connectionId !== connectionId;
    if (isFreshProvisioning) {
      provisioning = {
        connectionId,
        marker: uuid(),
        status: "recovering",
        startedAt: now(),
        lastAttemptAt: 0,
        lastError: null
      };
      await saveForConnection(connectionId, { databaseProvisioning: provisioning });
    }

    const recovered = await api.recover(settings, provisioning.marker, isFreshProvisioning);
    if (recovered) {
      await saveDestination(recovered, connectionId);
      return { destination: recovered, outcome: "reused" };
    }

    if (provisioning.status === "uncertain" && now() - provisioning.lastAttemptAt < uncertainRetryAfterMs) {
      const delayedRecovery = await recoverWithDelays(settings, provisioning.marker);
      if (delayedRecovery) {
        await saveDestination(delayedRecovery, connectionId);
        return { destination: delayedRecovery, outcome: "reused" };
      }
      throw new ProvisioningPendingError();
    }

    provisioning = {
      ...provisioning,
      status: "creating",
      lastAttemptAt: now(),
      lastError: null
    };
    await saveForConnection(connectionId, { databaseProvisioning: provisioning });

    try {
      const destination = await api.create(settings, provisioning.marker);
      await saveDestination(destination, connectionId);
      return { destination, outcome: "created" };
    } catch (error) {
      if (!isUncertainCreateError(error)) {
        await saveForConnection(connectionId, {
          databaseProvisioning: {
            ...provisioning,
            status: "failed",
            lastError: serializeError(error)
          }
        });
        throw error;
      }

      provisioning = {
        ...provisioning,
        status: "uncertain",
        lastError: serializeError(error)
      };
      await saveForConnection(connectionId, { databaseProvisioning: provisioning });
      const delayedRecovery = await recoverWithDelays(settings, provisioning.marker);
      if (delayedRecovery) {
        await saveDestination(delayedRecovery, connectionId);
        return { destination: delayedRecovery, outcome: "reused" };
      }
      throw new ProvisioningPendingError();
    }
  }

  async function recoverWithDelays(settings, marker) {
    for (const delay of recoveryDelays) {
      await wait(delay);
      const recovered = await api.recover(settings, marker, false);
      if (recovered) return recovered;
    }
    return null;
  }

  async function saveDestination(destination, connectionId) {
    await saveForConnection(connectionId, {
      destinationType: destination.type,
      destinationId: destination.id,
      destinationDatabaseId: destination.databaseId,
      destinationName: destination.name,
      destinationUrl: destination.url || "",
      titleProperty: destination.titleProperty,
      managedDestination: true,
      destinationSchemaVersion: destination.schemaVersion,
      destinationMarker: destination.marker,
      destinationProperties: destination.properties,
      destinationConnectionId: connectionId,
      onboardingComplete: true,
      databaseProvisioning: null
    });
  }

  async function saveForConnection(connectionId, values) {
    const current = await loadSettings();
    if (current.connectionId !== connectionId) {
      const error = new Error("The Notion connection changed while setup was running.");
      error.code = "connection_changed";
      error.status = 409;
      throw error;
    }
    await saveSettings(values);
  }

  return { ensure };
}

function destinationFromSettings(settings) {
  return {
    id: settings.destinationId,
    databaseId: settings.destinationDatabaseId || "",
    type: settings.destinationType,
    name: settings.destinationName,
    titleProperty: settings.titleProperty,
    url: settings.destinationUrl || "",
    managedDestination: Boolean(settings.managedDestination),
    schemaVersion: Number(settings.destinationSchemaVersion || 0),
    marker: settings.destinationMarker || "",
    properties: settings.destinationProperties || {}
  };
}

function isUncertainCreateError(error) {
  return !error.status || error.status >= 500 || error.code === "network_error";
}

function serializeError(error) {
  return {
    message: error.message || "Database setup failed.",
    status: error.status || 0,
    code: error.code || ""
  };
}
