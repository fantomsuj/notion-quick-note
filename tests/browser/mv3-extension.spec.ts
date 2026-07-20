import { chromium, expect, test, type BrowserContext, type Page, type Worker } from "@playwright/test";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension } from "../../scripts/build.js";
import { isRuntimeResponse, type CaptureContext, type EditorNode, type RuntimeRequest, type RuntimeResponse } from "../../src/contracts.js";

type HarnessPoint = "enqueue_committed" | "sending_committed" | "request_pending" | "remote_succeeded" | "oauth_refresh"
  | "malformed_database_success" | "malformed_page_success";
type HarnessKeysPayload = { harnessKey: string; eventKey: string; ledgerKey: string; point: HarnessPoint; runId: string };
type HarnessArmPayload = Pick<HarnessKeysPayload, "harnessKey" | "point" | "runId">;
interface LedgerRequest { url: string; body?: Record<string, unknown> }
interface HarnessLedger { pages: Record<string, unknown>; requests: LedgerRequest[]; createAttempts: number; acceptedCreates: number; refreshCompletions: number }
interface EnqueueOutcome {
  response?: { ok?: boolean; accepted?: boolean };
  portError?: string;
  acknowledgementTimedOut?: boolean;
}
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fixtureRoot = path.join(repoRoot, "tests/fixtures");
const HARNESS_KEY = "mv3FailureHarnessV1";
const EVENT_KEY = "mv3FailureEventV1";
const LEDGER_KEY = "mv3FailureLedgerV1";
const DELIVERY_ALARM = "notion-quick-note-delivery";

// Each test owns a persistent Chrome profile and may stop its service worker.
// Keeping this file ordered avoids startup contention between MV3 contexts.
test.describe.configure({ mode: "default" });

test("real MV3 dispatcher normalizes malformed stored settings before returning a correlated response", async () => {
  const profile = await mkdtemp(path.join(tmpdir(), "notion-quick-note-settings-"));
  let context: BrowserContext | undefined;
  try {
    context = await launchExtension(profile);
    const worker = await serviceWorker(context);
    const extensionId = new URL(worker.url()).host;
    const page = await openActivityPage(context, extensionId);
    await page.evaluate(() => chrome.storage.local.set({
      authType: "bad",
      destinationName: 42,
      includeSource: "yes",
      aiEnabled: false,
      destinationProperties: { title: { id: "title", name: 99 } }
    }));

    const response = await sendRuntimeRequestFromPage(page, { type: "GET_QUICK_SETTINGS" });

    expect(response).toEqual({
      ok: true,
      destinationName: "Quick Notes",
      includeSource: true,
      aiEnabled: false,
      aiSuggestTitle: true,
      aiExtractTodos: true,
      connected: false,
      configured: false
    });
  } finally {
    await context?.close().catch(() => undefined);
    await rm(profile, { recursive: true, force: true });
  }
});

