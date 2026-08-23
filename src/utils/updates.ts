// Reporting the outcome of an update.

/**
 * QuickBooks increments SyncToken on every accepted change. An update that
 * comes back with the same token changed nothing — QBO compared the payload to
 * the stored record and found no difference. Saying "updated successfully"
 * there reads as a change that never happened, which is exactly how a no-op
 * edit gets mistaken for a correction.
 */
export function formatUpdateResult(
  label: string,
  id: string,
  previousSyncToken: string | undefined,
  newSyncToken: string | undefined,
  qboUrl: string
): string {
  const unchanged =
    previousSyncToken !== undefined &&
    newSyncToken !== undefined &&
    previousSyncToken === newSyncToken;

  if (unchanged) {
    return [
      `${label} ${id}: no change.`,
      `QuickBooks accepted the update but the SyncToken did not advance (still ${newSyncToken}),`,
      "which means nothing in the payload differed from the stored record.",
      `View in QuickBooks: ${qboUrl}`,
    ].join("\n");
  }

  return [
    `${label} ${id} updated successfully.`,
    `New SyncToken: ${newSyncToken}`,
    `View in QuickBooks: ${qboUrl}`,
  ].join("\n");
}
