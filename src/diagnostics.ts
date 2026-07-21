type DiagnosticValue = string | number | boolean | null | undefined;
type DiagnosticDetails = Record<string, DiagnosticValue>;
const SENSITIVE_DETAIL_PARTS = ["body", "content", "note", "selection", "title", "url"];

function isSensitiveDetailKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return SENSITIVE_DETAIL_PARTS.some((part) => normalized.includes(part));
}

function compact(details: DiagnosticDetails): Record<string, Exclude<DiagnosticValue, undefined>> {
  return Object.fromEntries(
    Object.entries(details).filter((entry): entry is [string, Exclude<DiagnosticValue, undefined>] => (
      entry[1] !== undefined && !isSensitiveDetailKey(entry[0])
    ))
  );
}

function errorSummary(error: unknown): { name: string; message: string; code?: string; stack?: string } {
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? { code: error.code }
    : {};
  return error instanceof Error
    ? { name: error.name, message: error.message, ...code, ...(error.stack ? { stack: error.stack } : {}) }
    : { name: "Error", message: String(error), ...code };
}

export function serializeDiagnostic(event: string, details: DiagnosticDetails = {}, error?: unknown): string {
  return JSON.stringify({ event, ...compact(details), ...(error === undefined ? {} : { error: errorSummary(error) }) });
}

export function logDiagnostic(event: string, details: DiagnosticDetails = {}): void {
  console.log(`[NQN] ${serializeDiagnostic(event, details)}`);
}

export function logDiagnosticError(event: string, error: unknown, details: DiagnosticDetails = {}): void {
  console.error(`[NQN] ${serializeDiagnostic(event, details, error)}`);
}
