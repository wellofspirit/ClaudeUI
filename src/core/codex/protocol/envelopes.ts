// GENERATED from pinned app-server generate-json-schema --experimental.
import type { RequestId } from "./RequestId";
export type JSONRPCError = { error: JSONRPCErrorError; id: RequestId };
export type JSONRPCErrorError = { code: number; data?: unknown; message: string };
export type JSONRPCNotification = { method: string; params?: unknown };
export type JSONRPCRequest = { id: RequestId; method: string; params?: unknown; trace?: W3cTraceContext | null };
export type JSONRPCResponse = { id: RequestId; result: unknown };
export type W3cTraceContext = { traceparent?: string | null; tracestate?: string | null };
export type JSONRPCMessage = JSONRPCRequest | JSONRPCNotification | JSONRPCResponse | JSONRPCError;
