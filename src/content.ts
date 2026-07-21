import { Editor, Extension, InputRule, Mark as TiptapMark, Node as TiptapNode, markInputRule, wrappingInputRule } from "@tiptap/core";
import Blockquote from "@tiptap/extension-blockquote";
import Bold from "@tiptap/extension-bold";
import BulletList from "@tiptap/extension-bullet-list";
import Code from "@tiptap/extension-code";
import CodeBlock from "@tiptap/extension-code-block";
import Document from "@tiptap/extension-document";
import Gapcursor from "@tiptap/extension-gapcursor";
import HardBreak from "@tiptap/extension-hard-break";
import Heading from "@tiptap/extension-heading";
import HorizontalRule from "@tiptap/extension-horizontal-rule";
import Italic from "@tiptap/extension-italic";
import Link from "@tiptap/extension-link";
import ListItem from "@tiptap/extension-list-item";
import OrderedList from "@tiptap/extension-ordered-list";
import Paragraph from "@tiptap/extension-paragraph";
import Placeholder from "@tiptap/extension-placeholder";
import Strike from "@tiptap/extension-strike";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import Text from "@tiptap/extension-text";
import Underline from "@tiptap/extension-underline";
import { TrailingNode, UndoRedo } from "@tiptap/extensions";
import { MAX_CAPTURE_CHARACTERS, MAX_CAPTURE_TITLE_CHARACTERS } from "./constants.js";
import { clampComposerBounds, defaultComposerBounds, normalizeStoredComposerBounds, type ComposerBounds } from "./composer-bounds.js";
import { enqueueWithReconciliation, isContentRuntimeResponse, withRuntimeMessageDeadline, type ContentRuntimeRequest } from "./runtime-message.js";
import { AI_NOTE_LIMITS, cleanNoteTask, extractNoteTodos, languageModelAvailability, suggestNoteTitle } from "./ai-note-actions.js";
import { isEditorNode, isRecord, type CaptureContext, type CaptureDraft, type CaptureDraftInput, type CaptureSource, type CaptureStatusRecord, type EditorNode, type NotionColorName, type QuickSettings, type RecentItem, type RemoteTarget, type RuntimeRequest, type RuntimeResponse } from "./contracts.js";

type HTMLElementConstructor<T extends HTMLElement = HTMLElement> = { new(): T };
interface ComposerElements {
  "link[rel=stylesheet]": HTMLLinkElement; ".sheet": HTMLElement; ".status": HTMLSpanElement;
  ".more": HTMLButtonElement; ".recent": HTMLButtonElement; ".ai": HTMLButtonElement;
  ".safe-close": HTMLButtonElement; ".save": HTMLButtonElement; ".close": HTMLButtonElement;
  ".setup": HTMLButtonElement; ".page-menu": HTMLDivElement; ".manage-sources": HTMLButtonElement;
  ".open-settings": HTMLButtonElement; ".discard-draft": HTMLButtonElement; ".recent-panel": HTMLElement;
  ".recent-search": HTMLInputElement; ".recent-list": HTMLDivElement; ".source-panel": HTMLElement;
  ".source-panel-close": HTMLButtonElement; ".source-list": HTMLDivElement; ".source-empty": HTMLDivElement;
  ".add-current-source": HTMLButtonElement; ".ai-panel": HTMLElement; ".ai-panel-close": HTMLButtonElement;
  ".ai-action-list": HTMLDivElement; '[data-ai-action="title"]': HTMLButtonElement; '[data-ai-action="todos"]': HTMLButtonElement;
  ".ai-review": HTMLDivElement; ".ai-preview-title-wrap": HTMLLabelElement; ".ai-preview-title": HTMLInputElement;
  ".ai-preview-todos-wrap": HTMLLabelElement; ".ai-preview-todos": HTMLTextAreaElement; ".ai-review-back": HTMLButtonElement;
  ".ai-apply-title": HTMLButtonElement; ".ai-insert-todos": HTMLButtonElement; ".ai-status": HTMLParagraphElement;
  ".edit-banner": HTMLDivElement; ".edit-banner-copy": HTMLSpanElement; ".conflict-actions": HTMLSpanElement;
  ".reload-remote": HTMLButtonElement; ".save-conflict-new": HTMLButtonElement; ".open-conflict-remote": HTMLButtonElement;
  ".return-draft": HTMLButtonElement; ".stale-banner": HTMLDivElement; ".reload-draft": HTMLButtonElement;
  ".page-title": HTMLInputElement; ".editor": HTMLDivElement; ".character-limit": HTMLSpanElement; ".bubble": HTMLDivElement;
  ".block-type": HTMLButtonElement; ".format-menu": HTMLDivElement; ".link-editor": HTMLDivElement;
  ".link-input": HTMLInputElement; ".apply-link": HTMLButtonElement; ".slash-menu": HTMLDivElement; ".toast": HTMLDivElement;
  ".format-overflow-button": HTMLButtonElement; ".format-overflow": HTMLDivElement;
  '.color-palette[data-palette="text"]': HTMLDivElement; '.color-palette[data-palette="highlight"]': HTMLDivElement;
  '[data-palette-trigger="text"]': HTMLButtonElement; '[data-palette-trigger="highlight"]': HTMLButtonElement;
  '[data-command="link"]': HTMLButtonElement;
}
interface ComposerLists {
  ".destination-value": HTMLElement; ".source-count": HTMLElement; "[data-ai-action]": HTMLButtonElement;
  ".bubble [data-command]": HTMLButtonElement; ".format-menu [data-block]": HTMLButtonElement;
  "button:not(.close)": HTMLButtonElement; ".format-overflow [data-command]": HTMLButtonElement;
  ".format-overflow [data-palette-trigger]": HTMLButtonElement; ".color-swatch": HTMLButtonElement;
  ".bubble [data-command], .format-overflow [data-command]": HTMLButtonElement;
  ".color-palette": HTMLDivElement; "[data-palette-trigger]": HTMLButtonElement;
  ".block-type, .format-overflow-button, [data-palette-trigger]": HTMLButtonElement;
}
type ComposerSelector = keyof ComposerElements;
type ComposerListSelector = keyof ComposerLists;

type ComposerConstructorGroup = readonly [HTMLElementConstructor, readonly string[]];
const COMPOSER_ELEMENT_GROUPS = [
  [HTMLLinkElement, ["link[rel=stylesheet]"]],
  [HTMLElement, [".sheet", ".recent-panel", ".source-panel", ".ai-panel"]],
  [HTMLSpanElement, [".status", ".edit-banner-copy", ".conflict-actions", ".character-limit"]],
  [HTMLButtonElement, [
    ".more", ".recent", ".ai", ".safe-close", ".save", ".close", ".setup", ".manage-sources",
    ".open-settings", ".discard-draft", ".source-panel-close", ".add-current-source", ".ai-panel-close",
    '[data-ai-action="title"]', '[data-ai-action="todos"]', ".ai-review-back", ".ai-apply-title",
    ".ai-insert-todos", ".reload-remote", ".save-conflict-new", ".open-conflict-remote", ".return-draft",
    ".reload-draft", ".block-type", ".apply-link", ".format-overflow-button", '[data-palette-trigger="text"]',
    '[data-palette-trigger="highlight"]', '[data-command="link"]'
  ]],
  [HTMLDivElement, [
    ".page-menu", ".recent-list", ".source-list", ".source-empty", ".ai-action-list", ".ai-review",
    ".edit-banner", ".stale-banner", ".editor", ".bubble", ".format-menu", ".link-editor", ".slash-menu",
    ".toast", ".format-overflow", '.color-palette[data-palette="text"]', '.color-palette[data-palette="highlight"]'
  ]],
  [HTMLInputElement, [".recent-search", ".ai-preview-title", ".page-title", ".link-input"]],
  [HTMLLabelElement, [".ai-preview-title-wrap", ".ai-preview-todos-wrap"]],
  [HTMLTextAreaElement, [".ai-preview-todos"]],
  [HTMLParagraphElement, [".ai-status"]]
] as const satisfies readonly ComposerConstructorGroup[];
const COMPOSER_LIST_GROUPS = [
  [HTMLElement, [".destination-value", ".source-count"]],
  [HTMLButtonElement, [
    "[data-ai-action]", ".bubble [data-command]", ".format-menu [data-block]", "button:not(.close)",
    ".format-overflow [data-command]", ".format-overflow [data-palette-trigger]", ".color-swatch",
    ".bubble [data-command], .format-overflow [data-command]", "[data-palette-trigger]",
    ".block-type, .format-overflow-button, [data-palette-trigger]"
  ]],
  [HTMLDivElement, [".color-palette"]]
] as const satisfies readonly ComposerConstructorGroup[];

function constructorForSelector<T extends HTMLElement>(
  selector: string,
  groups: readonly ComposerConstructorGroup[]
): HTMLElementConstructor<T> {
  const match = groups.find(([, selectors]) => selectors.includes(selector));
  if (!match) throw new Error(`Unknown element: ${selector}`);
  return match[0] as HTMLElementConstructor<T>;
}

function requiredComposerElements<T extends HTMLElement>(
  root: ParentNode,
  selector: string,
  constructor: HTMLElementConstructor<T>
): [T, ...T[]] {
  const elements = [...root.querySelectorAll(selector)];
  if (!elements.length || elements.some((element) => !(element instanceof constructor))) {
    throw new Error(`Invalid element: ${selector}`);
  }
  return elements as [T, ...T[]];
}

class ComposerRoot {
  constructor(readonly shadow: ShadowRoot) {
    for (const [constructor, selectors] of COMPOSER_LIST_GROUPS) {
      for (const selector of selectors) requiredComposerElements(shadow, selector, constructor);
    }
    for (const [constructor, selectors] of COMPOSER_ELEMENT_GROUPS) {
      for (const selector of selectors) requiredComposerElements(shadow, selector, constructor);
    }
  }

  querySelector<S extends ComposerSelector>(selector: S): ComposerElements[S] {
    return requiredComposerElements(this.shadow, selector, constructorForSelector<ComposerElements[S]>(selector, COMPOSER_ELEMENT_GROUPS))[0];
  }

  querySelectorAll<S extends ComposerListSelector>(selector: S): ComposerLists[S][] {
    return requiredComposerElements(this.shadow, selector, constructorForSelector<ComposerLists[S]>(selector, COMPOSER_LIST_GROUPS));
  }

  optional<T extends HTMLElement>(selector: string, constructor: HTMLElementConstructor<T>): T | null {
    const element = this.shadow.querySelector(selector);
    if (element === null) return null;
    if (!(element instanceof constructor)) throw new Error(`Quick Note found an invalid ${selector}.`);
    return element;
  }

  get activeElement(): Element | null { return this.shadow.activeElement; }
}
type AiAvailability = Awaited<ReturnType<typeof languageModelAvailability>> | "checking";
interface PopupInstance {
  host: HTMLElement; root: ComposerRoot; page: CaptureContext; previousFocus: Element | null;
  editor: Editor | null; settings: Partial<QuickSettings> | null; settingsPromise: Promise<Partial<QuickSettings>> | null;
  draftId: string; tabId: number | null; sessionId: string; revision: number; mode: "new" | "edit";
  targetRecordId: string; returnDraftId: string; sources: CaptureSource[]; dismissedSourceUrls: string[];
  remote: RemoteTarget | null; baseFingerprint: string; conflict: boolean;
  draftTimer: ReturnType<typeof setTimeout> | null; draftFeedbackTimer: ReturnType<typeof setTimeout> | null;
  draftDirty: boolean; draftWritePromise: Promise<CaptureDraftInput | null> | null; toastTimer: ReturnType<typeof setTimeout> | null;
  timers: Set<ReturnType<typeof setTimeout>>; userEdited: boolean; hasStoredDraft: boolean; saving: boolean; accepted: boolean;
  captureId: string; deliveryStartedAt: number; safeToClose: boolean; closed: boolean; contextLost: boolean; handoff: boolean;
  onFullscreenChange: () => void; onViewportResize: () => void; removalCount: number; removalObserver: MutationObserver | null;
  aiController: AbortController | null; aiAvailability: AiAvailability; aiBusy: boolean;
  bounds: ComposerBounds;
}
interface DraftView extends Partial<CaptureDraftInput> {
  version: 2; title: string; includeSource: boolean; sources: CaptureSource[]; doc: EditorNode; conflict?: boolean;
}
interface SlashCommand { id: string; label: string; hint: string; keys: string; run(editor: Editor): boolean }
interface RecentGroups { drafts: RecentItem[]; notes: RecentItem[]; notionPages: RecentItem[]; notionError: string }
type AiAction = "title" | "todos";
type ToastTone = "" | "error" | "success";
type InlineCommand = "bold" | "italic" | "underline" | "strike" | "code" | "link";
type PaletteKind = "text" | "highlight";
type BlockCommand = "paragraph" | `heading${1 | 2 | 3}` | "bulletList" | "orderedList" | "taskList" | "blockquote" | "codeBlock";
type PrimaryAction = "close" | "settings" | "activity" | "save";
type EnqueueResponse = RuntimeResponse<Extract<RuntimeRequest, { type: "ENQUEUE_CAPTURE" | "SAVE_CAPTURE" }>>;
type IconName = "check" | "close" | "more" | "recent" | "sparkle" | "search" | "source" | "open" | "settings" | "trash";
interface OpenOptions { draft?: CaptureDraft; page?: CaptureContext; draftId?: string; tabId?: number | null; sessionId?: string; revision?: number; replaceWithoutPersist?: boolean }
interface ContentPage { version?: 1; title: string; url: string; selection: string; capturedAt?: number; frameUrl?: string }
interface ContextUpdate { page: CaptureContext; tabId?: number | null; explicit?: boolean }
type ContentMessage =
  | { type: "QUICK_NOTE_PING" }
  | { type: "FLUSH_AND_CLOSE_QUICK_NOTE"; sessionId?: string }
  | { type: "QUICK_SETTINGS_CHANGED"; settings: Partial<QuickSettings> }
  | { type: "TOGGLE_QUICK_NOTE"; page: ContentPage; draftId?: string; tabId?: number | null; sessionId?: string; revision?: number };
interface ContextLossError extends Error { code: "quick_note_context_lost" }

const NOTION_COLORS: NotionColorName[] = ["default", "gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"];

function asComposerRoot(root: ShadowRoot): ComposerRoot {
  return new ComposerRoot(root);
}

function requiredDescendant(root: ParentNode, selector: string): HTMLElement {
  const element = root.querySelector(selector);
  if (!(element instanceof HTMLElement)) throw new Error(`Quick Note template is missing ${selector}.`);
  return element;
}

function errorMessage(error: unknown, fallback: string): string {
  return isRecord(error) && typeof error.message === "string" && error.message ? error.message : fallback;
}

function errorCode(error: unknown): string {
  return isRecord(error) && typeof error.code === "string" ? error.code : "";
}

function isQuickSettingsPatch(value: unknown): value is Partial<QuickSettings> {
  if (!isRecord(value)) return false;
  return (value.destinationName === undefined || typeof value.destinationName === "string")
    && (value.includeSource === undefined || typeof value.includeSource === "boolean")
    && (value.aiEnabled === undefined || typeof value.aiEnabled === "boolean")
    && (value.aiSuggestTitle === undefined || typeof value.aiSuggestTitle === "boolean")
    && (value.aiExtractTodos === undefined || typeof value.aiExtractTodos === "boolean")
    && (value.connected === undefined || typeof value.connected === "boolean")
    && (value.configured === undefined || typeof value.configured === "boolean")
    && (value.authType === undefined || value.authType === "oauth" || value.authType === "token");
}

function isContentPage(value: unknown): value is ContentPage {
  return isRecord(value)
    && (value.version === undefined || value.version === 1)
    && typeof value.title === "string"
    && typeof value.url === "string"
    && typeof value.selection === "string"
    && (value.capturedAt === undefined || (typeof value.capturedAt === "number" && Number.isFinite(value.capturedAt)))
    && (value.frameUrl === undefined || typeof value.frameUrl === "string");
}

function normalizeContentPage(page: ContentPage): CaptureContext {
  return {
    version: 1,
    title: page.title,
    url: page.url,
    selection: page.selection,
    capturedAt: page.capturedAt ?? Date.now(),
    ...(page.frameUrl === undefined ? {} : { frameUrl: page.frameUrl })
  };
}

function isNotionColorName(value: unknown): value is NotionColorName {
  return typeof value === "string" && NOTION_COLORS.some((color) => color === value);
}

function isContentMessage(value: unknown): value is ContentMessage {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "QUICK_NOTE_PING") return true;
  if (value.type === "FLUSH_AND_CLOSE_QUICK_NOTE") return value.sessionId === undefined || typeof value.sessionId === "string";
  if (value.type === "QUICK_SETTINGS_CHANGED") return isQuickSettingsPatch(value.settings);
  return value.type === "TOGGLE_QUICK_NOTE"
    && isContentPage(value.page)
    && (value.draftId === undefined || typeof value.draftId === "string")
    && (value.tabId === undefined || value.tabId === null || (typeof value.tabId === "number" && Number.isInteger(value.tabId)))
    && (value.sessionId === undefined || typeof value.sessionId === "string")
    && (value.revision === undefined || (typeof value.revision === "number" && Number.isInteger(value.revision)));
}

