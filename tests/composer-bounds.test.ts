import assert from "node:assert/strict";
import test from "node:test";
import {
  clampComposerBounds,
  defaultComposerBounds,
  normalizeStoredComposerBounds,
  validateComposerBounds
} from "../src/composer-bounds.js";

test("validates only complete, finite stored composer bounds", () => {
  assert.deepEqual(validateComposerBounds({ left: 42, top: 64, width: 390, height: 520 }), {
    left: 42,
    top: 64,
    width: 390,
    height: 520
  });

  for (const value of [
    null,
    [],
    { left: 1, top: 2, width: 3 },
    { left: "1", top: 2, width: 3, height: 4 },
    { left: 1, top: 2, width: Number.NaN, height: 4 },
    { left: 1, top: 2, width: 0, height: 4 },
    { left: 1, top: 2, width: 4, height: -1 }
  ]) {
    assert.equal(validateComposerBounds(value), null);
  }
});

test("uses the current bottom-right composer size and placement by default", () => {
  assert.deepEqual(defaultComposerBounds({ width: 1440, height: 900 }), {
    left: 1034,
    top: 569,
    width: 390,
    height: 315
  });
});

test("clamps dimensions and position fully within the 16px viewport margin", () => {
  assert.deepEqual(
    clampComposerBounds({ left: -100, top: 900, width: 900, height: 900 }, { width: 800, height: 600 }),
    { left: 16, top: 16, width: 720, height: 568 }
  );

  assert.deepEqual(
    clampComposerBounds({ left: 999, top: 999, width: 320, height: 260 }, { width: 800, height: 600 }),
    { left: 464, top: 324, width: 320, height: 260 }
  );
});

test("reduces effective bounds on narrow or short viewports while retaining the margin", () => {
  assert.deepEqual(defaultComposerBounds({ width: 300, height: 240 }), {
    left: 16,
    top: 16,
    width: 268,
    height: 208
  });

  assert.deepEqual(
    clampComposerBounds({ left: 100, top: 100, width: 320, height: 260 }, { width: 300, height: 240 }),
    { left: 16, top: 16, width: 268, height: 208 }
  );
});

test("recovers valid stored geometry by clamping stale viewport values and rejects invalid values", () => {
  assert.deepEqual(
    normalizeStoredComposerBounds({ left: 900, top: 700, width: 390, height: 520 }, { width: 640, height: 480 }),
    { left: 234, top: 16, width: 390, height: 448 }
  );
  assert.equal(normalizeStoredComposerBounds({ left: 10, top: 10, width: "390", height: 520 }, { width: 640, height: 480 }), null);
});
