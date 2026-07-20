import type { RuntimeRequest, RuntimeResponse } from "./contracts.js";

export const RUNTIME_MESSAGE_TIMEOUT_MS = 5_000;

export class RuntimeMessageTimeoutError extends Error {
  readonly code = "runtime_message_timeout" as const;

  constructor(message = "Quick Note did not receive a response from the extension.") {
    super(message);
    this.name = "RuntimeMessageTimeoutError";
  }
}

interface TimerOverrides {
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export function withRuntimeMessageDeadline<T>(
  promise: PromiseLike<T> | T,
  timeoutMs = RUNTIME_MESSAGE_TIMEOUT_MS,
  { setTimer = globalThis.setTimeout, clearTimer = globalThis.clearTimeout as (handle: unknown) => void }: TimerOverrides = {}
): Promise<T> {
  let timer: unknown;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimer(() => reject(new RuntimeMessageTimeoutError()), timeoutMs);
  });
  return Promise.race([Promise.resolve(promise), deadline]).finally(() => clearTimer(timer));
}

export async function sendRuntimeRequest<T extends RuntimeRequest>(message: T): Promise<RuntimeResponse<T>> {
  return chrome.runtime.sendMessage(message) as Promise<RuntimeResponse<T>>;
}

interface ReconciliationOptions<T extends Extract<RuntimeRequest, { type: "ENQUEUE_CAPTURE" | "SAVE_CAPTURE" }>> {
  send: <R extends RuntimeRequest>(message: R) => Promise<RuntimeResponse<R>>;
  message: T;
  draftId: string;
}

export async function enqueueWithReconciliation<T extends Extract<RuntimeRequest, { type: "ENQUEUE_CAPTURE" | "SAVE_CAPTURE" }>>({
  send,
  message,
  draftId
}: ReconciliationOptions<T>): Promise<RuntimeResponse<T>> {
  try {
    return await send(message);
  } catch (error: unknown) {
    if (!(error instanceof RuntimeMessageTimeoutError)) throw error;
    const status = await send({ type: "GET_CAPTURE_STATUS", draftId }).catch(() => null);
    if (status?.ok && status.record) {
      return { ok: true, accepted: true, record: status.record, reconciled: true } as RuntimeResponse<T>;
    }
    throw error;
  }
}
