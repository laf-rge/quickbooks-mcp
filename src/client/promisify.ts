// Promisify helper for node-quickbooks callbacks

import { markWriteIssued } from "./write-barrier.js";

export function promisify<T>(fn: (callback: (err: Error | null, result: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    fn((err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}

/**
 * promisify for a call that can change data in QuickBooks — every create,
 * update and delete.
 *
 * Identical to promisify apart from arming the write barrier first, which is
 * what tells the auth-retry dispatcher that this attempt can no longer be
 * replayed. Use it for anything that posts; using plain promisify for a write
 * silently opts that tool back into being retried.
 */
export function promisifyWrite<T>(fn: (callback: (err: Error | null, result: T) => void) => void): Promise<T> {
  markWriteIssued();
  return promisify(fn);
}
