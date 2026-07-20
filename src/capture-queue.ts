// @ts-nocheck
import { DELIVERY_STATES, retryDelayMs } from "./capture-store.js";

const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;

export function createDeliveryQueue({
  repository,
  getConnection,
  deliver,
  findExisting = async () => null,
  now = () => Date.now(),
  onChanged = async () => undefined
}) {
  let activeDrain = null;

  async function drain() {
    if (activeDrain) return activeDrain;
    activeDrain = runDrain().finally(() => {
      activeDrain = null;
    });
    return activeDrain;
  }

  async function runDrain() {
    await bindUnconfiguredCaptures();
    const due = await repository.listDueCaptures(now());
    for (const record of due) await attempt(record.id);
    await onChanged();
  }

  async function bindUnconfiguredCaptures() {
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
        destination: record.destination || connection.destination,
        nextAttemptAt: now(),
        lastError: null
      });
    }
  }

  async function attempt(id) {
    let record = await repository.getCapture(id);
    if (!record || record.status !== DELIVERY_STATES.pending) return record || null;

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
        if (existing) return markDelivered(id, existing);
      }
      const remote = await deliver(record, connection);
      return markDelivered(id, remote);
    } catch (error) {
      return handleFailure(record, error);
    }
  }

  async function markDelivered(id, remote = {}) {
    const record = await repository.getCapture(id);
    const syncedCapture = record?.pendingCapture || record?.capture || null;
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
        ...remote,
        id: remote?.id || record?.remote?.id || "",
        url: remote?.url || record?.remote?.url || ""
      }
    });
  }

  async function handleFailure(record, error) {
    const failure = classifyDeliveryError(error, record.destination?.managedDestination);
    if (failure.verify) {
      const connection = await getConnection();
      const existing = await findExisting(record, connection).catch(() => null);
      if (existing) return markDelivered(record.id, existing);
    }
    const updates = {
      status: failure.status,
      nextAttemptAt: failure.status === DELIVERY_STATES.pending
        ? now() + retryDelayMs(record.attemptCount, error?.retryAfter || 0)
        : 0,
      lastError: {
        kind: failure.kind,
        message: error?.message || failure.message,
        status: Number(error?.status || 0),
        code: error?.code || ""
      }
    };
    return repository.updateCapture(record.id, updates);
  }

  async function retry(id, { force = false, retarget = false } = {}) {
    const record = await repository.getCapture(id);
    if (!record) return null;
    const connection = await getConnection();
    const updates = {
      status: connection?.configured ? DELIVERY_STATES.pending : DELIVERY_STATES.blockedSetup,
      nextAttemptAt: connection?.configured ? now() : 0,
      forceRetry: Boolean(force),
      lastError: null
    };
    if (retarget && connection?.configured) {
      updates.connectionId = connection.connectionId;
      updates.destination = connection.destination;
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

export function classifyDeliveryError(error = {}, managedDestination = false) {
  const status = Number(error.status || 0);
  if (error.code === "remote_conflict" || status === 409 && error.name === "NotionConflictError") {
    return blocked(DELIVERY_STATES.blockedConflict, "remote_conflict", "This note changed in Notion. Your local edit is preserved for review.");
  }
  if (status === 401) return blocked(DELIVERY_STATES.blockedAuth, "auth", "Reconnect Notion to continue.");
  if (status === 403 || (status >= 400 && status < 500 && status !== 408 && status !== 429)) {
    return blocked(DELIVERY_STATES.blockedDestination, "destination", "The destination is unavailable or no longer compatible.");
  }
  if (status === 408 || error.timeout || error.code === "notion_timeout") {
    return managedDestination
      ? { ...blocked(DELIVERY_STATES.pending, "timeout", "Notion took too long. Delivery will be checked and retried automatically."), verify: true }
      : blocked(DELIVERY_STATES.uncertain, "timeout_manual", "Notion may have accepted this capture. Review it before retrying.");
  }
  if (status === 429 || error.offline) {
    return blocked(DELIVERY_STATES.pending, status === 429 ? "rate_limited" : "offline", "Delivery will retry automatically.");
  }
  if (status >= 500 || error.code === "network_error" || !status) {
    return managedDestination
      ? { ...blocked(DELIVERY_STATES.pending, "ambiguous_managed", "Delivery will be checked and retried automatically."), verify: true }
      : blocked(DELIVERY_STATES.uncertain, "ambiguous_manual", "Notion may have accepted this capture. Review it before retrying.");
  }
  return blocked(DELIVERY_STATES.blockedDestination, "delivery", "Notion rejected this capture.");
}

function blocked(status, kind, message) {
  return { status, kind, message, verify: false };
}
