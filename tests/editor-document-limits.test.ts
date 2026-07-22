import assert from "node:assert/strict";
import test from "node:test";
import { LIST_DEPTH_LIMIT_MESSAGE, MAX_LIST_LEVELS } from "../src/constants.js";
import { assertSupportedListDepth, maximumListDepth } from "../src/editor-document-limits.js";
import type { EditorNode } from "../src/contracts.js";

const itemType = (listType: string): string => listType === "taskList" ? "taskItem" : "listItem";

function nestedList(types: string[]): EditorNode {
  const [type, ...rest] = types;
  if (!type) return { type: "paragraph", content: [{ type: "text", text: "leaf" }] };
  return {
    type,
    content: [{
      type: itemType(type),
      attrs: type === "taskList" ? { checked: false } : {},
      content: [
        { type: "paragraph", content: [{ type: "text", text: type }] },
        ...(rest.length ? [nestedList(rest)] : [])
      ]
    }]
  };
}

for (const type of ["bulletList", "orderedList", "taskList"]) {
  test(`${type} accepts level 10 and rejects level 11`, () => {
    const ten = { type: "doc", content: [nestedList(Array(10).fill(type))] };
    const eleven = { type: "doc", content: [nestedList(Array(11).fill(type))] };
    assert.equal(maximumListDepth(ten), MAX_LIST_LEVELS);
    assert.doesNotThrow(() => assertSupportedListDepth(ten));
    assert.throws(() => assertSupportedListDepth(eleven), new RegExp(LIST_DEPTH_LIMIT_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });
}

test("mixed list ancestry counts each outer list as one level", () => {
  const types = Array.from({ length: 10 }, (_, index) => ["bulletList", "orderedList", "taskList"][index % 3] as string);
  assert.equal(maximumListDepth({ type: "doc", content: [nestedList(types)] }), 10);
});
