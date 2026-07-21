import assert from "node:assert/strict";
import test from "node:test";
import { createSerializedOperationQueue } from "../src/serialized-operation-queue.js";

test("serializes concurrent composer-surface transitions and continues after a failure", async () => {
  const enqueue = createSerializedOperationQueue();
  const events: string[] = [];
  let releaseFirst: (() => void) | undefined;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });

  const first = enqueue(async () => {
    events.push("first:start");
    await firstGate;
    events.push("first:end");
  });
  const second = enqueue(async () => {
    events.push("second:start");
    events.push("second:end");
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["first:start"]);
  releaseFirst?.();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["first:start", "first:end", "second:start", "second:end"]);

  await assert.rejects(enqueue(async () => { throw new Error("expected"); }), /expected/);
  await enqueue(async () => { events.push("after-failure"); });
  assert.equal(events.at(-1), "after-failure");
});