function requireEditor(instance: PopupInstance): Editor {
  if (!instance.editor) throw new Error("Quick Note editor has not been initialized.");
  return instance.editor;
}

function currentEditor(editor: Editor | undefined): Editor {
  if (!editor) throw new Error("Quick Note editor is unavailable.");
  return editor;
}

(() => {
  const PROTOCOL = 1;
  const DRAFT_VERSION = 2;
  const COMPOSER_BOUNDS_STORAGE_KEY = "quickNoteComposerBounds";
  const COMPOSER_FONT = '15px "NotionInter"';
  const KEYBOARD_EVENTS = ["keydown", "keypress", "keyup"];
  const handledKeyboardEvents = new WeakSet();
  const composerKeyboardEvents = new WeakSet<KeyboardEvent>();
  const slashCommands: SlashCommand[] = [
    { id: "text", label: "Text", hint: "Plain paragraph", keys: "", run: (editor) => editor.chain().focus().setParagraph().run() },
    { id: "h1", label: "Heading 1", hint: "Large section heading", keys: "#", run: (editor) => editor.chain().focus().toggleHeading({ level: 1 }).run() },
    { id: "h2", label: "Heading 2", hint: "Medium section heading", keys: "##", run: (editor) => editor.chain().focus().toggleHeading({ level: 2 }).run() },
    { id: "h3", label: "Heading 3", hint: "Small section heading", keys: "###", run: (editor) => editor.chain().focus().toggleHeading({ level: 3 }).run() },
    { id: "bullet", label: "Bulleted list", hint: "Create a simple list", keys: "-", run: (editor) => editor.chain().focus().toggleBulletList().run() },
    { id: "number", label: "Numbered list", hint: "Create an ordered list", keys: "1.", run: (editor) => editor.chain().focus().toggleOrderedList().run() },
    { id: "todo", label: "To-do list", hint: "Track something to do", keys: "[]", run: (editor) => editor.chain().focus().toggleTaskList().run() },
    { id: "toggle", label: "Toggle list", hint: "Hide details inside a toggle", keys: ">", run: (editor) => editor.chain().focus().setNode("toggleBlock").run() },
    { id: "quote", label: "Quote", hint: "Capture a quotation", keys: "\"", run: (editor) => editor.chain().focus().toggleBlockquote().run() },
    { id: "divider", label: "Divider", hint: "Separate sections", keys: "---", run: (editor) => editor.chain().focus().setHorizontalRule().run() },
    { id: "code", label: "Code", hint: "Write a code block", keys: "```", run: (editor) => editor.chain().focus().toggleCodeBlock().run() }
  ];
  const suggestedSlashCommandIds = ["text", "h1", "todo", "bullet"];

  let popup: PopupInstance | undefined;
  let editor: Editor | undefined;
  let slashIndex = 0;
  let lastSlashQuery: string | null = null;

  let disposed = false;
  const instances = new Set<PopupInstance>();

  window.__notionQuickNoteRuntime?.dispose?.();
  Reflect.deleteProperty(window, "__notionQuickNoteInstalled");
  document.querySelectorAll("[data-notion-quick-note-owned='true']").forEach((element) => element.remove());

  const onMessage = (message: unknown, _sender: chrome.runtime.MessageSender, sendResponse: (response?: unknown) => void): boolean => {
    if (!isContentMessage(message)) return false;
    if (message?.type === "QUICK_NOTE_PING") {
      sendResponse({ ready: true, protocol: PROTOCOL, open: Boolean(popup), sessionId: popup?.sessionId || "" });
      return false;
    }
    if (message?.type === "FLUSH_AND_CLOSE_QUICK_NOTE") {
      if (!popup || (message.sessionId && popup.sessionId !== message.sessionId)) {
        sendResponse({ ok: true, closed: false });
        return false;
      }
      const surface = popup;
      surface.handoff = true;
      if (surface.draftTimer !== null) clearTimeout(surface.draftTimer);
      surface.draftTimer = null;
      void persistDraft(surface)
        .then(() => {
          close(surface, true);
          sendResponse({ ok: true, closed: true });
        })
        .catch((error: unknown) => {
          surface.handoff = false;
          sendResponse({ ok: false, error: errorMessage(error, "Draft flush failed.") });
        });
      return true;
    }
    if (message?.type === "QUICK_SETTINGS_CHANGED") {
      if (popup && message.settings) {
        popup.settings = { ...popup.settings, ...message.settings };
        hydrateSettings(popup);
      }
      return false;
    }
    if (message?.type !== "TOGGLE_QUICK_NOTE") return false;
    if (popup) close(popup);
    else open(normalizeContentPage(message.page), message.draftId, message.tabId, message.sessionId, message.revision);
    return false;
  };

  const openFromPage = async ({ draft, page, draftId, tabId, sessionId, revision, replaceWithoutPersist = false }: OpenOptions): Promise<void> => {
    const requestedDraftId = draft?.id || draftId || "";
    if (popup && requestedDraftId && popup.draftId === requestedDraftId) {
      if (replaceWithoutPersist && draft) {
        popup.tabId = draft.tabId;
        popup.sessionId = draft.sessionId;
        popup.revision = draft.revision;
        popup.hasStoredDraft = true;
      }
      resumeComposer();
      return;
    }
    if (popup && draft) {
      const current = popup;
      if (!current.accepted && !replaceWithoutPersist) {
        try {
          await persistDraft(current);
        } catch (error) {
          if (!current.closed) scheduleDraft(current);
          throw error;
        }
      }
      if (popup !== current || current.closed) return;
      stopTimers(current);
      current.page = draft.context || page || current.page;
      current.tabId = draft.tabId ?? tabId ?? current.tabId;
      current.accepted = false;
      current.saving = false;
      current.safeToClose = false;
      current.captureId = "";
      current.contextLost = false;
      current.root.querySelector(".stale-banner").hidden = true;
      closeTransientUi(current.root);
      applyDraftToInstance(current.root, current, draft);
      resumeComposer();
      return;
    }
    if (popup) close(popup);
    open(page || draft?.context || { version: 1, title: "Quick Note", url: "", selection: "", capturedAt: Date.now() }, requestedDraftId, tabId, sessionId, revision, draft);
  };
  const updateContext = ({ page, tabId, explicit = false }: ContextUpdate): void => {
    if (!popup || !page) return;
    updatePageContext(popup, page, tabId, explicit);
  };
  const suspendComposer = () => {
    if (!popup || popup.closed) return;
    if (popup.host.matches(":popover-open")) popup.host.hidePopover();
    popup.host.hidden = true;
  };
  const resumeComposer = () => {
    if (!popup || popup.closed) return;
    popup.host.hidden = false;
    if (popup.host.isConnected && !popup.host.matches(":popover-open")) popup.host.showPopover();
  };
  const prepareDiscard = async (draftId: string): Promise<boolean> => {
    const current = popup;
    if (!current || current.closed || current.draftId !== draftId) return false;
    current.accepted = true;
    current.draftDirty = false;
    stopTimers(current);
    await current.draftWritePromise?.catch(() => null);
    current.draftDirty = false;
    return popup === current && !current.closed;
  };
  const finishDiscard = (draftId: string, discarded: boolean): void => {
    const current = popup;
    if (!current || current.closed || current.draftId !== draftId) return;
    if (!discarded) {
      current.accepted = false;
      scheduleDraft(current);
      return;
    }
    disposePopup(current);
  };
  const runtime = { protocol: PROTOCOL, dispose };
  chrome.runtime.onMessage.addListener(onMessage);
  window.__notionQuickNoteOpen = openFromPage;
  window.__notionQuickNoteUpdateContext = updateContext;
  window.__notionQuickNoteSuspend = suspendComposer;
  window.__notionQuickNoteResume = resumeComposer;
  window.__notionQuickNotePrepareDiscard = prepareDiscard;
  window.__notionQuickNoteFinishDiscard = finishDiscard;
  window.__notionQuickNoteRuntime = runtime;

  function dispose() {
    if (disposed) return;
    disposed = true;
    globalThis.chrome?.runtime?.onMessage?.removeListener?.(onMessage);
    if (window.__notionQuickNoteOpen === openFromPage) Reflect.deleteProperty(window, "__notionQuickNoteOpen");
    if (window.__notionQuickNoteUpdateContext === updateContext) Reflect.deleteProperty(window, "__notionQuickNoteUpdateContext");
    if (window.__notionQuickNoteSuspend === suspendComposer) Reflect.deleteProperty(window, "__notionQuickNoteSuspend");
    if (window.__notionQuickNoteResume === resumeComposer) Reflect.deleteProperty(window, "__notionQuickNoteResume");
    if (window.__notionQuickNotePrepareDiscard === prepareDiscard) Reflect.deleteProperty(window, "__notionQuickNotePrepareDiscard");
    if (window.__notionQuickNoteFinishDiscard === finishDiscard) Reflect.deleteProperty(window, "__notionQuickNoteFinishDiscard");
    if (window.__notionQuickNoteRuntime === runtime) Reflect.deleteProperty(window, "__notionQuickNoteRuntime");
    for (const instance of [...instances]) disposePopup(instance);
    document.querySelectorAll("[data-notion-quick-note-owned='true']").forEach((element) => element.remove());
  }

  function open(page: CaptureContext, draftId = "", tabId: number | null = null, sessionId: string = crypto.randomUUID(), revision = 0, providedDraft: CaptureDraft | null = null): void {
    const previousFocus = document.activeElement;
    const host = document.createElement("div");
    host.id = document.getElementById("notion-quick-note-root")
      ? `notion-quick-note-root-${crypto.randomUUID()}`
      : "notion-quick-note-root";
    host.dataset.notionQuickNoteOwned = "true";
    host.setAttribute("aria-label", "Notion Quick Note");
    host.setAttribute("popover", "manual");
    host.setAttribute("role", "dialog");
    // Keep geometry inline, but let the shadow stylesheet own typography. `all: initial`
    // resets font-family to the browser's initial serif face (usually Times) and, because
    // it is inline, overrides the `:host` NotionInter declaration in composer.css.
    host.style.cssText = "position:fixed;margin:0;padding:0;border:0;background:transparent;overflow:visible";
    const shadowRoot = host.attachShadow({ mode: "open" });
    shadowRoot.innerHTML = template();
    const root = asComposerRoot(shadowRoot);

    const instance: PopupInstance = {
      host,
      root,
      page,
      previousFocus,
      editor: null,
      settings: null,
      settingsPromise: null,
      draftId,
      tabId,
      sessionId,
      revision: Number(revision) || 0,
      mode: "new",
      targetRecordId: "",
      returnDraftId: "",
      sources: [],
      dismissedSourceUrls: [],
      remote: null,
      baseFingerprint: "",
      conflict: false,
      draftTimer: null,
      draftFeedbackTimer: null,
      draftDirty: false,
      draftWritePromise: null,
      toastTimer: null,
      timers: new Set(),
      userEdited: false,
      hasStoredDraft: false,
      saving: false,
      accepted: false,
      captureId: "",
      deliveryStartedAt: 0,
      safeToClose: false,
      closed: false,
      contextLost: false,
      handoff: false,
      onFullscreenChange: () => undefined,
      onViewportResize: () => undefined,
      removalCount: 0,
      removalObserver: null,
      aiController: null,
      aiAvailability: "checking",
      aiBusy: false,
      bounds: defaultComposerBounds(composerViewport())
    };
    instances.add(instance);
    popup = instance;
    const stylesheet = root.querySelector("link[rel=stylesheet]");
    const sheet = root.querySelector(".sheet");
    let fontVerificationStarted = false;
    const revealComposerSheet = async () => {
      if (fontVerificationStarted) return;
      fontVerificationStarted = true;
      try {
        await document.fonts.load(COMPOSER_FONT);
        if (!document.fonts.check(COMPOSER_FONT)) throw new Error("NotionInter did not load.");
        host.dataset.fontStatus = "loaded";
      } catch {
        host.dataset.fontStatus = "fallback";
        host.classList.add("font-fallback");
      }
      if (instance.closed) return;
      sheet.style.removeProperty("display");
      requestAnimationFrame(() => {
        if (popup === instance && !instance.closed) sheet.classList.add("visible");
      });
    };
    stylesheet.addEventListener("load", () => void revealComposerSheet(), { once: true });
    if (stylesheet.sheet) void revealComposerSheet();

    containKeyboard(instance);
    const initialDraft = normalizeDraft(providedDraft, instance);
    hydrateShell(root, initialDraft, instance);
    applyComposerBounds(instance, instance.bounds);
    (document.fullscreenElement || document.documentElement).append(host);
    host.showPopover();
    createEditor(root, initialDraft, instance);
    wire(root, instance);
    wireComposerGeometry(root, instance);
    if (providedDraft) applyDraftToInstance(root, instance, providedDraft);
    requireEditor(instance).commands.focus("end");

    instance.onFullscreenChange = () => promoteAfterFullscreenChange(instance);
    document.addEventListener("fullscreenchange", instance.onFullscreenChange);
    instance.onViewportResize = () => clampAndPersistComposerBounds(instance);
    window.addEventListener("resize", instance.onViewportResize);
    void restoreComposerBounds(instance);
    stylesheet.addEventListener("error", () => fallbackFromOverlay(instance), { once: true });
    instance.removalObserver = new MutationObserver(() => recoverRemovedOverlay(instance));
    instance.removalObserver.observe(document, { childList: true, subtree: true });

    instance.settingsPromise = sendRuntimeMessage({ type: "GET_QUICK_SETTINGS" }, instance)
      .then((settings) => {
        instance.settings = settings?.ok ? settings : {};
        if (popup === instance && !instance.closed) hydrateSettings(instance);
        return instance.settings;
      })
      .catch((error: unknown) => {
        instance.settings = {};
        if (popup === instance && !instance.closed) {
          setStatus(instance.root, "Settings unavailable");
          showToast(instance.root, errorMessage(error, "Quick Note could not load settings."), "error", instance);
        }
        return instance.settings;
      });
    if (!providedDraft) void hydrateDraft(instance).catch((error: unknown) => {
      if (popup === instance && !instance.closed && !instance.contextLost) {
        setStatus(instance.root, "Draft not loaded");
        showToast(instance.root, errorMessage(error, "Quick Note could not load the local draft."), "error", instance);
      }
    });
  }

  function containKeyboard(instance: PopupInstance): void {
    for (const type of KEYBOARD_EVENTS) {
      instance.root.shadow.addEventListener(type, (event) => {
        if (type === "keydown" && event instanceof KeyboardEvent) {
          composerKeyboardEvents.add(event);
          handleRootKeyDown(instance.root, event, instance);
        }
        event.stopPropagation();
      });
      instance.host.addEventListener(type, (event) => {
        if (type === "keydown" && event instanceof KeyboardEvent && !composerKeyboardEvents.has(event)) {
          composerKeyboardEvents.add(event);
          handleRootKeyDown(instance.root, event, instance);
        }
        event.stopPropagation();
      });
    }
  }

  function composerViewport(): { width: number; height: number } {
    return { width: window.innerWidth, height: window.innerHeight };
  }

  function sameComposerBounds(left: ComposerBounds, right: ComposerBounds): boolean {
    return left.left === right.left && left.top === right.top && left.width === right.width && left.height === right.height;
  }

  function applyComposerBounds(instance: PopupInstance, bounds: ComposerBounds): void {
    instance.bounds = clampComposerBounds(bounds, composerViewport());
    const { host } = instance;
    host.style.left = `${instance.bounds.left}px`;
    host.style.top = `${instance.bounds.top}px`;
    host.style.width = `${instance.bounds.width}px`;
    host.style.height = `${instance.bounds.height}px`;
  }

  function persistComposerBounds(instance: PopupInstance): void {
    if (instance.closed) return;
    void chrome.storage.local.set({ [COMPOSER_BOUNDS_STORAGE_KEY]: instance.bounds }).catch(() => undefined);
  }

  function clampAndPersistComposerBounds(instance: PopupInstance): void {
    const before = instance.bounds;
    applyComposerBounds(instance, before);
    if (!sameComposerBounds(before, instance.bounds)) persistComposerBounds(instance);
  }

  async function restoreComposerBounds(instance: PopupInstance): Promise<void> {
    try {
      const values = await chrome.storage.local.get(COMPOSER_BOUNDS_STORAGE_KEY);
      if (instance.closed || popup !== instance) return;
      const stored = values[COMPOSER_BOUNDS_STORAGE_KEY];
      const restored = normalizeStoredComposerBounds(stored, composerViewport());
      if (restored) {
        applyComposerBounds(instance, restored);
        if (!sameComposerBounds(stored as ComposerBounds, restored)) persistComposerBounds(instance);
      } else if (stored !== undefined) {
        applyComposerBounds(instance, defaultComposerBounds(composerViewport()));
        persistComposerBounds(instance);
      }
    } catch {
      // Geometry must never interfere with editing when extension storage is unavailable.
    }
  }

  function wireComposerGeometry(root: ComposerRoot, instance: PopupInstance): void {
    const dragRegion = root.optional("[data-composer-drag-region]", HTMLElement);
    const resizeHandle = root.optional("[data-composer-resize-handle]", HTMLElement);
    const wirePointerOperation = (
      target: HTMLElement | null,
      update: (start: ComposerBounds, deltaX: number, deltaY: number) => ComposerBounds
    ): void => {
      target?.addEventListener("pointerdown", (event) => {
        if (event.button !== 0 || instance.closed) return;
        event.preventDefault();
        const start = instance.bounds;
        const startX = event.clientX;
        const startY = event.clientY;
        target.setPointerCapture(event.pointerId);
        let frame = 0;
        let pendingX = startX;
        let pendingY = startY;
        const render = () => {
          frame = 0;
          applyComposerBounds(instance, update(start, pendingX - startX, pendingY - startY));
        };
        const move = (moveEvent: PointerEvent) => {
          pendingX = moveEvent.clientX;
          pendingY = moveEvent.clientY;
          if (!frame) frame = requestAnimationFrame(render);
        };
        const finish = () => {
          if (frame) {
            cancelAnimationFrame(frame);
            frame = 0;
            applyComposerBounds(instance, update(start, pendingX - startX, pendingY - startY));
          }
          target.removeEventListener("pointermove", move);
          target.removeEventListener("pointerup", finish);
          target.removeEventListener("pointercancel", finish);
          persistComposerBounds(instance);
        };
        target.addEventListener("pointermove", move);
        target.addEventListener("pointerup", finish, { once: true });
        target.addEventListener("pointercancel", finish, { once: true });
      });
    };
    wirePointerOperation(dragRegion, (start, deltaX, deltaY) => ({ ...start, left: start.left + deltaX, top: start.top + deltaY }));
    wirePointerOperation(resizeHandle, (start, deltaX, deltaY) => ({ ...start, width: start.width + deltaX, height: start.height + deltaY }));
  }

  function promoteAfterFullscreenChange(instance: PopupInstance): void {
    requestAnimationFrame(() => {
      if (popup !== instance || instance.closed || !instance.host.isConnected) return;
      const menuButton = instance.root.querySelector(".more");
      const active = menuButton.getAttribute("aria-expanded") === "true"
        ? menuButton
        : instance.root.activeElement || instance.root.optional(".ProseMirror", HTMLElement);
      if (instance.host.matches(":popover-open")) instance.host.hidePopover();
      const fullscreenContainer = document.fullscreenElement || document.documentElement;
      if (instance.host.parentElement !== fullscreenContainer) fullscreenContainer.append(instance.host);
      clampAndPersistComposerBounds(instance);
      instance.host.showPopover();
      if (active instanceof HTMLElement) active.focus({ preventScroll: true });
      requestAnimationFrame(() => {
        if (popup === instance && !instance.closed && active instanceof HTMLElement) active.focus({ preventScroll: true });
      });
    });
  }

  function recoverRemovedOverlay(instance: PopupInstance): void {
    if (instance.closed || instance.host.isConnected) return;
    instance.removalCount += 1;
    if (instance.removalCount === 1) {
      (document.fullscreenElement || document.documentElement).append(instance.host);
      return;
    }
    fallbackFromOverlay(instance);
  }

  function fallbackFromOverlay(instance: PopupInstance): void {
    if (instance.closed) return;
    instance.handoff = true;
    void persistDraft(instance)
      .catch(() => undefined)
      .finally(() => close(instance, true));
  }

  function close(instance: PopupInstance | undefined = popup, force = false): void {
    if (!instance || instance.closed) return;
    if (!force && instance.saving && !instance.safeToClose) {
      setStatus(instance.root, instance.accepted ? "Sending to Notion…" : "Saving locally…");
      return;
    }
    instance.closed = true;
    if (popup === instance) popup = undefined;
    if (editor === instance.editor) editor = undefined;

    stopTimers(instance);
    document.removeEventListener("fullscreenchange", instance.onFullscreenChange);
    window.removeEventListener("resize", instance.onViewportResize);
    instance.removalObserver?.disconnect();
    if (!instance.accepted && !instance.handoff) void persistDraft(instance).catch(() => undefined);
    void sendRuntimeMessage({ type: "RELEASE_COMPOSER_SURFACE", sessionId: instance.sessionId }, instance).catch(() => undefined);

    const sheet = instance.root.querySelector(".sheet");
    sheet.classList.remove("visible");
    instance.host.classList.add("closing");
    instance.host.removeAttribute("id");
    instance.host.style.pointerEvents = "none";
    if (instance.host.matches(":popover-open")) instance.host.hidePopover();
    restoreFocus(instance.previousFocus);

    const delay = matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 150;
    schedule(instance, () => {
      instance.editor?.destroy();
      instance.host.remove();
      instances.delete(instance);
      if (!popup) restoreFocus(instance.previousFocus);
    }, delay, "Couldn’t finish closing Quick Note.");
  }

  function disposePopup(instance: PopupInstance): void {
    instance.closed = true;
    if (popup === instance) popup = undefined;
    if (editor === instance.editor) editor = undefined;
    if (!instance.accepted && !instance.handoff && !instance.contextLost) void persistDraft(instance).catch(() => undefined);
    stopTimers(instance);
    document.removeEventListener("fullscreenchange", instance.onFullscreenChange);
    window.removeEventListener("resize", instance.onViewportResize);
    instance.removalObserver?.disconnect();
    if (instance.host.matches(":popover-open")) instance.host.hidePopover();
    instance.editor?.destroy();
    instance.host.remove();
    instances.delete(instance);
  }

  function stopTimers(instance: PopupInstance): void {
    if (instance.draftTimer !== null) clearTimeout(instance.draftTimer);
    if (instance.draftFeedbackTimer !== null) clearTimeout(instance.draftFeedbackTimer);
    if (instance.toastTimer !== null) clearTimeout(instance.toastTimer);
    instance.draftTimer = null;
    instance.draftFeedbackTimer = null;
    instance.toastTimer = null;
    instance.aiController?.abort();
    instance.aiController = null;
    for (const timer of instance.timers) clearTimeout(timer);
    instance.timers.clear();
  }

  function reportAsyncFailure(instance: PopupInstance, error: unknown, fallback: string): void {
    if (isContextLossError(error)) {
      handleContextLoss(instance);
      return;
    }
    if (instance.closed) return;
    if (instance.aiBusy) {
      instance.aiController?.abort();
      instance.aiController = null;
      instance.aiBusy = false;
      setAiActionButtonsDisabled(instance.root, instance.aiAvailability === "unavailable");
    }
    showToast(instance.root, errorMessage(error, fallback), "error", instance);
  }

  function observeInstancePromise(instance: PopupInstance, promise: PromiseLike<unknown>, fallback: string): void {
    void Promise.resolve(promise).catch((error: unknown) => reportAsyncFailure(instance, error, fallback));
  }

  function isContextLossError(error: unknown): boolean {
    if (errorCode(error) === "quick_note_context_lost") return true;
    const message = errorMessage(error, String(error || "")).toLowerCase();
    return [
      "extension context invalidated",
      "receiving end does not exist",
      "message port closed",
      "access to storage is not allowed from this context",
      "storage is disabled",
      "cannot read properties of undefined (reading 'sendmessage')",
      "cannot read properties of undefined (reading 'session')"
    ].some((fragment) => message.includes(fragment));
  }

  function contextLossError(): ContextLossError {
    const error = new Error("Quick Note extension context is unavailable.") as ContextLossError;
    error.code = "quick_note_context_lost";
    return error;
  }

  async function sendRuntimeMessage<const T extends ContentRuntimeRequest>(message: T, instance: PopupInstance | undefined = popup): Promise<RuntimeResponse<T> | undefined> {
    try {
      const runtime = globalThis.chrome?.runtime;
      if (!runtime?.id || typeof runtime.sendMessage !== "function") throw contextLossError();
      const response: unknown = await withRuntimeMessageDeadline(runtime.sendMessage(message));
      if (!isContentRuntimeResponse(message, response)) throw new Error(`Quick Note received a malformed response for ${message.type}.`);
      return response;
    } catch (error: unknown) {
      if (!isContextLossError(error)) throw error;
      handleContextLoss(instance);
      return undefined;
    }
  }

  function handleContextLoss(instance: PopupInstance | undefined = popup): void {
    if (!instance || instance.closed || instance.contextLost) return;
    instance.contextLost = true;
    instance.saving = false;
    stopTimers(instance);
    instance.editor?.setEditable(false);
    const title = instance.root.querySelector(".page-title");
    if (title) title.readOnly = true;
    instance.root.querySelectorAll("button:not(.close)").forEach((button) => { button.disabled = true; });
    const notice = "Quick Note was updated. Reopen it to continue.";
    setStatus(instance.root, notice);
    const toast = instance.root.querySelector(".toast");
    toast.textContent = notice;
    toast.dataset.tone = "error";
    toast.hidden = false;
  }

  function restoreFocus(element: Element | null): void {
    if (!(element instanceof HTMLElement) || !element.isConnected) return;
    try {
      element.focus({ preventScroll: true });
    } catch {
      element.focus();
    }
  }

  async function hydrateDraft(instance: PopupInstance): Promise<void> {
    let response: RuntimeResponse<Extract<RuntimeRequest, { type: "GET_OR_CREATE_DRAFT" }>> | undefined;
    try {
      response = await sendRuntimeMessage({
        type: "GET_OR_CREATE_DRAFT",
        draftId: instance.draftId,
        ...(instance.tabId === null ? {} : { tabId: instance.tabId }),
        sessionId: instance.sessionId,
        context: instance.page,
        includeSource: instance.settings?.includeSource !== false
      }, instance);
    } catch (error: unknown) {
      if (!isContextLossError(error)) throw error;
      response = undefined;
    }
    if (popup !== instance || instance.closed || instance.userEdited) return;
    if (instance.contextLost) return;
    if (response?.ok === false) {
      setStatus(instance.root, "Draft not saved locally");
      showToast(instance.root, response.error || "Local draft storage is unavailable.", "error", instance);
      return;
    }
    const storedDraft = response?.draft;
    instance.hasStoredDraft = Boolean(storedDraft);
    const draft = normalizeDraft(storedDraft, instance);
    applyDraftToInstance(instance.root, instance, draft);
  }

  function normalizeDraft(value: CaptureDraft | DraftView | string | null | undefined, instance: PopupInstance): DraftView {
    if (typeof value !== "string" && value?.doc?.type === "doc") {
      return {
        ...value,
        version: DRAFT_VERSION,
        mode: value.mode === "edit" ? "edit" : "new",
        sources: normalizeSources(value.sources || (value.context?.url ? [value.context] : [])),
        dismissedSourceUrls: normalizeDismissedSourceUrls(value.dismissedSourceUrls),
        revision: Number(value.revision) || 0,
        sessionId: value.sessionId || instance?.sessionId || crypto.randomUUID()
      };
    }
    if (typeof value === "string" && value.trim()) {
      return {
        version: DRAFT_VERSION,
        title: "",
        includeSource: instance.settings?.includeSource !== false,
        sources: sourceFromPage(instance.page),
        doc: paragraphDocument(value)
      };
    }
    if (instance.page.selection) {
      return {
        version: DRAFT_VERSION,
        title: "",
        includeSource: instance.settings?.includeSource !== false,
        sources: sourceFromPage(instance.page),
        doc: {
          type: "doc",
          content: [
            { type: "blockquote", content: [{ type: "paragraph", content: [{ type: "text", text: instance.page.selection }] }] },
            { type: "paragraph" }
          ]
        }
      };
    }
    return {
      version: DRAFT_VERSION,
      title: "",
      includeSource: instance.settings?.includeSource !== false,
      sources: sourceFromPage(instance.page),
      doc: paragraphDocument("")
    };
  }

  function applyDraftToInstance(root: ComposerRoot, instance: PopupInstance, draftValue: CaptureDraft | DraftView | string): void {
    const draft = normalizeDraft(draftValue, instance);
    instance.draftId = draft.id || instance.draftId;
    instance.revision = Number(draft.revision) || 0;
    instance.sessionId = draft.sessionId || instance.sessionId;
    instance.mode = draft.mode || "new";
    instance.targetRecordId = draft.targetRecordId || "";
    instance.returnDraftId = draft.returnDraftId || "";
    instance.sources = normalizeSources(draft.sources || sourceFromPage(draft.context || instance.page));
    instance.dismissedSourceUrls = normalizeDismissedSourceUrls(draft.dismissedSourceUrls);
    instance.remote = draft.remote || null;
    instance.baseFingerprint = draft.baseFingerprint || "";
    instance.conflict = Boolean(draft.conflict);
    instance.draftDirty = false;
    root.querySelector(".page-title").value = draft.title || "";
    const draftEditor = requireEditor(instance);
    draftEditor.commands.setContent(draft.doc, { emitUpdate: false });
    renderSources(root, instance);
    renderEditBanner(root, instance);
    instance.userEdited = false;
    draftEditor.setEditable(true);
    root.querySelector(".page-title").readOnly = false;
    configureAiFeatures(instance);
    draftEditor.commands.focus("end");
    updateEditorUi(root);
  }

  function sourceFromPage(page: CaptureContext): CaptureSource[] {
    return page.url ? [{ title: page.title || hostname(page.url), url: page.url, selection: page.selection || "", capturedAt: Date.now() }] : [];
  }

  function normalizePageUrl(value: unknown = ""): string {
    try {
      const url = new URL(String(value));
      if (!/^https?:$/.test(url.protocol)) return "";
      url.hash = "";
      return url.href;
    } catch {
      return "";
    }
  }

  function normalizeDismissedSourceUrls(values: readonly unknown[] | undefined = []): string[] {
    return [...new Set(values.map(normalizePageUrl).filter(Boolean))].slice(0, 100);
  }

  function normalizeSources(sources: readonly Partial<CaptureSource>[] = []): CaptureSource[] {
    const seen = new Set<string>();
    return sources.flatMap((source) => {
      if (!source?.url) return [];
      let key: string;
      try {
        const url = new URL(source.url);
        url.hash = "";
        key = url.href;
      } catch {
        key = source.url;
      }
      if (seen.has(key)) return [];
      seen.add(key);
      return [{
        title: source.title || hostname(key),
        url: key,
        selection: source.selection || "",
        capturedAt: source.capturedAt || Date.now()
      }];
    }).slice(0, 20);
  }

  function updatePageContext(instance: PopupInstance, page: CaptureContext, tabId: number | null | undefined, explicit: boolean): void {
    const url = normalizePageUrl(page.url);
    if (!url) return;
    instance.page = { ...instance.page, ...page, url, selection: explicit ? page.selection || "" : "" };
    if (typeof tabId === "number") instance.tabId = tabId;
    if (!explicit && instance.mode === "edit") {
      renderSources(instance.root, instance);
      return;
    }

    const dismissed = new Set(normalizeDismissedSourceUrls(instance.dismissedSourceUrls));
    if (!explicit && dismissed.has(url)) {
      renderSources(instance.root, instance);
      return;
    }
    if (explicit) dismissed.delete(url);
    instance.dismissedSourceUrls = [...dismissed];

    const sources = normalizeSources(instance.sources);
    const index = sources.findIndex((source) => source.url === url);
    const title = page.title || hostname(url);
    const selectedText = explicit ? String(page.selection || "").trim() : "";
    let changed = false;
    if (index >= 0) {
      const existingSource = sources[index];
      if (existingSource && (existingSource.title !== title || (selectedText && existingSource.selection !== selectedText))) {
        sources[index] = { ...existingSource, title, ...(selectedText ? { selection: selectedText } : {}) };
        changed = true;
      }
    } else if (sources.length < 20) {
      sources.push({ title, url, selection: selectedText, capturedAt: Date.now() });
      changed = true;
    }
    const pageEditor = requireEditor(instance);
    if (selectedText && !pageEditor.getText().includes(selectedText)) {
      pageEditor.chain().focus("end").insertContent([
        { type: "blockquote", content: [{ type: "paragraph", content: [{ type: "text", text: selectedText }] }] },
        { type: "paragraph" }
      ]).run();
      changed = true;
    }
    instance.sources = sources;
    renderSources(instance.root, instance);
    if (changed || explicit) scheduleDraft(instance);
  }

  function paragraphDocument(text: string): EditorNode {
    return {
      type: "doc",
      content: [{ type: "paragraph", ...(text ? { content: [{ type: "text", text }] } : {}) }]
    };
  }

  function hydrateShell(root: ComposerRoot, draft: DraftView, instance: PopupInstance): void {
    root.querySelector(".page-title").value = draft.title || "";
    root.querySelectorAll(".destination-value").forEach((element) => { element.textContent = "Notion Inbox"; });
    instance.sources = normalizeSources(draft.sources || sourceFromPage(instance.page));
    renderSources(root, instance);
  }

  function hydrateSettings(instance: PopupInstance): void {
    const settings = instance.settings ?? {};
    instance.root.querySelectorAll(".destination-value").forEach((element) => {
      element.textContent = settings.destinationName || "Notion Inbox";
    });
    const setup = instance.root.querySelector(".setup");
    setup.hidden = settings.configured !== false;
    requiredDescendant(setup, "strong").textContent = settings.connected ? "Finish setup" : "One minute of setup";
    requiredDescendant(setup, "span").textContent = settings.connected
      ? "Your token is connected. Choose where notes should land."
      : "Connect Notion and choose where notes should land.";
    configureAiFeatures(instance);
    renderSources(instance.root, instance);
  }

  function hostname(url: string): string {
    try {
      return new URL(url).hostname;
    } catch {
      return url;
    }
  }

  function createEditor(root: ComposerRoot, draft: DraftView, instance: PopupInstance): void {
    const createdEditor = new Editor({
      element: root.querySelector(".editor"),
      extensions: [
        Bold,
        BulletList,
        Code,
        CodeBlock,
        Document,
        Gapcursor,
        HardBreak,
        Heading,
        HorizontalRule,
        Italic,
        ListItem,
        Paragraph,
        Text,
        TrailingNode,
        UndoRedo,
        NotionBlockquote,
        NotionOrderedList,
        NotionStrike,
        Underline,
        Link.configure({ openOnClick: false, autolink: true, defaultProtocol: "https" }),
        TaskList,
        TaskItem.configure({ nested: true }),
        ToggleBlock,
        NotionColor,
        LockedNotionBlock,
        NotionShortcuts,
        Placeholder.configure({ placeholder: "Type '/' for commands" })
      ],
      content: draft.doc,
      editorProps: {
        attributes: {
          "aria-label": "Quick note content",
          spellcheck: "true",
          style: "white-space: pre-wrap;"
        },
        handleDOMEvents: {
          beforeinput: () => {
            instance.userEdited = true;
            return false;
          }
        },
        handleKeyDown: (_view, event) => handleEditorKeyDown(root, event),
        handlePaste: (_view, event) => handleLinkPaste(event)
      },
      onUpdate: () => {
        instance.userEdited = true;
        updateEditorUi(root);
        scheduleDraft(instance);
      },
      onSelectionUpdate: () => updateEditorUi(root),
      onFocus: () => updateEditorUi(root),
      onBlur: () => schedule(instance, () => {
        if (popup === instance && !instance.closed) updateBubble(root);
      }, 0)
    });
    instance.editor = createdEditor;
    editor = createdEditor;
    updateEditorUi(root);
  }

  async function discardDraft(root: ComposerRoot, instance: PopupInstance): Promise<void> {
    const draftId = instance.draftId;
    let discarded = false;
    try {
      await prepareDiscard(draftId);
      const response = await sendRuntimeMessage({ type: "DISCARD_DRAFT", id: draftId }, instance);
      if (!response?.ok) throw new Error(response?.error || "Couldn’t discard this draft.");
      if (!response.discarded) throw new Error("Couldn’t discard this draft.");
      discarded = true;
    } catch (error) {
      throw error;
    } finally {
      finishDiscard(draftId, discarded);
      if (!discarded && !instance.closed && !instance.contextLost) setStatus(root, "Draft preserved");
    }
  }

  function wire(root: ComposerRoot, instance: PopupInstance): void {
    const title = root.querySelector(".page-title");
    const save = root.querySelector(".save");
    const menu = root.querySelector(".page-menu");
    const menuButton = root.querySelector(".more");
    const recentPanel = root.querySelector(".recent-panel");
    const recentButton = root.querySelector(".recent");
    const sourcePanel = root.querySelector(".source-panel");
    const aiPanel = root.querySelector(".ai-panel");
    const aiButton = root.querySelector(".ai");

    root.querySelector(".editor").addEventListener("beforeinput", () => {
      instance.userEdited = true;
    });

    title.addEventListener("input", () => {
      instance.userEdited = true;
      scheduleDraft(instance);
    });
    title.addEventListener("keydown", (event: Event) => {
      if (!(event instanceof KeyboardEvent)) return;
      if (event.key === "Enter") {
        event.preventDefault();
        requireEditor(instance).commands.focus("start");
      }
    });

    root.querySelector(".close").addEventListener("click", () => close(instance));
    root.querySelector(".safe-close").addEventListener("click", () => close(instance));
    menuButton.addEventListener("click", (event: MouseEvent) => {
      const willOpen = menu.hidden;
      closeTransientUi(root);
      menu.hidden = !willOpen;
      menuButton.setAttribute("aria-expanded", String(willOpen));
      if (willOpen && event.detail === 0) menu.querySelector("button")?.focus();
    });
    recentButton.addEventListener("click", () => {
      const willOpen = recentPanel.hidden;
      closeTransientUi(root);
      recentPanel.hidden = !willOpen;
      recentButton.setAttribute("aria-expanded", String(willOpen));
      if (willOpen) observeInstancePromise(instance, loadRecents(root, instance, ""), "Recent notes are unavailable.");
    });
    aiButton.addEventListener("click", (event: MouseEvent) => {
      if (!event.isTrusted) return;
      const willOpen = aiPanel.hidden;
      closeTransientUi(root);
      if (willOpen) {
        observeInstancePromise(instance, openAiPanel(instance), "Couldn’t open AI actions.");
      } else {
        aiPanel.hidden = true;
        aiButton.setAttribute("aria-expanded", "false");
      }
    });
    root.querySelector(".ai-panel-close").addEventListener("click", () => {
      instance.aiController?.abort();
      aiPanel.hidden = true;
      aiButton.setAttribute("aria-expanded", "false");
      aiButton.focus();
    });
    root.querySelectorAll("[data-ai-action]").forEach((button: HTMLButtonElement) => {
      button.addEventListener("click", (event: MouseEvent) => {
        const action = button.dataset.aiAction;
        if (event.isTrusted && (action === "title" || action === "todos")) {
          observeInstancePromise(instance, runAiAction(instance, action), "On-device AI couldn’t finish this action.");
        }
      });
    });
    root.querySelector(".ai-review-back").addEventListener("click", () => showAiActions(root));
    root.querySelector(".ai-apply-title").addEventListener("click", () => applyAiTitle(instance));
    root.querySelector(".ai-insert-todos").addEventListener("click", () => insertAiTodos(instance));
    root.querySelector(".recent-search").addEventListener("input", (event: Event) => {
      if (event.currentTarget instanceof HTMLInputElement) {
        observeInstancePromise(instance, loadRecents(root, instance, event.currentTarget.value), "Recent notes are unavailable.");
      }
    });
    root.querySelector(".manage-sources").addEventListener("click", () => {
      closeTransientUi(root);
      sourcePanel.hidden = false;
      renderSources(root, instance);
    });
    root.querySelector(".source-panel-close").addEventListener("click", () => {
      sourcePanel.hidden = true;
      menuButton.focus();
    });
    root.querySelector(".add-current-source").addEventListener("click", () => {
      updatePageContext(instance, instance.page, instance.tabId, true);
      instance.userEdited = true;
    });
    root.querySelector(".open-settings").addEventListener("click", () => {
      observeInstancePromise(instance, sendRuntimeMessage({ type: "OPEN_SETTINGS" }, instance), "Couldn’t open settings.");
    });
    root.querySelector(".setup").addEventListener("click", () => {
      observeInstancePromise(instance, sendRuntimeMessage({ type: "OPEN_SETTINGS" }, instance), "Couldn’t open settings.");
    });
    root.querySelector(".discard-draft").addEventListener("click", () => {
      observeInstancePromise(instance, discardDraft(root, instance), "Couldn’t discard this draft.");
    });
    root.querySelector(".return-draft").addEventListener("click", () => {
      observeInstancePromise(instance, (async () => {
        if (!instance.returnDraftId) return;
        if (instance.draftTimer !== null) clearTimeout(instance.draftTimer);
        instance.draftTimer = null;
        await persistDraft(instance);
        const response = await sendRuntimeMessage({ type: "ACTIVATE_DRAFT", id: instance.returnDraftId, sessionId: instance.sessionId }, instance);
        if (!response?.ok) throw new Error(response?.error || "Couldn’t restore the stashed draft.");
        applyDraftToInstance(root, instance, response.draft);
        showToast(root, "Stashed draft restored", "success", instance);
      })(), "Couldn’t restore the stashed draft.");
    });
    root.querySelector(".reload-remote").addEventListener("click", () => {
      observeInstancePromise(instance, (async () => {
        const response = await sendRuntimeMessage({
          type: "LOAD_RECENT_NOTE",
          id: instance.targetRecordId,
          sessionId: instance.sessionId,
          reloadLatest: true
        }, instance);
        if (!response?.ok) throw new Error(response?.error || "Couldn’t reload the latest Notion version.");
        applyDraftToInstance(root, instance, response.draft);
        setStatus(root, "Latest Notion version loaded");
      })(), "Couldn’t reload the latest Notion version.");
    });
    root.querySelector(".save-conflict-new").addEventListener("click", () => {
      observeInstancePromise(instance, (async () => {
        const response = await sendRuntimeMessage({ type: "CONVERT_EDIT_TO_NEW_DRAFT", id: instance.draftId }, instance);
        if (!response?.ok) throw new Error(response?.error || "Couldn’t prepare a new note.");
        applyDraftToInstance(root, instance, response.draft);
        await saveCapture(root, instance);
      })(), "Couldn’t prepare a new note.");
    });
    root.querySelector(".open-conflict-remote").addEventListener("click", () => {
      observeInstancePromise(instance, sendRuntimeMessage({ type: "OPEN_CAPTURE_RESULT", id: instance.targetRecordId }, instance), "Couldn’t open this note in Notion.");
    });
    root.querySelector(".reload-draft").addEventListener("click", () => {
      observeInstancePromise(instance, (async () => {
        const response = await sendRuntimeMessage({
          type: "GET_OR_CREATE_DRAFT",
          ...(instance.tabId === null ? {} : { tabId: instance.tabId }),
          sessionId: instance.sessionId,
          context: instance.page
        }, instance);
        if (!response?.ok) throw new Error(response?.error || "Couldn’t reload the latest draft.");
        root.querySelector(".stale-banner").hidden = true;
        applyDraftToInstance(root, instance, response.draft);
        setStatus(root, "Latest draft loaded");
      })(), "Couldn’t reload the latest draft.");
    });
    save.addEventListener("click", () => {
      const action = save.dataset.action || "save";
      if (action === "close") return close(instance);
      if (action === "settings") return observeInstancePromise(instance, sendRuntimeMessage({ type: "OPEN_SETTINGS" }, instance), "Couldn’t open settings.");
      if (action === "activity") return observeInstancePromise(instance, sendRuntimeMessage({ type: "OPEN_ACTIVITY" }, instance), "Couldn’t open activity.");
      observeInstancePromise(instance, saveCapture(root, instance), "Couldn’t save this note.");
    });

    root.shadow.addEventListener("click", (event) => {
      const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("button") : null;
      if (!button) return;
      const command = button.dataset.command;
      if (command && ["bold", "italic", "underline", "strike", "code", "link"].includes(command)) {
        runInlineCommand(root, command as InlineCommand);
        if (button.closest(".format-overflow")) closeToolbarMenus(root);
      } else if (button.matches(".format-overflow-button")) toggleToolbarMenu(root, button, root.querySelector(".format-overflow"));
      else if (button.matches(".block-type")) toggleToolbarMenu(root, button, root.querySelector(".format-menu"));
      else if (button.dataset.paletteTrigger) openPalette(root, button, button.dataset.paletteTrigger as PaletteKind);
      else if (button.dataset.color && isNotionColorName(button.dataset.color)) applyNotionColor(root, button.dataset.color, button.closest<HTMLElement>(".color-palette")?.dataset.palette === "highlight" ? "highlight" : "text");
      else if (button.dataset.block) {
        runBlockCommand(button.dataset.block as BlockCommand);
        closeToolbarMenus(root);
      }
    });
    root.querySelector(".link-input").addEventListener("keydown", (event: Event) => {
      if (!(event instanceof KeyboardEvent)) return;
      if (event.key === "Enter" && !event.metaKey && !event.ctrlKey) {
        handledKeyboardEvents.add(event);
        event.preventDefault();
        applyLink(root);
      }
      if (event.key === "Escape") {
        handledKeyboardEvents.add(event);
        event.preventDefault();
        closeLinkEditor(root);
      }
    });
    root.querySelector(".apply-link").addEventListener("click", () => applyLink(root));

    root.shadow.addEventListener("mousedown", (event: Event) => {
      if (!(event instanceof MouseEvent)) return;
      const toolbar = event.composedPath().some((item) => item instanceof Element && item.matches?.(".bubble, .format-menu, .format-overflow, .color-palette"));
      if (toolbar) event.preventDefault();
      else closeToolbarMenus(root);
      if (!event.composedPath().some((item) => item === menu || item === menuButton)) {
        menu.hidden = true;
        menuButton.setAttribute("aria-expanded", "false");
      }
    });
  }

  function configureAiFeatures(instance: PopupInstance): void {
    const root = instance.root;
    const enabled = instance.settings?.aiEnabled !== false;
    const titleEnabled = enabled && instance.settings?.aiSuggestTitle !== false;
    const todosEnabled = enabled && instance.settings?.aiExtractTodos !== false;
    const anyEnabled = titleEnabled || todosEnabled;
    root.querySelector(".ai").hidden = !anyEnabled;
    root.querySelector(".ai").disabled = !anyEnabled || !aiActionsAllowed(instance);
    root.querySelector('[data-ai-action="title"]').hidden = !titleEnabled;
    root.querySelector('[data-ai-action="todos"]').hidden = !todosEnabled;
    if (!anyEnabled) {
      root.querySelector(".ai-panel").hidden = true;
      root.querySelector(".ai").setAttribute("aria-expanded", "false");
    }
  }

  function aiActionsAllowed(instance: PopupInstance): boolean {
    return !instance.closed
      && !instance.contextLost
      && instance.editor?.isEditable !== false
      && !instance.root.querySelector(".page-title").readOnly;
  }

  function aiActionEnabled(instance: PopupInstance, action: AiAction): boolean {
    if (instance.settings?.aiEnabled === false) return false;
    if (action === "title") return instance.settings?.aiSuggestTitle !== false;
    if (action === "todos") return instance.settings?.aiExtractTodos !== false;
    return false;
  }

  async function refreshAiSettings(instance: PopupInstance): Promise<boolean> {
    const latest = await sendRuntimeMessage({ type: "GET_QUICK_SETTINGS" }, instance);
    if (!latest?.ok || instance.closed) return false;
    instance.settings = { ...(instance.settings ?? {}), ...latest };
    configureAiFeatures(instance);
    return true;
  }

  async function openAiPanel(instance: PopupInstance): Promise<void> {
    if (!aiActionsAllowed(instance) || !await refreshAiSettings(instance)) return;
    const root = instance.root;
    if (root.querySelector(".ai").hidden) {
      showToast(root, "AI actions are turned off in Settings.", "error", instance);
      return;
    }
    root.querySelector(".ai-panel").hidden = false;
    root.querySelector(".ai").setAttribute("aria-expanded", "true");
    showAiActions(root);
    await refreshAiAvailability(instance);
  }

  async function refreshAiAvailability(instance: PopupInstance): Promise<void> {
    if (instance.closed || instance.aiBusy) return;
    const root = instance.root;
    instance.aiAvailability = "checking";
    setAiActionButtonsDisabled(root, true);
    setAiStatus(root, "Checking Chrome’s on-device model…");
    const availability = await languageModelAvailability();
    if (instance.closed || root.querySelector(".ai-panel").hidden) return;
    instance.aiAvailability = availability;
    setAiActionButtonsDisabled(root, availability === "unavailable");
    if (availability === "unavailable") {
      setAiStatus(root, "On-device AI isn’t available in this version of Chrome or on this device.", "error");
    } else if (availability === "downloadable") {
      setAiStatus(root, "Chrome will download its on-device model when you run an action.");
    } else if (availability === "downloading") {
      setAiStatus(root, "Chrome is downloading its on-device model. You can start now and keep this open.");
    } else {
      setAiStatus(root, "Ready on this device.");
    }
  }

  async function runAiAction(instance: PopupInstance, action: AiAction): Promise<void> {
    if (instance.aiBusy || !aiActionsAllowed(instance)) return;
    const root = instance.root;
    if (!await refreshAiSettings(instance) || !aiActionEnabled(instance, action)) {
      showToast(root, "This AI action is turned off in Settings.", "error", instance);
      return;
    }
    const aiEditor = requireEditor(instance);
    const note = aiEditor.getText().trim();
    if (!note) {
      showToast(root, "Write something before using an AI action.", "error", instance);
      aiEditor.commands.focus();
      return;
    }

    instance.aiBusy = true;
    instance.aiController?.abort();
    instance.aiController = new AbortController();
    setAiActionButtonsDisabled(root, true);
    root.querySelector(".ai-review").hidden = true;
    root.querySelector(".ai-action-list").hidden = false;
    setAiStatus(root, action === "title" ? "Suggesting a title…" : "Finding action items…");

    const context = {
      note,
      pageTitle: instance.sources.some((source) => sameUrl(source.url, instance.page?.url)) ? instance.page?.title || "" : "",
      sourceTitles: instance.sources.map((source) => source.title)
    };
    const contextKey = JSON.stringify(context);
    const controller = instance.aiController;
    const callbacks = {
      signal: instance.aiController.signal,
      ...(instance.aiAvailability === "checking" ? {} : { availability: instance.aiAvailability }),
      onStateChange(state: Exclude<AiAvailability, "checking"> | "generating") {
        if (state === "downloadable") setAiStatus(root, "Preparing Chrome’s on-device model…");
        else if (state === "downloading") setAiStatus(root, "Downloading Chrome’s on-device model…");
        else if (state === "generating") setAiStatus(root, action === "title" ? "Suggesting a title…" : "Finding action items…");
      },
      onDownloadProgress(progress: number) {
        setAiStatus(root, `Downloading Chrome’s on-device model… ${Math.round(progress * 100)}%`);
      }
    };

    try {
      if (action === "title") {
        const title = await suggestNoteTitle(context, callbacks);
        const currentContextKey = JSON.stringify({
          note: aiEditor.getText().trim(),
          pageTitle: instance.sources.some((source) => sameUrl(source.url, instance.page.url)) ? instance.page.title || "" : "",
          sourceTitles: instance.sources.map((source) => source.title)
        });
        if (instance.aiController !== controller || root.querySelector(".ai-panel").hidden || currentContextKey !== contextKey) return;
        if (!await refreshAiSettings(instance) || !aiActionEnabled(instance, action) || !aiActionsAllowed(instance)) {
          showToast(root, "This AI action was turned off before its result was applied.", "error", instance);
          return;
        }
        renderAiTitleReview(root, title);
      } else {
        const tasks = await extractNoteTodos(context, callbacks);
        const currentContextKey = JSON.stringify({
          note: aiEditor.getText().trim(),
          pageTitle: instance.sources.some((source) => sameUrl(source.url, instance.page.url)) ? instance.page.title || "" : "",
          sourceTitles: instance.sources.map((source) => source.title)
        });
        if (instance.aiController !== controller || root.querySelector(".ai-panel").hidden || currentContextKey !== contextKey) return;
        if (!await refreshAiSettings(instance) || !aiActionEnabled(instance, action) || !aiActionsAllowed(instance)) {
          showToast(root, "This AI action was turned off before its result was applied.", "error", instance);
          return;
        }
        if (!tasks.length) {
          setAiStatus(root, "No clear action items found. Nothing changed.");
        } else renderAiTodosReview(root, tasks);
      }
      instance.aiAvailability = "available";
    } catch (error: unknown) {
      if (isRecord(error) && error.name !== "AbortError" && !instance.closed) {
        if (errorCode(error) === "unavailable") instance.aiAvailability = "unavailable";
        setAiStatus(root, errorMessage(error, "On-device AI couldn’t finish this action."), "error");
      }
    } finally {
      instance.aiBusy = false;
      instance.aiController = null;
      if (!instance.closed) setAiActionButtonsDisabled(root, instance.aiAvailability === "unavailable");
    }
  }

  function renderAiTitleReview(root: ComposerRoot, title: string): void {
    root.querySelector(".ai-action-list").hidden = true;
    root.querySelector(".ai-review").hidden = false;
    root.querySelector(".ai-preview-title-wrap").hidden = false;
    root.querySelector(".ai-preview-todos-wrap").hidden = true;
    root.querySelector(".ai-preview-title").value = title;
    root.querySelector(".ai-apply-title").hidden = false;
    root.querySelector(".ai-insert-todos").hidden = true;
    setAiStatus(root, "Review the suggestion before applying it.");
    root.querySelector(".ai-preview-title").focus();
    root.querySelector(".ai-preview-title").select();
  }

  function renderAiTodosReview(root: ComposerRoot, tasks: string[]): void {
    root.querySelector(".ai-action-list").hidden = true;
    root.querySelector(".ai-review").hidden = false;
    root.querySelector(".ai-preview-title-wrap").hidden = true;
    root.querySelector(".ai-preview-todos-wrap").hidden = false;
    root.querySelector(".ai-preview-todos").value = tasks.join("\n");
    root.querySelector(".ai-apply-title").hidden = true;
    root.querySelector(".ai-insert-todos").hidden = false;
    setAiStatus(root, "Review one task per line before inserting.");
    root.querySelector(".ai-preview-todos").focus();
  }

  function showAiActions(root: ComposerRoot): void {
    root.querySelector(".ai-review").hidden = true;
    root.querySelector(".ai-action-list").hidden = false;
    setAiStatus(root, "Ready on this device.");
    root.optional("[data-ai-action]:not([hidden])", HTMLButtonElement)?.focus();
  }

  function applyAiTitle(instance: PopupInstance): void {
    const root = instance.root;
    if (!aiActionsAllowed(instance) || !aiActionEnabled(instance, "title")) return;
    const value = root.querySelector(".ai-preview-title").value.replace(/\s+/g, " ").trim().slice(0, MAX_CAPTURE_TITLE_CHARACTERS);
    if (!value) return showToast(root, "Add a title before applying it.", "error", instance);
    root.querySelector(".page-title").value = value;
    instance.userEdited = true;
    scheduleDraft(instance);
    closeTransientUi(root);
    root.querySelector(".page-title").focus();
    showToast(root, "Title applied", "success", instance);
  }

  function insertAiTodos(instance: PopupInstance): void {
    const root = instance.root;
    if (!aiActionsAllowed(instance) || !aiActionEnabled(instance, "todos")) return;
    const tasks = root.querySelector(".ai-preview-todos").value.split(/\r?\n/)
      .map(cleanNoteTask)
      .filter(Boolean)
      .slice(0, AI_NOTE_LIMITS.tasks);
    if (!tasks.length) return showToast(root, "Keep at least one task before inserting.", "error", instance);
    const todoEditor = requireEditor(instance);
    const currentCharacters = Array.from(todoEditor.getText()).length;
    const insertedCharacters = tasks.reduce((total, task) => total + Array.from(task).length, tasks.length);
    if (currentCharacters + insertedCharacters > MAX_CAPTURE_CHARACTERS) {
      return showToast(root, "These to-dos would exceed the 8,000-character note limit. Shorten the note or the task list first.", "error", instance);
    }
    const taskList = {
      type: "taskList",
      content: tasks.map((task) => ({
        type: "taskItem",
        attrs: { checked: false },
        content: [{ type: "paragraph", content: [{ type: "text", text: task }] }]
      }))
    };
    todoEditor.chain().focus("end").insertContent(taskList).run();
    closeTransientUi(root);
    todoEditor.commands.focus("end");
    showToast(root, `${tasks.length} ${tasks.length === 1 ? "to-do" : "to-dos"} inserted`, "success", instance);
  }

  function setAiActionButtonsDisabled(root: ComposerRoot, disabled: boolean): void {
    root.querySelectorAll("[data-ai-action]").forEach((button: HTMLButtonElement) => { button.disabled = disabled; });
  }

  function setAiStatus(root: ComposerRoot, text: string, tone: ToastTone = ""): void {
    const status = root.querySelector(".ai-status");
    status.textContent = text;
    status.dataset.tone = tone;
  }

  function renderSources(root: ComposerRoot, instance: PopupInstance): void {
    const sources = normalizeSources(instance.sources);
    instance.sources = sources;
    root.querySelectorAll(".source-count").forEach((node: HTMLElement) => {
      node.textContent = sources.length ? `${sources.length} attached` : "No attached pages";
    });
    const list = root.querySelector(".source-list");
    list.replaceChildren(...sources.map((source, index) => {
      const row = document.createElement("div");
      row.className = "source-row";
      const copy = document.createElement("span");
      copy.innerHTML = `<b>${escapeHtml(source.title || hostname(source.url))}</b><small>${index === 0 ? "Primary · " : ""}${escapeHtml(hostname(source.url))}</small>`;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "source-remove";
      remove.setAttribute("aria-label", `Remove ${source.title || source.url}`);
      remove.innerHTML = icon("close");
      remove.addEventListener("click", () => {
        instance.sources = sources.filter((_, sourceIndex) => sourceIndex !== index);
        instance.dismissedSourceUrls = normalizeDismissedSourceUrls([...instance.dismissedSourceUrls, source.url]);
        instance.userEdited = true;
        renderSources(root, instance);
        scheduleDraft(instance);
      });
      row.append(copy, remove);
      return row;
    }));
    root.querySelector(".source-empty").hidden = sources.length > 0;
    root.querySelector(".add-current-source").disabled = !instance.page?.url || sources.some((source) => sameUrl(source.url, instance.page.url)) || sources.length >= 20;
  }

  function renderEditBanner(root: ComposerRoot, instance: PopupInstance): void {
    const banner = root.querySelector(".edit-banner");
    banner.hidden = instance.mode !== "edit";
    if (banner.hidden) return;
    root.querySelector(".edit-banner-copy").textContent = instance.conflict
      ? "Notion changed · your local edit is preserved"
      : instance.returnDraftId ? "Editing a recent note · your draft is stashed" : "Editing a recent note";
    root.querySelector(".return-draft").hidden = !instance.returnDraftId;
    root.querySelector(".conflict-actions").hidden = !instance.conflict;
  }

  async function loadRecents(root: ComposerRoot, instance: PopupInstance, query: string): Promise<void> {
    const panel = root.querySelector(".recent-panel");
    const list = root.querySelector(".recent-list");
    const requestId = crypto.randomUUID();
    panel.dataset.requestId = requestId;
    list.innerHTML = '<div class="popover-state">Loading recent notes…</div>';
    const response = await sendRuntimeMessage({ type: "LIST_RECENT_NOTES", query, limit: query.trim() ? 100 : 5 }, instance)
      .catch((error: unknown) => ({ ok: false as const, error: errorMessage(error, "Recent notes are unavailable.") }));
    if (panel.dataset.requestId !== requestId || instance.closed) return;
    if (!response?.ok) {
      list.innerHTML = `<div class="popover-state error">${escapeHtml(response?.error || "Recent notes are unavailable.")}</div>`;
      return;
    }
    renderRecents(root, instance, {
      drafts: response.drafts || [],
      notes: response.notes || [],
      notionPages: response.notionPages || [],
      notionError: response.notionError || ""
    });
  }

  function renderRecents(root: ComposerRoot, instance: PopupInstance, groups: RecentGroups): void {
    const list = root.querySelector(".recent-list");
    const drafts = (groups.drafts || []).filter((draft) => draft.id !== instance.draftId);
    const notes = groups.notes || [];
    const notionPages = groups.notionPages || [];
    const nodes = [];
    if (drafts.length) {
      nodes.push(recentSectionHeading("Drafts", "Local work still in Quick Note"));
      nodes.push(...drafts.map((record) => recentRow(root, instance, record)));
    }
    if (notes.length) {
      nodes.push(recentSectionHeading("Saved notes", "Recently delivered from this extension"));
      nodes.push(...notes.map((record) => recentRow(root, instance, record)));
    }
    if (notionPages.length) {
      nodes.push(recentSectionHeading("From Notion", "Recently edited pages you can pull in"));
      nodes.push(...notionPages.map((record) => recentRow(root, instance, record)));
    } else if (groups.notionError) {
      nodes.push(recentSectionHeading("From Notion", groups.notionError));
    }
    if (!nodes.length) {
      list.innerHTML = '<div class="popover-state">No matching drafts or notes yet.</div>';
      return;
    }
    list.replaceChildren(...nodes);
  }

  function recentSectionHeading(title: string, subtitle: string): HTMLDivElement {
    const heading = document.createElement("div");
    heading.className = "recent-section";
    const label = document.createElement("b");
    label.textContent = title;
    const hint = document.createElement("small");
    hint.textContent = subtitle;
    heading.append(label, hint);
    return heading;
  }

  function recentRow(root: ComposerRoot, instance: PopupInstance, record: RecentItem): HTMLDivElement {
    const row = document.createElement("div");
    row.className = "recent-row";
    row.dataset.source = record.source || "note";
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "recent-edit";
    const title = document.createElement("b");
    title.textContent = record.title || "Untitled";
    const preview = document.createElement("span");
    preview.className = "recent-preview";
    preview.textContent = truncatePreview(record.preview, 90);
    preview.hidden = !preview.textContent;
    const metadata = document.createElement("small");
    metadata.textContent = record.editable === false ? `${recentSubtitle(record)} · Open in Notion only` : recentSubtitle(record);
    edit.append(title, preview, metadata);
    edit.addEventListener("click", () => observeInstancePromise(instance, openRecentItem(root, instance, record), "Couldn’t open this recent note."));
    const openRemote = document.createElement("button");
    openRemote.type = "button";
    openRemote.className = "recent-open";
    openRemote.innerHTML = icon("open");
    openRemote.setAttribute("aria-label", `Open ${record.title || "note"} in Notion`);
    openRemote.hidden = !record.remoteUrl || record.source === "draft";
    openRemote.addEventListener("click", () => observeInstancePromise(instance, sendRuntimeMessage({
      type: "OPEN_CAPTURE_RESULT",
      id: record.source === "notion" ? "" : record.id,
      url: record.remoteUrl || ""
    }, instance), "Couldn’t open this note in Notion."));
    row.append(edit, openRemote);
    return row;
  }

  async function openRecentItem(root: ComposerRoot, instance: PopupInstance, record: RecentItem): Promise<void> {
    if (record.source === "draft") return openRecentDraft(root, instance, record.id);
    if (record.source === "notion") return openNotionPage(root, instance, record);
    if (record.editable === false) {
      await sendRuntimeMessage({ type: "OPEN_CAPTURE_RESULT", id: record.id, url: record.remoteUrl || "" }, instance);
      return;
    }
    return openRecentNote(root, instance, record.id);
  }

  async function openRecentDraft(root: ComposerRoot, instance: PopupInstance, draftId: string): Promise<void> {
    if (!draftId || draftId === instance.draftId) {
      closeTransientUi(root);
      return;
    }
    try {
      if (instance.draftTimer !== null) clearTimeout(instance.draftTimer);
      instance.draftTimer = null;
      await persistDraft(instance);
      setStatus(root, "Opening draft…");
      const response = await sendRuntimeMessage({ type: "ACTIVATE_DRAFT", id: draftId, sessionId: instance.sessionId }, instance);
      if (!response?.ok) throw new Error(response?.error || "Couldn’t open this draft.");
      applyDraftToInstance(root, instance, response.draft);
      closeTransientUi(root);
      setStatus(root, "Editing draft");
    } catch (error: unknown) {
      setStatus(root, "Draft preserved");
      showToast(root, errorMessage(error, "Couldn’t open this draft."), "error", instance);
    }
  }

  async function openNotionPage(root: ComposerRoot, instance: PopupInstance, record: RecentItem): Promise<void> {
    try {
      if (instance.draftTimer !== null) clearTimeout(instance.draftTimer);
      instance.draftTimer = null;
      await persistDraft(instance);
      setStatus(root, "Loading from Notion…");
      const response = await sendRuntimeMessage({
        type: "LOAD_NOTION_PAGE",
        pageId: record.pageId || record.id,
        title: record.title || "",
        url: record.remoteUrl || "",
        sessionId: instance.sessionId
      }, instance);
      if (!response?.ok) throw new Error(response?.error || "Couldn’t load this Notion page.");
      applyDraftToInstance(root, instance, { ...response.draft, conflict: response.conflict });
      closeTransientUi(root);
      setStatus(root, "Editing Notion page");
    } catch (error: unknown) {
      setStatus(root, "Draft preserved");
      showToast(root, errorMessage(error, "Couldn’t load this Notion page."), "error", instance);
    }
  }

  async function openRecentNote(root: ComposerRoot, instance: PopupInstance, recordId: string): Promise<void> {
    try {
      if (instance.draftTimer !== null) clearTimeout(instance.draftTimer);
      instance.draftTimer = null;
      await persistDraft(instance);
      setStatus(root, "Loading latest from Notion…");
      const response = await sendRuntimeMessage({ type: "LOAD_RECENT_NOTE", id: recordId, sessionId: instance.sessionId }, instance);
      if (!response?.ok) throw new Error(response?.error || "Couldn’t load this note.");
      applyDraftToInstance(root, instance, { ...response.draft, conflict: response.conflict });
      closeTransientUi(root);
      setStatus(root, "");
    } catch (error: unknown) {
      setStatus(root, "Draft preserved");
      showToast(root, errorMessage(error, "Couldn’t load this note."), "error", instance);
    }
  }

  function recentSubtitle(record: RecentItem): string {
    if (record.source === "draft") {
      const kind = record.mode === "edit" ? "Edit draft" : "Draft";
      return `${kind} · ${relativeTime(record.updatedAt)}`;
    }
    if (record.source === "notion") {
      return `Notion · ${relativeTime(record.updatedAt)}`;
    }
    const destination = record.destinationName ? `${record.destinationName} · ` : "";
    const status = record.status === "blocked_conflict" ? "Conflict · local edit preserved" : relativeTime(record.updatedAt);
    return `${destination}${status}`;
  }

  function truncatePreview(value: string, limit: number): string {
    const characters = Array.from(String(value || "").replace(/\s+/g, " ").trim());
    return characters.length > limit ? `${characters.slice(0, limit).join("").trimEnd()}…` : characters.join("");
  }

  function relativeTime(timestamp: number): string {
    const elapsed = Math.max(0, Date.now() - Number(timestamp || 0));
    if (elapsed < 60_000) return "Just now";
    if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
    if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
    return `${Math.floor(elapsed / 86_400_000)}d ago`;
  }

  function sameUrl(left: string, right: string): boolean {
    const normalizedLeft = normalizePageUrl(left);
    const normalizedRight = normalizePageUrl(right);
    return Boolean(normalizedLeft && normalizedLeft === normalizedRight);
  }

  function escapeHtml(value: unknown): string {
    const span = document.createElement("span");
    span.textContent = String(value || "");
    return span.innerHTML;
  }

  function scheduleDraft(instance: PopupInstance | undefined = popup): void {
    if (!instance || instance.closed || instance.contextLost || instance.accepted) return;
    instance.draftDirty = true;
    if (instance.draftTimer !== null) clearTimeout(instance.draftTimer);
    if (instance.draftFeedbackTimer !== null) clearTimeout(instance.draftFeedbackTimer);
    instance.draftFeedbackTimer = null;
    if (instance.draftWritePromise || instance.saving) {
      instance.draftTimer = null;
      return;
    }
    instance.draftTimer = setTimeout(async () => {
      instance.draftTimer = null;
      if (instance.saving || instance.accepted) return;
      let showingSlowFeedback = false;
      instance.draftFeedbackTimer = setTimeout(() => {
        instance.draftFeedbackTimer = null;
        if (popup !== instance || instance.closed || instance.contextLost || instance.saving) return;
        const status = instance.root.querySelector(".status");
        if (status.textContent) return;
        showingSlowFeedback = true;
        setStatus(instance.root, "Saving locally…");
      }, 750);
      try {
        const saved = await persistDraft(instance, { force: false });
        if (instance.draftFeedbackTimer !== null) clearTimeout(instance.draftFeedbackTimer);
        instance.draftFeedbackTimer = null;
        if (saved && popup === instance && !instance.closed && !instance.contextLost) {
          const status = instance.root.querySelector(".status");
          if (showingSlowFeedback && status.textContent === "Saving locally…") setStatus(instance.root, "");
          if (status.textContent === "Local backup failed") setStatus(instance.root, "");
        }
      } catch (error: unknown) {
        if (instance.draftFeedbackTimer !== null) clearTimeout(instance.draftFeedbackTimer);
        instance.draftFeedbackTimer = null;
        if (popup === instance && !instance.closed && !instance.contextLost) {
          setStatus(instance.root, "Local backup failed");
          showToast(instance.root, errorMessage(error, "Local draft storage is unavailable."), "error", instance);
        }
      }
    }, 180);
  }

  function persistDraft(instance: PopupInstance | undefined = popup, { force = true }: { force?: boolean } = {}): Promise<CaptureDraftInput | null> {
    if (!instance?.editor || !instance.draftId || instance.contextLost) return Promise.resolve(null);
    if (force && !instance.draftWritePromise) instance.draftDirty = true;
    if (instance.draftWritePromise) return instance.draftWritePromise;
    if (!instance.draftDirty) return Promise.resolve(null);

    const write = drainDraftWrites(instance);
    instance.draftWritePromise = write;
    void write.finally(() => {
      if (instance.draftWritePromise === write) instance.draftWritePromise = null;
    }).catch(() => undefined);
    return write;
  }

  async function drainDraftWrites(instance: PopupInstance): Promise<CaptureDraftInput | null> {
    let latestSnapshot: CaptureDraftInput | null = null;
    while (instance.draftDirty && !instance.contextLost) {
      instance.draftDirty = false;
      const snapshot = draftSnapshot(instance);
      try {
        await writeDraftSnapshot(instance, snapshot);
      } catch (error) {
        instance.draftDirty = true;
        throw error;
      }
      latestSnapshot = snapshot;
    }
    return instance.contextLost ? null : latestSnapshot;
  }

  function draftSnapshot(instance: PopupInstance): CaptureDraftInput {
    const root = instance.root;
    return {
      version: 2,
      id: instance.draftId,
      tabId: instance.tabId,
      sessionId: instance.sessionId,
      revision: instance.revision,
      mode: instance.mode,
      targetRecordId: instance.targetRecordId,
      returnDraftId: instance.returnDraftId,
      remote: instance.remote,
      baseFingerprint: instance.baseFingerprint,
      context: instance.page,
      title: root.querySelector(".page-title").value,
      sources: structuredClone(instance.sources),
      dismissedSourceUrls: structuredClone(instance.dismissedSourceUrls),
      includeSource: instance.sources.length > 0,
      doc: (() => {
        const value: unknown = requireEditor(instance).getJSON();
        if (!isEditorNode(value)) throw new Error("Quick Note editor produced an invalid document.");
        return value;
      })()
    };
  }

  async function writeDraftSnapshot(instance: PopupInstance, snapshot: CaptureDraftInput): Promise<void> {
    const response = await sendRuntimeMessage({
      type: "UPSERT_DRAFT",
      expectedRevision: snapshot.revision,
      draft: snapshot
    }, instance);
    if (response?.ok === false) {
      if (response.code === "stale_draft") markStaleDraft(instance);
      const error = new Error(response.error || "Local draft storage is unavailable.") as Error & { code?: string };
      if (response.code) error.code = response.code;
      throw error;
    }
    if (response?.draft) {
      instance.revision = Number(response.draft.revision) || instance.revision;
      instance.sessionId = response.draft.sessionId || instance.sessionId;
      instance.hasStoredDraft = true;
    } else if (response?.discarded) {
      instance.revision = 0;
      instance.hasStoredDraft = false;
    }
  }

  function markStaleDraft(instance: PopupInstance): void {
    if (!instance || instance.closed) return;
    instance.aiController?.abort();
    instance.editor?.setEditable(false);
    instance.root.querySelector(".page-title").readOnly = true;
    instance.root.querySelector(".ai-panel").hidden = true;
    instance.root.querySelector(".ai").disabled = true;
    instance.root.querySelector(".ai").setAttribute("aria-expanded", "false");
    setAiActionButtonsDisabled(instance.root, true);
    instance.root.querySelector(".stale-banner").hidden = false;
    setStatus(instance.root, "Updated in another tab");
  }

  async function saveCapture(root: ComposerRoot, instance: PopupInstance): Promise<void> {
    if (instance.saving || instance.contextLost) return;
    await (instance.settings || instance.settingsPromise);
    if (popup !== instance || instance.closed) return;
    const captureEditor = requireEditor(instance);
    if (!captureEditor.getText().trim()) {
      showToast(root, "Write something before saving.", "error");
      captureEditor.commands.focus();
      return;
    }

    if (instance.draftTimer !== null) clearTimeout(instance.draftTimer);
    if (instance.draftFeedbackTimer !== null) clearTimeout(instance.draftFeedbackTimer);
    instance.draftTimer = null;
    instance.draftFeedbackTimer = null;
    instance.saving = true;
    instance.deliveryStartedAt = Date.now();
    const save = root.querySelector(".save");
    save.disabled = true;
    save.textContent = "Saving locally…";
    save.dataset.action = "save";
    root.querySelector(".close").disabled = true;
    root.querySelector(".safe-close").hidden = true;
    setStatus(root, "Saving locally…");
    closeTransientUi(root);

    let savedDraft;
    try {
      savedDraft = await persistDraft(instance);
    } catch (error: unknown) {
      instance.saving = false;
      save.disabled = false;
      save.textContent = "Save";
      root.querySelector(".close").disabled = false;
      setStatus(root, "Draft not saved");
      showToast(root, errorMessage(error, "Local storage is unavailable. Keep this composer open and try again."), "error", instance);
      return;
    }
    if (instance.contextLost) return;
    savedDraft ||= draftSnapshot(instance);

    let response: EnqueueResponse;
    try {
      response = await enqueueWithReconciliation({
        send: async (message) => {
          const result = await sendRuntimeMessage(message, instance);
          if (!result) throw contextLossError();
          return result;
        },
        draftId: instance.draftId,
        message: {
          type: "ENQUEUE_CAPTURE",
          draftId: instance.draftId,
          context: instance.page,
          capture: {
            document: {
              version: 1,
              title: savedDraft.title.trim(),
              doc: savedDraft.doc
            },
            sources: savedDraft.sources,
            pageTitle: instance.page.title,
            url: instance.page.url,
            includeSource: savedDraft.includeSource
          }
        }
      });
    } catch (error: unknown) {
      response = {
        ok: false,
        error: errorCode(error) === "runtime_message_timeout"
          ? "The extension did not acknowledge delivery. Your draft is still local—try again to reconcile it."
          : errorMessage(error, "Couldn’t save this note.")
      };
    }

    if (instance.contextLost) return;

    if (response?.ok && response.accepted) {
      if (popup !== instance || instance.closed) return;
      instance.accepted = true;
      instance.captureId = response.record?.id || "";
      applyDeliveryRecord(root, instance, response.record);
      if (response.record?.status !== "delivered") pollCaptureStatus(root, instance);
      return;
    }

    instance.saving = false;
    if (popup !== instance || instance.closed) return;
    save.disabled = false;
    save.textContent = "Save";
    save.dataset.action = "save";
    root.querySelector(".close").disabled = false;
    setStatus(root, "Draft preserved");
    showToast(root, "error" in response ? response.error : "Couldn’t save this note.", "error", instance);
    await persistDraft(instance);
  }

  function pollCaptureStatus(root: ComposerRoot, instance: PopupInstance): void {
    if (!instance.captureId || instance.closed || !instance.accepted) return;
    const elapsed = Date.now() - instance.deliveryStartedAt;
    const delay = elapsed < 10_000 ? 500 : 2_000;
    schedule(instance, async () => {
      if (popup !== instance || instance.closed) return;
      let response;
      try {
        response = await sendRuntimeMessage({ type: "GET_CAPTURE_STATUS", id: instance.captureId }, instance);
      } catch {
        if (popup === instance && !instance.closed) {
          applySlowDeliveryState(root, instance);
          pollCaptureStatus(root, instance);
        }
        return;
      }
      if (popup !== instance || instance.closed || instance.contextLost) return;
      if (!response?.ok || !response.record) {
        applySlowDeliveryState(root, instance);
        pollCaptureStatus(root, instance);
        return;
      }
      applyDeliveryRecord(root, instance, response.record);
      if (["pending", "sending"].includes(response.record.status)) pollCaptureStatus(root, instance);
    }, delay, "Couldn’t refresh the delivery status.");
  }

  function applyDeliveryRecord(root: ComposerRoot, instance: PopupInstance, record: CaptureStatusRecord): void {
    const status = record.status;
    const kind = record.lastError?.kind || "";
    if (status === "delivered") {
      instance.safeToClose = true;
      instance.saving = false;
      setStatus(root, "Saved to Notion");
      setPrimaryAction(root, `Saved ${icon("check")}`, "close", false);
      root.querySelector(".close").disabled = false;
      root.querySelector(".safe-close").hidden = true;
      showToast(root, "Saved to Notion", "success", instance);
      schedule(instance, () => {
        if (popup === instance) close(instance);
      }, 700);
      return;
    }

    if (status === "blocked_setup" || status === "blocked_auth") {
      setActionableDeliveryState(root, instance, "Saved locally—reconnect Notion to send", "Reconnect", "settings");
      return;
    }
    if (status === "blocked_destination") {
      setActionableDeliveryState(root, instance, "Saved locally—allow Insert Content or reshare the destination", "Check access", "settings");
      return;
    }
    if (status === "blocked_conflict") {
      setActionableDeliveryState(root, instance, "Notion changed—your local edit is preserved", "Review", "activity");
      return;
    }
    if (status === "uncertain") {
      setActionableDeliveryState(root, instance, "Saved locally—Notion may have received it; review before retrying", "Review", "activity");
      return;
    }
    if (kind === "rate_limited") {
      setActionableDeliveryState(root, instance, "Saved locally—Notion rate limited delivery; retrying", "Close safely", "close", false);
      return;
    }
    if (kind === "offline") {
      setActionableDeliveryState(root, instance, "Saved locally—you’re offline; retrying automatically", "Close safely", "close", false);
      return;
    }
    if (["ambiguous_managed", "timeout"].includes(kind)) {
      setActionableDeliveryState(root, instance, "Saved locally—checking whether Notion received it", "Close safely", "close", false);
      return;
    }

    if (Date.now() - instance.deliveryStartedAt >= 10_000) applySlowDeliveryState(root, instance);
    else {
      setStatus(root, "Sending to Notion…");
      setPrimaryAction(root, "Sending…", "save", true);
      root.querySelector(".close").disabled = true;
    }
  }

  function applySlowDeliveryState(root: ComposerRoot, instance: PopupInstance): void {
    if (Date.now() - instance.deliveryStartedAt < 10_000) return;
    instance.safeToClose = true;
    setStatus(root, "Safe locally—Notion is taking longer");
    setPrimaryAction(root, "Close safely", "close", false);
    root.querySelector(".close").disabled = false;
  }

  function setActionableDeliveryState(root: ComposerRoot, instance: PopupInstance, message: string, label: string, action: PrimaryAction, showSecondaryClose = true): void {
    instance.safeToClose = true;
    setStatus(root, message);
    setPrimaryAction(root, label, action, false);
    root.querySelector(".close").disabled = false;
    root.querySelector(".safe-close").hidden = !showSecondaryClose;
  }

  function setPrimaryAction(root: ComposerRoot, label: string, action: PrimaryAction, disabled: boolean): void {
    const save = root.querySelector(".save");
    save.innerHTML = label;
    save.dataset.action = action;
    save.disabled = disabled;
  }

  function schedule(instance: PopupInstance, callback: () => void | Promise<void>, delay: number, failureMessage = "Quick Note background task failed."): void {
    const timer = setTimeout(() => {
      instance.timers.delete(timer);
      observeInstancePromise(instance, Promise.resolve().then(callback), failureMessage);
    }, delay);
    instance.timers.add(timer);
  }

  function handleRootKeyDown(root: ComposerRoot, event: KeyboardEvent, instance: PopupInstance | undefined = popup): void {
    if (!instance || handledKeyboardEvents.has(event) || event.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && event.shiftKey) {
      event.preventDefault();
      root.querySelector(".save").click();
      return;
    }
    if (event.key === "Escape") {
      const textPalette = root.querySelector('.color-palette[data-palette="text"]');
      const highlightPalette = root.querySelector('.color-palette[data-palette="highlight"]');
      const palette = !textPalette.hidden ? textPalette : !highlightPalette.hidden ? highlightPalette : null;
      if (palette) {
        event.preventDefault();
        palette.hidden = true;
        const trigger = palette === highlightPalette ? root.querySelector('[data-palette-trigger="highlight"]') : root.querySelector('[data-palette-trigger="text"]');
        trigger.setAttribute("aria-expanded", "false");
        trigger.focus();
        return;
      }
      if (!root.querySelector(".format-overflow").hidden) {
        event.preventDefault();
        root.querySelector(".format-overflow").hidden = true;
        root.querySelector(".format-overflow-button").setAttribute("aria-expanded", "false");
        root.querySelector(".format-overflow-button").focus();
        return;
      }
      if (closeTransientUi(root)) {
        event.preventDefault();
        instance.editor?.commands.focus();
      } else {
        event.preventDefault();
        close(instance);
      }
      return;
    }
    if (event.defaultPrevented) return;
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      if (instance.editor?.isActive("taskItem")) {
        event.preventDefault();
        const checked = instance.editor.getAttributes("taskItem").checked === true;
        instance.editor.chain().focus().updateAttributes("taskItem", { checked: !checked }).run();
        return;
      }
      if (instance.editor?.isActive("toggleBlock")) {
        event.preventDefault();
        const open = instance.editor.getAttributes("toggleBlock").open !== false;
        instance.editor.chain().focus().updateAttributes("toggleBlock", { open: !open }).run();
        return;
      }
    }
  }

  function handleEditorKeyDown(root: ComposerRoot, event: KeyboardEvent): boolean {
    const activeEditor = currentEditor(editor);
    if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key === "Enter") {
      handledKeyboardEvents.add(event);
      event.preventDefault();
      root.querySelector(".save").click();
      return true;
    }
    if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key === "Enter") {
      if (activeEditor.isActive("taskItem")) {
        handledKeyboardEvents.add(event);
        event.preventDefault();
        const checked = activeEditor.getAttributes("taskItem").checked === true;
        return activeEditor.chain().focus().updateAttributes("taskItem", { checked: !checked }).run();
      }
      if (activeEditor.isActive("toggleBlock")) {
        handledKeyboardEvents.add(event);
        event.preventDefault();
        const open = activeEditor.getAttributes("toggleBlock").open !== false;
        return activeEditor.chain().focus().updateAttributes("toggleBlock", { open: !open }).run();
      }
    }
    const slash = root.querySelector(".slash-menu");
    if (!slash.hidden) {
      const items = [...slash.querySelectorAll("button")];
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        slashIndex = (slashIndex + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        setSlashActive(items);
        return true;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        items[slashIndex]?.click();
        return true;
      }
      if (event.key === "Escape") {
        handledKeyboardEvents.add(event);
        event.preventDefault();
        slash.hidden = true;
        return true;
      }
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      openLinkEditor(root);
      return true;
    }
    return false;
  }

  function handleLinkPaste(event: ClipboardEvent): boolean {
    const activeEditor = currentEditor(editor);
    const url = event.clipboardData?.getData("text/plain")?.trim();
    const { from, to } = activeEditor.state.selection;
    if (from === to || !isUrl(url)) return false;
    event.preventDefault();
    activeEditor.chain().focus().setLink({ href: url }).run();
    return true;
  }

  function updateEditorUi(root: ComposerRoot): void {
    const activeEditor = currentEditor(editor);
    const characters = activeEditor.getText().length;
    root.querySelector(".character-limit").hidden = characters < MAX_CAPTURE_CHARACTERS * 0.9;
    root.querySelector(".character-limit").textContent = `${characters.toLocaleString()} / ${MAX_CAPTURE_CHARACTERS.toLocaleString()}`;
    if (characters > MAX_CAPTURE_CHARACTERS) root.querySelector(".character-limit").dataset.tone = "error";
    else delete root.querySelector(".character-limit").dataset.tone;
    updateSlashMenu(root);
    updateBubble(root);
  }

  function updateSlashMenu(root: ComposerRoot): void {
    const activeEditor = currentEditor(editor);
    const slash = root.querySelector(".slash-menu");
    const query = slashQuery();
    if (query === null) {
      slash.hidden = true;
      lastSlashQuery = null;
      return;
    }
    const matches = slashCommands.filter((command) => `${command.label} ${command.id}`.toLowerCase().includes(query));
    if (!matches.length) {
      slash.hidden = true;
      lastSlashQuery = query;
      return;
    }
    if (query !== lastSlashQuery) slashIndex = 0;
    lastSlashQuery = query;

    const groups = query
      ? [{ label: "", commands: matches }]
      : [
          { label: "Suggested", commands: suggestedSlashCommandIds.flatMap((id) => {
            const command = slashCommands.find((candidate) => candidate.id === id);
            return command ? [command] : [];
          }) },
          { label: "Basic blocks", commands: slashCommands.filter((command) => command.id !== "code") },
          { label: "Advanced blocks", commands: slashCommands.filter((command) => command.id === "code") }
        ];
    const scroll = document.createElement("div");
    scroll.className = "slash-scroll";
    let optionIndex = 0;
    for (const group of groups) {
      const section = document.createElement("div");
      section.className = "slash-group";
      section.setAttribute("role", "group");
      if (group.label) {
        const heading = document.createElement("div");
        heading.className = "slash-group-label";
        heading.textContent = group.label;
        section.setAttribute("aria-label", group.label);
        section.append(heading);
      }
      for (const command of group.commands) section.append(slashButton(command, optionIndex++, root));
      scroll.append(section);
    }

    const footer = document.createElement("div");
    footer.className = "slash-footer";
    footer.setAttribute("aria-hidden", "true");
    footer.innerHTML = `<span>Type '/' on the page</span><span>esc</span>`;
    slash.replaceChildren(scroll, footer);
    const optionCount = scroll.querySelectorAll("button").length;
    slashIndex = Math.min(slashIndex, optionCount - 1);
    slash.hidden = false;
    positionSlashMenu(root, slash, activeEditor.state.selection.from);
    setSlashActive([...slash.querySelectorAll("button")]);
  }

  function slashQuery(): string | null {
    const activeEditor = currentEditor(editor);
    const { $from, empty } = activeEditor.state.selection;
    if (!empty || !$from.parent.isTextblock) return null;
    const before = $from.parent.textBetween(0, $from.parentOffset, "\n", "\n");
    const match = before.match(/^\/([a-z0-9-]*)$/i);
    return match ? (match[1] || "").toLowerCase() : null;
  }

  function slashButton(command: SlashCommand, index: number, root: ComposerRoot): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "slash-item";
    button.dataset.index = String(index);
    button.setAttribute("role", "option");
    button.setAttribute("aria-label", `${command.label}, ${command.hint}`);
    button.innerHTML = `<span class="command-icon">${commandIcon(command.id)}</span><span class="slash-label">${command.label}</span><kbd>${command.keys}</kbd>`;
    button.addEventListener("mousedown", (event: MouseEvent) => event.preventDefault());
    button.addEventListener("click", () => {
      const activeEditor = currentEditor(editor);
      const { $from } = activeEditor.state.selection;
      const from = $from.start();
      const to = activeEditor.state.selection.from;
      activeEditor.chain().focus().deleteRange({ from, to }).run();
      command.run(activeEditor);
      root.querySelector(".slash-menu").hidden = true;
    });
    return button;
  }

  function setSlashActive(items: HTMLElement[]): void {
    items.forEach((item, index) => {
      item.classList.toggle("active", index === slashIndex);
      item.setAttribute("aria-selected", String(index === slashIndex));
    });
    items[slashIndex]?.scrollIntoView({ block: "nearest" });
  }

  function updateBubble(root: ComposerRoot): void {
    const activeEditor = currentEditor(editor);
    const bubble = root.querySelector(".bubble");
    const { from, to } = activeEditor.state.selection;
    const toolbarFocused = root.activeElement instanceof Element && Boolean(root.activeElement.closest(".bubble, .format-menu, .format-overflow, .color-palette"));
    const shouldShow = (activeEditor.isFocused || toolbarFocused) && from !== to && !root.querySelector(".link-editor").dataset.open;
    bubble.hidden = !shouldShow;
    if (!shouldShow) {
      closeToolbarMenus(root);
      return;
    }
    root.querySelector(".block-type").textContent = currentBlockLabel();
    root.querySelectorAll(".bubble [data-command], .format-overflow [data-command]").forEach((button: HTMLButtonElement) => {
      const command = button.dataset.command;
      const active = command ? activeEditor.isActive(command) : false;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    const link = root.querySelector('[data-command="link"]');
    link.setAttribute("aria-label", activeEditor.isActive("link") ? "Edit link" : "Add link");
    positionFloating(root, bubble, from, to, true);
  }

  function closeToolbarMenus(root: ComposerRoot): void {
    root.querySelector(".format-menu").hidden = true;
    root.querySelector(".format-overflow").hidden = true;
    root.querySelectorAll(".color-palette").forEach((menu) => { menu.hidden = true; });
    root.querySelectorAll(".block-type, .format-overflow-button, [data-palette-trigger]").forEach((button) => button.setAttribute("aria-expanded", "false"));
  }

  function toggleToolbarMenu(root: ComposerRoot, button: HTMLElement, menu: HTMLElement): void {
    const open = menu.hidden;
    closeToolbarMenus(root);
    menu.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
    if (open) positionToolbarMenu(root, menu, button);
  }

  function positionToolbarMenu(root: ComposerRoot, menu: HTMLElement, button: HTMLElement): void {
    const sheet = root.querySelector(".sheet").getBoundingClientRect();
    const anchor = button.getBoundingClientRect();
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(anchor.left - sheet.left, sheet.width - rect.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(anchor.bottom - sheet.top + 4, sheet.height - rect.height - 8))}px`;
  }

  function openPalette(root: ComposerRoot, trigger: HTMLElement, kind: PaletteKind): void {
    const palette = root.querySelector(`.color-palette[data-palette="${kind}"]`);
    root.querySelectorAll(".color-palette").forEach((menu) => { menu.hidden = true; });
    root.querySelectorAll("[data-palette-trigger]").forEach((button) => button.setAttribute("aria-expanded", "false"));
    palette.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    updatePalette(root, palette, kind);
    positionToolbarMenu(root, palette, trigger);
    palette.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
  }

  function updatePalette(root: ComposerRoot, palette: HTMLElement, kind: PaletteKind): void {
    const value = String(currentEditor(editor).getAttributes("notionColor").color || "default");
    palette.querySelectorAll<HTMLButtonElement>(".color-swatch").forEach((button) => {
      const expected = kind === "highlight" && button.dataset.color !== "default" ? `${button.dataset.color}_background` : button.dataset.color;
      button.setAttribute("aria-checked", String(value === expected));
    });
  }

  function applyNotionColor(root: ComposerRoot, color: NotionColorName, kind: PaletteKind): void {
    const chain = currentEditor(editor).chain().focus().unsetMark("notionColor");
    if (color !== "default") chain.setMark("notionColor", { color: kind === "highlight" ? `${color}_background` : color });
    chain.run();
    closeToolbarMenus(root);
  }

  function positionFloating(root: ComposerRoot, element: HTMLElement, from: number, to = from, above = false): void {
    const activeEditor = currentEditor(editor);
    const sheetRect = root.querySelector(".sheet").getBoundingClientRect();
    const start = activeEditor.view.coordsAtPos(from);
    const end = activeEditor.view.coordsAtPos(to);
    const elementRect = element.getBoundingClientRect();
    const halfWidth = elementRect.width / 2;
    const left = Math.max(12 + halfWidth, Math.min((start.left + end.right) / 2 - sheetRect.left, sheetRect.width - 12 - halfWidth));
    const preferredTop = above ? start.top - sheetRect.top - 10 : end.bottom - sheetRect.top + 8;
    const top = Math.max(8 + (above ? elementRect.height : 0), Math.min(preferredTop, sheetRect.height - 8 - (above ? 0 : elementRect.height)));
    element.style.left = `${left}px`;
    element.style.top = `${top}px`;
    element.style.transform = above ? "translate(-50%,-100%)" : "translateX(-50%)";
  }

  function positionSlashMenu(root: ComposerRoot, element: HTMLElement, position: number): void {
    const activeEditor = currentEditor(editor);
    const sheetRect = root.querySelector(".sheet").getBoundingClientRect();
    const caret = activeEditor.view.coordsAtPos(position);
    const margin = 12;
    const gap = 8;

    element.style.maxHeight = "";
    element.style.transform = "none";

    const menuRect = element.getBoundingClientRect();
    const maxLeft = Math.max(margin, sheetRect.width - menuRect.width - margin);
    const preferredLeft = caret.left - sheetRect.left - menuRect.width / 2;
    const left = Math.max(margin, Math.min(preferredLeft, maxLeft));
    const spaceAbove = Math.max(0, caret.top - sheetRect.top - gap - margin);
    const spaceBelow = Math.max(0, sheetRect.bottom - caret.bottom - gap - margin);
    const placeAbove = spaceBelow < menuRect.height && spaceAbove > spaceBelow;
    const availableHeight = placeAbove ? spaceAbove : spaceBelow;

    element.style.left = `${left}px`;
    element.style.maxHeight = `${Math.min(menuRect.height, availableHeight)}px`;

    const fittedHeight = element.getBoundingClientRect().height;
    const preferredTop = placeAbove
      ? caret.top - sheetRect.top - gap - fittedHeight
      : caret.bottom - sheetRect.top + gap;
    const maxTop = Math.max(margin, sheetRect.height - fittedHeight - margin);
    element.style.top = `${Math.max(margin, Math.min(preferredTop, maxTop))}px`;
    element.dataset.placement = placeAbove ? "above" : "below";
  }

  function runInlineCommand(root: ComposerRoot, command: InlineCommand): void {
    if (command === "link") return openLinkEditor(root);
    const chain = currentEditor(editor).chain().focus();
    if (command === "bold") chain.toggleBold().run();
    else if (command === "italic") chain.toggleItalic().run();
    else if (command === "underline") chain.toggleUnderline().run();
    else if (command === "strike") chain.toggleStrike().run();
    else chain.toggleCode().run();
  }

  function runBlockCommand(block: BlockCommand): void {
    const chain = currentEditor(editor).chain().focus();
    if (block === "paragraph") chain.setParagraph().run();
    else if (block === "heading1") chain.toggleHeading({ level: 1 }).run();
    else if (block === "heading2") chain.toggleHeading({ level: 2 }).run();
    else if (block === "heading3") chain.toggleHeading({ level: 3 }).run();
    else if (block === "bulletList") chain.toggleBulletList().run();
    else if (block === "orderedList") chain.toggleOrderedList().run();
    else if (block === "taskList") chain.toggleTaskList().run();
    else if (block === "blockquote") chain.toggleBlockquote().run();
    else if (block === "codeBlock") chain.toggleCodeBlock().run();
  }

  function currentBlockLabel(): string {
    const activeEditor = currentEditor(editor);
    if (activeEditor.isActive("heading", { level: 1 })) return "Heading 1";
    if (activeEditor.isActive("heading", { level: 2 })) return "Heading 2";
    if (activeEditor.isActive("heading", { level: 3 })) return "Heading 3";
    if (activeEditor.isActive("bulletList")) return "Bulleted list";
    if (activeEditor.isActive("orderedList")) return "Numbered list";
    if (activeEditor.isActive("taskList")) return "To-do";
    if (activeEditor.isActive("blockquote")) return "Quote";
    if (activeEditor.isActive("codeBlock")) return "Code";
    return "Text";
  }

  function openLinkEditor(root: ComposerRoot): void {
    const activeEditor = currentEditor(editor);
    const editorElement = root.querySelector(".link-editor");
    const href = String(activeEditor.getAttributes("link").href || "");
    editorElement.dataset.open = "true";
    editorElement.hidden = false;
    root.querySelector(".bubble").hidden = true;
    root.querySelector(".link-input").value = href;
    positionFloating(root, editorElement, activeEditor.state.selection.from, activeEditor.state.selection.to, true);
    root.querySelector(".link-input").focus();
  }

  function closeLinkEditor(root: ComposerRoot): void {
    const link = root.querySelector(".link-editor");
    link.hidden = true;
    delete link.dataset.open;
    currentEditor(editor).commands.focus();
  }

  function applyLink(root: ComposerRoot): void {
    const activeEditor = currentEditor(editor);
    const href = root.querySelector(".link-input").value.trim();
    if (!href) activeEditor.chain().focus().unsetLink().run();
    else activeEditor.chain().focus().extendMarkRange("link").setLink({ href: normalizeUrl(href) }).run();
    closeLinkEditor(root);
  }

  function closeTransientUi(root: ComposerRoot): boolean {
    let closed = false;
    if (!root.querySelector(".ai-panel").hidden) {
      const instance = [...instances].find((candidate) => candidate.root === root);
      instance?.aiController?.abort();
    }
    const transientSelectors = [".page-menu", ".recent-panel", ".source-panel", ".ai-panel", ".slash-menu", ".format-menu", ".link-editor"] as const satisfies readonly ComposerSelector[];
    for (const selector of transientSelectors) {
      const element = root.querySelector(selector);
      if (!element.hidden) {
        element.hidden = true;
        closed = true;
      }
    }
    delete root.querySelector(".link-editor").dataset.open;
    root.querySelector(".more").setAttribute("aria-expanded", "false");
    root.querySelector(".recent").setAttribute("aria-expanded", "false");
    root.querySelector(".ai").setAttribute("aria-expanded", "false");
    return closed;
  }

  function setStatus(root: ComposerRoot, text: string): void {
    root.querySelector(".status").textContent = text;
  }

  function showToast(root: ComposerRoot, text: string, tone: ToastTone, instance: PopupInstance | undefined = popup): void {
    const toast = root.querySelector(".toast");
    toast.textContent = text;
    toast.dataset.tone = tone;
    toast.hidden = false;
    if (instance?.toastTimer !== null && instance?.toastTimer !== undefined) clearTimeout(instance.toastTimer);
    if (instance) {
      instance.toastTimer = setTimeout(() => {
        if (!instance.closed) toast.hidden = true;
      }, tone === "error" ? 5000 : 1800);
    }
  }

  function isUrl(value: string | undefined): value is string {
    if (!value) return false;
    try {
      const url = new URL(normalizeUrl(value));
      return url.protocol === "http:" || url.protocol === "https:";
    } catch {
      return false;
    }
  }

  function normalizeUrl(value: string): string {
    return /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`;
  }

  function commandIcon(id: string): string {
    const type: Record<string, string> = { text: "T", h1: "H1", h2: "H2", h3: "H3" };
    if (type[id]) return `<span class="command-type" aria-hidden="true">${type[id]}</span>`;
    const paths: Record<string, string> = {
      bullet: '<circle cx="4" cy="5" r="1" fill="currentColor"/><circle cx="4" cy="10" r="1" fill="currentColor"/><circle cx="4" cy="15" r="1" fill="currentColor"/><path d="M8 5h10M8 10h10M8 15h10" fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="1.35"/>',
      number: '<path d="M2.8 4.6h1.8V2.7L3 3.5M2.8 9.5c.15-1 .7-1.55 1.45-1.55.7 0 1.2.4 1.2 1 0 .85-1 1.5-2.55 3h2.7M3 15.2c.25.55.75.85 1.35.85.75 0 1.25-.4 1.25-1.05 0-.7-.55-1-1.35-1h-.6l1.6-1.7H3" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.15"/><path d="M9 5h9M9 10h9M9 15h9" fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="1.35"/>',
      todo: '<path d="m2.5 5.4 1.5 1.5 2.8-3.2M9 5.5h9M2.5 12.5h4v4h-4zM9 14.5h9" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.35"/>',
      toggle: '<path d="m3.5 3.5 3 2.5-3 2.5M10 6h8M3.5 11.5l3 2.5-3 2.5M10 14h8" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.35"/>',
      quote: '<path d="M4.25 6.5h3.5v3.6c0 2.4-1.1 4-3.3 4.9M12.25 6.5h3.5v3.6c0 2.4-1.1 4-3.3 4.9" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.45"/>',
      divider: '<path d="M2.5 10h17" fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="1.35"/>',
      code: '<path d="m7.5 5-5 5 5 5M14.5 5l5 5-5 5M12 3 9 17" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.35"/>'
    };
    return `<svg class="command-svg" viewBox="0 0 22 20" aria-hidden="true">${paths[id] || ""}</svg>`;
  }

  function icon(name: IconName): string {
    const paths: Record<IconName, string> = {
      check: '<path d="m3.5 8.25 2.75 2.75 6.25-6.25" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.6"/>',
      close: '<path d="m4 4 8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="1.5"/>',
      more: '<circle cx="3.25" cy="8" r="1" fill="currentColor"/><circle cx="8" cy="8" r="1" fill="currentColor"/><circle cx="12.75" cy="8" r="1" fill="currentColor"/>',
      recent: '<path d="M3.2 5.25A5.25 5.25 0 1 1 2.75 9M3.2 5.25V2.8M3.2 5.25H5.7M8 5v3.35l2.2 1.25" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.35"/>',
      sparkle: '<path d="M8 1.8c.35 2.65 1.55 3.85 4.2 4.2C9.55 6.35 8.35 7.55 8 10.2 7.65 7.55 6.45 6.35 3.8 6 6.45 5.65 7.65 4.45 8 1.8ZM12.3 9.4c.18 1.38.82 2.02 2.2 2.2-1.38.18-2.02.82-2.2 2.2-.18-1.38-.82-2.02-2.2-2.2 1.38-.18 2.02-.82 2.2-2.2Z" fill="currentColor"/>',
      search: '<circle cx="7" cy="7" r="3.75" fill="none" stroke="currentColor" stroke-width="1.35"/><path d="m10 10 3 3" fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="1.35"/>',
      source: '<path d="M6.2 9.8 9.8 6.2M5.15 11.35l-1 .95a2.45 2.45 0 0 1-3.45-3.45l2.2-2.2a2.45 2.45 0 0 1 3.45 0M10.85 4.65l1-.95a2.45 2.45 0 0 1 3.45 3.45l-2.2 2.2a2.45 2.45 0 0 1-3.45 0" fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="1.3"/>',
      open: '<path d="M6 3.5H3.75a1.25 1.25 0 0 0-1.25 1.25v7.5a1.25 1.25 0 0 0 1.25 1.25h7.5a1.25 1.25 0 0 0 1.25-1.25V10M8.5 2.5h5v5M13.25 2.75 7 9" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.35"/>',
      settings: '<circle cx="8" cy="8" r="2.25" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 2.25v1.2M8 12.55v1.2M2.25 8h1.2M12.55 8h1.2M3.93 3.93l.85.85M11.22 11.22l.85.85M12.07 3.93l-.85.85M4.78 11.22l-.85.85" fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="1.4"/>',
      trash: '<path d="M3.5 4.5h9M6 4.5V3h4v1.5M5 6.5l.5 6h5l.5-6M7 7.5v3.5M9 7.5v3.5" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.3"/>'
    };
    return `<svg class="inline-icon" viewBox="0 0 16 16" aria-hidden="true">${paths[name]}</svg>`;
  }

  function palette(kind: PaletteKind): string {
    return `<div class="color-palette" data-palette="${kind}" role="menu" aria-label="${kind === "text" ? "Text color" : "Highlight"}" hidden>${NOTION_COLORS.map((color) => `<button class="color-swatch" type="button" role="menuitemradio" aria-label="${color[0]?.toUpperCase()}${color.slice(1)}" aria-checked="false" data-color="${color}"><span></span>${color[0]?.toUpperCase()}${color.slice(1)}</button>`).join("")}</div>`;
  }

  function template(): string {
    return `
      <link rel="stylesheet" href="${chrome.runtime.getURL("styles/composer.css")}">
      <section class="sheet" role="document" aria-label="Quick note editor">
        <header class="topbar">
          <div class="drag-region" data-composer-drag-region aria-label="Drag Quick Note">
            <span class="status" role="status" aria-live="polite" aria-atomic="true"></span>
          </div>
          <div class="top-actions">
            <button class="top-button more" type="button" aria-label="Note options" aria-haspopup="menu" aria-expanded="false">${icon("more")}</button>
            <button class="top-button recent" type="button" aria-label="Recent notes" aria-haspopup="dialog" aria-expanded="false">${icon("recent")}</button>
            <button class="top-button ai" type="button" aria-label="AI actions" aria-haspopup="dialog" aria-expanded="false" hidden>${icon("sparkle")}</button>
            <button class="safe-close" type="button" hidden>Close safely</button>
            <button class="save" type="button" data-action="save">Save</button>
            <button class="top-button close" type="button" aria-label="Close Quick Note">${icon("close")}</button>
          </div>
        </header>
        <button class="setup" type="button" hidden><strong>One minute of setup</strong><span>Connect Notion and choose where notes land.</span></button>
        <div class="page-menu" role="menu" hidden>
          <div class="menu-heading">Save destination</div>
          <div class="destination-row"><span class="menu-icon">↳</span><span><small>Notion</small><b class="destination-value"></b></span></div>
          <button class="menu-item manage-sources" type="button" role="menuitem"><span class="menu-icon">${icon("source")}</span><span><b>Sources</b><small class="source-count"></small></span><span class="menu-chevron">›</span></button>
          <div class="menu-divider"></div>
          <button class="menu-item open-settings" type="button" role="menuitem"><span class="menu-icon">${icon("settings")}</span><span><b>Settings</b><small>Connection and destination</small></span></button>
          <button class="menu-item discard-draft" type="button" role="menuitem"><span class="menu-icon">${icon("trash")}</span><span><b>Discard draft</b><small>Remove this local draft</small></span></button>
          <div class="menu-shortcut"><span>Save note</span><kbd>⌘ ⇧ ↵</kbd></div>
        </div>
        <section class="recent-panel popover-panel" role="dialog" aria-label="Recent notes" hidden>
          <div class="popover-heading"><div><b>Recent</b><small>Drafts, saved notes, and Notion pages</small></div></div>
          <label class="recent-search-wrap">${icon("search")}<input class="recent-search" type="search" autocomplete="off" placeholder="Search drafts and Notion" aria-label="Search recent notes"></label>
          <div class="recent-list"></div>
        </section>
        <section class="source-panel popover-panel" role="dialog" aria-label="Attached sources" hidden>
          <div class="popover-heading"><div><b>Attached sources</b><small>Up to 20 pages travel with this note</small></div><button class="source-panel-close" type="button" aria-label="Close sources">${icon("close")}</button></div>
          <div class="source-list"></div>
          <div class="source-empty" hidden>No pages are attached.</div>
          <button class="add-current-source" type="button">${icon("source")} Add this page</button>
        </section>
        <section class="ai-panel popover-panel" role="dialog" aria-label="AI actions" hidden>
          <div class="popover-heading"><div><b>AI actions</b><small>Runs on this device only when you choose</small></div><button class="ai-panel-close" type="button" aria-label="Close AI actions">${icon("close")}</button></div>
          <div class="ai-action-list">
            <button class="ai-action" type="button" data-ai-action="title"><span class="ai-action-icon">${icon("sparkle")}</span><span><b>Suggest title</b><small>Create a short title for this note</small></span></button>
            <button class="ai-action" type="button" data-ai-action="todos"><span class="ai-action-icon">${icon("check")}</span><span><b>Extract to-dos</b><small>Find action items and preview task blocks</small></span></button>
          </div>
          <div class="ai-review" hidden>
            <label class="ai-preview-title-wrap"><span>Suggested title</span><input class="ai-preview-title" type="text" maxlength="${MAX_CAPTURE_TITLE_CHARACTERS}" autocomplete="off"></label>
            <label class="ai-preview-todos-wrap" hidden><span>To-dos · one per line</span><textarea class="ai-preview-todos" rows="6"></textarea></label>
            <div class="ai-review-actions"><button class="ai-review-back" type="button">Back</button><button class="ai-apply-title" type="button">Apply title</button><button class="ai-insert-todos" type="button" hidden>Insert below</button></div>
          </div>
          <p class="ai-status" role="status" aria-live="polite"></p>
          <p class="ai-privacy">Generated text stays separate until you apply it. Saving never depends on AI.</p>
        </section>
        <div class="edit-banner" hidden><span class="edit-banner-copy">Editing a recent note</span><span class="conflict-actions" hidden><button class="reload-remote" type="button">Reload latest</button><button class="save-conflict-new" type="button">Save as new</button><button class="open-conflict-remote" type="button">Open in Notion</button></span><button class="return-draft" type="button">Back to stashed draft</button></div>
        <div class="stale-banner" hidden><span>This composer is out of date and is now read-only.</span><button class="reload-draft" type="button">Reload latest</button></div>
        <main class="page">
          <input class="page-title" type="text" maxlength="${MAX_CAPTURE_TITLE_CHARACTERS}" autocomplete="off" aria-label="Note title" placeholder="Untitled">
          <div class="editor"></div>
          <span class="character-limit" hidden></span>
        </main>
        <div class="bubble" role="toolbar" aria-label="Text formatting" hidden>
          <button class="block-type" type="button" aria-haspopup="menu" aria-expanded="false">Text</button>
          <button type="button" data-command="link" aria-label="Add link" aria-pressed="false">${icon("source")}</button>
          <button type="button" data-command="bold" aria-label="Bold"><b>B</b></button>
          <button type="button" data-command="italic" aria-label="Italic"><i>i</i></button>
          <button type="button" data-command="underline" aria-label="Underline"><u>U</u></button>
          <button class="format-overflow-button" type="button" aria-label="More formatting" aria-haspopup="menu" aria-expanded="false">${icon("more")}</button>
        </div>
        <div class="format-menu" role="menu" hidden>
          <button type="button" data-block="paragraph">Text</button>
          <button type="button" data-block="heading1">Heading 1</button>
          <button type="button" data-block="heading2">Heading 2</button>
          <button type="button" data-block="heading3">Heading 3</button>
          <button type="button" data-block="bulletList">Bulleted list</button>
          <button type="button" data-block="orderedList">Numbered list</button>
          <button type="button" data-block="taskList">To-do</button>
          <button type="button" data-block="blockquote">Quote</button>
          <button type="button" data-block="codeBlock">Code</button>
        </div>
        <div class="format-overflow" role="menu" aria-label="More formatting" hidden>
          <button type="button" role="menuitem" data-command="strike" aria-pressed="false"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8h10M5 4.5c.5-1 1.5-1.5 3-1.5 2 0 3 1 3 2M5 11c.7 1.3 1.8 2 3.4 2 1.8 0 2.8-.8 2.8-2" fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="1.3"/></svg><span>Strikethrough</span></button>
          <button type="button" role="menuitem" data-command="code" aria-pressed="false">${commandIcon("code")}<span>Inline code</span></button>
          <button type="button" role="menuitem" data-palette-trigger="text" aria-haspopup="menu" aria-expanded="false"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 13h10M5 10l3-8 3 8M6 7h4" fill="none" stroke="currentColor" stroke-width="1.4"/></svg><span>Text color</span></button>
          <button type="button" role="menuitem" data-palette-trigger="highlight" aria-haspopup="menu" aria-expanded="false"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3 11 6-8 4 3-6 8H3v-3Z" fill="none" stroke="currentColor" stroke-linejoin="round" stroke-width="1.4"/></svg><span>Highlight</span></button>
        </div>
        ${palette("text")}${palette("highlight")}
        <div class="link-editor" hidden><input class="link-input" type="url" aria-label="Link URL" placeholder="Paste a link"><button class="apply-link" type="button">Apply</button></div>
        <div class="slash-menu" role="listbox" aria-label="Block commands" hidden></div>
        <div class="toast" role="alert" hidden></div>
        <div class="resize-handle" data-composer-resize-handle aria-hidden="true"></div>
      </section>`;
  }


  const NotionBlockquote = Blockquote.extend({
    addInputRules() {
      return [wrappingInputRule({ find: /^"\s$/, type: this.type })];
    }
  });

  const NotionStrike = Strike.extend({
    addInputRules() {
      return [
        ...(this.parent?.() || []),
        markInputRule({ find: /(?:^|\s)(~(?!\s+~)([^~]+)~(?!\s+~))$/, type: this.type })
      ];
    }
  });

  const NotionOrderedList = OrderedList.extend({
    addInputRules() {
      return [
        ...(this.parent?.() || []),
        wrappingInputRule({ find: /^(a)\.\s$/i, type: this.type, getAttributes: () => ({ start: 1, type: "a" }) }),
        wrappingInputRule({ find: /^(i)\.\s$/i, type: this.type, getAttributes: () => ({ start: 1, type: "i" }) })
      ];
    }
  });

  const LockedNotionBlock = TiptapNode.create({
    name: "notionBlock",
    group: "block",
    atom: true,
    selectable: false,
    draggable: false,
    addAttributes() {
      return {
        remoteId: { default: "" },
        remoteType: { default: "unsupported" },
        label: { default: "Unsupported Notion block" }
      };
    },
    parseHTML() {
      return [{ tag: "div[data-notion-block-placeholder]" }];
    },
    renderHTML({ HTMLAttributes }) {
      return ["div", { ...HTMLAttributes, "data-notion-block-placeholder": "true", contenteditable: "false" }];
    },
    addNodeView() {
      return ({ node }) => {
        const dom = document.createElement("div");
        dom.className = "notion-block-placeholder";
        dom.dataset.notionBlockPlaceholder = "true";
        dom.contentEditable = "false";
        const label = document.createElement("span");
        label.innerHTML = `<b>Locked Notion block</b><small>${escapeHtml(node.attrs.label || node.attrs.remoteType)}</small>`;
        dom.append(label);
        return { dom, ignoreMutation: () => true, stopEvent: () => true };
      };
    }
  });

  const NotionColor = TiptapMark.create({
    name: "notionColor",
    addAttributes() {
      return { color: { default: "default", parseHTML: (element) => element.dataset.notionColor || "default" } };
    },
    parseHTML() {
      return [{ tag: "span[data-notion-color]" }];
    },
    renderHTML({ HTMLAttributes }) {
      return ["span", { "data-notion-color": HTMLAttributes.color, class: `notion-color-${HTMLAttributes.color}` }, 0];
    }
  });

  const ToggleBlock = TiptapNode.create({
    name: "toggleBlock",
    group: "block",
    content: "inline*",
    defining: true,
    addAttributes() {
      return { open: { default: true } };
    },
    parseHTML() {
      return [{ tag: 'details[data-type="toggle-block"]' }];
    },
    renderHTML({ HTMLAttributes }) {
      return ["details", { ...HTMLAttributes, "data-type": "toggle-block", ...(HTMLAttributes.open ? { open: "" } : {}) }, ["summary", 0]];
    },
    addInputRules() {
      return [new InputRule({
        find: /^>\s$/,
        handler: ({ state, range }) => {
          const { tr } = state;
          tr.delete(range.from, range.to);
          tr.setBlockType(range.from, range.from, this.type);
        }
      })];
    },
    addNodeView() {
      return ({ node, getPos, editor: nodeEditor }) => {
        const dom = document.createElement("details");
        dom.dataset.type = "toggle-block";
        dom.open = node.attrs.open !== false;
        const contentDOM = document.createElement("summary");
        dom.append(contentDOM);
        dom.addEventListener("toggle", () => {
          const position = getPos();
          if (typeof position !== "number") return;
          nodeEditor.commands.command(({ tr }) => {
            tr.setNodeMarkup(position, undefined, { ...node.attrs, open: dom.open });
            return true;
          });
        });
        return {
          dom,
          contentDOM,
          update: (nextNode) => {
            if (nextNode.type !== node.type) return false;
            dom.open = nextNode.attrs.open !== false;
            return true;
          }
        };
      };
    }
  });

  const NotionShortcuts = Extension.create({
    name: "notionShortcuts",
    addKeyboardShortcuts() {
      const blockShortcut = (number: number): (() => boolean) => () => {
        const chain = this.editor.chain().focus();
        if (number === 0) return chain.setParagraph().run();
        if (number === 1) return chain.toggleHeading({ level: 1 }).run();
        if (number === 2) return chain.toggleHeading({ level: 2 }).run();
        if (number === 3) return chain.toggleHeading({ level: 3 }).run();
        if (number === 4) return chain.toggleTaskList().run();
        if (number === 5) return chain.toggleBulletList().run();
        if (number === 6) return chain.toggleOrderedList().run();
        if (number === 7) return chain.setNode("toggleBlock").run();
        return chain.toggleCodeBlock().run();
      };
      const shortcuts: Record<string, () => boolean> = {};
      for (let number = 0; number <= 8; number += 1) {
        shortcuts[`Mod-Alt-${number}`] = blockShortcut(number);
        shortcuts[`Mod-Shift-${number}`] = blockShortcut(number);
      }
      return shortcuts;
    }
  });
})();
