import type {
  CaptureRecord,
  CaptureRepositoryPort,
  RuntimeRequest,
  RuntimeResponse
} from "../../src/contracts.js";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;

type PendingRecord = CaptureRecord & { status: "pending" };
type DeliveredRecord = Extract<CaptureRecord, { status: "delivered" }>;
type _PendingHasZeroDeliveredAt = Expect<Equal<PendingRecord["deliveredAt"], 0>>;
type _DeliveredHasRemote = Expect<Equal<DeliveredRecord["remote"], NonNullable<DeliveredRecord["remote"]>>>;

type SettingsRequest = Extract<RuntimeRequest, { type: "GET_QUICK_SETTINGS" }>;
type SettingsResponse = RuntimeResponse<SettingsRequest>;
type _SettingsResponseCorrelates = Expect<Equal<Extract<SettingsResponse, { ok: true }>["authType"], "oauth" | "token" | undefined>>;

declare const repository: CaptureRepositoryPort;
void repository;

// @ts-expect-error A response type can only be requested for a valid runtime request.
type _InvalidRequest = RuntimeResponse<{ type: "NOT_A_MESSAGE" }>;