test("real MV3 worker durably recovers a queued capture after termination and profile relaunch", async () => {
  test.setTimeout(60_000);
  const profile = await mkdtemp(path.join(tmpdir(), "notion-quick-note-mv3-"));
  let context: BrowserContext | undefined;
  try {
    context = await launchExtension(profile);
    const worker = await serviceWorker(context);
    const extensionId = new URL(worker.url()).host;
    const page = await openActivityPage(context, extensionId);
    await expect(page.locator(".data-practices summary")).toHaveText("How your captures are handled");
    await page.locator(".data-practices summary").click();
    await expect(page.locator(".data-practices")).toContainText("until delivery succeeds or you delete them");
    await expect(page.locator(".data-practices")).toContainText("selected Notion workspace");

    const captureContext: CaptureContext = { version: 1, title: "MV3 recovery test", url: "https://example.test/source", selection: "", capturedAt: Date.now() };
    const draftResponse = await sendRuntimeRequestFromPage(page, {
      type: "GET_OR_CREATE_DRAFT",
      tabId: 91,
      context: captureContext
    });
    if (!draftResponse.ok) throw new Error(draftResponse.error);
    const draft = draftResponse.draft;
    const storedDraft = await sendRuntimeRequestFromPage(page, {
      type: "UPSERT_DRAFT",
      draft: {
        ...draft,
        title: "Durable thought",
        doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Survive the worker" }] }] }
      }
    });
    if (!storedDraft.ok) throw new Error(storedDraft.error);
    await expect(page.locator(".drafts-group")).toContainText("Durable thought");
    await expect(page.locator(".drafts-group")).toContainText("Saved locally");
    await expect(page.locator(".note-count")).toHaveText("1");
    const accepted = await sendRuntimeRequestFromPage(page, {
      type: "ENQUEUE_CAPTURE",
      draftId: draft.id,
      context: captureContext,
      capture: {
        document: { version: 1, title: "Durable thought", doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Survive the worker" }] }] } },
        pageTitle: captureContext.title,
        url: captureContext.url,
        includeSource: true
      }
    });
    if (!accepted.ok) throw new Error(accepted.error);
    if (!accepted.accepted) throw new Error("Capture was not accepted.");
    const queuedId = accepted.record.id;
    const reconciledByDraft = await sendRuntimeRequestFromPage(page, {
      type: "GET_CAPTURE_STATUS",
      draftId: draft.id
    });
    if (!reconciledByDraft.ok || !reconciledByDraft.record) throw new Error("Queued capture was not found by draft ID.");
    expect(reconciledByDraft.record.id).toBe(queuedId);

    const [statusBeforeRestart, diagnosticsBeforeRestart] = await Promise.all([
      sendRuntimeRequestFromPage(page, { type: "GET_CAPTURE_STATUS", id: queuedId }),
      sendRuntimeRequestFromPage(page, { type: "GET_STORAGE_DIAGNOSTICS" })
    ]);
    const persistedBeforeRestart = {
      status: statusBeforeRestart.ok ? statusBeforeRestart.record?.status || "" : "",
      backend: diagnosticsBeforeRestart.ok ? diagnosticsBeforeRestart.diagnostics.backend : ""
    };
    expect(persistedBeforeRestart).toEqual({ status: "blocked_setup", backend: "indexeddb" });

    await page.locator(".storage-recovery summary").click();
    await expect(page.locator(".storage-health")).toContainText("indexeddb");
    await expect(page.locator(".origin-bytes")).not.toBeEmpty();
    await expect(page.locator(".persistence-state")).not.toBeEmpty();
    await expect(page.locator(".maintenance-time")).not.toBeEmpty();
    const jsonDownload = page.waitForEvent("download");
    await page.locator('[data-export="json"]').click();
    await expect((await jsonDownload).suggestedFilename()).toMatch(/\.json$/);
    const markdownDownload = page.waitForEvent("download");
    await page.locator('[data-export="markdown"]').click();
    await expect((await markdownDownload).suggestedFilename()).toMatch(/\.md$/);

    const cdp = await context.newCDPSession(page);
    await cdp.send("ServiceWorker.enable");
    await cdp.send("ServiceWorker.stopAllWorkers");

    const activityInProcess = await sendRuntimeRequestFromPage(page, { type: "LIST_CAPTURE_ACTIVITY" });
    const recoveredInProcess = activityInProcess.ok
      ? activityInProcess.queued.find((record) => record.id === queuedId)?.status || ""
      : "";
    expect(recoveredInProcess).toBe("blocked_setup");

    await context.close();
    context = await launchExtension(profile);
    const relaunchedWorker = await serviceWorker(context);
    expect(new URL(relaunchedWorker.url()).host).toBe(extensionId);
    const relaunchedPage = await openActivityPage(context, extensionId);
    const relaunchedActivity = await sendRuntimeRequestFromPage(relaunchedPage, { type: "LIST_CAPTURE_ACTIVITY" });
    const recoveredAfterRelaunch = relaunchedActivity.ok
      && relaunchedActivity.queued.some((record) => record.id === queuedId && record.status === "blocked_setup");
    expect(recoveredAfterRelaunch).toBe(true);
  } finally {
    await context?.close().catch(() => undefined);
    await rm(profile, { recursive: true, force: true });
  }
});

const terminationCases = [
  { point: "enqueue_committed", label: "immediately after enqueue commits", beforeStatus: "pending", beforeAttempts: 0, createAttempts: 1 },
  { point: "sending_committed", label: "after sending is durable", beforeStatus: "sending", beforeAttempts: 1, createAttempts: 1 },
  { point: "request_pending", label: "while the Notion create is pending", beforeStatus: "sending", beforeAttempts: 1, createAttempts: 2 },
  { point: "remote_succeeded", label: "after Notion succeeds before local delivery is recorded", beforeStatus: "sending", beforeAttempts: 1, createAttempts: 1 },
  { point: "oauth_refresh", label: "during OAuth token refresh", beforeStatus: "sending", beforeAttempts: 1, createAttempts: 2 }
] as const satisfies readonly { point: HarnessPoint; label: string; beforeStatus: string; beforeAttempts: number; createAttempts: number }[];

for (const scenario of terminationCases) {
  test(`real MV3 worker recovers ${scenario.label}`, async () => {
    test.setTimeout(60_000);
    const profile = await mkdtemp(path.join(tmpdir(), `notion-quick-note-${scenario.point}-profile-`));
    const extensionRoot = await mkdtemp(path.join(tmpdir(), `notion-quick-note-${scenario.point}-extension-`));
    let context: BrowserContext | undefined;
    try {
      await prepareFailureExtension(extensionRoot);
      context = await launchExtension(profile, extensionRoot);
      const worker = await serviceWorker(context);
      await waitForFailureHarness(worker);
      const extensionId = new URL(worker.url()).host;
      const page = await openControlPage(context, extensionId);
      let observer = await openControlPage(context, extensionId);
      const draftId = `draft-${scenario.point}`;
      const runId = `${scenario.point}-${Date.now()}`;

      await page.evaluate(async ({ harnessKey, eventKey, ledgerKey, point, runId }: HarnessKeysPayload) => {
        await chrome.storage.local.set({
          authType: "oauth",
          token: "access-old",
          connectionHandle: "handle-test",
          oauthBrokerUrl: "https://oauth.test",
          workspaceId: "workspace-test",
          connectionId: "connection-test",
          destinationType: "database",
          destinationId: "data-source-test",
          destinationDatabaseId: "database-test",
          destinationName: "Quick Notes",
          destinationUrl: "https://notion.test/database-test",
          titleProperty: "Name",
          managedDestination: true,
          destinationSchemaVersion: 3,
          destinationMarker: "marker-test",
          destinationProperties: {
            title: { id: "title", name: "Name" },
            captureId: { id: "capture_id", name: "Capture ID" }
          },
          [harnessKey]: { point, runId, armed: false },
          [eventKey]: null,
          [ledgerKey]: { pages: {}, requests: [], createAttempts: 0, acceptedCreates: 0, refreshCompletions: 0 }
        });
        await chrome.runtime.sendMessage({ type: "GET_PENDING_COUNT" });
      }, { harnessKey: HARNESS_KEY, eventKey: EVENT_KEY, ledgerKey: LEDGER_KEY, point: scenario.point, runId });

      const captureContext: CaptureContext = {
        version: 1,
        title: `MV3 ${scenario.point}`,
        url: `https://example.test/${scenario.point}`,
        selection: "",
        capturedAt: Date.now()
      };
      const draftResponse = await sendRuntimeRequestFromPage(page, {
        type: "GET_OR_CREATE_DRAFT",
        draftId,
        tabId: 101,
        context: captureContext
      });
      if (!draftResponse.ok) throw new Error(draftResponse.error);
      const draft = draftResponse.draft;
      const doc: EditorNode = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: `Survive ${scenario.point}` }] }] };
      const storedDraft = await sendRuntimeRequestFromPage(page, {
        type: "UPSERT_DRAFT",
        draft: { ...draft, title: "Durable matrix capture", doc }
      });
      expect(storedDraft.ok).toBe(true);

      await page.evaluate(({ harnessKey, point, runId }: HarnessArmPayload) => chrome.storage.local.set({
        [harnessKey]: { point, runId, armed: true }
      }), { harnessKey: HARNESS_KEY, point: scenario.point, runId });

      const enqueuePromise: Promise<EnqueueOutcome> = Promise.race([
        sendRuntimeRequestFromPage(page, {
          type: "ENQUEUE_CAPTURE",
          draftId,
          context: captureContext,
          capture: {
            document: { version: 1, title: "Durable matrix capture", doc },
            pageTitle: captureContext.title,
            url: captureContext.url,
            includeSource: true
          }
        }).then((response): EnqueueOutcome => ({
          response: { ok: response.ok, ...(response.ok ? { accepted: response.accepted } : {}) }
        }), (error: unknown): EnqueueOutcome => ({ portError: error instanceof Error ? error.message : String(error) })),
        new Promise<EnqueueOutcome>((resolve) => setTimeout(() => resolve({ acknowledgementTimedOut: true }), 1_000))
      ]);

      if (scenario.point !== "enqueue_committed") {
        const accepted = await enqueuePromise;
        expect(accepted.response).toMatchObject({ ok: true, accepted: true });
      }

      const checkpoint = await expect.poll(async () => observer.evaluate((eventKey: string) =>
        chrome.storage.local.get(eventKey).then((values) => values[eventKey]), EVENT_KEY), { timeout: 10_000 }).toMatchObject({ runId, point: scenario.point });
      expect(checkpoint).toBeUndefined();

      const [beforeValues, beforeStatus, beforeActivity] = await Promise.all([
        observer.evaluate((ledgerKey: string) => chrome.storage.local.get([ledgerKey, "token", "refreshToken"]), LEDGER_KEY),
        sendRuntimeRequestFromPage(observer, { type: "GET_CAPTURE_STATUS", draftId }),
        sendRuntimeRequestFromPage(observer, { type: "LIST_CAPTURE_ACTIVITY" })
      ]);
      if (!beforeStatus.ok || !beforeStatus.record) throw new Error("Queued capture status was unavailable before restart.");
      if (!beforeActivity.ok) throw new Error(beforeActivity.error);
      const before = {
        record: beforeStatus.record,
        draftPresent: beforeActivity.drafts.some((draft) => draft.id === draftId),
        ledger: beforeValues[LEDGER_KEY] as HarnessLedger,
        token: beforeValues.token,
        refreshToken: beforeValues.refreshToken
      };
      expect(before.record).toMatchObject({ status: scenario.beforeStatus, attemptCount: scenario.beforeAttempts });
      expect(before.draftPresent).toBe(false);
      expect(before.ledger.acceptedCreates).toBe(scenario.point === "remote_succeeded" ? 1 : 0);
      if (scenario.point === "oauth_refresh") {
        expect(before.token).toBe("access-old");
        expect(before.refreshToken).toBeUndefined();
        const refreshRequest = before.ledger.requests.find((request: LedgerRequest) => request.url.endsWith("/refresh"));
        expect(refreshRequest?.body).toMatchObject({ connection_handle: "handle-test" });
        expect(refreshRequest?.body?.timestamp).toMatch(/^\d+$/);
        expect(refreshRequest?.body?.nonce).toMatch(/^[A-Za-z0-9_-]+$/);
        expect(refreshRequest?.body?.signature).toMatch(/^[A-Za-z0-9_-]+$/);
        expect(refreshRequest?.body).not.toHaveProperty("refresh_token");
      }

      if (scenario.point === "enqueue_committed") {
        const interrupted = await enqueuePromise;
        expect(interrupted.portError || interrupted.acknowledgementTimedOut).toBeTruthy();
      }

      await context.close();
      context = await launchExtension(profile, extensionRoot);
      const restartedWorker = await serviceWorker(context);
      expect(new URL(restartedWorker.url()).host).toBe(extensionId);
      await waitForFailureHarness(restartedWorker);
      observer = await openControlPage(context, extensionId);

      await observer.evaluate((id: string) => chrome.runtime.sendMessage({ type: "GET_CAPTURE_STATUS", id }).catch(() => null), before.record.id);

      await expect.poll(async () => {
        const response = await sendRuntimeRequestFromPage(observer, { type: "GET_CAPTURE_STATUS", id: before.record.id });
        return response.ok ? response.record?.status || "" : "";
      }, { timeout: 10_000 }).toBe("delivered");

      const final = await expect.poll(async () => {
        const [valuesAndSurfaces, status] = await Promise.all([
          observer.evaluate(async ({ ledgerKey, alarmName }: { ledgerKey: string; alarmName: string }) => {
            const values = await chrome.storage.local.get([ledgerKey, "token", "refreshToken"]);
            const alarm = await chrome.alarms.get(alarmName);
            const badge = await chrome.action.getBadgeText({});
            return { values, alarm: alarm || null, badge };
          }, { ledgerKey: LEDGER_KEY, alarmName: DELIVERY_ALARM }),
          sendRuntimeRequestFromPage(observer, { type: "GET_CAPTURE_STATUS", id: before.record.id })
        ]);
        return {
          record: status.ok ? status.record : null,
          ledger: valuesAndSurfaces.values[LEDGER_KEY],
          token: valuesAndSurfaces.values.token,
          refreshToken: valuesAndSurfaces.values.refreshToken,
          alarm: valuesAndSurfaces.alarm,
          badge: valuesAndSurfaces.badge
        };
      }, { timeout: 10_000 }).toMatchObject({
        record: { status: "delivered", attemptCount: scenario.point === "enqueue_committed" ? 1 : 2, lastError: null },
        ledger: { acceptedCreates: 1, createAttempts: scenario.createAttempts },
        alarm: null,
        badge: ""
      });
      expect(final).toBeUndefined();

      const [finalStoredValues, finalStatus] = await Promise.all([
        observer.evaluate((ledgerKey: string) => chrome.storage.local.get([ledgerKey, "token", "refreshToken"]), LEDGER_KEY),
        sendRuntimeRequestFromPage(observer, { type: "GET_CAPTURE_STATUS", id: before.record.id })
      ]);
      if (!finalStatus.ok || !finalStatus.record) throw new Error("Delivered capture status was unavailable.");
      const finalRecord = finalStatus.record;
      if (finalRecord.status !== "delivered") throw new Error("Capture was not delivered.");
      if (!finalRecord.remote) throw new Error("Delivered capture was missing its remote target.");
      const finalLedger = finalStoredValues[LEDGER_KEY] as HarnessLedger;
      expect(finalRecord.remote.id).toBe(`remote-${before.record.id}`);
      expect(Object.keys(finalLedger.pages)).toEqual([before.record.id]);
      if (scenario.point === "remote_succeeded") expect(finalLedger.createAttempts).toBe(1);
      if (scenario.point === "oauth_refresh") {
        expect(finalStoredValues.token).toBe("access-new");
        expect(finalStoredValues.refreshToken).toBeUndefined();
        expect(finalLedger.refreshCompletions).toBe(1);
      }
    } finally {
      await context?.close().catch(() => undefined);
      await Promise.all([
        rm(profile, { recursive: true, force: true }),
        rm(extensionRoot, { recursive: true, force: true })
      ]);
    }
  });
}

