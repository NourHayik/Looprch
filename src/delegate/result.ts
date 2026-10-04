import { existsSync, readFileSync } from "node:fs";
import { LrError } from "../core/errors.js";
import { isObject } from "../core/validate.js";

export const RELAY_SCHEMA = "delegate-relay.result.v1";

export type RelayStatus = "completed" | "failed" | "timeout" | "aborted" | "unavailable";

export interface RelayResult {
  status: RelayStatus;
  rawStatus: string;
  exitCode: number | null;
  sessionId: string | null;
  finalMessage: string;
  touchedFiles: string[] | null;
  readOnlyViolation: boolean;
  stderrTail: string;
}

const SESSION_FIELDS = ["threadId", "sessionId", "conversationId"] as const;

export function parseRelayResult(raw: unknown, sessionField?: string): RelayResult {
  if (!isObject(raw)) throw new LrError("relay_result_invalid", "Relay result is not a JSON object");
  if (raw.schema !== undefined && raw.schema !== RELAY_SCHEMA) throw new LrError("relay_result_invalid", `Unknown relay result schema ${String(raw.schema)}`);
  const rawStatus = typeof raw.status === "string" ? raw.status : "failed";
  const status: RelayStatus =
    rawStatus === "completed" || rawStatus === "failed" || rawStatus === "timeout" || rawStatus === "aborted"
      ? rawStatus
      : rawStatus.endsWith("_unavailable")
        ? "unavailable"
        : "failed";
  const fields = sessionField ? [sessionField, ...SESSION_FIELDS] : [...SESSION_FIELDS];
  let sessionId: string | null = null;
  for (const f of fields) {
    const v = raw[f];
    if (typeof v === "string" && v) {
      sessionId = v;
      break;
    }
  }
  const touched = raw.touchedFiles;
  const touchedFiles = Array.isArray(touched) ? touched.map((t) => (typeof t === "string" ? t : isObject(t) && typeof t.path === "string" ? t.path : JSON.stringify(t))) : null;
  const stderr = raw.stderrTail;
  return {
    status,
    rawStatus,
    exitCode: typeof raw.exitCode === "number" ? raw.exitCode : null,
    sessionId,
    finalMessage: typeof raw.finalMessage === "string" ? raw.finalMessage : "",
    touchedFiles,
    readOnlyViolation: raw.readOnlyViolation === true || (isObject(raw.readOnlyViolation) && Object.keys(raw.readOnlyViolation).length > 0),
    stderrTail: Array.isArray(stderr) ? stderr.join("\n") : typeof stderr === "string" ? stderr : "",
  };
}

export function readRelayResult(path: string, sessionField?: string): RelayResult | null {
  if (!existsSync(path)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new LrError("relay_result_invalid", `Relay result ${path} is not valid JSON`);
  }
  return parseRelayResult(raw, sessionField);
}

export const SAMPLE_RESULT = {
  schema: RELAY_SCHEMA,
  status: "completed",
  exitCode: 0,
  signal: null,
  sessionId: "ses_sample",
  finalMessage: 'Done.\n\n```looprch-result\n{"role":"worker","decision":"answered","evidence":[]}\n```',
  touchedFiles: [],
};
