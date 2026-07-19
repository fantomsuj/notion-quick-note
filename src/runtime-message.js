export const RUNTIME_MESSAGE_TIMEOUT_MS = 5_000;

export class RuntimeMessageTimeoutError extends Error {
  constructor(message = "Quick Note did not receive a response from the extension.") {
    super(message);
    this.name = "RuntimeMessageTimeoutError";
    this.code = "runtime_message_timeout";
  }
}

export function withRuntimeMessageDeadline(
  promise,
  timeoutMs = RUNTIME_MESSAGE_TIMEOUT_MS,
  { setTimer = setTimeout, clearTimer = clearTimeout } = {}
) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimer(() => reject(new RuntimeMessageTimeoutError()), timeoutMs);
  });
  return Promise.race([Promise.resolve(promise), deadline]).finally(() => clearTimer(timer));
}

export async function enqueueWithReconciliation({ send, message, draftId }) {
  try {
    return await send(message);
  } catch (error) {
    if (error?.code !== "runtime_message_timeout") throw error;
    const status = await send({ type: "GET_CAPTURE_STATUS", draftId }).catch(() => null);
    if (status?.ok && status.record) {
      return { ok: true, accepted: true, record: status.record, reconciled: true };
    }
    throw error;
  }
}
