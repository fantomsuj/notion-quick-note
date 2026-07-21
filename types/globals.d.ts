import type { CaptureContext, CaptureDraft, CaptureRecord } from "../src/contracts.js";

declare global {
  var __notionQuickNoteCaptureCheckpoint: ((event: { kind: string; record?: CaptureRecord; structural?: boolean }) => void | Promise<void>) | undefined;
  var __mv3FailureHarnessReady: boolean | undefined;
  var __mv3FailureHarnessError: string | undefined;
  var __notionQuickNoteUpdateContext: ((update: {
    page: CaptureContext;
    tabId?: number | null;
    explicit?: boolean;
  }) => void) | undefined;
  var __notionQuickNoteOpen: ((options: {
    draft?: CaptureDraft;
    page?: CaptureContext;
    draftId?: string;
    tabId?: number | null;
    sessionId?: string;
    revision?: number;
    replaceWithoutPersist?: boolean;
  }) => void | Promise<void>) | undefined;
  var __notionQuickNoteSuspend: (() => void) | undefined;
  var __notionQuickNoteResume: (() => void) | undefined;
  var __notionQuickNotePrepareDiscard: ((draftId: string) => Promise<boolean>) | undefined;
  var __notionQuickNoteFinishDiscard: ((draftId: string, discarded: boolean) => void) | undefined;
  var __notionQuickNoteInstalled: boolean | undefined;
  var __notionQuickNoteRuntime: { protocol: number; dispose(): void } | undefined;
}

export {};
