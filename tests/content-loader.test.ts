// @ts-nocheck
import assert from "node:assert/strict";
import test from "node:test";
import {
  createContentRuntimeLoader,
  QUICK_NOTE_BUNDLE,
  QUICK_NOTE_PROTOCOL
} from "../src/content-loader.js";

function loaderFixture(responses = [], holdInjection = false) {
  const calls = { messages: [], scripts: [] };
  let index = 0;
  let releaseInjection;
  const injectionGate = new Promise((resolve) => { releaseInjection = resolve; });
  const ensure = createContentRuntimeLoader({
    tabs: {
      async sendMessage(tabId, message) {
        calls.messages.push({ tabId, message });
        const response = responses[Math.min(index, responses.length - 1)];
        index += 1;
        if (response instanceof Error) throw response;
        return response;
      }
    },
    scripting: {
      async executeScript(options) {
        calls.scripts.push(options);
        if (holdInjection) await injectionGate;
      }
    }
  });
  return { calls, ensure, releaseInjection };
}

test("uses a compatible content runtime without injecting", async () => {
  const fixture = loaderFixture([{ ready: true, protocol: QUICK_NOTE_PROTOCOL }]);
  await fixture.ensure(17);
  assert.equal(fixture.calls.scripts.length, 0);
  assert.deepEqual(fixture.calls.messages[0], {
    tabId: 17,
    message: { type: "QUICK_NOTE_PING", protocol: QUICK_NOTE_PROTOCOL }
  });
});

test("recovers a missing receiver by injecting and verifying the bundle", async () => {
  const fixture = loaderFixture([
    new Error("Could not establish connection. Receiving end does not exist."),
    new Error("Could not establish connection. Receiving end does not exist."),
    { ready: true, protocol: QUICK_NOTE_PROTOCOL }
  ]);
  await fixture.ensure(23);
  assert.deepEqual(fixture.calls.scripts, [{ target: { tabId: 23 }, files: [QUICK_NOTE_BUNDLE] }]);
  assert.equal(fixture.calls.messages.length, 3);
});

test("replaces a protocol-incompatible runtime", async () => {
  const fixture = loaderFixture([
    { ready: true, protocol: QUICK_NOTE_PROTOCOL + 1 },
    { ready: true, protocol: QUICK_NOTE_PROTOCOL + 1 },
    { ready: true, protocol: QUICK_NOTE_PROTOCOL }
  ]);
  await fixture.ensure(29);
  assert.equal(fixture.calls.scripts.length, 1);
});

test("coalesces concurrent installation attempts for one tab", async () => {
  const fixture = loaderFixture([
    new Error("missing"),
    new Error("missing"),
    new Error("missing"),
    { ready: true, protocol: QUICK_NOTE_PROTOCOL }
  ], true);
  const first = fixture.ensure(31);
  const second = fixture.ensure(31);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.calls.scripts.length, 1);
  fixture.releaseInjection();
  await Promise.all([first, second]);
  assert.equal(fixture.calls.scripts.length, 1);
});
