import assert from "node:assert/strict";
import test from "node:test";
import {
  clearTerminalDraft,
  composerNavigationForDraft,
  preparePanelDraft,
  routeShowComposer,
  shouldPublishExplicitContext,
  shouldRegisterPanel
} from "../src/panel-lifecycle.js";

test("Activity resume produces an explicit composer navigation that can activate the draft", () => {
  assert.deepEqual(composerNavigationForDraft({ id: "resume-me", tabId: 12 }), {
    type: "SHOW_COMPOSER",
    draftId: "resume-me",
    tabId: 12
  });
  assert.deepEqual(composerNavigationForDraft({ id: "detached", tabId: null }), {
    type: "SHOW_COMPOSER",
    draftId: "detached"
  });
});

test("only the true global side panel registers its window port", () => {
  assert.equal(shouldRegisterPanel(new URLSearchParams()), true);
  assert.equal(shouldRegisterPanel(new URLSearchParams("view=compose")), false);
  assert.equal(shouldRegisterPanel(new URLSearchParams("view=activity&draft=saved")), false);
});

test("a connected panel without an active repository draft creates a fresh draft", async () => {
  const calls: string[] = [];
  const draft = await preparePanelDraft({
    connected: true,
    async getActiveDraft() {
      calls.push("active");
      return null;
    },
    async createDraft() {
      calls.push("create");
      return { id: "fresh" };
    }
  });

  assert.deepEqual(calls, ["active", "create"]);
  assert.deepEqual(draft, { id: "fresh" });
});

test("explicit selection context is published only when reusing a mounted active draft", () => {
  assert.equal(shouldPublishExplicitContext("Selected text", true), true);
  assert.equal(shouldPublishExplicitContext("Selected text", false), false);
  assert.equal(shouldPublishExplicitContext("", true), false);
});

test("an explicit same-draft command reopens the active composer without fetching", async () => {
  const activeDraft = { id: "active" };
  const calls: string[] = [];
  const result = await routeShowComposer({
    activeDraft,
    message: { type: "SHOW_COMPOSER", draftId: "active" },
    async loadDraft() {
      calls.push("load");
      return { id: "loaded" };
    },
    async openDraft(draft) {
      calls.push(`open:${draft.id}`);
    }
  });

  assert.deepEqual(calls, ["open:active"]);
  assert.equal(result, activeDraft);
});

test("a command without a draft id fetches even when an active draft is known", async () => {
  const calls: string[] = [];
  const loadedDraft = { id: "fresh" };
  const result = await routeShowComposer({
    activeDraft: { id: "active" },
    message: { type: "SHOW_COMPOSER" },
    async loadDraft() {
      calls.push("load");
      return loadedDraft;
    },
    async openDraft(draft) {
      calls.push(`open:${draft.id}`);
    }
  });

  assert.deepEqual(calls, ["load", "open:fresh"]);
  assert.equal(result, loadedDraft);
});

test("a failed in-place draft open rejects without replacing the caller's active draft", async () => {
  const oldDraft = { id: "old" };
  let activeDraft = oldDraft;

  await assert.rejects(async () => {
    activeDraft = await routeShowComposer({
      activeDraft,
      message: { type: "SHOW_COMPOSER", draftId: "new" },
      async loadDraft() {
        return { id: "new" };
      },
      async openDraft() {
        throw new Error("old draft persist failed");
      }
    });
  }, /old draft persist failed/);

  assert.equal(activeDraft, oldDraft);
});

test("activation failure refreshes the previously active draft before restoring it", async () => {
  const staleActive = { id: "old", revision: 1 };
  const freshActive = { id: "old", revision: 4 };
  let restored: typeof staleActive | null = null;

  await assert.rejects(routeShowComposer({
    activeDraft: staleActive,
    message: { type: "SHOW_COMPOSER", draftId: "new" },
    async loadDraft() { return { id: "new", revision: 2 }; },
    async openDraft() {},
    async activateDraft() { throw new Error("activation failed"); },
    async refreshDraft(draft) {
      assert.equal(draft, staleActive);
      return freshActive;
    },
    async restoreDraft(draft) { restored = draft; }
  }), /activation failed/);

  assert.equal(restored, freshActive);
});

test("identity-sync failure restores the revision returned by rollback activation", async () => {
  const active = { id: "old", revision: 2 };
  const target = { id: "new", revision: 3 };
  const reactivated = { id: "old", revision: 7 };
  let restored: typeof active | null = null;

  await assert.rejects(routeShowComposer({
    activeDraft: active,
    message: { type: "SHOW_COMPOSER", draftId: target.id },
    async loadDraft() { return target; },
    async openDraft() {},
    async activateDraft(draft) { return draft.id === target.id ? target : reactivated; },
    async syncDraft() { throw new Error("identity sync failed"); },
    async restoreDraft(draft) { restored = draft; }
  }), /identity sync failed/);

  assert.equal(restored, reactivated);
});

test("a terminal composer event clears only the matching cached panel draft", () => {
  const activeDraft = { id: "active" };

  assert.equal(clearTerminalDraft(activeDraft, { draftId: "active", reason: "saved" }), null);
  assert.equal(clearTerminalDraft(activeDraft, { draftId: "other", reason: "discarded" }), activeDraft);
});
