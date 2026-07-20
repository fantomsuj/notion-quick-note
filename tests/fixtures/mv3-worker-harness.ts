// @ts-nocheck
const HARNESS_KEY = "mv3FailureHarnessV1";
const EVENT_KEY = "mv3FailureEventV1";
const LEDGER_KEY = "mv3FailureLedgerV1";
const storageGet = chrome.storage.local.get.bind(chrome.storage.local);
const storageSet = chrome.storage.local.set.bind(chrome.storage.local);
let ledgerMutation = Promise.resolve();

globalThis.__notionQuickNoteCaptureCheckpoint = async ({ record } = {}) => {
  if (!record) return;
  const harness = await loadHarness();
  if (!harness.armed) return;
  if (!checkpointRecord(harness.point, record)) return;
  await trip(harness, record.id, { status: record.status, attemptCount: record.attemptCount });
  await never();
};

globalThis.fetch = async (input, init = {}) => {
  const url = String(input?.url || input);
  const method = String(init.method || input?.method || "GET").toUpperCase();
  const headers = new Headers(init.headers || input?.headers || {});
  const body = parseBody(init.body);
  const request = { url, method, authorization: headers.get("Authorization") || "", body };
  await updateLedger((ledger) => {
    ledger.requests.push(request);
  });

  if (url.endsWith("/refresh")) return handleRefresh(request);
  if (!url.startsWith("https://api.notion.com/")) return jsonResponse(404, { message: "Unhandled test URL" });
  if (url.includes("/query")) return handleQuery(request);
  if (url.endsWith("/v1/pages") && method === "POST") return handleCreate(request);
  return jsonResponse(404, { message: `Unhandled Notion test request: ${method} ${url}` });
};

async function handleRefresh(request) {
  const proof = request.body || {};
  const hasValidProof = proof.connection_handle === "handle-test"
    && /^\d+$/.test(proof.timestamp || "")
    && /^[A-Za-z0-9_-]+$/.test(proof.nonce || "")
    && /^[A-Za-z0-9_-]+$/.test(proof.signature || "")
    && !("refresh_token" in proof);
  if (!hasValidProof) return jsonResponse(400, { error: "Invalid device-bound refresh proof" });

  const harness = await loadHarness();
  if (harness.armed && harness.point === "oauth_refresh") {
    await trip(harness, "", { request: "oauth_refresh" });
    return never();
  }
  await updateLedger((ledger) => {
    ledger.refreshCompletions += 1;
  });
  return jsonResponse(200, { access_token: "access-new" });
}

async function handleQuery(request) {
  const harness = await loadHarness();
  if (harness.point === "oauth_refresh" && request.authorization === "Bearer access-old") {
    return jsonResponse(401, { message: "Token expired", code: "unauthorized" });
  }
  const captureId = String(request.body?.filter?.rich_text?.equals || "");
  const ledger = await loadLedger();
  const page = ledger.pages[captureId];
  return jsonResponse(200, { results: page ? [page] : [] });
}

async function handleCreate(request) {
  const harness = await loadHarness();
  await updateLedger((ledger) => {
    ledger.createAttempts += 1;
  });
  if (harness.point === "oauth_refresh" && request.authorization === "Bearer access-old") {
    return jsonResponse(401, { message: "Token expired", code: "unauthorized" });
  }

  const captureId = captureIdFromCreate(request.body);
  if (harness.armed && harness.point === "request_pending") {
    await trip(harness, captureId, { request: "notion_create_pending" });
    return never();
  }

  const page = {
    id: `remote-${captureId}`,
    url: `https://notion.test/${captureId}`,
    last_edited_time: "2026-07-19T00:00:00.000Z"
  };
  await updateLedger((ledger) => {
    ledger.acceptedCreates += 1;
    ledger.pages[captureId] = page;
  });

  if (harness.armed && harness.point === "remote_succeeded") {
    return gatedJsonResponse(page, async () => {
      await trip(harness, captureId, { request: "notion_create_succeeded" });
    });
  }
  return jsonResponse(200, page);
}

function checkpointRecord(point, record) {
  if (point === "enqueue_committed") return record.status === "pending" && record.attemptCount === 0;
  if (point === "sending_committed") return record.status === "sending" && record.attemptCount === 1;
  return false;
}

async function trip(harness, captureId, detail) {
  const latest = await loadHarness();
  if (!latest.armed || latest.runId !== harness.runId || latest.point !== harness.point) return;
  const stopped = { ...latest, armed: false };
  await storageSet({
    [HARNESS_KEY]: stopped,
    [EVENT_KEY]: {
      runId: latest.runId,
      point: latest.point,
      captureId,
      detail,
      reachedAt: Date.now()
    }
  });
}

function captureIdFromCreate(body = {}) {
  const properties = body.properties || {};
  const candidates = [properties.capture_id, properties["Capture ID"]].filter(Boolean);
  for (const property of candidates) {
    const value = property?.rich_text?.[0]?.text?.content || property?.rich_text?.[0]?.plain_text;
    if (typeof value === "string" && value) return value;
  }
  throw new Error("The MV3 test harness could not find the managed Capture ID.");
}

function parseBody(value) {
  if (typeof value !== "string" || !value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

async function loadHarness() {
  return (await storageGet(HARNESS_KEY))[HARNESS_KEY] || {};
}

async function loadLedger() {
  return normalizeLedger((await storageGet(LEDGER_KEY))[LEDGER_KEY]);
}

function updateLedger(callback) {
  const task = ledgerMutation.then(async () => {
    const ledger = await loadLedger();
    await callback(ledger);
    await storageSet({ [LEDGER_KEY]: ledger });
    return ledger;
  });
  ledgerMutation = task.catch(() => undefined);
  return task;
}

function normalizeLedger(value = {}) {
  return {
    pages: value.pages && typeof value.pages === "object" ? value.pages : {},
    requests: Array.isArray(value.requests) ? value.requests : [],
    createAttempts: Number(value.createAttempts || 0),
    acceptedCreates: Number(value.acceptedCreates || 0),
    refreshCompletions: Number(value.refreshCompletions || 0)
  };
}

function jsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "Content-Type": "application/json" }),
    async json() { return structuredClone(payload); }
  };
}

function gatedJsonResponse(payload, beforeGate) {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "Content-Type": "application/json" }),
    async json() {
      await beforeGate();
      return never();
    }
  };
}

function never() {
  return new Promise(() => {});
}
