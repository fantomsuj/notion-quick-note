import { LIST_DEPTH_LIMIT_MESSAGE, MAX_LIST_LEVELS } from "./constants.js";
import type { EditorNode } from "./contracts.js";

const LIST_TYPES: ReadonlySet<string> = new Set(["bulletList", "orderedList", "taskList"]);

export function maximumListDepth(node: EditorNode | null | undefined, listDepth = 0): number {
  if (!node) return listDepth;
  const nextDepth = listDepth + (LIST_TYPES.has(node.type) ? 1 : 0);
  return (node.content || []).reduce(
    (maximum, child) => Math.max(maximum, maximumListDepth(child, nextDepth)),
    nextDepth
  );
}

export function assertSupportedListDepth(doc: EditorNode | null | undefined): void {
  if (maximumListDepth(doc) > MAX_LIST_LEVELS) throw new Error(LIST_DEPTH_LIMIT_MESSAGE);
}
