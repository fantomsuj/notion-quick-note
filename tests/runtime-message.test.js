import assert from "node:assert/strict";
import test from "node:test";
import {
  enqueueWithReconciliation,
  RuntimeMessageTimeoutError,
  withRuntimeMessageDeadline
} from "../src/runtime-message.js";

test("runtime messages reject at the five-second deadline without waiting for the sender", async () => {
  let callback;
  const pending = new Promise((resolve) => { callback = resolve; });
  let scheduledDelay;
  await assert.rejects(
    withRuntimeMessageDeadline(pending, 5_000, {
      setTimer(fn, delay) {
        scheduledDelay = delay;
        fn();
        return 1;
      },
      clearTimer() {}
    }),
    (error) => error instanceof RuntimeMessageTimeoutError && error.code === "runtime_message_timeout"
  );
  assert.equal(scheduledDelay, 5_000);
  callback({ ok: true });
});

test("a timed-out enqueue reconciles by draft ID before exposing retry", async () => {
  const calls = [];
  const response = await enqueueWithReconciliation({
    draftId: "draft-1",
    message: { type: "ENQUEUE_CAPTURE", draftId: "draft-1" },
    async send(message) {
      calls.push(message);
      if (message.type === "ENQUEUE_CAPTURE") throw new RuntimeMessageTimeoutError();
      return { ok: true, record: { id: "capture-1", status: "sending" } };
    }
  });
  assert.deepEqual(calls.map((message) => message.type), ["ENQUEUE_CAPTURE", "GET_CAPTURE_STATUS"]);
  assert.deepEqual(response, {
    ok: true,
    accepted: true,
    record: { id: "capture-1", status: "sending" },
    reconciled: true
  });
});

test("a timed-out enqueue remains retryable only after reconciliation finds no capture", async () => {
  await assert.rejects(
    enqueueWithReconciliation({
      draftId: "draft-1",
      message: { type: "ENQUEUE_CAPTURE", draftId: "draft-1" },
      async send(message) {
        if (message.type === "ENQUEUE_CAPTURE") throw new RuntimeMessageTimeoutError();
        return { ok: true, record: null };
      }
    }),
    (error) => error.code === "runtime_message_timeout"
  );
});
