const HARNESS_KEY = "mv3FailureHarnessV1";
const EVENT_KEY = "mv3FailureEventV1";
const LEDGER_KEY = "mv3FailureLedgerV1";
const storageGet = chrome.storage.local.get.bind(chrome.storage.local);
const storageSet = chrome.storage.local.set.bind(chrome.storage.local);
let ledgerMutation = Promise.resolve();

type HarnessPoint = "enqueue_committed" | "sending_committed" | "request_pending" | "remote_succeeded" | "oauth_refresh"
  | "malformed_database_success" | "malformed_page_success";

interface HarnessState {
  point: HarnessPoint;
  runId: string;
  armed: boolean;
}

interface HarnessRequest {
  url: string;
  method: string;
  authorization: string;
  body: Record<string, unknown> | null;
}

interface HarnessPage {
  id: string;
  url: string;
  last_edited_time: string;
}

interface HarnessLedger {
  pages: Record<string, HarnessPage>;
  requests: HarnessRequest[];
  createAttempts: number;
  acceptedCreates: number;
  refreshCompletions: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

globalThis.__notionQuickNoteCaptureCheckpoint = async ({ record }) => {
  if (!record) return;
  const harness = await loadHarness();
  if (!harness.armed) return;
  if (!checkpointRecord(harness.point, record)) return;
  await trip(harness, record.id, { status: record.status, attemptCount: record.attemptCount });
  await never();
};

globalThis.fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
  const inputRequest = input instanceof Request ? input : null;
  const url = inputRequest?.url ?? String(input);
  const method = String(init.method ?? inputRequest?.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers ?? inputRequest?.headers);
  const body = parseBody(init.body);
  const request = { url, method, authorization: headers.get("Authorization") || "", body };
  await updateLedger((ledger) => {
    ledger.requests.push(request);
  });

  if (url.endsWith("/refresh")) return handleRefresh(request);
  if (!url.startsWith("https://api.notion.com/")) return jsonResponse(404, { message: "Unhandled test URL" });
  if (url.includes("/query")) return handleQuery(request);
  if (url.endsWith("/v1/pages") && method === "POST") return handleCreate(request);
  if (url.includes("/children") && method === "PATCH") return handleAppend();
  return jsonResponse(404, { message: `Unhandled Notion test request: ${method} ${url}` });
};

