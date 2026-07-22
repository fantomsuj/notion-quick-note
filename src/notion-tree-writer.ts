import type { TreeWriteJournal } from "./contracts.js";

const MAX_SIBLINGS = 100;
const MAX_BLOCKS = 1000;

export type NotionAppendPosition =
  | { type: "start" }
  | { type: "end" }
  | { type: "after_block"; after_block: { id: string } };

export interface NotionWriteBlock {
  object?: string;
  type: string;
  [key: string]: unknown;
}

export interface NotionRemoteBlock {
  id?: string;
  type?: string;
  [key: string]: unknown;
}

export interface NotionTreeRequestPort {
  appendChildren(parentId: string, children: NotionWriteBlock[], position?: NotionAppendPosition): Promise<Array<{ id: string }>>;
  retrieveChildren(parentId: string): Promise<NotionRemoteBlock[]>;
  isAmbiguousMutation(error: unknown): boolean;
}

export interface AppendBlockTreeOptions {
  parentId: string;
  blocks: NotionWriteBlock[];
  rootPosition?: NotionAppendPosition;
  namespace: string;
  journal: TreeWriteJournal;
  onProgress(journal: TreeWriteJournal): Promise<void>;
  request: NotionTreeRequestPort;
  reconcileMissingGroups?: boolean;
}

export class NotionTreeWriteReviewError extends Error {
  readonly code = "tree_write_ambiguous";

  constructor(message = "Notion may have written this list more than once. Review the note before retrying.") {
    super(message);
    this.name = "NotionTreeWriteReviewError";
  }
}

export async function appendBlockTree(options: AppendBlockTreeOptions): Promise<{
  rootBlockIds: string[];
  journal: TreeWriteJournal;
}> {
  validateTree(options.blocks);
  const journal = cloneJournal(options.journal);

  const writeGroup = async (
    parentId: string,
    blocks: NotionWriteBlock[],
    path: string,
    position?: NotionAppendPosition
  ): Promise<string[]> => {
    let ids = journal.groups[path];
    if (!ids) {
      const shallow = blocks.map(shallowBlock);
      let result = options.reconcileMissingGroups
        ? await reconcileExistingGroup(options.request, parentId, shallow, position)
        : null;
      if (!result) {
        try {
          result = await options.request.appendChildren(parentId, shallow, position);
        } catch (error) {
          if (!options.request.isAmbiguousMutation(error)) throw error;
          result = await reconcileAmbiguousGroup(options.request, parentId, shallow, position);
        }
      }
      ids = requiredReturnedIds(result, blocks.length);
      journal.groups[path] = [...ids];
      await options.onProgress(cloneJournal(journal));
    } else if (ids.length !== blocks.length || ids.some((id) => typeof id !== "string" || !id)) {
      throw new NotionTreeWriteReviewError("Stored Notion list progress does not match the document being resumed.");
    }

    for (let index = 0; index < blocks.length; index += 1) {
      const children = embeddedChildren(blocks[index]);
      if (!children.length) continue;
      const returnedParentId = ids[index];
      if (!returnedParentId) throw new NotionTreeWriteReviewError("Stored Notion list progress is missing a parent block ID.");
      await writeGroup(returnedParentId, children, `${path}/${index}`);
    }
    return ids;
  };

  const rootBlockIds = await writeGroup(options.parentId, options.blocks, options.namespace, options.rootPosition);
  return { rootBlockIds, journal };
}

function validateTree(blocks: NotionWriteBlock[]): void {
  let total = 0;
  const visit = (siblings: NotionWriteBlock[]): void => {
    if (siblings.length > MAX_SIBLINGS) throw new Error("Quick Note supports up to 100 blocks in one sibling group.");
    for (const block of siblings) {
      total += 1;
      if (total > MAX_BLOCKS) throw new Error("This note contains too many blocks for one capture.");
      visit(embeddedChildren(block));
    }
  };
  visit(blocks);
}

function embeddedChildren(block: NotionWriteBlock | undefined): NotionWriteBlock[] {
  if (!block) return [];
  const attributes = block[block.type];
  if (!isObject(attributes)) return [];
  const children = attributes.children;
  if (!Array.isArray(children)) return [];
  return children.filter(isWriteBlock);
}

function shallowBlock(block: NotionWriteBlock): NotionWriteBlock {
  const copy: NotionWriteBlock = { ...block };
  delete copy.children;
  const attributes = block[block.type];
  if (isObject(attributes)) {
    const shallowAttributes = { ...attributes };
    delete shallowAttributes.children;
    copy[block.type] = shallowAttributes;
  }
  return copy;
}

