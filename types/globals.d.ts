import type { CaptureRecord } from "../src/contracts.js";

declare global {
  var __notionQuickNoteCaptureCheckpoint: ((event: { kind: string; record?: CaptureRecord; structural?: boolean }) => void | Promise<void>) | undefined;
  var __mv3FailureHarnessReady: boolean | undefined;
  var __mv3FailureHarnessError: string | undefined;
}

export {};
