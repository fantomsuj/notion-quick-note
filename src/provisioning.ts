import { MANAGED_DATABASE_SCHEMA_VERSION } from "./constants.js";
import type { Destination, Settings } from "./contracts.js";

interface SerializedProvisioningError {
  message: string;
  status: number;
  code: string;
}

export interface ProvisioningState {
  connectionId: string;
  marker: string;
  status: "recovering" | "creating" | "uncertain" | "failed";
  startedAt: number;
  lastAttemptAt: number;
  lastError?: SerializedProvisioningError | null;
}

export type ProvisioningSettings = Omit<Partial<Settings>, "databaseProvisioning"> & {
  databaseProvisioning?: ProvisioningState | null;
};

export interface ManagedDestination extends Destination {
  databaseId: string;
  type: "database";
  titleProperty: string;
  schemaVersion: number;
  marker: string;
  properties: NonNullable<Destination["properties"]>;
}

export interface ProvisioningApi {
  create(settings: ProvisioningSettings, marker: string): Promise<ManagedDestination>;
  recover(settings: ProvisioningSettings, marker: string, isFresh: boolean): Promise<ManagedDestination | null>;
  migrate(settings: ProvisioningSettings, marker: string): Promise<ManagedDestination>;
}

interface ProvisioningDependencies {
  loadSettings(): Promise<ProvisioningSettings>;
  saveSettings(values: Partial<ProvisioningSettings>): Promise<void>;
  api: ProvisioningApi;
  uuid?: () => string;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
  recoveryDelays?: number[];
  uncertainRetryAfterMs?: number;
}

export type ProvisioningOutcome = "existing" | "migrated" | "reused" | "created";
export interface ProvisioningResult {
  destination: Destination;
  outcome: ProvisioningOutcome;
}

export class ProvisioningPendingError extends Error {
  readonly code = "provisioning_uncertain";
  readonly status = 0;

  constructor(message = "Notion may still be creating the database. Try again in a moment.") {
    super(message);
    this.name = "ProvisioningPendingError";
  }
}

class ProvisioningStateError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = "ProvisioningStateError";
    this.code = code;
    this.status = status;
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
}: ProvisioningDependencies): { ensure(): Promise<ProvisioningResult> } {
  let activePromise: Promise<ProvisioningResult> | undefined;

  function ensure(): Promise<ProvisioningResult> {
    if (!activePromise) {
      activePromise = run().finally(() => {
        activePromise = undefined;
      });
    }
    return activePromise;
  }

  async function run(): Promise<ProvisioningResult> {
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
      if (!needsMigration) return { destination: destinationFromSettings(settings), outcome: "existing" };

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

    if (!provisioning) throw new ProvisioningPendingError();

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

    provisioning = { ...provisioning, status: "creating", lastAttemptAt: now(), lastError: null };
    await saveForConnection(connectionId, { databaseProvisioning: provisioning });

    try {
      const destination = await api.create(settings, provisioning.marker);
      await saveDestination(destination, connectionId);
      return { destination, outcome: "created" };
    } catch (error: unknown) {
      if (!isUncertainCreateError(error)) {
        await saveForConnection(connectionId, {
          databaseProvisioning: { ...provisioning, status: "failed", lastError: serializeError(error) }
        });
        throw error;
      }

      provisioning = { ...provisioning, status: "uncertain", lastError: serializeError(error) };
      await saveForConnection(connectionId, { databaseProvisioning: provisioning });
      const delayedRecovery = await recoverWithDelays(settings, provisioning.marker);
      if (delayedRecovery) {
        await saveDestination(delayedRecovery, connectionId);
        return { destination: delayedRecovery, outcome: "reused" };
      }
      throw new ProvisioningPendingError();
    }
  }

  async function recoverWithDelays(settings: ProvisioningSettings, marker: string): Promise<ManagedDestination | null> {
    for (const delay of recoveryDelays) {
      await wait(delay);
      const recovered = await api.recover(settings, marker, false);
      if (recovered) return recovered;
    }
    return null;
  }

  async function saveDestination(destination: ManagedDestination, connectionId: string): Promise<void> {
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

  async function saveForConnection(connectionId: string, values: Partial<ProvisioningSettings>): Promise<void> {
    const current = await loadSettings();
    if (current.connectionId !== connectionId) {
      throw new ProvisioningStateError("The Notion connection changed while setup was running.", "connection_changed", 409);
    }
    await saveSettings(values);
  }

  return { ensure };
}

function destinationFromSettings(settings: ProvisioningSettings): Destination {
  return {
    id: settings.destinationId || "",
    databaseId: settings.destinationDatabaseId || "",
    type: settings.destinationType || "database",
    name: settings.destinationName || "Quick Notes",
    titleProperty: settings.titleProperty || "Name",
    url: settings.destinationUrl || "",
    managedDestination: Boolean(settings.managedDestination),
    schemaVersion: Number(settings.destinationSchemaVersion || 0),
    marker: settings.destinationMarker || "",
    properties: settings.destinationProperties || {}
  };
}

function errorMetadata(error: unknown): { message?: string; status?: number; code?: string } {
  if (typeof error !== "object" || error === null) return {};
  const message = Reflect.get(error, "message");
  const status = Reflect.get(error, "status");
  const code = Reflect.get(error, "code");
  return {
    ...(typeof message === "string" ? { message } : {}),
    ...(typeof status === "number" ? { status } : {}),
    ...(typeof code === "string" ? { code } : {})
  };
}

function isUncertainCreateError(error: unknown): boolean {
  const metadata = errorMetadata(error);
  return !metadata.status || metadata.status >= 500 || metadata.code === "network_error";
}

function serializeError(error: unknown): SerializedProvisioningError {
  const metadata = errorMetadata(error);
  return {
    message: metadata.message || "Database setup failed.",
    status: metadata.status || 0,
    code: metadata.code || ""
  };
}
