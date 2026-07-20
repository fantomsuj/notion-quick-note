import assert from "node:assert/strict";
import test from "node:test";
import type { WorkerToPanelMessage } from "../src/contracts.js";
import { isPanelRegistrationMessage } from "../src/contracts.js";
import { createPanelCoordinator, type PanelPort } from "../src/panel-coordinator.js";

function recordingPort(): PanelPort & { messages: WorkerToPanelMessage[] } {
  const messages: WorkerToPanelMessage[] = [];
  return {
    messages,
    postMessage(message) {
      messages.push(message);
    }
  };
}

test("registration guard accepts only non-negative integer window IDs", () => {
  assert.equal(isPanelRegistrationMessage({ type: "REGISTER_PANEL", windowId: 0 }), true);
  assert.equal(isPanelRegistrationMessage({ type: "REGISTER_PANEL", windowId: 42 }), true);
  assert.equal(isPanelRegistrationMessage({ type: "REGISTER_PANEL", windowId: -1 }), false);
  assert.equal(isPanelRegistrationMessage({ type: "REGISTER_PANEL", windowId: 1.5 }), false);
  assert.equal(isPanelRegistrationMessage({ type: "REGISTER_PANEL", windowId: Number.NaN }), false);
  assert.equal(isPanelRegistrationMessage({ type: "REGISTER_PANEL", windowId: "1" }), false);
  assert.equal(isPanelRegistrationMessage({ type: "SHOW_ACTIVITY", windowId: 1 }), false);
  assert.equal(isPanelRegistrationMessage(null), false);
});

test("keeps one current port per window and exposes registration through has", () => {
  const coordinator = createPanelCoordinator();
  const first = recordingPort();
  const replacement = recordingPort();

  assert.equal(coordinator.has(7), false);
  coordinator.register(7, first);
  assert.equal(coordinator.has(7), true);
  coordinator.register(7, replacement);
  coordinator.navigate(7, { type: "SHOW_ACTIVITY" });

  assert.deepEqual(first.messages, []);
  assert.deepEqual(replacement.messages, [{ type: "SHOW_ACTIVITY" }]);
});

test("queues only the latest navigation and flushes it exactly once on registration", () => {
  const coordinator = createPanelCoordinator();
  const port = recordingPort();

  coordinator.navigate(2, { type: "SHOW_COMPOSER", draftId: "older" });
  coordinator.navigate(2, { type: "SHOW_COMPOSER", draftId: "latest", tabId: 9 });
  coordinator.register(2, port);
  coordinator.unregister(2, port);
  coordinator.register(2, port);

  assert.deepEqual(port.messages, [
    { type: "SHOW_COMPOSER", draftId: "latest", tabId: 9 }
  ]);
});

test("delivers navigation immediately to a registered port", () => {
  const coordinator = createPanelCoordinator();
  const port = recordingPort();
  coordinator.register(3, port);

  coordinator.navigate(3, { type: "SHOW_COMPOSER", tabId: 11 });
  coordinator.navigate(3, { type: "SHOW_ACTIVITY" });

  assert.deepEqual(port.messages, [
    { type: "SHOW_COMPOSER", tabId: 11 },
    { type: "SHOW_ACTIVITY" }
  ]);
});

test("delivers context only to a current port and never queues it", () => {
  const coordinator = createPanelCoordinator();
  const port = recordingPort();
  const page = {
    version: 1 as const,
    title: "Example",
    url: "https://example.com",
    selection: "Selected",
    capturedAt: 123
  };

  coordinator.publishContext(4, { type: "ACTIVE_PAGE_CONTEXT", tabId: 12, page });
  coordinator.register(4, port);
  assert.deepEqual(port.messages, []);

  coordinator.publishContext(4, { type: "ACTIVE_PAGE_CONTEXT", tabId: 13, page });
  assert.deepEqual(port.messages, [
    { type: "ACTIVE_PAGE_CONTEXT", tabId: 13, page }
  ]);
});

test("a failed navigation unregisters the throwing port and queues the command", () => {
  const coordinator = createPanelCoordinator();
  const throwingPort: PanelPort = {
    postMessage() {
      throw new Error("disconnected");
    }
  };
  const replacement = recordingPort();
  coordinator.register(5, throwingPort);

  assert.doesNotThrow(() => {
    coordinator.navigate(5, { type: "SHOW_COMPOSER", draftId: "retry-me" });
  });
  assert.equal(coordinator.has(5), false);
  coordinator.register(5, replacement);

  assert.deepEqual(replacement.messages, [
    { type: "SHOW_COMPOSER", draftId: "retry-me" }
  ]);
});

test("a failed queued-navigation flush remains queued for the next port", () => {
  const coordinator = createPanelCoordinator();
  const throwingPort: PanelPort = {
    postMessage() {
      throw new Error("disconnected during flush");
    }
  };
  const replacement = recordingPort();
  coordinator.navigate(6, { type: "SHOW_ACTIVITY" });

  assert.doesNotThrow(() => coordinator.register(6, throwingPort));
  assert.equal(coordinator.has(6), false);
  coordinator.register(6, replacement);

  assert.deepEqual(replacement.messages, [{ type: "SHOW_ACTIVITY" }]);
});

test("a failed context send unregisters the throwing port and drops the context", () => {
  const coordinator = createPanelCoordinator();
  const throwingPort: PanelPort = {
    postMessage() {
      throw new Error("disconnected");
    }
  };
  const replacement = recordingPort();
  const message = {
    type: "ACTIVE_PAGE_CONTEXT" as const,
    tabId: 14,
    page: {
      version: 1 as const,
      title: "Example",
      url: "https://example.com",
      selection: "",
      capturedAt: 456
    }
  };
  coordinator.register(8, throwingPort);

  assert.doesNotThrow(() => coordinator.publishContext(8, message));
  assert.equal(coordinator.has(8), false);
  coordinator.register(8, replacement);

  assert.deepEqual(replacement.messages, []);
});

test("unregistering a stale replaced port preserves the current port", () => {
  const coordinator = createPanelCoordinator();
  const stale = recordingPort();
  const current = recordingPort();
  coordinator.register(9, stale);
  coordinator.register(9, current);

  coordinator.unregister(9, stale);
  assert.equal(coordinator.has(9), true);
  coordinator.navigate(9, { type: "SHOW_ACTIVITY" });

  assert.deepEqual(current.messages, [{ type: "SHOW_ACTIVITY" }]);
});
