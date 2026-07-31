// Retry for transient QuickBooks failures.
//
// Intuit throttles per realm, and fanning several entity queries out at once is
// enough to trip it. A throttled query used to surface as an entity that simply
// returned nothing, which in an account drill-down reads as "no activity" rather
// than "ask again" — so retry before giving up.

import { isQBError, extractQBErrorInfo } from "../types/index.js";

// Intuit throttles with 429 and sheds load with 5xx under concurrency.
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 300;

function statusOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  // rest.ts attaches `status`; node-quickbooks hands back the underlying axios
  // error, which carries it on `response`.
  const e = error as { status?: number; response?: { status?: number } };
  return e.status ?? e.response?.status;
}

/**
 * Whether another attempt could plausibly succeed. Validation faults are not
 * retried — a malformed query fails identically every time, and retrying it
 * just burns throttle budget the caller needs for the queries that can work.
 */
export function isRetryableError(error: unknown): boolean {
  const status = statusOf(error);
  if (status !== undefined) return RETRYABLE_STATUS.has(status);

  if (isQBError(error)) {
    const { code } = extractQBErrorInfo(error);
    // 4xxx fault codes are validation problems: unqueryable field, bad entity,
    // syntax error. 3xxx are auth, handled by the retry in tools/index.ts.
    return !(code?.startsWith("4") || code?.startsWith("3"));
  }

  // Neither a status nor a Fault — a socket or DNS blip. Worth one more try.
  return true;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `fn`, retrying transient failures with exponential backoff. Rethrows the
 * last error once attempts are exhausted, so callers still see a real failure.
 */
export async function withRetry<T>(fn: () => Promise<T>, maxAttempts = MAX_ATTEMPTS): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts || !isRetryableError(error)) throw error;
      // Jitter so parallel queries that were throttled together don't all wake
      // up at the same instant and trip the limit again.
      const backoff = BASE_DELAY_MS * 2 ** (attempt - 1);
      await sleep(backoff + Math.random() * BASE_DELAY_MS);
    }
  }

  throw lastError;
}
