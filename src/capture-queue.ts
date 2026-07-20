import { DELIVERY_STATES, retryDelayMs } from "./capture-store.js";
import type {
  CaptureDestination,
  CaptureRecord,
  CaptureRecordUpdate,
  CaptureRepositoryPort,
  Clock,
  DeliveryErrorKind,
  DeliveryState,
  RemoteTarget
} from "./contracts.js";
import { assertNever, isRecord } from "./contracts.js";

const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;

type DeliveryConnection =
  | { configured: false; connectionId?: string; destination?: CaptureDestination | null }
  | { configured: true; connectionId: string; destination?: CaptureDestination | null };

interface DeliveryQueueOptions {
  repository: CaptureRepositoryPort;
  getConnection: () => Promise<DeliveryConnection>;
  deliver: (record: CaptureRecord, connection: DeliveryConnection) => Promise<unknown>;
  findExisting?: (record: CaptureRecord, connection: DeliveryConnection) => Promise<unknown>;
  now?: Clock;
  onChanged?: () => void | Promise<void>;
}

interface ClassifiedDeliveryFailure {
  status: DeliveryState;
  kind: DeliveryErrorKind;
  message: string;
  verify: boolean;
}

export function createDeliveryQueue({
  repository,
  getConnection,
  deliver,
  findExisting = async () => null,
  now = () => Date.now(),
  onChanged = async () => undefined
}: DeliveryQueueOptions) {
  let activeDrain: Promise<void> | null = null;

  async function drain(): Promise<void> {
    if (activeDrain) return activeDrain;
    activeDrain = runDrain().finally(() => {
      activeDrain = null;
    });
    return activeDrain;
  }

  async function runDrain(): Promise<void> {
    await bindUnconfiguredCaptures();
    const due = await repository.listDueCaptures(now());
    for (const record of due) await attempt(record.id);
    await onChanged();
  }

  async function bindUnconfiguredCaptures(): Promise<void> {
    const connection = await getConnection();
    if (!connection?.configured) return;
    const resumable = (await repository.listCaptures({ statuses: [DELIVERY_STATES.blockedSetup, DELIVERY_STATES.blockedAuth] })).filter((record) =>
      (record.status === DELIVERY_STATES.blockedSetup && !record.connectionId)
      || (record.status === DELIVERY_STATES.blockedAuth && record.connectionId === connection.connectionId)
    );
    for (const record of resumable) {
      await repository.updateCapture(record.id, {
        status: DELIVERY_STATES.pending,
        connectionId: record.connectionId || connection.connectionId,
        destination: record.destination || connection.destination || null,
        nextAttemptAt: now(),
        lastError: null
      });
    }
  }

  async function attempt(id: string): Promise<CaptureRecord | null> {
    let record = await repository.getCapture(id);
    if (!record) return null;
    const status = record.status;
    switch (status) {
      case DELIVERY_STATES.pending:
        break;
      case DELIVERY_STATES.sending:
      case DELIVERY_STATES.delivered:
      case DELIVERY_STATES.blockedSetup:
      case DELIVERY_STATES.blockedAuth:
      case DELIVERY_STATES.blockedDestination:
      case DELIVERY_STATES.blockedConflict:
      case DELIVERY_STATES.uncertain:
        return record;
      default:
        return assertNever(status);
    }

    if (!record.forceRetry && record.firstAttemptAt && now() - record.firstAttemptAt >= SEVEN_DAYS) {
      return repository.updateCapture(id, {
        status: DELIVERY_STATES.uncertain,
        nextAttemptAt: 0,
        lastError: { kind: "attention_required", message: "Delivery has been retrying for seven days. Review it before retrying." }
      });
    }

    const connection = await getConnection();
    if (!connection?.configured) {
      return repository.updateCapture(id, {
        status: record.connectionId ? DELIVERY_STATES.blockedAuth : DELIVERY_STATES.blockedSetup,
        nextAttemptAt: 0,
        lastError: { kind: record.connectionId ? "auth" : "setup", message: record.connectionId ? "Reconnect Notion to deliver this capture." : "Connect Notion to deliver this capture." }
      });
    }
    if (record.connectionId && record.connectionId !== connection.connectionId) {
      return repository.updateCapture(id, {
        status: DELIVERY_STATES.blockedDestination,
        nextAttemptAt: 0,
        lastError: { kind: "connection_changed", message: "This capture belongs to a different Notion connection. Retarget it before retrying." }
      });
    }

    record = await repository.claimCapture(id, now());
    if (!record) return null;

    try {
      if (record.operation !== "update" && record.destination?.managedDestination && record.attemptCount > 1) {
        const existing = await findExisting(record, connection);
        if (existing) return await markDelivered(id, existing);
      }
      const remote = await deliver(record, connection);
      return await markDelivered(id, remote);
    } catch (error) {
      return handleFailure(record, error);
    }
  }

  async function markDelivered(id: string, remote: unknown = {}): Promise<CaptureRecord | null> {
    const record = await repository.getCapture(id);
    if (!record) return null;
    const syncedCapture = record.pendingCapture || record.capture;
    const normalizedRemote = normalizeRemote(remote, record.remote);
    return repository.updateCapture(id, {
      status: DELIVERY_STATES.delivered,
      deliveredAt: now(),
      nextAttemptAt: 0,
      lastError: null,
      capture: syncedCapture,
      syncedCapture,
      pendingCapture: null,
      operation: "",
      baseFingerprint: "",
      syncJournal: null,
      remote: {
        ...(record?.remote || {}),
        ...normalizedRemote,
        id: normalizedRemote.id || record?.remote?.id || "",
        url: normalizedRemote.url || record?.remote?.url || ""
      }
    });
  }

  async function handleFailure(record: CaptureRecord, error: unknown): Promise<CaptureRecord | null> {
    const failure = classifyDeliveryError(error, record.destination?.managedDestination);
    if (failure.verify) {
      const connection = await getConnection();
      const existing = await findExisting(record, connection).catch(() => null);
      if (hasRemoteIdentity(existing)) return await markDelivered(record.id, existing);
    }
    const errorValue = isRecord(error) ? error : {};
    const updates: CaptureRecordUpdate = {
      status: failure.status,
      nextAttemptAt: failure.status === DELIVERY_STATES.pending
        ? now() + retryDelayMs(record.attemptCount, typeof errorValue.retryAfter === "number" ? errorValue.retryAfter : 0)
        : 0,
      lastError: {
        kind: failure.kind,
        message: typeof errorValue.message === "string" ? errorValue.message : failure.message,
        status: Number(errorValue.status || 0),
        code: typeof errorValue.code === "string" ? errorValue.code : ""
      }
    };
    return repository.updateCapture(record.id, updates);
  }

  async function retry(id: string, { force = false, retarget = false }: { force?: boolean; retarget?: boolean } = {}): Promise<CaptureRecord | null> {
    const record = await repository.getCapture(id);
    if (!record) return null;
    const connection = await getConnection();
    const updates: CaptureRecordUpdate = {
      status: connection?.configured ? DELIVERY_STATES.pending : DELIVERY_STATES.blockedSetup,
      nextAttemptAt: connection?.configured ? now() : 0,
      forceRetry: Boolean(force),
      lastError: connection?.configured ? null : { kind: "setup", message: "Connect Notion to deliver this capture." }
    };
    if (retarget && connection?.configured) {
      updates.connectionId = connection.connectionId;
      updates.destination = connection.destination || null;
    } else if (retarget) {
      updates.connectionId = "";
      updates.destination = null;
    }
    const next = await repository.updateCapture(id, updates);
    await onChanged();
    if (next?.status === DELIVERY_STATES.pending) void drain();
    return next;
  }

  return { drain, attempt, retry, markDelivered, bindUnconfiguredCaptures };
}