for (const scenario of [
  { point: "malformed_database_success", destinationType: "database", expectedStatus: "uncertain" },
  { point: "malformed_page_success", destinationType: "page", expectedStatus: "uncertain" }
] as const satisfies readonly { point: HarnessPoint; destinationType: "database" | "page"; expectedStatus: string }[]) {
  test(`malformed ${scenario.destinationType} success does not mark delivered or mutate lastCapture`, async () => {
    test.setTimeout(30_000);
    const profile = await mkdtemp(path.join(tmpdir(), `notion-quick-note-${scenario.point}-profile-`));
    const extensionRoot = await mkdtemp(path.join(tmpdir(), `notion-quick-note-${scenario.point}-extension-`));
    let context: BrowserContext | undefined;
    try {
      await prepareFailureExtension(extensionRoot);
      context = await launchExtension(profile, extensionRoot);
      const worker = await serviceWorker(context);
      await waitForFailureHarness(worker);
      const extensionId = new URL(worker.url()).host;
      const page = await openControlPage(context, extensionId);
      const priorLastCapture = { savedAt: "2026-07-01T00:00:00.000Z", destinationName: "Earlier destination" };
      await page.evaluate(async ({ point, destinationType, priorLastCapture, harnessKey }: {
        point: HarnessPoint;
        destinationType: "database" | "page";
        priorLastCapture: { savedAt: string; destinationName: string };
        harnessKey: string;
      }) => {
        await chrome.storage.local.set({
          authType: "token",
          token: "access-token",
          connectionId: "connection-test",
          destinationConnectionId: "connection-test",
          destinationType,
          destinationId: destinationType === "database" ? "data-source-test" : "page-test",
          destinationName: "Malformed destination",
          destinationUrl: "https://notion.test/destination",
          titleProperty: "Name",
          managedDestination: false,
          lastCapture: priorLastCapture,
          [harnessKey]: { point, runId: `malformed-${destinationType}`, armed: false }
        });
        await chrome.runtime.sendMessage({ type: "GET_PENDING_COUNT" });
      }, { point: scenario.point, destinationType: scenario.destinationType, priorLastCapture, harnessKey: HARNESS_KEY });

      const captureContext: CaptureContext = {
        version: 1,
        title: "Malformed success",
        url: "https://example.test/malformed-success",
        selection: "",
        capturedAt: Date.now()
      };
      const accepted = await sendRuntimeRequestFromPage(page, {
        type: "ENQUEUE_CAPTURE",
        draftId: `draft-${scenario.point}`,
        context: captureContext,
        capture: {
          document: {
            version: 1,
            title: "Malformed response stays local",
            doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Keep this queued" }] }] }
          },
          includeSource: false
        }
      });
      expect(accepted).toMatchObject({ ok: true, accepted: true });
      if (!accepted.ok) throw new Error(accepted.error);

      const result = await expect.poll(async () => {
        const [status, values] = await Promise.all([
          sendRuntimeRequestFromPage(page, { type: "GET_CAPTURE_STATUS", id: accepted.record.id }),
          page.evaluate(() => chrome.storage.local.get("lastCapture"))
        ]);
        const lastCapture = values.lastCapture as Record<string, unknown> | undefined;
        return {
          status: status.ok ? status.record?.status || "" : "",
          remote: status.ok ? status.record?.remote || null : null,
          lastCapture,
          lastCaptureUnchanged: lastCapture?.savedAt === priorLastCapture.savedAt
            && lastCapture.destinationName === priorLastCapture.destinationName
            && Object.keys(lastCapture).length === 2
        };
      }, { timeout: 10_000 }).toMatchObject({
        status: scenario.expectedStatus,
        remote: null,
        lastCapture: priorLastCapture,
        lastCaptureUnchanged: true
      });
      expect(result).toBeUndefined();
    } finally {
      await context?.close().catch(() => undefined);
      await Promise.all([
        rm(profile, { recursive: true, force: true }),
        rm(extensionRoot, { recursive: true, force: true })
      ]);
    }
  });
}

