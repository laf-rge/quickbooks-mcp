// Turning a QuickBooks failure into something a caller can act on.
//
// node-quickbooks hands its callback whatever axios rejected with, so an HTTP
// 400 arrives as a generic Error whose message is "Request failed with status
// code 400" — the part that says *why* sits untouched on `response.data` as a
// QBO Fault. Surfacing only `error.message` throws away the code, message and
// detail that name the offending field, which is the difference between a
// two-minute fix and a bisect against live data.
//
// The shapes vary: a Fault can be the rejection value itself (rest.ts throws the
// parsed body; node-quickbooks passes the body through when a 200 carries a
// Fault), or nested under an axios `response.data`, and Intuit has shipped both
// `Fault.Error[].Message` and lowercase spellings. Everything here treats the
// input as untrusted and degrades to plain text rather than throwing — an error
// formatter that can itself fail hides the original failure completely.

// Cap on the generic JSON dump we fall back to when there is no Fault to read.
// Enough to identify an unexpected shape, short enough that a stray entity body
// cannot flood the response.
const FALLBACK_DUMP_CHARS = 2000;

export interface QboFaultError {
  code?: string;
  message?: string;
  detail?: string;
  element?: string;
}

export interface QboFault {
  type?: string;
  errors: QboFaultError[];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function asText(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number") return String(value);
  return undefined;
}

// A body may arrive already parsed or still as the raw response text.
function parseIfJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

// Places a Fault has been observed: the value itself, an axios error's
// `response.data`, and the `data`/`body` a hand-rolled wrapper might attach.
function faultCandidates(error: unknown): unknown[] {
  const out: unknown[] = [error];
  const record = asRecord(error);
  if (record) {
    out.push(parseIfJson(record.data), parseIfJson(record.body));
    const response = asRecord(record.response);
    if (response) out.push(parseIfJson(response.data), parseIfJson(response.body));
  }
  return out;
}

function readFault(candidate: unknown): QboFault | undefined {
  const record = asRecord(candidate);
  if (!record) return undefined;

  const fault = asRecord(record.Fault) ?? asRecord(record.fault);
  if (!fault) return undefined;

  const rawErrors = Array.isArray(fault.Error)
    ? fault.Error
    : Array.isArray(fault.error)
      ? fault.error
      : [];

  const errors: QboFaultError[] = [];
  for (const entry of rawErrors) {
    const e = asRecord(entry);
    if (!e) continue;
    errors.push({
      code: asText(e.code) ?? asText(e.Code),
      message: asText(e.Message) ?? asText(e.message),
      detail: asText(e.Detail) ?? asText(e.detail),
      element: asText(e.element) ?? asText(e.Element),
    });
  }

  const type = asText(fault.type) ?? asText(fault.Type);
  // A `Fault` key with nothing readable under it is not worth reporting as one.
  if (errors.length === 0 && !type) return undefined;
  return { type, errors };
}

/** The QBO Fault carried by `error`, wherever it happens to be, or undefined. */
export function extractQboFault(error: unknown): QboFault | undefined {
  try {
    for (const candidate of faultCandidates(error)) {
      const fault = readFault(candidate);
      if (fault) return fault;
    }
  } catch {
    // Never let fault extraction mask the failure it was called to describe.
  }
  return undefined;
}

/** HTTP status attached by axios (`response.status`) or by rest.ts (`status`). */
export function extractHttpStatus(error: unknown): number | undefined {
  const record = asRecord(error);
  if (!record) return undefined;
  const direct = record.status ?? record.statusCode;
  if (typeof direct === "number") return direct;
  const response = asRecord(record.response);
  const nested = response?.status;
  return typeof nested === "number" ? nested : undefined;
}

// QBO's own codes for "these credentials will not do": 3200 is the v3 API's
// AuthenticationFault code; 401 is what rest.ts synthesizes when a 401 comes
// back with no fault body at all.
const AUTH_FAULT_CODES = new Set(["3200", "401"]);

/**
 * Whether QuickBooks rejected the credentials rather than the request.
 *
 * The fault is looked up wherever it sits, which is the whole point: a call made
 * through a node-quickbooks method rejects with the raw axios error, so an
 * expired token arrives as a generic Error carrying the AuthenticationFault down
 * on `response.data`. Reading only the top level classifies that as an ordinary
 * failure and the caller never learns to refresh.
 */
export function isAuthFault(error: unknown): boolean {
  const fault = extractQboFault(error);
  if (fault) {
    if (fault.errors.some((e) => e.code !== undefined && AUTH_FAULT_CODES.has(e.code))) return true;
    if (fault.type && /authentication|authorization/i.test(fault.type)) return true;
    // A fault that named some other problem *is* that problem. Don't let a
    // transport status override QBO's own account of what went wrong.
    return false;
  }
  return extractHttpStatus(error) === 401;
}

function safeStringify(value: unknown): string {
  try {
    // Cheap circular guard: axios errors reference their own config/socket.
    const seen = new WeakSet<object>();
    const json = JSON.stringify(
      value,
      (_key, val) => {
        if (typeof val === "object" && val !== null) {
          if (seen.has(val)) return "[Circular]";
          seen.add(val);
        }
        return val;
      },
      2
    );
    if (typeof json !== "string") return String(value);
    return json.length > FALLBACK_DUMP_CHARS ? `${json.slice(0, FALLBACK_DUMP_CHARS)}… (truncated)` : json;
  } catch {
    return String(value);
  }
}

function formatFaultError(error: QboFaultError): string {
  const head = error.code ? `[${error.code}]` : "[no code]";
  const parts = [error.message ?? "(no message)"];
  if (error.detail && error.detail !== error.message) parts.push(error.detail);
  if (error.element) parts.push(`element: ${error.element}`);
  return `${head} ${parts.join(" — ")}`;
}

/**
 * A caller-facing description of a failed QuickBooks call: the transport-level
 * message, plus every Fault entry QBO returned. Only fields QBO put in the
 * fault are echoed — never the request body, which for a write is client
 * financial data.
 */
export function formatQboError(error: unknown): string {
  try {
    const fault = extractQboFault(error);
    const status = extractHttpStatus(error);

    let base: string;
    if (error instanceof Error) {
      base = error.message || error.name || "Unknown error";
    } else if (fault) {
      // The Fault is the whole rejection value; the lines below say it all.
      base = status !== undefined ? `QuickBooks request failed (HTTP ${status})` : "QuickBooks request failed";
    } else if (typeof error === "object" && error !== null) {
      base = safeStringify(error);
    } else {
      base = String(error);
    }

    if (!fault) return base;

    const lines = [base];
    const label = fault.type ? `QuickBooks fault (${fault.type})` : "QuickBooks fault";
    lines.push(fault.errors.length > 1 ? `${label}:` : `${label}: ${formatFaultError(fault.errors[0] ?? {})}`);
    if (fault.errors.length > 1) {
      for (const entry of fault.errors) lines.push(`  ${formatFaultError(entry)}`);
    }
    return lines.join("\n");
  } catch {
    // Formatting must never be the thing that throws.
    try {
      return String(error);
    } catch {
      return "Unknown error";
    }
  }
}