async function handleRefresh(request: HarnessRequest): Promise<Response> {
  const proof = request.body || {};
  const hasValidProof = proof.connection_handle === "handle-test"
    && /^\d+$/.test(String(proof.timestamp ?? ""))
    && /^[A-Za-z0-9_-]+$/.test(String(proof.nonce ?? ""))
    && /^[A-Za-z0-9_-]+$/.test(String(proof.signature ?? ""))
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

async function handleQuery(request: HarnessRequest): Promise<Response> {
  const harness = await loadHarness();
  if (harness.point === "oauth_refresh" && request.authorization === "Bearer access-old") {
    return jsonResponse(401, { message: "Token expired", code: "unauthorized" });
  }
  const filter = isRecord(request.body?.filter) ? request.body.filter : {};
  const richText = isRecord(filter.rich_text) ? filter.rich_text : {};
  const captureId = String(richText.equals ?? "");
  const ledger = await loadLedger();
  const page = ledger.pages[captureId];
  return jsonResponse(200, { results: page ? [page] : [] });
}

async function handleCreate(request: HarnessRequest): Promise<Response> {
  const harness = await loadHarness();
  await updateLedger((ledger) => {
    ledger.createAttempts += 1;
  });
  if (harness.point === "oauth_refresh" && request.authorization === "Bearer access-old") {
    return jsonResponse(401, { message: "Token expired", code: "unauthorized" });
  }
  if (harness.point === "malformed_database_success") return jsonResponse(200, {});

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

async function handleAppend(): Promise<Response> {
  const harness = await loadHarness();
  if (harness.point === "malformed_page_success") return jsonResponse(200, {});
  return jsonResponse(200, { results: [] });
}

function checkpointRecord(point: HarnessPoint, record: import("../../src/contracts.js").CaptureRecord): boolean {
  if (point === "enqueue_committed") return record.status === "pending" && record.attemptCount === 0;
  if (point === "sending_committed") return record.status === "sending" && record.attemptCount === 1;
  return false;
}

async function trip(harness: HarnessState, captureId: string, detail: Record<string, unknown>): Promise<void> {
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

function captureIdFromCreate(body: Record<string, unknown> | null): string {
  body ??= {};
  const properties = body.properties || {};
  if (!isRecord(properties)) throw new Error("The MV3 test harness received invalid properties.");
  const candidates = [properties.capture_id, properties["Capture ID"]].filter(isRecord);
  for (const property of candidates) {
    const richText = Array.isArray(property.rich_text) ? property.rich_text : [];
    const first = isRecord(richText[0]) ? richText[0] : {};
    const text = isRecord(first.text) ? first.text : {};
    const value = text.content || first.plain_text;
    if (typeof value === "string" && value) return value;
  }
  throw new Error("The MV3 test harness could not find the managed Capture ID.");
}

function parseBody(value: BodyInit | null | undefined): Record<string, unknown> | null {
  if (typeof value !== "string" || !value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function loadHarness(): Promise<HarnessState> {
  const value = (await storageGet(HARNESS_KEY))[HARNESS_KEY];
  if (!isRecord(value) || typeof value.point !== "string" || typeof value.runId !== "string") {
    return { point: "enqueue_committed", runId: "", armed: false };
  }
  const points: HarnessPoint[] = [
    "enqueue_committed", "sending_committed", "request_pending", "remote_succeeded", "oauth_refresh",
    "malformed_database_success", "malformed_page_success"
  ];
  return {
    point: points.includes(value.point as HarnessPoint) ? value.point as HarnessPoint : "enqueue_committed",
    runId: value.runId,
    armed: value.armed === true
  };
}

async function loadLedger(): Promise<HarnessLedger> {
  return normalizeLedger((await storageGet(LEDGER_KEY))[LEDGER_KEY]);
}

function updateLedger(callback: (ledger: HarnessLedger) => void | Promise<void>): Promise<HarnessLedger> {
  const task = ledgerMutation.then(async () => {
    const ledger = await loadLedger();
    await callback(ledger);
    await storageSet({ [LEDGER_KEY]: ledger });
    return ledger;
  });
  ledgerMutation = task.then(() => undefined, () => undefined);
  return task;
}

function normalizeLedger(value: unknown): HarnessLedger {
  const record = isRecord(value) ? value : {};
  return {
    pages: isRecord(record.pages)
      ? Object.fromEntries(Object.entries(record.pages).filter((entry): entry is [string, HarnessPage] => isHarnessPage(entry[1])))
      : {},
    requests: Array.isArray(record.requests) ? record.requests.filter(isHarnessRequest) : [],
    createAttempts: Number(record.createAttempts || 0),
    acceptedCreates: Number(record.acceptedCreates || 0),
    refreshCompletions: Number(record.refreshCompletions || 0)
  };
}

function isHarnessPage(value: unknown): value is HarnessPage {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.url === "string"
    && typeof value.last_edited_time === "string";
}

function isHarnessRequest(value: unknown): value is HarnessRequest {
  return isRecord(value)
    && typeof value.url === "string"
    && typeof value.method === "string"
    && typeof value.authorization === "string"
    && (value.body === null || isRecord(value.body));
}

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function gatedJsonResponse(payload: unknown, beforeGate: () => void | Promise<void>): Response {
  const response = jsonResponse(200, payload);
  Object.defineProperty(response, "json", {
    value: async (): Promise<never> => {
      await beforeGate();
      return never();
    }
  });
  return response;
}

function never(): Promise<never> {
  return new Promise<never>(() => undefined);
}
