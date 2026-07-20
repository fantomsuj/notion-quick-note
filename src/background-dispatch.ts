import {
  isRuntimeResponse,
  type CaptureRecord,
  type QuickSettings,
  type RuntimeRequest,
  type RuntimeResponse,
  type RuntimeResponseMap
} from "./contracts.js";

export type CaptureRecordResponseType = "RETRY_CAPTURE" | "RETARGET_CAPTURE" | "MARK_CAPTURE_DELIVERED";

export function quickSettingsResponse(settings: QuickSettings): RuntimeResponseMap["GET_QUICK_SETTINGS"] {
  return { ok: true, ...settings };
}

export async function requiredCaptureRecordResponse<T extends CaptureRecordResponseType>(
  type: T,
  operation: PromiseLike<CaptureRecord | null>
): Promise<RuntimeResponseMap[T]> {
  const record = await operation;
  if (!record) throw new Error(`${type} did not return a capture record.`);
  return { ok: true, record };
}

export function validatedRuntimeResponse<T extends RuntimeRequest>(request: T, value: unknown): RuntimeResponse<T> {
  if (!isRuntimeResponse(request, value)) throw new Error(`Quick Note produced a malformed response for ${request.type}.`);
  return value;
}
