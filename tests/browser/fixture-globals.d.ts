import type { CaptureDraft, EditorNode, RuntimeRequest } from "../../src/contracts.js";

interface FixtureSource {
  title: string;
  url: string;
  selection?: string;
  capturedAt?: number;
}

interface FixtureRuntimeMessage {
  type: RuntimeRequest["type"] | "QUICK_SETTINGS_CHANGED";
  id?: string;
  pageId?: string;
  draft?: CaptureDraft;
  expectedRevision?: number;
  capture?: { document: { doc: EditorNode; [key: string]: unknown }; [key: string]: unknown };
  [key: string]: unknown;
}

interface FixtureRecentItem {
  id: string;
  source?: string;
  pageId?: string;
  title: string;
  preview?: string;
  destinationName?: string;
  status: string;
  mode?: "new" | "edit";
  updatedAt: number;
  remoteUrl?: string;
  editable?: boolean;
}

interface FixtureCaptureStatus {
  id: string;
  status: string;
  lastError: { kind: string; [key: string]: unknown } | null;
}

interface FixtureLanguageModelPrompt {
  prompt: string;
  promptOptions: { signal: AbortSignal; [key: string]: unknown };
}

type FixtureStoredDraft = Partial<Omit<CaptureDraft, "version">> & { version?: 1 | 2 };

declare global {
  interface Window {
    openQuickNote(options?: Partial<Pick<import("../../src/contracts.js").CaptureContext, "title" | "url" | "selection">>): Promise<unknown>;
    dispatchRuntimeMessage(message: FixtureRuntimeMessage): Promise<unknown>;
    rememberedQuickNoteEditor?: Element;
    rememberedQuickNoteHost?: Element;
    mediaEvents: Array<{ type: string; key: string }>;
    pagePointerEvents: number;
    pageTouchEvents: number;
    underlyingPointerEvents: number;
    underlyingTouchEvents: number;
    pageEscapeEvents: number;
    settingsResponse: Record<string, unknown>;
    currentDraft: CaptureDraft | null;
    runtimeMessages: FixtureRuntimeMessage[];
    savedSession: Record<string, FixtureStoredDraft>;
    recentDrafts: FixtureRecentItem[];
    recentNotes: FixtureRecentItem[];
    recentNotionPages: FixtureRecentItem[];
    recentDraftBodies: Record<string, CaptureDraft>;
    notionPageDraft: CaptureDraft | null;
    remoteDraft: CaptureDraft | null;
    recentConflict?: boolean;
    recentNotionError?: string;
    captureStatus: FixtureCaptureStatus | null;
    saveResponse?: { ok: boolean; error?: string; [key: string]: unknown };
    discardResponse?: { ok: boolean; discarded?: boolean; error?: string };
    discardError?: Error | null;
    discardDeletesBeforeError?: boolean;
    runtimeError?: Error | null;
    storageError?: Error | null;
    saveDelay?: number;
    draftDelay?: number;
    draftSaveDelay?: number;
    settingsDelay?: number;
    holdDraft?: boolean;
    holdDraftSave?: boolean;
    fullscreenOnNextClick?: boolean;
    releaseDraft: () => void;
    releaseDraftSave: () => void;
    releaseNextDraftSave: () => void;
    pendingDraftSaveReleases?: Array<() => void>;
    draftWrites: Array<FixtureRuntimeMessage & { draft: CaptureDraft }>;
    activeDraftWrites: number;
    maxConcurrentDraftWrites: number;
    manualDraftSaves?: boolean;
    activeRuntimeListeners(): number;
    aiPrompts: FixtureLanguageModelPrompt[];
    aiDestroyed: number;
    aiClickWasTrusted?: boolean;
    __settingsState: Record<string, unknown>;
    __shortcut: string;
    __shortcutError: boolean;
    __tabCreateError: boolean;
    __openedShortcutUrl?: string;
  }
}

export {};