test("blank drafts stay transient and adaptive previews disclose only as much body as each surface needs", async () => {
  test.setTimeout(60_000);
  const profile = await mkdtemp(path.join(tmpdir(), "notion-quick-note-previews-"));
  let context: BrowserContext | undefined;
  try {
    context = await launchExtension(profile);
    const worker = await serviceWorker(context);
    const extensionId = new URL(worker.url()).host;
    const page = await openActivityPage(context, extensionId);
    const captureContext: CaptureContext = { version: 1, title: "Preview source", url: "https://example.test/preview", selection: "", capturedAt: Date.now() };
    const draftResponse = await sendRuntimeRequestFromPage(page, {
      type: "GET_OR_CREATE_DRAFT",
      draftId: "preview-draft",
      tabId: 92,
      context: captureContext
    });
    if (!draftResponse.ok) throw new Error(draftResponse.error);
    const draft = draftResponse.draft;

    const transientActivity = await sendRuntimeRequestFromPage(page, { type: "LIST_CAPTURE_ACTIVITY" });
    if (!transientActivity.ok) throw new Error(transientActivity.error);
    expect(transientActivity.drafts).toHaveLength(0);
    await expect(page.locator(".draft-list")).toContainText("No local drafts");
    await expect(page.locator(".note-count")).toBeHidden();

    const titleOnly = await sendRuntimeRequestFromPage(page, {
      type: "UPSERT_DRAFT",
      expectedRevision: draft.revision,
      draft: { ...draft, title: "Title without body" }
    });
    expect(titleOnly).toMatchObject({ ok: true, draft: null, discarded: true });

    const paragraphs = Array.from({ length: 9 }, (_, index) => index === 8
      ? "Final paragraph marker confirms the complete draft is available after expansion."
      : `Paragraph ${index + 1} contains enough thoughtful note content to make the collapsed preview useful without crowding the Notes view.`);
    const doc: EditorNode = {
      type: "doc",
      content: paragraphs.map((text) => ({ type: "paragraph", content: [{ type: "text", text }] }))
    };
    const stored = await sendRuntimeRequestFromPage(page, {
      type: "UPSERT_DRAFT",
      expectedRevision: 0,
      draft: { ...draft, title: "Expandable draft", doc }
    });
    expect(stored.ok).toBe(true);

    const draftCard = page.locator(".draft-list .card");
    await expect(draftCard.locator(".card-title")).toHaveText("Expandable draft");
    await expect(draftCard.locator(".card-preview")).toContainText("Paragraph 1");
    await expect(draftCard.locator(".card-preview-toggle")).toBeVisible();
    await expect(draftCard.locator(".card-preview-toggle")).toHaveAttribute("aria-expanded", "false");
    await draftCard.locator(".card-preview-toggle").click();
    await expect(draftCard.locator(".card-preview-toggle")).toHaveAttribute("aria-expanded", "true");
    await expect(draftCard.locator(".card-preview")).toContainText("Final paragraph marker");

    const accepted = await sendRuntimeRequestFromPage(page, {
      type: "ENQUEUE_CAPTURE",
      draftId: draft.id,
      context: captureContext,
      capture: {
        document: { version: 1, title: "Expandable draft", doc },
        pageTitle: captureContext.title,
        url: captureContext.url,
        includeSource: true
      }
    });
    expect(accepted.ok).toBe(true);
    const queuePreview = page.locator(".queue-list .card-preview");
    await expect(queuePreview).toContainText("Paragraph 1");
    expect(await queuePreview.evaluate((element: HTMLElement) => Array.from(element.textContent ?? "").length)).toBeLessThanOrEqual(181);
    await expect(page.locator(".queue-list .card-preview-toggle")).toHaveCount(0);

    const untitled = await sendRuntimeRequestFromPage(page, {
      type: "GET_OR_CREATE_DRAFT",
      draftId: "untitled-draft",
      tabId: 92,
      context: captureContext
    });
    if (!untitled.ok) throw new Error(untitled.error);
    const untitledDoc: EditorNode = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Heading borrowed from the body" }] },
        { type: "paragraph", content: [{ type: "text", text: "Only this second paragraph belongs in the excerpt." }] }
      ]
    };
    const storedUntitled = await sendRuntimeRequestFromPage(page, {
      type: "UPSERT_DRAFT",
      expectedRevision: 0,
      draft: { ...untitled.draft, title: "", doc: untitledDoc }
    });
    if (!storedUntitled.ok) throw new Error(storedUntitled.error);
    const untitledCard = page.locator(".draft-list .card");
    await expect(untitledCard.locator(".card-title")).toHaveText("Heading borrowed from the body");
    await expect(untitledCard.locator(".card-preview")).toHaveText("Only this second paragraph belongs in the excerpt.");
  } finally {
    await context?.close().catch(() => undefined);
    await rm(profile, { recursive: true, force: true });
  }
});