async function reconcileAmbiguousGroup(
  request: NotionTreeRequestPort,
  parentId: string,
  expected: NotionWriteBlock[],
  position?: NotionAppendPosition
): Promise<Array<{ id: string }>> {
  const result = await matchingRemoteGroups(request, parentId, expected, position);
  if (result.length !== 1) throw new NotionTreeWriteReviewError();
  return result[0]!.map((block) => ({ id: requiredRemoteId(block) }));
}

async function reconcileExistingGroup(
  request: NotionTreeRequestPort,
  parentId: string,
  expected: NotionWriteBlock[],
  position?: NotionAppendPosition
): Promise<Array<{ id: string }> | null> {
  const matches = await matchingRemoteGroups(request, parentId, expected, position);
  if (!matches.length) return null;
  if (matches.length > 1) throw new NotionTreeWriteReviewError();
  return matches[0]!.map((block) => ({ id: requiredRemoteId(block) }));
}

async function matchingRemoteGroups(
  request: NotionTreeRequestPort,
  parentId: string,
  expected: NotionWriteBlock[],
  position?: NotionAppendPosition
): Promise<NotionRemoteBlock[][]> {
  const remote = await request.retrieveChildren(parentId);
  const expectedFingerprints = expected.map(shallowFingerprint);
  const matches: NotionRemoteBlock[][] = [];
  for (let start = 0; start + expected.length <= remote.length; start += 1) {
    const window = remote.slice(start, start + expected.length);
    if (!window.every((block, index) => shallowFingerprint(block) === expectedFingerprints[index])) continue;
    if (!matchesPosition(remote, start, expected.length, position)) continue;
    matches.push(window);
  }
  return matches;
}

function matchesPosition(remote: NotionRemoteBlock[], start: number, length: number, position?: NotionAppendPosition): boolean {
  if (!position) return true;
  if (position.type === "start") return start === 0;
  if (position.type === "end") return start + length === remote.length;
  return start > 0 && remote[start - 1]?.id === position.after_block.id;
}

function shallowFingerprint(block: NotionWriteBlock | NotionRemoteBlock): string {
  const type = typeof block.type === "string" ? block.type : "";
  const attributes = type && isObject(block[type]) ? block[type] as Record<string, unknown> : {};
  return JSON.stringify({
    type,
    rich_text: normalizeRichText(attributes.rich_text),
    checked: attributes.checked === undefined ? null : Boolean(attributes.checked),
    language: typeof attributes.language === "string" ? attributes.language : "",
    list_start_index: typeof attributes.list_start_index === "number" ? attributes.list_start_index : null,
    list_format: typeof attributes.list_format === "string" ? attributes.list_format : ""
  });
}

function normalizeRichText(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (!isObject(item)) return { text: "" };
    const text = isObject(item.text) ? item.text : {};
    const link = isObject(text.link) ? text.link : {};
    const annotations = isObject(item.annotations) ? item.annotations : {};
    return {
      text: typeof item.plain_text === "string" ? item.plain_text : typeof text.content === "string" ? text.content : "",
      href: typeof item.href === "string" ? item.href : typeof link.url === "string" ? link.url : "",
      annotations: {
        bold: Boolean(annotations.bold),
        italic: Boolean(annotations.italic),
        strikethrough: Boolean(annotations.strikethrough),
        underline: Boolean(annotations.underline),
        code: Boolean(annotations.code),
        color: typeof annotations.color === "string" ? annotations.color : "default"
      }
    };
  });
}

function requiredReturnedIds(result: Array<{ id: string }>, expectedCount: number): string[] {
  if (!Array.isArray(result) || result.length !== expectedCount) {
    throw new NotionTreeWriteReviewError("Notion returned a different number of blocks than Quick Note wrote.");
  }
  return result.map((block) => requiredRemoteId(block));
}

function requiredRemoteId(block: { id?: unknown }): string {
  if (typeof block.id !== "string" || !block.id) {
    throw new NotionTreeWriteReviewError("Notion returned a written block without an ID.");
  }
  return block.id;
}

function cloneJournal(journal: TreeWriteJournal): TreeWriteJournal {
  return {
    ...journal,
    groups: Object.fromEntries(Object.entries(journal.groups).map(([path, ids]) => [path, [...ids]])),
    archivedBlockIds: [...journal.archivedBlockIds]
  };
}

function isWriteBlock(value: unknown): value is NotionWriteBlock {
  return isObject(value) && typeof value.type === "string";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
