import { chromium, expect, test } from "@playwright/test";
import { copyFile, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fixtureRoot = path.join(repoRoot, "tests/fixtures");
const HARNESS_KEY = "mv3FailureHarnessV1";
const EVENT_KEY = "mv3FailureEventV1";
const LEDGER_KEY = "mv3FailureLedgerV1";
const DELIVERY_ALARM = "notion-quick-note-delivery";

// Each test owns a persistent Chrome profile and may stop its service worker.
// Keeping this file ordered avoids startup contention between MV3 contexts.
test.describe.configure({ mode: "default" });

test("real MV3 worker durably recovers a queued capture after termination and profile relaunch", async () => {
  test.setTimeout(60_000);
  const profile = await mkdtemp(path.join(tmpdir(), "notion-quick-note-mv3-"));
  let context;
  try {
    context = await launchExtension(profile);
    const worker = await serviceWorker(context);
    const extensionId = new URL(worker.url()).host;
    const page = await openActivityPage(context, extensionId);
    await expect(page.locator(".data-practices summary")).toHaveText("How your captures are handled");
    await page.locator(".data-practices summary").click();
    await expect(page.locator(".data-practices")).toContainText("until delivery succeeds or you delete them");
    await expect(page.locator(".data-practices")).toContainText("selected Notion workspace");

    const captureContext = { version: 1, title: "MV3 recovery test", url: "https://example.test/source", selection: "", capturedAt: Date.now() };
    const draftResponse = await page.evaluate((context) => chrome.runtime.sendMessage({
      type: "GET_OR_CREATE_DRAFT",
      tabId: 91,
      context
    }), captureContext);
    const draft = draftResponse.draft;
    await page.evaluate(({ draft, context }) => chrome.runtime.sendMessage({
        type: "UPSERT_DRAFT",
        draft: {
          ...draft,
          title: "Durable thought",
          doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Survive the worker" }] }] }
        }
      }), { draft, context: captureContext });
    await expect(page.locator(".drafts-group")).toContainText("Durable thought");
    await expect(page.locator(".drafts-group")).toContainText("Saved locally");
    await expect(page.locator(".note-count")).toHaveText("1");
    const accepted = await page.evaluate(({ draftId, context }) => chrome.runtime.sendMessage({
        type: "ENQUEUE_CAPTURE",
        draftId,
        context,
        capture: {
          document: { version: 1, title: "Durable thought", doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Survive the worker" }] }] } },
          pageTitle: context.title,
          url: context.url,
          includeSource: true
        }
      }), { draftId: draft.id, context: captureContext });
    if (!accepted.ok || !accepted.accepted) throw new Error(accepted.error || "Capture was not accepted.");
    const queuedId = accepted.record.id;
    const reconciledByDraft = await page.evaluate((draftId) => chrome.runtime.sendMessage({
      type: "GET_CAPTURE_STATUS",
      draftId
    }), draft.id);
    expect(reconciledByDraft.record.id).toBe(queuedId);

    const persistedBeforeRestart = await page.evaluate(async (id) => {
      const status = await chrome.runtime.sendMessage({ type: "GET_CAPTURE_STATUS", id });
      const diagnostics = await chrome.runtime.sendMessage({ type: "GET_STORAGE_DIAGNOSTICS" });
      return { status: status.record?.status || "", backend: diagnostics.diagnostics?.backend || "" };
    }, queuedId);
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

    const recoveredInProcess = await page.evaluate(async (id) => {
      const activity = await chrome.runtime.sendMessage({ type: "LIST_CAPTURE_ACTIVITY" });
      return activity.queued.find((record) => record.id === id)?.status || "";
    }, queuedId);
    expect(recoveredInProcess).toBe("blocked_setup");

    await context.close();
    context = await launchExtension(profile);
    const relaunchedWorker = await serviceWorker(context);
    expect(new URL(relaunchedWorker.url()).host).toBe(extensionId);
    const relaunchedPage = await openActivityPage(context, extensionId);
    const recoveredAfterRelaunch = await relaunchedPage.evaluate(async (id) => {
      const activity = await chrome.runtime.sendMessage({ type: "LIST_CAPTURE_ACTIVITY" });
      return activity.queued.some((record) => record.id === id && record.status === "blocked_setup");
    }, queuedId);
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
];

for (const scenario of terminationCases) {
  test(`real MV3 worker recovers ${scenario.label}`, async () => {
    test.setTimeout(60_000);
    const profile = await mkdtemp(path.join(tmpdir(), `notion-quick-note-${scenario.point}-profile-`));
    const extensionRoot = await mkdtemp(path.join(tmpdir(), `notion-quick-note-${scenario.point}-extension-`));
    let context;
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

      await page.evaluate(async ({ harnessKey, eventKey, ledgerKey, point, runId }) => {
        await chrome.storage.local.set({
          authType: "oauth",
          token: "access-old",
          refreshToken: "refresh-old",
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

      const captureContext = {
        version: 1,
        title: `MV3 ${scenario.point}`,
        url: `https://example.test/${scenario.point}`,
        selection: "",
        capturedAt: Date.now()
      };
      const draftResponse = await page.evaluate(({ draftId, captureContext }) => chrome.runtime.sendMessage({
        type: "GET_OR_CREATE_DRAFT",
        draftId,
        tabId: 101,
        context: captureContext
      }), { draftId, captureContext });
      const draft = draftResponse.draft;
      const doc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: `Survive ${scenario.point}` }] }] };
      const storedDraft = await page.evaluate(({ draft, doc }) => chrome.runtime.sendMessage({
        type: "UPSERT_DRAFT",
        draft: { ...draft, title: "Durable matrix capture", doc }
      }), { draft, doc });
      expect(storedDraft.ok).toBe(true);

      await page.evaluate(({ harnessKey, point, runId }) => chrome.storage.local.set({
        [harnessKey]: { point, runId, armed: true }
      }), { harnessKey: HARNESS_KEY, point: scenario.point, runId });

      const enqueuePromise = page.evaluate(({ draftId, captureContext, doc }) => Promise.race([
        chrome.runtime.sendMessage({
          type: "ENQUEUE_CAPTURE",
          draftId,
          context: captureContext,
          capture: {
            document: { version: 1, title: "Durable matrix capture", doc },
            pageTitle: captureContext.title,
            url: captureContext.url,
            includeSource: true
          }
        }).then((response) => ({ response }), (error) => ({ portError: error.message })),
        new Promise((resolve) => setTimeout(() => resolve({ acknowledgementTimedOut: true }), 1_000))
      ]), { draftId, captureContext, doc });

      if (scenario.point !== "enqueue_committed") {
        const accepted = await enqueuePromise;
        expect(accepted.response).toMatchObject({ ok: true, accepted: true });
      }

      const checkpoint = await expect.poll(async () => observer.evaluate((eventKey) =>
        chrome.storage.local.get(eventKey).then((values) => values[eventKey]), EVENT_KEY), { timeout: 10_000 }).toMatchObject({ runId, point: scenario.point });
      expect(checkpoint).toBeUndefined();

      const before = await observer.evaluate(async ({ draftId, ledgerKey }) => {
        const [values, status, activity] = await Promise.all([
          chrome.storage.local.get([ledgerKey, "token", "refreshToken"]),
          chrome.runtime.sendMessage({ type: "GET_CAPTURE_STATUS", draftId }),
          chrome.runtime.sendMessage({ type: "LIST_CAPTURE_ACTIVITY" })
        ]);
        return {
          record: status.record,
          draftPresent: activity.drafts.some((draft) => draft.id === draftId),
          ledger: values[ledgerKey],
          token: values.token,
          refreshToken: values.refreshToken
        };
      }, { draftId, ledgerKey: LEDGER_KEY });
      expect(before.record).toMatchObject({ status: scenario.beforeStatus, attemptCount: scenario.beforeAttempts });
      expect(before.draftPresent).toBe(false);
      expect(before.ledger.acceptedCreates).toBe(scenario.point === "remote_succeeded" ? 1 : 0);
      if (scenario.point === "oauth_refresh") {
        expect(before.token).toBe("access-old");
        expect(before.refreshToken).toBe("refresh-old");
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

      await observer.evaluate((id) => chrome.runtime.sendMessage({ type: "GET_CAPTURE_STATUS", id }).catch(() => null), before.record.id);

      await expect.poll(async () => observer.evaluate((id) => chrome.runtime.sendMessage({ type: "GET_CAPTURE_STATUS", id })
        .then((response) => response.record?.status || ""), before.record.id), { timeout: 10_000 }).toBe("delivered");

      const final = await expect.poll(async () => observer.evaluate(async ({ id, ledgerKey, alarmName }) => {
        const [values, status] = await Promise.all([
          chrome.storage.local.get([ledgerKey, "token", "refreshToken"]),
          chrome.runtime.sendMessage({ type: "GET_CAPTURE_STATUS", id })
        ]);
        const alarm = await chrome.alarms.get(alarmName);
        const badge = await chrome.action.getBadgeText({});
        return {
          record: status.record,
          ledger: values[ledgerKey],
          token: values.token,
          refreshToken: values.refreshToken,
          alarm: alarm || null,
          badge
        };
      }, { id: before.record.id, ledgerKey: LEDGER_KEY, alarmName: DELIVERY_ALARM }), { timeout: 10_000 }).toMatchObject({
        record: { status: "delivered", attemptCount: scenario.point === "enqueue_committed" ? 1 : 2, lastError: null },
        ledger: { acceptedCreates: 1, createAttempts: scenario.createAttempts },
        alarm: null,
        badge: ""
      });
      expect(final).toBeUndefined();

      const finalValues = await observer.evaluate(async ({ ledgerKey, id }) => ({
        ...await chrome.storage.local.get([ledgerKey, "token", "refreshToken"]),
        record: (await chrome.runtime.sendMessage({ type: "GET_CAPTURE_STATUS", id })).record
      }), { ledgerKey: LEDGER_KEY, id: before.record.id });
      const finalRecord = finalValues.record;
      expect(finalRecord.remote.id).toBe(`remote-${before.record.id}`);
      expect(Object.keys(finalValues[LEDGER_KEY].pages)).toEqual([before.record.id]);
      if (scenario.point === "remote_succeeded") expect(finalValues[LEDGER_KEY].createAttempts).toBe(1);
      if (scenario.point === "oauth_refresh") {
        expect(finalValues.token).toBe("access-new");
        expect(finalValues.refreshToken).toBe("refresh-new");
        expect(finalValues[LEDGER_KEY].refreshCompletions).toBe(1);
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

test("blank drafts stay transient and adaptive previews disclose only as much body as each surface needs", async () => {
  test.setTimeout(60_000);
  const profile = await mkdtemp(path.join(tmpdir(), "notion-quick-note-previews-"));
  let context;
  try {
    context = await launchExtension(profile);
    const worker = await serviceWorker(context);
    const extensionId = new URL(worker.url()).host;
    const page = await openActivityPage(context, extensionId);
    const captureContext = { version: 1, title: "Preview source", url: "https://example.test/preview", selection: "", capturedAt: Date.now() };
    const draftResponse = await page.evaluate((captureContext) => chrome.runtime.sendMessage({
      type: "GET_OR_CREATE_DRAFT",
      draftId: "preview-draft",
      tabId: 92,
      context: captureContext
    }), captureContext);
    const draft = draftResponse.draft;

    const transientActivity = await page.evaluate(() => chrome.runtime.sendMessage({ type: "LIST_CAPTURE_ACTIVITY" }));
    expect(transientActivity.drafts).toHaveLength(0);
    await expect(page.locator(".draft-list")).toContainText("No local drafts");
    await expect(page.locator(".note-count")).toBeHidden();

    const titleOnly = await page.evaluate((draft) => chrome.runtime.sendMessage({
      type: "UPSERT_DRAFT",
      expectedRevision: draft.revision,
      draft: { ...draft, title: "Title without body" }
    }), draft);
    expect(titleOnly).toMatchObject({ ok: true, draft: null, discarded: true });

    const paragraphs = Array.from({ length: 9 }, (_, index) => index === 8
      ? "Final paragraph marker confirms the complete draft is available after expansion."
      : `Paragraph ${index + 1} contains enough thoughtful note content to make the collapsed preview useful without crowding the Notes view.`);
    const doc = {
      type: "doc",
      content: paragraphs.map((text) => ({ type: "paragraph", content: [{ type: "text", text }] }))
    };
    const stored = await page.evaluate(({ draft, doc }) => chrome.runtime.sendMessage({
      type: "UPSERT_DRAFT",
      expectedRevision: 0,
      draft: { ...draft, title: "Expandable draft", doc }
    }), { draft, doc });
    expect(stored.ok).toBe(true);

    const draftCard = page.locator(".draft-list .card");
    await expect(draftCard.locator(".card-title")).toHaveText("Expandable draft");
    await expect(draftCard.locator(".card-preview")).toContainText("Paragraph 1");
    await expect(draftCard.locator(".card-preview-toggle")).toBeVisible();
    await expect(draftCard.locator(".card-preview-toggle")).toHaveAttribute("aria-expanded", "false");
    await draftCard.locator(".card-preview-toggle").click();
    await expect(draftCard.locator(".card-preview-toggle")).toHaveAttribute("aria-expanded", "true");
    await expect(draftCard.locator(".card-preview")).toContainText("Final paragraph marker");

    const accepted = await page.evaluate(({ draftId, captureContext, doc }) => chrome.runtime.sendMessage({
      type: "ENQUEUE_CAPTURE",
      draftId,
      context: captureContext,
      capture: {
        document: { version: 1, title: "Expandable draft", doc },
        pageTitle: captureContext.title,
        url: captureContext.url,
        includeSource: true
      }
    }), { draftId: draft.id, captureContext, doc });
    expect(accepted.ok).toBe(true);
    const queuePreview = page.locator(".queue-list .card-preview");
    await expect(queuePreview).toContainText("Paragraph 1");
    expect(await queuePreview.evaluate((element) => Array.from(element.textContent).length)).toBeLessThanOrEqual(181);
    await expect(page.locator(".queue-list .card-preview-toggle")).toHaveCount(0);

    const untitled = await page.evaluate((captureContext) => chrome.runtime.sendMessage({
      type: "GET_OR_CREATE_DRAFT",
      draftId: "untitled-draft",
      tabId: 92,
      context: captureContext
    }), captureContext);
    const untitledDoc = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Heading borrowed from the body" }] },
        { type: "paragraph", content: [{ type: "text", text: "Only this second paragraph belongs in the excerpt." }] }
      ]
    };
    await page.evaluate(({ draft, doc }) => chrome.runtime.sendMessage({
      type: "UPSERT_DRAFT",
      expectedRevision: 0,
      draft: { ...draft, title: "", doc }
    }), { draft: untitled.draft, doc: untitledDoc });
    const untitledCard = page.locator(".draft-list .card");
    await expect(untitledCard.locator(".card-title")).toHaveText("Heading borrowed from the body");
    await expect(untitledCard.locator(".card-preview")).toHaveText("Only this second paragraph belongs in the excerpt.");
  } finally {
    await context?.close().catch(() => undefined);
    await rm(profile, { recursive: true, force: true });
  }
});

function launchExtension(userDataDir, extensionRoot = repoRoot) {
  return chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    headless: true,
    args: [
      `--disable-extensions-except=${extensionRoot}`,
      `--load-extension=${extensionRoot}`
    ]
  });
}

async function openControlPage(context, extensionId) {
  await new Promise((resolve) => setTimeout(resolve, 300));
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/control.html`);
  return page;
}

async function prepareFailureExtension(extensionRoot) {
  await cp(path.join(repoRoot, "src"), path.join(extensionRoot, "src"), { recursive: true });
  const [harness, background, recordRepository] = await Promise.all([
    readFile(path.join(fixtureRoot, "mv3-worker-harness.js"), "utf8"),
    readFile(path.join(repoRoot, "src/background.js"), "utf8"),
    readFile(path.join(repoRoot, "src/capture-record-repository.js"), "utf8")
  ]);
  await writeFile(
    path.join(extensionRoot, "src/background.js"),
    `${harness}\n${background}\nglobalThis.__mv3FailureHarnessReady = true;\n`
  );
  const checkpointedRepository = recordRepository.replace(
    "    const event = { kind, ...detail };\n    await Promise.resolve(changeHandler(event)).catch(() => undefined);",
    "    const event = { kind, ...detail };\n    await Promise.resolve(globalThis.__notionQuickNoteCaptureCheckpoint?.(event));\n    await Promise.resolve(changeHandler(event)).catch(() => undefined);"
  );
  if (checkpointedRepository === recordRepository) throw new Error("Could not install the MV3 repository checkpoint fixture.");
  await writeFile(path.join(extensionRoot, "src/capture-record-repository.js"), checkpointedRepository);
  await Promise.all([
    copyFile(path.join(fixtureRoot, "mv3-control.html"), path.join(extensionRoot, "control.html")),
    copyFile(path.join(fixtureRoot, "mv3-manifest.json"), path.join(extensionRoot, "manifest.json"))
  ]);
}

async function serviceWorker(context) {
  return context.serviceWorkers()[0] || context.waitForEvent("serviceworker");
}

async function waitForFailureHarness(worker) {
  await expect.poll(() => worker.evaluate(() => ({
    ready: globalThis.__mv3FailureHarnessReady,
    error: globalThis.__mv3FailureHarnessError || ""
  })), { timeout: 10_000, message: "MV3 failure harness did not finish loading" })
    .toEqual({ ready: true, error: "" });
}

async function openActivityPage(context, extensionId) {
  // A freshly loaded unpacked extension can open its install page just after
  // the worker starts. Let that one-time navigation settle before creating the
  // page used by the durability assertions.
  await new Promise((resolve) => setTimeout(resolve, 300));
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/sidepanel/index.html?view=activity`);
  return page;
}
