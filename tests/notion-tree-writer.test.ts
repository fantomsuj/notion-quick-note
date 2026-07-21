import assert from "node:assert/strict";
import test from "node:test";
import type { TreeWriteJournal } from "../src/contracts.js";
import {
  appendBlockTree,
  NotionTreeWriteReviewError,
  type NotionAppendPosition,
  type NotionRemoteBlock,
  type NotionTreeRequestPort,
  type NotionWriteBlock
} from "../src/notion-tree-writer.js";

function journal(groups: Record<string, string[]> = {}): TreeWriteJournal {
  return {
    version: 1,
    phase: "writing",
    connectionId: "connection",
    destinationType: "page",
    destinationParentId: "page",
    operationTimestamp: "2026-07-21T12:00:00.000Z",
    groups,
    archivedBlockIds: []
  };
}

function block(type: string, text: string, children: NotionWriteBlock[] = []): NotionWriteBlock {
  return {
    object: "block",
    type,
    [type]: {
      rich_text: [{ type: "text", text: { content: text } }],
      ...(children.length ? { children } : {})
    }
  };
}

test("writes childless sibling groups and journals deterministic paths", async () => {
  const rootPosition: NotionAppendPosition = { type: "after_block", after_block: { id: "previous" } };
  const tree = [
    block("bulleted_list_item", "root", [
      block("numbered_list_item", "child", [block("bulleted_list_item", "grandchild")]),
      block("to_do", "task")
    ]),
    block("paragraph", "second")
  ];
  const calls: Array<{ parentId: string; children: NotionWriteBlock[]; position?: NotionAppendPosition }> = [];
  const ids = [[{ id: "root-0" }, { id: "root-1" }], [{ id: "child-0" }, { id: "child-1" }], [{ id: "grandchild-0" }]];
  const progress: TreeWriteJournal[] = [];
  const request: NotionTreeRequestPort = {
    appendChildren: async (parentId, children, position) => {
      calls.push({ parentId, children, ...(position ? { position } : {}) });
      return ids[calls.length - 1]!;
    },
    retrieveChildren: async () => [],
    isAmbiguousMutation: () => false
  };
  const result = await appendBlockTree({
    parentId: "page",
    blocks: tree,
    rootPosition,
    namespace: "capture/content",
    journal: journal(),
    onProgress: async (value) => { progress.push(value); },
    request
  });

  assert.deepEqual(calls.map((call) => ({
    parentId: call.parentId,
    types: call.children.map((child) => child.type),
    hasEmbeddedChildren: call.children.some((child) => JSON.stringify(child).includes('"children"')),
    position: call.position
  })), [
    { parentId: "page", types: ["bulleted_list_item", "paragraph"], hasEmbeddedChildren: false, position: rootPosition },
    { parentId: "root-0", types: ["numbered_list_item", "to_do"], hasEmbeddedChildren: false, position: undefined },
    { parentId: "child-0", types: ["bulleted_list_item"], hasEmbeddedChildren: false, position: undefined }
  ]);
  assert.deepEqual(result.rootBlockIds, ["root-0", "root-1"]);
  assert.deepEqual(result.journal.groups, {
    "capture/content": ["root-0", "root-1"],
    "capture/content/0": ["child-0", "child-1"],
    "capture/content/0/0": ["grandchild-0"]
  });
  assert.equal(progress.length, 3);
});

test("skips journaled groups but resumes missing descendants", async () => {
  const calls: string[] = [];
  const result = await appendBlockTree({
    parentId: "page",
    blocks: [block("bulleted_list_item", "root", [block("to_do", "child")])],
    namespace: "capture/content",
    journal: journal({ "capture/content": ["root"] }),
    onProgress: async () => undefined,
    request: {
      appendChildren: async (parentId) => { calls.push(parentId); return [{ id: "child" }]; },
      retrieveChildren: async () => [],
      isAmbiguousMutation: () => false
    }
  });
  assert.deepEqual(calls, ["root"]);
  assert.deepEqual(result.journal.groups["capture/content/0"], ["child"]);
});

