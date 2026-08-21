// Records whether a write request has left the process during one attempt at a
// tool call.
//
// The dispatcher in tools/index.ts retries a failed call once with refreshed
// credentials, and that retry re-runs the *whole* handler. For a read that is
// free. For a create or an update it is only safe while nothing has been posted
// yet: re-running a handler that already sent its POST would book the
// transaction twice, and a duplicate bill or payment is far worse than the
// error message the caller would otherwise have seen.
//
// QBO rejects an unauthenticated request before it does anything with it, so an
// auth fault on the write call itself means nothing was committed. That is a
// property of Intuit's gateway, though, not of this code, and the handlers'
// current shape — every write is the last call the handler makes — is not
// enforced anywhere. Rather than rest the safety of every write tool on two
// invariants nobody can see, writes announce themselves here and the retry is
// declined once one has been announced.
//
// AsyncLocalStorage rather than a module-level flag: tool calls can overlap, and
// a shared flag would let one call's attempt boundary clear another call's
// record — the one failure mode that would turn this guard into the bug it
// exists to prevent.

import { AsyncLocalStorage } from "node:async_hooks";

export interface AttemptRecord {
  /** True once a request that can change data has been sent to QuickBooks. */
  writeIssued: boolean;
}

const storage = new AsyncLocalStorage<AttemptRecord>();

/** A fresh record for one attempt. Caller keeps it; it stays readable after. */
export function newAttemptRecord(): AttemptRecord {
  return { writeIssued: false };
}

/** Run `fn` with `record` as the ambient attempt, including across awaits. */
export function withWriteTracking<T>(record: AttemptRecord, fn: () => Promise<T>): Promise<T> {
  return storage.run(record, fn);
}

/**
 * Declare that a data-changing request is about to go out. Called *before* the
 * request, not after: the dangerous state is "may have been committed", which
 * begins the moment the bytes leave, not when a response comes back.
 *
 * A no-op outside an attempt (a direct handler call in a test, say), which is
 * why the retry decision reads the record it created rather than asking here.
 */
export function markWriteIssued(): void {
  const record = storage.getStore();
  if (record) record.writeIssued = true;
}
