// @ts-nocheck
import { Editor, Extension, InputRule, Mark as TiptapMark, Node as TiptapNode, markInputRule, wrappingInputRule } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Blockquote from "@tiptap/extension-blockquote";
import Link from "@tiptap/extension-link";
import OrderedList from "@tiptap/extension-ordered-list";
import Placeholder from "@tiptap/extension-placeholder";
import Strike from "@tiptap/extension-strike";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import Underline from "@tiptap/extension-underline";
import { MAX_CAPTURE_CHARACTERS, MAX_CAPTURE_TITLE_CHARACTERS } from "./constants.js";
import { enqueueWithReconciliation, withRuntimeMessageDeadline } from "./runtime-message.js";
import { AI_NOTE_LIMITS, cleanNoteTask, extractNoteTodos, languageModelAvailability, suggestNoteTitle } from "./ai-note-actions.js";

(() => {
  const PROTOCOL = 1;
  const DRAFT_VERSION = 2;
  const KEYBOARD_EVENTS = ["keydown", "keypress", "keyup"];
  const handledKeyboardEvents = new WeakSet();
  const slashCommands = [
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

  let popup;
  let editor;
  let slashIndex = 0;
  let lastSlashQuery = null;

  let disposed = false;
  const instances = new Set();

  window.__notionQuickNoteRuntime?.dispose?.();
  delete window.__notionQuickNoteInstalled;
  document.querySelectorAll("[data-notion-quick-note-owned='true']").forEach((element) => element.remove());

  const onMessage = (message, _sender, sendResponse) => {
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
      clearTimeout(surface.draftTimer);
      surface.draftTimer = null;
      void persistDraft(surface)
        .then(() => {
          close(surface, true);
          sendResponse({ ok: true, closed: true });
        })
        .catch((error) => {
          surface.handoff = false;
          sendResponse({ ok: false, error: error?.message || "Draft flush failed." });
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
    else open(message.page, message.draftId, message.tabId, message.sessionId, message.revision);
    return false;
  };

  const openFromPage = ({ page, draftId, tabId, sessionId, revision } = {}) => {
    if (popup) close(popup);
    open(page || { title: "Quick Note", url: "", selection: "" }, draftId, tabId, sessionId, revision);
  };
  const runtime = { protocol: PROTOCOL, dispose };
  chrome.runtime.onMessage.addListener(onMessage);
  window.__notionQuickNoteOpen = openFromPage;
  window.__notionQuickNoteRuntime = runtime;

  function dispose() {
    if (disposed) return;
    disposed = true;
    globalThis.chrome?.runtime?.onMessage?.removeListener?.(onMessage);
    if (window.__notionQuickNoteOpen === openFromPage) delete window.__notionQuickNoteOpen;
    if (window.__notionQuickNoteRuntime === runtime) delete window.__notionQuickNoteRuntime;
    for (const instance of [...instances]) disposePopup(instance);
    document.querySelectorAll("[data-notion-quick-note-owned='true']").forEach((element) => element.remove());
  }

  function open(page, draftId = "", tabId = null, sessionId = crypto.randomUUID(), revision = 0) {
    const previousFocus = document.activeElement;
    const dialog = document.createElement("dialog");
    dialog.id = document.getElementById("notion-quick-note-root")
      ? `notion-quick-note-root-${crypto.randomUUID()}`
      : "notion-quick-note-root";
    dialog.dataset.notionQuickNoteOwned = "true";
    dialog.setAttribute("aria-label", "Notion Quick Note");
    dialog.setAttribute("aria-modal", "true");
    dialog.style.cssText = "all:initial;display:block;position:fixed;inset:auto clamp(12px,2vw,24px) clamp(12px,2vw,24px) auto;width:auto;height:auto;max-width:none;max-height:none;margin:0;padding:0;border:0;background:transparent;overflow:visible";
    const backdropStyle = document.createElement("style");
    backdropStyle.textContent = `#${CSS.escape(dialog.id)}::backdrop{background:transparent}`;
    const surface = document.createElement("div");
    const root = surface.attachShadow({ mode: "open" });
    root.innerHTML = template();
    dialog.append(backdropStyle, surface);

    const instance = {
      host: dialog,
      surface,
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
      targetRecordId: null,
      returnDraftId: null,
      sources: [],
      remote: null,
      baseFingerprint: null,
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
      onFullscreenChange: null,
      removalCount: 0,
      removalObserver: null,
      aiController: null,
      aiAvailability: "checking",
      aiBusy: false
    };
    instances.add(instance);
    popup = instance;

    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      close(instance);
    });
    containKeyboard(instance);
    const initialDraft = normalizeDraft(undefined, instance);
    hydrateShell(root, initialDraft, instance);
    (document.fullscreenElement || document.documentElement).append(dialog);
    dialog.showModal();
    createEditor(root, initialDraft, instance);
    wire(root, instance);
    instance.editor.commands.focus("end");

    instance.onFullscreenChange = () => promoteAfterFullscreenChange(instance);
    document.addEventListener("fullscreenchange", instance.onFullscreenChange);
    const stylesheet = root.querySelector("link[rel=stylesheet]");
    stylesheet.addEventListener("load", () => {
      const sheet = root.querySelector(".sheet");
      sheet.style.removeProperty("display");
      requestAnimationFrame(() => {
        if (popup === instance && !instance.closed) sheet.classList.add("visible");
      });
    }, { once: true });
    stylesheet.addEventListener("error", () => fallbackFromOverlay(instance), { once: true });
    instance.removalObserver = new MutationObserver(() => recoverRemovedOverlay(instance));
    instance.removalObserver.observe(document, { childList: true, subtree: true });

    instance.settingsPromise = sendRuntimeMessage({ type: "GET_QUICK_SETTINGS" }, instance)
      .then((settings) => {
        instance.settings = settings || {};
        if (popup === instance && !instance.closed) hydrateSettings(instance);
        return instance.settings;
      })
      .catch((error) => {
        instance.settings = {};
        if (popup === instance && !instance.closed) {
          setStatus(instance.root, "Settings unavailable");
          showToast(instance.root, error?.message || "Quick Note could not load settings.", "error", instance);
        }
        return instance.settings;
      });
    void hydrateDraft(instance).catch((error) => {
      if (popup === instance && !instance.closed && !instance.contextLost) {
        setStatus(instance.root, "Draft not loaded");
        showToast(instance.root, error?.message || "Quick Note could not load the local draft.", "error", instance);
      }
    });
  }

  function containKeyboard(instance) {
    for (const type of KEYBOARD_EVENTS) {
      instance.root.addEventListener(type, (event) => {
        if (type === "keydown") handleRootKeyDown(instance.root, event, instance);
        event.stopPropagation();
      });
      instance.host.addEventListener(type, (event) => event.stopPropagation());
    }
  }

  function promoteAfterFullscreenChange(instance) {
    requestAnimationFrame(() => {
      if (popup !== instance || instance.closed || !instance.host.isConnected) return;
      const menuButton = instance.root.querySelector(".more");
      const active = menuButton.getAttribute("aria-expanded") === "true"
        ? menuButton
        : instance.root.activeElement || instance.root.querySelector(".ProseMirror");
      if (instance.host.open) instance.host.close();
      const fullscreenContainer = document.fullscreenElement || document.documentElement;
      if (instance.host.parentElement !== fullscreenContainer) fullscreenContainer.append(instance.host);
      instance.host.showModal();
      active?.focus({ preventScroll: true });
      requestAnimationFrame(() => {
        if (popup === instance && !instance.closed) active?.focus({ preventScroll: true });
      });
    });
  }

  function recoverRemovedOverlay(instance) {
    if (instance.closed || instance.host.isConnected) return;
    instance.removalCount += 1;
    if (instance.removalCount === 1) {
      (document.fullscreenElement || document.documentElement).append(instance.host);
      return;
    }
    fallbackFromOverlay(instance);
  }

  function fallbackFromOverlay(instance) {
    if (instance.closed) return;
    void persistDraft(instance)
      .catch(() => undefined)
      .finally(() => sendRuntimeMessage({ type: "OPEN_COMPOSER_FALLBACK", draftId: instance.draftId }, instance));
    close(instance, true);
  }

  function close(instance = popup, force = false) {
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
    instance.removalObserver?.disconnect();
    if (!instance.accepted && !instance.handoff) void persistDraft(instance).catch(() => undefined);
    void sendRuntimeMessage({ type: "RELEASE_COMPOSER_SURFACE", sessionId: instance.sessionId }, instance).catch(() => undefined);

    const sheet = instance.root.querySelector(".sheet");
    sheet.classList.remove("visible");
    instance.surface.classList.add("closing");
    instance.host.removeAttribute("id");
    instance.host.style.pointerEvents = "none";
    if (instance.host.open) instance.host.close();
    restoreFocus(instance.previousFocus);

    const delay = matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 150;
    schedule(instance, () => {
      instance.editor?.destroy();
      instance.host.remove();
      instances.delete(instance);
      if (!popup) restoreFocus(instance.previousFocus);
    }, delay);
  }

  function disposePopup(instance) {
    instance.closed = true;
    if (popup === instance) popup = undefined;
    if (editor === instance.editor) editor = undefined;
    if (!instance.accepted && !instance.handoff && !instance.contextLost) void persistDraft(instance).catch(() => undefined);
    stopTimers(instance);
    document.removeEventListener("fullscreenchange", instance.onFullscreenChange);
    instance.removalObserver?.disconnect();
    if (instance.host.open) instance.host.close();
    instance.editor?.destroy();
    instance.host.remove();
    instances.delete(instance);
  }

  function stopTimers(instance) {
    clearTimeout(instance.draftTimer);
    clearTimeout(instance.draftFeedbackTimer);
    clearTimeout(instance.toastTimer);
    instance.draftTimer = null;
    instance.draftFeedbackTimer = null;
    instance.toastTimer = null;
    instance.aiController?.abort();
    instance.aiController = null;
    for (const timer of instance.timers) clearTimeout(timer);
    instance.timers.clear();
  }

  function isContextLossError(error) {
    if (error?.code === "quick_note_context_lost") return true;
    const message = String(error?.message || error || "").toLowerCase();
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

  function contextLossError() {
    const error = new Error("Quick Note extension context is unavailable.");
    error.code = "quick_note_context_lost";
    return error;
  }

  async function sendRuntimeMessage(message, instance = popup) {
    try {
      const runtime = globalThis.chrome?.runtime;
      if (!runtime?.id || typeof runtime.sendMessage !== "function") throw contextLossError();
      return await withRuntimeMessageDeadline(runtime.sendMessage(message));
    } catch (error) {
      if (!isContextLossError(error)) throw error;
      handleContextLoss(instance);
      return undefined;
    }
  }

  async function accessSessionStorage(method, value, instance = popup) {
    try {
      const storage = globalThis.chrome?.storage?.session;
      if (typeof storage?.[method] !== "function") throw contextLossError();
      return await storage[method](value);
    } catch (error) {
      if (!isContextLossError(error)) throw error;
      handleContextLoss(instance);
      return undefined;
    }
  }

  function handleContextLoss(instance = popup) {
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

  function restoreFocus(element) {
    if (!(element instanceof HTMLElement) || !element.isConnected) return;
    try {
      element.focus({ preventScroll: true });
    } catch {
      element.focus();
    }
  }

  async function hydrateDraft(instance) {
    let response;
    try {
      response = await sendRuntimeMessage({
        type: "GET_OR_CREATE_DRAFT",
        draftId: instance.draftId,
        tabId: instance.tabId,
        sessionId: instance.sessionId,
        context: instance.page,
        includeSource: instance.settings?.includeSource !== false
      }, instance);
    } catch (error) {
      if (!isContextLossError(error)) throw error;
      response = {};
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

  function normalizeDraft(value, instance = popup) {
    if (value?.doc?.type === "doc") {
      return {
        ...value,
        version: DRAFT_VERSION,
        mode: value.mode === "edit" ? "edit" : "new",
        sources: normalizeSources(value.sources || (value.context?.url ? [value.context] : [])),
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

  function applyDraftToInstance(root, instance, draftValue) {
    const draft = normalizeDraft(draftValue, instance);
    instance.draftId = draft.id || instance.draftId;
    instance.revision = Number(draft.revision) || 0;
    instance.sessionId = draft.sessionId || instance.sessionId;
    instance.mode = draft.mode || "new";
    instance.targetRecordId = draft.targetRecordId || null;
    instance.returnDraftId = draft.returnDraftId || null;
    instance.sources = normalizeSources(draft.sources || sourceFromPage(draft.context || instance.page));
    instance.remote = draft.remote || null;
    instance.baseFingerprint = draft.baseFingerprint || null;
    instance.conflict = Boolean(draft.conflict);
    instance.draftDirty = false;
    root.querySelector(".page-title").value = draft.title || "";
    instance.editor.commands.setContent(draft.doc, { emitUpdate: false });
    renderSources(root, instance);
    renderEditBanner(root, instance);
    instance.userEdited = false;
    instance.editor.setEditable(true);
    root.querySelector(".page-title").readOnly = false;
    configureAiFeatures(instance);
    instance.editor.commands.focus("end");
    updateEditorUi(root);
  }

  function sourceFromPage(page = {}) {
    return page.url ? [{ title: page.title || hostname(page.url), url: page.url, capturedAt: Date.now() }] : [];
  }

  function normalizeSources(sources = []) {
    const seen = new Set();
    return sources.flatMap((source) => {
      if (!source?.url) return [];
      let key;
      try {
        const url = new URL(source.url);
        url.hash = "";
        key = url.href;
      } catch {
        key = source.url;
      }
      if (seen.has(key)) return [];
      seen.add(key);
      return [{ title: source.title || hostname(source.url), url: source.url, capturedAt: source.capturedAt || Date.now() }];
    }).slice(0, 20);
  }

  function paragraphDocument(text) {
    return {
      type: "doc",
      content: [{ type: "paragraph", ...(text ? { content: [{ type: "text", text }] } : {}) }]
    };
  }

  function hydrateShell(root, draft, instance) {
    root.querySelector(".page-title").value = draft.title || "";
    root.querySelectorAll(".destination-value").forEach((element) => { element.textContent = "Notion Inbox"; });
    instance.sources = normalizeSources(draft.sources || sourceFromPage(instance.page));
    renderSources(root, instance);
  }

  function hydrateSettings(instance) {
    instance.root.querySelectorAll(".destination-value").forEach((element) => {
      element.textContent = instance.settings.destinationName || "Notion Inbox";
    });
    const setup = instance.root.querySelector(".setup");
    setup.hidden = instance.settings.configured !== false;
    setup.querySelector("strong").textContent = instance.settings.connected ? "Finish setup" : "One minute of setup";
    setup.querySelector("span").textContent = instance.settings.connected
      ? "Your token is connected. Choose where notes should land."
      : "Connect Notion and choose where notes should land.";
    configureAiFeatures(instance);
    renderSources(instance.root, instance);
  }

  function hostname(url) {
    try {
      return new URL(url).hostname;
    } catch {
      return url;
    }
  }

  function createEditor(root, draft, instance) {
    instance.editor = new Editor({
      element: root.querySelector(".editor"),
      extensions: [
        StarterKit.configure({
          blockquote: false,
          link: false,
          orderedList: false,
          strike: false,
          underline: false
        }),
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
    editor = instance.editor;
    updateEditorUi(root);
  }

  function wire(root, instance) {
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
    title.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        editor.commands.focus("start");
      }
    });

    root.querySelector(".close").addEventListener("click", () => close(instance));
    root.querySelector(".safe-close").addEventListener("click", () => close(instance));
    menuButton.addEventListener("click", (event) => {
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
      if (willOpen) void loadRecents(root, instance, "");
    });
    aiButton.addEventListener("click", (event) => {
      if (!event.isTrusted) return;
      const willOpen = aiPanel.hidden;
      closeTransientUi(root);
      if (willOpen) {
        void openAiPanel(instance);
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
    root.querySelectorAll("[data-ai-action]").forEach((button) => {
      button.addEventListener("click", (event) => {
        if (event.isTrusted) void runAiAction(instance, button.dataset.aiAction);
      });
    });
    root.querySelector(".ai-review-back").addEventListener("click", () => showAiActions(root));
    root.querySelector(".ai-apply-title").addEventListener("click", () => applyAiTitle(instance));
    root.querySelector(".ai-insert-todos").addEventListener("click", () => insertAiTodos(instance));
    root.querySelector(".recent-search").addEventListener("input", (event) => {
      void loadRecents(root, instance, event.currentTarget.value);
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
      instance.sources = normalizeSources([...instance.sources, ...sourceFromPage(instance.page)]);
      instance.userEdited = true;
      renderSources(root, instance);
      scheduleDraft(instance);
    });
    root.querySelector(".open-settings").addEventListener("click", () => {
      void sendRuntimeMessage({ type: "OPEN_SETTINGS" }, instance);
    });
    root.querySelector(".setup").addEventListener("click", () => {
      void sendRuntimeMessage({ type: "OPEN_SETTINGS" }, instance);
    });
    root.querySelector(".discard-draft").addEventListener("click", async () => {
      const response = await sendRuntimeMessage({ type: "DISCARD_DRAFT", id: instance.draftId }, instance).catch((error) => {
        if (isContextLossError(error)) return null;
        throw error;
      });
      if (instance.contextLost) return;
      if (!response?.ok) {
        showToast(root, response?.error || "Couldn’t discard this draft.", "error", instance);
        return;
      }
      instance.accepted = true;
      close(instance);
    });
    root.querySelector(".return-draft").addEventListener("click", async () => {
      if (!instance.returnDraftId) return;
      clearTimeout(instance.draftTimer);
      instance.draftTimer = null;
      await persistDraft(instance);
      const response = await sendRuntimeMessage({ type: "ACTIVATE_DRAFT", id: instance.returnDraftId, sessionId: instance.sessionId }, instance);
      if (!response?.ok || !response.draft) {
        showToast(root, response?.error || "Couldn’t restore the stashed draft.", "error", instance);
        return;
      }
      applyDraftToInstance(root, instance, response.draft);
      showToast(root, "Stashed draft restored", "success", instance);
    });
    root.querySelector(".reload-remote").addEventListener("click", async () => {
      const response = await sendRuntimeMessage({
        type: "LOAD_RECENT_NOTE",
        id: instance.targetRecordId,
        sessionId: instance.sessionId,
        reloadLatest: true
      }, instance);
      if (!response?.ok || !response.draft) {
        showToast(root, response?.error || "Couldn’t reload the latest Notion version.", "error", instance);
        return;
      }
      applyDraftToInstance(root, instance, response.draft);
      setStatus(root, "Latest Notion version loaded");
    });
    root.querySelector(".save-conflict-new").addEventListener("click", async () => {
      const response = await sendRuntimeMessage({ type: "CONVERT_EDIT_TO_NEW_DRAFT", id: instance.draftId }, instance);
      if (!response?.ok || !response.draft) {
        showToast(root, response?.error || "Couldn’t prepare a new note.", "error", instance);
        return;
      }
      applyDraftToInstance(root, instance, response.draft);
      await saveCapture(root, instance);
    });
    root.querySelector(".open-conflict-remote").addEventListener("click", () => {
      void sendRuntimeMessage({ type: "OPEN_CAPTURE_RESULT", id: instance.targetRecordId }, instance);
    });
    root.querySelector(".reload-draft").addEventListener("click", async () => {
      const response = await sendRuntimeMessage({
        type: "GET_OR_CREATE_DRAFT",
        tabId: instance.tabId,
        sessionId: instance.sessionId,
        context: instance.page
      }, instance);
      if (!response?.ok || !response.draft) {
        showToast(root, response?.error || "Couldn’t reload the latest draft.", "error", instance);
        return;
      }
      root.querySelector(".stale-banner").hidden = true;
      applyDraftToInstance(root, instance, response.draft);
      setStatus(root, "Latest draft loaded");
    });
    save.addEventListener("click", () => {
      const action = save.dataset.action || "save";
      if (action === "close") return close(instance);
      if (action === "settings") return void sendRuntimeMessage({ type: "OPEN_SETTINGS" }, instance);
      if (action === "activity") return void sendRuntimeMessage({ type: "OPEN_ACTIVITY" }, instance);
      return saveCapture(root, instance);
    });

    root.querySelectorAll(".bubble [data-command]").forEach((button) => {
      button.addEventListener("mousedown", (event) => event.preventDefault());
      button.addEventListener("click", () => runInlineCommand(root, button.dataset.command));
    });
    root.querySelector(".block-type").addEventListener("mousedown", (event) => event.preventDefault());
    root.querySelector(".block-type").addEventListener("click", () => {
      root.querySelector(".format-menu").hidden = !root.querySelector(".format-menu").hidden;
    });
    root.querySelectorAll(".format-menu [data-block]").forEach((button) => {
      button.addEventListener("mousedown", (event) => event.preventDefault());
      button.addEventListener("click", () => {
        runBlockCommand(button.dataset.block);
        root.querySelector(".format-menu").hidden = true;
      });
    });
    root.querySelector(".link-input").addEventListener("keydown", (event) => {
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

    root.addEventListener("mousedown", (event) => {
      if (!event.composedPath().some((item) => item === menu || item === menuButton)) {
        menu.hidden = true;
        menuButton.setAttribute("aria-expanded", "false");
      }
    });
  }

  function configureAiFeatures(instance) {
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

  function aiActionsAllowed(instance) {
    return !instance.closed
      && !instance.contextLost
      && instance.editor?.isEditable !== false
      && !instance.root.querySelector(".page-title").readOnly;
  }

  function aiActionEnabled(instance, action) {
    if (instance.settings?.aiEnabled === false) return false;
    if (action === "title") return instance.settings?.aiSuggestTitle !== false;
    if (action === "todos") return instance.settings?.aiExtractTodos !== false;
    return false;
  }

  async function refreshAiSettings(instance) {
    const latest = await sendRuntimeMessage({ type: "GET_QUICK_SETTINGS" }, instance);
    if (!latest || instance.closed) return false;
    instance.settings = { ...instance.settings, ...latest };
    configureAiFeatures(instance);
    return true;
  }

  async function openAiPanel(instance) {
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

  async function refreshAiAvailability(instance) {
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

  async function runAiAction(instance, action) {
    if (instance.aiBusy || !aiActionsAllowed(instance)) return;
    const root = instance.root;
    if (!await refreshAiSettings(instance) || !aiActionEnabled(instance, action)) {
      showToast(root, "This AI action is turned off in Settings.", "error", instance);
      return;
    }
    const note = instance.editor.getText().trim();
    if (!note) {
      showToast(root, "Write something before using an AI action.", "error", instance);
      instance.editor.commands.focus();
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
      availability: instance.aiAvailability,
      onStateChange(state) {
        if (state === "downloadable") setAiStatus(root, "Preparing Chrome’s on-device model…");
        else if (state === "downloading") setAiStatus(root, "Downloading Chrome’s on-device model…");
        else if (state === "generating") setAiStatus(root, action === "title" ? "Suggesting a title…" : "Finding action items…");
      },
      onDownloadProgress(progress) {
        setAiStatus(root, `Downloading Chrome’s on-device model… ${Math.round(progress * 100)}%`);
      }
    };

    try {
      const result = action === "title"
        ? await suggestNoteTitle(context, callbacks)
        : await extractNoteTodos(context, callbacks);
      const currentContextKey = JSON.stringify({
        note: instance.editor.getText().trim(),
        pageTitle: instance.sources.some((source) => sameUrl(source.url, instance.page?.url)) ? instance.page?.title || "" : "",
        sourceTitles: instance.sources.map((source) => source.title)
      });
      if (instance.aiController !== controller || root.querySelector(".ai-panel").hidden || currentContextKey !== contextKey) return;
      if (!await refreshAiSettings(instance) || !aiActionEnabled(instance, action) || !aiActionsAllowed(instance)) {
        showToast(root, "This AI action was turned off before its result was applied.", "error", instance);
        return;
      }
      if (action === "title") renderAiTitleReview(root, result);
      else {
        const tasks = result;
        if (!tasks.length) {
          setAiStatus(root, "No clear action items found. Nothing changed.");
        } else renderAiTodosReview(root, tasks);
      }
      instance.aiAvailability = "available";
    } catch (error) {
      if (error?.name !== "AbortError" && !instance.closed) {
        if (error?.code === "unavailable") instance.aiAvailability = "unavailable";
        setAiStatus(root, error?.message || "On-device AI couldn’t finish this action.", "error");
      }
    } finally {
      instance.aiBusy = false;
      instance.aiController = null;
      if (!instance.closed) setAiActionButtonsDisabled(root, instance.aiAvailability === "unavailable");
    }
  }

  function renderAiTitleReview(root, title) {
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

  function renderAiTodosReview(root, tasks) {
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

  function showAiActions(root) {
    root.querySelector(".ai-review").hidden = true;
    root.querySelector(".ai-action-list").hidden = false;
    setAiStatus(root, "Ready on this device.");
    root.querySelector("[data-ai-action]:not([hidden])")?.focus();
  }

  function applyAiTitle(instance) {
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

  function insertAiTodos(instance) {
    const root = instance.root;
    if (!aiActionsAllowed(instance) || !aiActionEnabled(instance, "todos")) return;
    const tasks = root.querySelector(".ai-preview-todos").value.split(/\r?\n/)
      .map(cleanNoteTask)
      .filter(Boolean)
      .slice(0, AI_NOTE_LIMITS.tasks);
    if (!tasks.length) return showToast(root, "Keep at least one task before inserting.", "error", instance);
    const currentCharacters = Array.from(instance.editor.getText()).length;
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
    instance.editor.chain().focus("end").insertContent(taskList).run();
    closeTransientUi(root);
    instance.editor.commands.focus("end");
    showToast(root, `${tasks.length} ${tasks.length === 1 ? "to-do" : "to-dos"} inserted`, "success", instance);
  }

  function setAiActionButtonsDisabled(root, disabled) {
    root.querySelectorAll("[data-ai-action]").forEach((button) => { button.disabled = disabled; });
  }

  function setAiStatus(root, text, tone = "") {
    const status = root.querySelector(".ai-status");
    status.textContent = text;
    status.dataset.tone = tone;
  }

  function renderSources(root, instance) {
    const sources = normalizeSources(instance.sources);
    instance.sources = sources;
    root.querySelectorAll(".source-count").forEach((node) => {
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

  function renderEditBanner(root, instance) {
    const banner = root.querySelector(".edit-banner");
    banner.hidden = instance.mode !== "edit";
    if (banner.hidden) return;
    root.querySelector(".edit-banner-copy").textContent = instance.conflict
      ? "Notion changed · your local edit is preserved"
      : instance.returnDraftId ? "Editing a recent note · your draft is stashed" : "Editing a recent note";
    root.querySelector(".return-draft").hidden = !instance.returnDraftId;
    root.querySelector(".conflict-actions").hidden = !instance.conflict;
  }

  async function loadRecents(root, instance, query) {
    const panel = root.querySelector(".recent-panel");
    const list = root.querySelector(".recent-list");
    const requestId = crypto.randomUUID();
    panel.dataset.requestId = requestId;
    list.innerHTML = '<div class="popover-state">Loading recent notes…</div>';
    const response = await sendRuntimeMessage({ type: "LIST_RECENT_NOTES", query, limit: query.trim() ? 100 : 5 }, instance).catch((error) => ({ ok: false, error: error?.message }));
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

  function renderRecents(root, instance, groups) {
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

  function recentSectionHeading(title, subtitle) {
    const heading = document.createElement("div");
    heading.className = "recent-section";
    const label = document.createElement("b");
    label.textContent = title;
    const hint = document.createElement("small");
    hint.textContent = subtitle;
    heading.append(label, hint);
    return heading;
  }

  function recentRow(root, instance, record) {
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
    edit.addEventListener("click", () => void openRecentItem(root, instance, record));
    const openRemote = document.createElement("button");
    openRemote.type = "button";
    openRemote.className = "recent-open";
    openRemote.innerHTML = icon("open");
    openRemote.setAttribute("aria-label", `Open ${record.title || "note"} in Notion`);
    openRemote.hidden = !record.remoteUrl || record.source === "draft";
    openRemote.addEventListener("click", () => void sendRuntimeMessage({
      type: "OPEN_CAPTURE_RESULT",
      id: record.source === "notion" ? "" : record.id,
      url: record.remoteUrl || ""
    }, instance));
    row.append(edit, openRemote);
    return row;
  }

  async function openRecentItem(root, instance, record) {
    if (record.source === "draft") return void openRecentDraft(root, instance, record.id);
    if (record.source === "notion") return void openNotionPage(root, instance, record);
    if (record.editable === false) {
      return void sendRuntimeMessage({ type: "OPEN_CAPTURE_RESULT", id: record.id, url: record.remoteUrl || "" }, instance);
    }
    return void openRecentNote(root, instance, record.id);
  }

  async function openRecentDraft(root, instance, draftId) {
    if (!draftId || draftId === instance.draftId) {
      closeTransientUi(root);
      return;
    }
    try {
      clearTimeout(instance.draftTimer);
      instance.draftTimer = null;
      await persistDraft(instance);
      setStatus(root, "Opening draft…");
      const response = await sendRuntimeMessage({ type: "ACTIVATE_DRAFT", id: draftId, sessionId: instance.sessionId }, instance);
      if (!response?.ok || !response.draft) throw new Error(response?.error || "Couldn’t open this draft.");
      applyDraftToInstance(root, instance, response.draft);
      closeTransientUi(root);
      setStatus(root, "Editing draft");
    } catch (error) {
      setStatus(root, "Draft preserved");
      showToast(root, error?.message || "Couldn’t open this draft.", "error", instance);
    }
  }

  async function openNotionPage(root, instance, record) {
    try {
      clearTimeout(instance.draftTimer);
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
      if (!response?.ok || !response.draft) throw new Error(response?.error || "Couldn’t load this Notion page.");
      applyDraftToInstance(root, instance, { ...response.draft, conflict: response.conflict });
      closeTransientUi(root);
      setStatus(root, "Editing Notion page");
    } catch (error) {
      setStatus(root, "Draft preserved");
      showToast(root, error?.message || "Couldn’t load this Notion page.", "error", instance);
    }
  }

  async function openRecentNote(root, instance, recordId) {
    try {
      clearTimeout(instance.draftTimer);
      instance.draftTimer = null;
      await persistDraft(instance);
      setStatus(root, "Loading latest from Notion…");
      const response = await sendRuntimeMessage({ type: "LOAD_RECENT_NOTE", id: recordId, sessionId: instance.sessionId }, instance);
      if (!response?.ok || !response.draft) throw new Error(response?.error || "Couldn’t load this note.");
      applyDraftToInstance(root, instance, { ...response.draft, conflict: response.conflict });
      closeTransientUi(root);
      setStatus(root, "Editing recent note");
    } catch (error) {
      setStatus(root, "Draft preserved");
      showToast(root, error?.message || "Couldn’t load this note.", "error", instance);
    }
  }

  function recentSubtitle(record) {
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

  function truncatePreview(value, limit) {
    const characters = Array.from(String(value || "").replace(/\s+/g, " ").trim());
    return characters.length > limit ? `${characters.slice(0, limit).join("").trimEnd()}…` : characters.join("");
  }

  function relativeTime(timestamp) {
    const elapsed = Math.max(0, Date.now() - Number(timestamp || 0));
    if (elapsed < 60_000) return "Just now";
    if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
    if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
    return `${Math.floor(elapsed / 86_400_000)}d ago`;
  }

  function sameUrl(left, right) {
    return normalizeSources([{ url: left }, { url: right }]).length === 1;
  }

  function escapeHtml(value) {
    const span = document.createElement("span");
    span.textContent = String(value || "");
    return span.innerHTML;
  }

  function scheduleDraft(instance = popup) {
    if (!instance || instance.closed || instance.contextLost || instance.accepted) return;
    instance.draftDirty = true;
    clearTimeout(instance.draftTimer);
    clearTimeout(instance.draftFeedbackTimer);
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
        clearTimeout(instance.draftFeedbackTimer);
        instance.draftFeedbackTimer = null;
        if (saved && popup === instance && !instance.closed && !instance.contextLost) {
          const status = instance.root.querySelector(".status");
          if (showingSlowFeedback && status.textContent === "Saving locally…") setStatus(instance.root, "");
          if (status.textContent === "Local backup failed") setStatus(instance.root, "");
        }
      } catch (error) {
        clearTimeout(instance.draftFeedbackTimer);
        instance.draftFeedbackTimer = null;
        if (popup === instance && !instance.closed && !instance.contextLost) {
          setStatus(instance.root, "Local backup failed");
          showToast(instance.root, error?.message || "Local draft storage is unavailable.", "error", instance);
        }
      }
    }, 180);
  }

  function persistDraft(instance = popup, { force = true } = {}) {
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

  async function drainDraftWrites(instance) {
    let latestSnapshot = null;
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

  function draftSnapshot(instance) {
    const root = instance.root;
    return {
      version: DRAFT_VERSION,
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
      includeSource: instance.sources.length > 0,
      doc: instance.editor.getJSON()
    };
  }

  async function writeDraftSnapshot(instance, snapshot) {
    const response = await sendRuntimeMessage({
      type: "UPSERT_DRAFT",
      expectedRevision: snapshot.revision,
      draft: snapshot
    }, instance);
    if (response?.ok === false) {
      if (response.code === "stale_draft") markStaleDraft(instance);
      const error = new Error(response.error || "Local draft storage is unavailable.");
      error.code = response.code;
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

  function markStaleDraft(instance) {
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

  async function saveCapture(root, instance) {
    if (instance.saving || instance.contextLost) return;
    await (instance.settings || instance.settingsPromise);
    if (popup !== instance || instance.closed) return;
    if (!instance.editor.getText().trim()) {
      showToast(root, "Write something before saving.", "error");
      instance.editor.commands.focus();
      return;
    }

    clearTimeout(instance.draftTimer);
    clearTimeout(instance.draftFeedbackTimer);
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
    } catch (error) {
      instance.saving = false;
      save.disabled = false;
      save.textContent = "Save";
      root.querySelector(".close").disabled = false;
      setStatus(root, "Draft not saved");
      showToast(root, error?.message || "Local storage is unavailable. Keep this composer open and try again.", "error", instance);
      return;
    }
    if (instance.contextLost) return;
    savedDraft ||= draftSnapshot(instance);

    let response;
    try {
      response = await enqueueWithReconciliation({
        send: (message) => sendRuntimeMessage(message, instance),
        draftId: instance.draftId,
        message: {
          type: "ENQUEUE_CAPTURE",
          draftId: instance.draftId,
          context: instance.page,
          capture: {
            document: {
              version: DRAFT_VERSION,
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
    } catch (error) {
      response = {
        ok: false,
        error: error?.code === "runtime_message_timeout"
          ? "The extension did not acknowledge delivery. Your draft is still local—try again to reconcile it."
          : error?.message
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
    showToast(root, response?.error || "Couldn’t save this note.", "error", instance);
    await persistDraft(instance);
  }

  function pollCaptureStatus(root, instance) {
    if (!instance.captureId || instance.closed || !instance.accepted) return;
    const elapsed = Date.now() - instance.deliveryStartedAt;
    const delay = elapsed < 10_000 ? 500 : 2_000;
    schedule(instance, async () => {
      if (popup !== instance || instance.closed) return;
      let response;
      try {
        response = await sendRuntimeMessage({ type: "GET_CAPTURE_STATUS", id: instance.captureId }, instance);
      } catch (error) {
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
    }, delay);
  }

  function applyDeliveryRecord(root, instance, record = {}) {
    const status = record?.status;
    const kind = record?.lastError?.kind || "";
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

  function applySlowDeliveryState(root, instance) {
    if (Date.now() - instance.deliveryStartedAt < 10_000) return;
    instance.safeToClose = true;
    setStatus(root, "Safe locally—Notion is taking longer");
    setPrimaryAction(root, "Close safely", "close", false);
    root.querySelector(".close").disabled = false;
  }

  function setActionableDeliveryState(root, instance, message, label, action, showSecondaryClose = true) {
    instance.safeToClose = true;
    setStatus(root, message);
    setPrimaryAction(root, label, action, false);
    root.querySelector(".close").disabled = false;
    root.querySelector(".safe-close").hidden = !showSecondaryClose;
  }

  function setPrimaryAction(root, label, action, disabled) {
    const save = root.querySelector(".save");
    save.innerHTML = label;
    save.dataset.action = action;
    save.disabled = disabled;
  }

  function schedule(instance, callback, delay) {
    const timer = setTimeout(() => {
      instance.timers.delete(timer);
      callback();
    }, delay);
    instance.timers.add(timer);
  }

  function handleRootKeyDown(root, event, instance = popup) {
    if (!instance || handledKeyboardEvents.has(event) || event.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && event.shiftKey) {
      event.preventDefault();
      root.querySelector(".save").click();
      return;
    }
    if (event.key === "Escape") {
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
    if (event.key === "Tab") trapTab(root, event);
  }

  function trapTab(root, event) {
    const focusable = [...root.querySelectorAll("button, input, [contenteditable=true], [tabindex]")]
      .filter((element) => !element.disabled && element.getAttribute("tabindex") !== "-1" && !element.closest("[hidden]"));
    if (!focusable.length) return;
    const active = root.activeElement;
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && (active === first || !focusable.includes(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function handleEditorKeyDown(root, event) {
    if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key === "Enter") {
      handledKeyboardEvents.add(event);
      event.preventDefault();
      root.querySelector(".save").click();
      return true;
    }
    if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key === "Enter") {
      if (editor.isActive("taskItem")) {
        handledKeyboardEvents.add(event);
        event.preventDefault();
        const checked = editor.getAttributes("taskItem").checked === true;
        return editor.chain().focus().updateAttributes("taskItem", { checked: !checked }).run();
      }
      if (editor.isActive("toggleBlock")) {
        handledKeyboardEvents.add(event);
        event.preventDefault();
        const open = editor.getAttributes("toggleBlock").open !== false;
        return editor.chain().focus().updateAttributes("toggleBlock", { open: !open }).run();
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

  function handleLinkPaste(event) {
    const url = event.clipboardData?.getData("text/plain")?.trim();
    const { from, to } = editor.state.selection;
    if (from === to || !isUrl(url)) return false;
    event.preventDefault();
    editor.chain().focus().setLink({ href: url }).run();
    return true;
  }

  function updateEditorUi(root) {
    const characters = editor.getText().length;
    root.querySelector(".character-limit").hidden = characters < MAX_CAPTURE_CHARACTERS * 0.9;
    root.querySelector(".character-limit").textContent = `${characters.toLocaleString()} / ${MAX_CAPTURE_CHARACTERS.toLocaleString()}`;
    if (characters > MAX_CAPTURE_CHARACTERS) root.querySelector(".character-limit").dataset.tone = "error";
    else delete root.querySelector(".character-limit").dataset.tone;
    updateSlashMenu(root);
    updateBubble(root);
  }

  function updateSlashMenu(root) {
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
          { label: "Suggested", commands: suggestedSlashCommandIds.map((id) => slashCommands.find((command) => command.id === id)) },
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
    positionSlashMenu(root, slash, editor.state.selection.from);
    setSlashActive([...slash.querySelectorAll("button")]);
  }

  function slashQuery() {
    const { $from, empty } = editor.state.selection;
    if (!empty || !$from.parent.isTextblock) return null;
    const before = $from.parent.textBetween(0, $from.parentOffset, "\n", "\n");
    const match = before.match(/^\/([a-z0-9-]*)$/i);
    return match ? match[1].toLowerCase() : null;
  }

  function slashButton(command, index, root) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "slash-item";
    button.dataset.index = String(index);
    button.setAttribute("role", "option");
    button.setAttribute("aria-label", `${command.label}, ${command.hint}`);
    button.innerHTML = `<span class="command-icon">${commandIcon(command.id)}</span><span class="slash-label">${command.label}</span><kbd>${command.keys}</kbd>`;
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", () => {
      const { $from } = editor.state.selection;
      const from = $from.start();
      const to = editor.state.selection.from;
      editor.chain().focus().deleteRange({ from, to }).run();
      command.run(editor);
      root.querySelector(".slash-menu").hidden = true;
    });
    return button;
  }

  function setSlashActive(items) {
    items.forEach((item, index) => {
      item.classList.toggle("active", index === slashIndex);
      item.setAttribute("aria-selected", String(index === slashIndex));
    });
    items[slashIndex]?.scrollIntoView({ block: "nearest" });
  }

  function updateBubble(root) {
    const bubble = root.querySelector(".bubble");
    const { from, to } = editor.state.selection;
    const shouldShow = editor.isFocused && from !== to && !root.querySelector(".link-editor").dataset.open;
    bubble.hidden = !shouldShow;
    if (!shouldShow) return;
    root.querySelector(".block-type").textContent = currentBlockLabel();
    root.querySelectorAll(".bubble [data-command]").forEach((button) => {
      button.classList.toggle("active", editor.isActive(button.dataset.command));
    });
    positionFloating(root, bubble, from, to, true);
  }

  function positionFloating(root, element, from, to = from, above = false) {
    const sheetRect = root.querySelector(".sheet").getBoundingClientRect();
    const start = editor.view.coordsAtPos(from);
    const end = editor.view.coordsAtPos(to);
    const elementRect = element.getBoundingClientRect();
    const halfWidth = elementRect.width / 2;
    const left = Math.max(12 + halfWidth, Math.min((start.left + end.right) / 2 - sheetRect.left, sheetRect.width - 12 - halfWidth));
    const preferredTop = above ? start.top - sheetRect.top - 10 : end.bottom - sheetRect.top + 8;
    const top = Math.max(8 + (above ? elementRect.height : 0), Math.min(preferredTop, sheetRect.height - 8 - (above ? 0 : elementRect.height)));
    element.style.left = `${left}px`;
    element.style.top = `${top}px`;
    element.style.transform = above ? "translate(-50%,-100%)" : "translateX(-50%)";
  }

  function positionSlashMenu(root, element, position) {
    const sheetRect = root.querySelector(".sheet").getBoundingClientRect();
    const caret = editor.view.coordsAtPos(position);
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

  function runInlineCommand(root, command) {
    if (command === "link") return openLinkEditor(root);
    const names = { bold: "toggleBold", italic: "toggleItalic", underline: "toggleUnderline", strike: "toggleStrike", code: "toggleCode" };
    editor.chain().focus()[names[command]]().run();
  }

  function runBlockCommand(block) {
    const chain = editor.chain().focus();
    if (block === "paragraph") chain.setParagraph().run();
    else if (block.startsWith("heading")) chain.toggleHeading({ level: Number(block.at(-1)) }).run();
    else if (block === "bulletList") chain.toggleBulletList().run();
    else if (block === "orderedList") chain.toggleOrderedList().run();
    else if (block === "taskList") chain.toggleTaskList().run();
    else if (block === "blockquote") chain.toggleBlockquote().run();
    else if (block === "codeBlock") chain.toggleCodeBlock().run();
  }

  function currentBlockLabel() {
    if (editor.isActive("heading", { level: 1 })) return "Heading 1";
    if (editor.isActive("heading", { level: 2 })) return "Heading 2";
    if (editor.isActive("heading", { level: 3 })) return "Heading 3";
    if (editor.isActive("bulletList")) return "Bulleted list";
    if (editor.isActive("orderedList")) return "Numbered list";
    if (editor.isActive("taskList")) return "To-do";
    if (editor.isActive("blockquote")) return "Quote";
    if (editor.isActive("codeBlock")) return "Code";
    return "Text";
  }

  function openLinkEditor(root) {
    const editorElement = root.querySelector(".link-editor");
    const href = editor.getAttributes("link").href || "";
    editorElement.dataset.open = "true";
    editorElement.hidden = false;
    root.querySelector(".bubble").hidden = true;
    root.querySelector(".link-input").value = href;
    positionFloating(root, editorElement, editor.state.selection.from, editor.state.selection.to, true);
    root.querySelector(".link-input").focus();
  }

  function closeLinkEditor(root) {
    const link = root.querySelector(".link-editor");
    link.hidden = true;
    delete link.dataset.open;
    editor.commands.focus();
  }

  function applyLink(root) {
    const href = root.querySelector(".link-input").value.trim();
    if (!href) editor.chain().focus().unsetLink().run();
    else editor.chain().focus().extendMarkRange("link").setLink({ href: normalizeUrl(href) }).run();
    closeLinkEditor(root);
  }

  function closeTransientUi(root) {
    let closed = false;
    if (!root.querySelector(".ai-panel").hidden) {
      const instance = [...instances].find((candidate) => candidate.root === root);
      instance?.aiController?.abort();
    }
    for (const selector of [".page-menu", ".recent-panel", ".source-panel", ".ai-panel", ".slash-menu", ".format-menu", ".link-editor"]) {
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

  function setStatus(root, text) {
    root.querySelector(".status").textContent = text;
  }

  function showToast(root, text, tone, instance = popup) {
    const toast = root.querySelector(".toast");
    toast.textContent = text;
    toast.dataset.tone = tone;
    toast.hidden = false;
    clearTimeout(instance?.toastTimer);
    if (instance) {
      instance.toastTimer = setTimeout(() => {
        if (!instance.closed) toast.hidden = true;
      }, tone === "error" ? 5000 : 1800);
    }
  }

  function isUrl(value) {
    try {
      const url = new URL(normalizeUrl(value));
      return url.protocol === "http:" || url.protocol === "https:";
    } catch {
      return false;
    }
  }

  function normalizeUrl(value) {
    return /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`;
  }

  function commandIcon(id) {
    const type = { text: "T", h1: "H1", h2: "H2", h3: "H3" };
    if (type[id]) return `<span class="command-type" aria-hidden="true">${type[id]}</span>`;
    const paths = {
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

  function icon(name) {
    const paths = {
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

  function template() {
    return `
      <link rel="stylesheet" href="${chrome.runtime.getURL("styles/composer.css")}">
      <section class="sheet" role="document" aria-label="Quick note editor">
        <header class="topbar">
          <span class="status" role="status" aria-live="polite" aria-atomic="true"></span>
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
          <button class="block-type" type="button">Text</button>
          <span class="toolbar-line"></span>
          <button type="button" data-command="bold" aria-label="Bold"><b>B</b></button>
          <button type="button" data-command="italic" aria-label="Italic"><i>i</i></button>
          <button type="button" data-command="underline" aria-label="Underline"><u>U</u></button>
          <button type="button" data-command="strike" aria-label="Strikethrough"><s>S</s></button>
          <button type="button" data-command="code" aria-label="Inline code"><span class="code-icon">&lt;&gt;</span></button>
          <button type="button" data-command="link" aria-label="Add link">↗</button>
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
        <div class="link-editor" hidden><input class="link-input" type="url" aria-label="Link URL" placeholder="Paste a link"><button class="apply-link" type="button">Apply</button></div>
        <div class="slash-menu" role="listbox" aria-label="Block commands" hidden></div>
        <div class="toast" role="alert" hidden></div>
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
      return ({ node, updateAttributes }) => {
        const dom = document.createElement("details");
        dom.dataset.type = "toggle-block";
        dom.open = node.attrs.open !== false;
        const contentDOM = document.createElement("summary");
        dom.append(contentDOM);
        dom.addEventListener("toggle", () => updateAttributes({ open: dom.open }));
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
      const blockShortcut = (number) => () => {
        const chain = this.editor.chain().focus();
        if (number === 0) return chain.setParagraph().run();
        if (number <= 3) return chain.toggleHeading({ level: number }).run();
        if (number === 4) return chain.toggleTaskList().run();
        if (number === 5) return chain.toggleBulletList().run();
        if (number === 6) return chain.toggleOrderedList().run();
        if (number === 7) return chain.setNode("toggleBlock").run();
        return chain.toggleCodeBlock().run();
      };
      const shortcuts = {};
      for (let number = 0; number <= 8; number += 1) {
        shortcuts[`Mod-Alt-${number}`] = blockShortcut(number);
        shortcuts[`Mod-Shift-${number}`] = blockShortcut(number);
      }
      return shortcuts;
    }
  });
})();