test("resume pre-reconciliation adopts a uniquely matching unjournaled group", async () => {
  let appends = 0;
  const progress: TreeWriteJournal[] = [];
  const result = await appendBlockTree({
    parentId: "page",
    blocks: [block("paragraph", "already remote")],
    rootPosition: { type: "end" },
    namespace: "capture/content",
    journal: journal(),
    reconcileMissingGroups: true,
    onProgress: async (value) => { progress.push(value); },
    request: {
      appendChildren: async () => { appends += 1; return [{ id: "duplicate" }]; },
      retrieveChildren: async () => [{ id: "existing", ...block("paragraph", "already remote") }],
      isAmbiguousMutation: () => false
    }
  });
  assert.equal(appends, 0);
  assert.deepEqual(result.rootBlockIds, ["existing"]);
  assert.equal(progress.length, 1);
});

test("enforces sibling, total, and returned-ID limits", async () => {
  const request: NotionTreeRequestPort = {
    appendChildren: async (_parentId, children) => children.map((_, index) => ({ id: String(index) })),
    retrieveChildren: async () => [],
    isAmbiguousMutation: () => false
  };
  await assert.doesNotReject(appendBlockTree({ parentId: "page", blocks: Array.from({ length: 100 }, (_, index) => block("paragraph", String(index))), namespace: "n", journal: journal(), onProgress: async () => undefined, request }));
  await assert.rejects(appendBlockTree({ parentId: "page", blocks: Array.from({ length: 101 }, (_, index) => block("paragraph", String(index))), namespace: "n", journal: journal(), onProgress: async () => undefined, request }));
  const chains = Array.from({ length: 100 }, (_, root) => {
    let current = block("paragraph", `${root}-9`);
    for (let depth = 8; depth >= 0; depth -= 1) current = block("bulleted_list_item", `${root}-${depth}`, [current]);
    return current;
  });
  await assert.doesNotReject(appendBlockTree({ parentId: "page", blocks: chains, namespace: "n", journal: journal(), onProgress: async () => undefined, request }));
  await assert.rejects(appendBlockTree({ parentId: "page", blocks: [...chains, block("paragraph", "extra")], namespace: "n", journal: journal(), onProgress: async () => undefined, request }));
  await assert.rejects(appendBlockTree({ parentId: "page", blocks: [block("paragraph", "one")], namespace: "n", journal: journal(), onProgress: async () => undefined, request: { ...request, appendChildren: async () => [] } }), NotionTreeWriteReviewError);
});

test("adopts one conservatively reconciled ambiguous group", async () => {
  const expected = [block("paragraph", "one"), block("to_do", "two")];
  const remote: NotionRemoteBlock[] = [
    { id: "previous", type: "divider", divider: {} },
    { id: "one", ...expected[0] },
    { id: "two", ...expected[1] }
  ];
  const result = await appendBlockTree({
    parentId: "page",
    blocks: expected,
    rootPosition: { type: "after_block", after_block: { id: "previous" } },
    namespace: "capture/content",
    journal: journal(),
    onProgress: async () => undefined,
    request: {
      appendChildren: async () => { throw new Error("timeout"); },
      retrieveChildren: async () => remote,
      isAmbiguousMutation: () => true
    }
  });
  assert.deepEqual(result.rootBlockIds, ["one", "two"]);
});

test("requires review for zero or multiple ambiguous matches", async () => {
  const expected = [block("paragraph", "same")];
  for (const remote of [
    [block("paragraph", "different")],
    [{ id: "one", ...expected[0] }, { id: "two", ...expected[0] }]
  ] as NotionRemoteBlock[][]) {
    await assert.rejects(appendBlockTree({
      parentId: "page",
      blocks: expected,
      namespace: "capture/content",
      journal: journal(),
      onProgress: async () => undefined,
      request: {
        appendChildren: async () => { throw new Error("timeout"); },
        retrieveChildren: async () => remote,
        isAmbiguousMutation: () => true
      }
    }), (error: unknown) => error instanceof NotionTreeWriteReviewError && error.code === "tree_write_ambiguous");
  }
});