export function classifyDeliveryError(error: unknown = {}, managedDestination = false): ClassifiedDeliveryFailure {
  const value = isRecord(error) ? error : {};
  const status = Number(value.status || 0);
  if (value.code === "remote_conflict" || status === 409 && value.name === "NotionConflictError") {
    return blocked(DELIVERY_STATES.blockedConflict, "remote_conflict", "This note changed in Notion. Your local edit is preserved for review.");
  }
  if (status === 401) return blocked(DELIVERY_STATES.blockedAuth, "auth", "Reconnect Notion to continue.");
  if (status === 403 || (status >= 400 && status < 500 && status !== 408 && status !== 429)) {
    return blocked(DELIVERY_STATES.blockedDestination, "destination", "The destination is unavailable or no longer compatible.");
  }
  if (status === 408 || value.timeout || value.code === "notion_timeout") {
    return managedDestination
      ? { ...blocked(DELIVERY_STATES.pending, "timeout", "Notion took too long. Delivery will be checked and retried automatically."), verify: true }
      : blocked(DELIVERY_STATES.uncertain, "timeout_manual", "Notion may have accepted this capture. Review it before retrying.");
  }
  if (status === 429 || value.offline) {
    return blocked(DELIVERY_STATES.pending, status === 429 ? "rate_limited" : "offline", "Delivery will retry automatically.");
  }
  if (status >= 500 || value.code === "network_error" || !status) {
    return managedDestination
      ? { ...blocked(DELIVERY_STATES.pending, "ambiguous_managed", "Delivery will be checked and retried automatically."), verify: true }
      : blocked(DELIVERY_STATES.uncertain, "ambiguous_manual", "Notion may have accepted this capture. Review it before retrying.");
  }
  return blocked(DELIVERY_STATES.blockedDestination, "delivery", "Notion rejected this capture.");
}

function blocked(status: DeliveryState, kind: DeliveryErrorKind, message: string): ClassifiedDeliveryFailure {
  return { status, kind, message, verify: false };
}

function normalizeRemote(value: unknown, fallback: RemoteTarget | null): RemoteTarget {
  const remote = isRecord(value) ? value : {};
  const suppliedId = typeof remote.id === "string" ? remote.id.trim() : "";
  const suppliedPageId = typeof remote.pageId === "string" ? remote.pageId.trim() : "";
  if (!suppliedId && !suppliedPageId) {
    throw new InvalidRemoteTargetError();
  }
  const id = suppliedId || suppliedPageId;
  const kind = remote.kind === "page" || remote.kind === "section" || remote.kind === "legacy_section"
    ? remote.kind
    : fallback?.kind || "page";
  return {
    kind,
    id,
    url: typeof remote.url === "string" ? remote.url : fallback?.url || "",
    pageId: suppliedPageId || fallback?.pageId || id,
    blockIds: Array.isArray(remote.blockIds) ? remote.blockIds.map(String) : fallback?.blockIds || [],
    fingerprint: typeof remote.fingerprint === "string" ? remote.fingerprint : fallback?.fingerprint || "",
    ...(typeof remote.lastEditedTime === "string" ? { lastEditedTime: remote.lastEditedTime } : fallback?.lastEditedTime ? { lastEditedTime: fallback.lastEditedTime } : {})
  };
}

function hasRemoteIdentity(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return typeof value.id === "string" && value.id.trim().length > 0
    || typeof value.pageId === "string" && value.pageId.trim().length > 0;
}

class InvalidRemoteTargetError extends Error {
  readonly code = "invalid_remote_target";

  constructor() {
    super("Notion returned a delivery result without a remote page identity.");
    this.name = "InvalidRemoteTargetError";
  }
}
