// One retry of a tool call with refreshed credentials, and the rule for when
// that retry is allowed at all.
//
// An access token can be rejected mid-session — a stale cached credential in a
// warm Lambda is the usual cause — and the fix is mechanical: drop the cache,
// mint a fresh token, run the call again. Doing that automatically is the
// difference between a tool that occasionally hiccups and one the user has to
// re-authenticate by hand.
//
// The catch is that "run the call again" means re-running the handler, and a
// write handler that already posted would post a second time. So the retry is
// conditional on the write barrier: an attempt that never sent a data-changing
// request can be replayed freely; one that did is reported instead, with the
// caller told to check QuickBooks before trying again. In practice that still
// covers every read, every draft preview, and every write that failed while
// resolving accounts, vendors or departments — the failures that actually
// happen — while a duplicate transaction stays impossible by construction.

// Imported from the leaf modules rather than the client barrel: the barrel
// pulls in the credential providers, and this decision needs neither.
import { isAuthFault } from "../utils/errors.js";
import { newAttemptRecord, withWriteTracking } from "../client/write-barrier.js";

export type AuthRetryOutcome<T> =
  | { status: "ok"; value: T }
  | {
      status: "failed";
      error: unknown;
      /** The call was attempted a second time with fresh credentials. */
      retried: boolean;
      /** Auth failure, but a write had gone out, so no retry was attempted. */
      retryBlockedByWrite: boolean;
    };

/**
 * Run `operation`, retrying once with refreshed credentials if QuickBooks
 * rejected the token and nothing was written on the failed attempt.
 *
 * `refreshCredentials` is injected rather than imported so the decision logic
 * can be exercised without a live credential provider.
 */
export async function runWithAuthRetry<T>(
  operation: () => Promise<T>,
  refreshCredentials: () => void
): Promise<AuthRetryOutcome<T>> {
  const first = newAttemptRecord();

  try {
    return { status: "ok", value: await withWriteTracking(first, operation) };
  } catch (error) {
    if (!isAuthFault(error)) {
      return { status: "failed", error, retried: false, retryBlockedByWrite: false };
    }

    if (first.writeIssued) {
      return { status: "failed", error, retried: false, retryBlockedByWrite: true };
    }

    refreshCredentials();

    const second = newAttemptRecord();
    try {
      return { status: "ok", value: await withWriteTracking(second, operation) };
    } catch (retryError) {
      return { status: "failed", error: retryError, retried: true, retryBlockedByWrite: false };
    }
  }
}