function launchExtension(userDataDir: string, extensionRoot = repoRoot): Promise<BrowserContext> {
  return chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    headless: true,
    args: [
      `--disable-extensions-except=${extensionRoot}`,
      `--load-extension=${extensionRoot}`
    ]
  });
}

async function openControlPage(context: BrowserContext, extensionId: string): Promise<Page> {
  await new Promise((resolve) => setTimeout(resolve, 300));
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/control.html`);
  return page;
}

async function prepareFailureExtension(extensionRoot: string): Promise<void> {
  await buildExtension({ outdir: path.join(extensionRoot, "dist"), fixture: true });
  await Promise.all([
    copyFile(path.join(fixtureRoot, "mv3-control.html"), path.join(extensionRoot, "control.html")),
    copyFile(path.join(fixtureRoot, "mv3-manifest.json"), path.join(extensionRoot, "manifest.json"))
  ]);
}

async function serviceWorker(context: BrowserContext): Promise<Worker> {
  return context.serviceWorkers()[0] || context.waitForEvent("serviceworker");
}

async function waitForFailureHarness(worker: Worker): Promise<void> {
  await expect.poll(() => worker.evaluate(() => ({
    ready: globalThis.__mv3FailureHarnessReady,
    error: globalThis.__mv3FailureHarnessError || ""
  })), { timeout: 10_000, message: "MV3 failure harness did not finish loading" })
    .toEqual({ ready: true, error: "" });
}

async function openActivityPage(context: BrowserContext, extensionId: string): Promise<Page> {
  // A freshly loaded unpacked extension can open its install page just after
  // the worker starts. Let that one-time navigation settle before creating the
  // page used by the durability assertions.
  await new Promise((resolve) => setTimeout(resolve, 300));
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/sidepanel/index.html?view=activity`);
  return page;
}

async function sendRuntimeRequestFromPage<T extends RuntimeRequest>(page: Page, request: T): Promise<RuntimeResponse<T>> {
  const response: unknown = await page.evaluate((message: object) => chrome.runtime.sendMessage(message), request as object);
  if (!isRuntimeResponse(request, response)) {
    throw new Error(`MV3 harness received a malformed response for ${request.type}.`);
  }
  return response;
}
