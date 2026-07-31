// Bounded parallelism for fan-out work.

/**
 * Like `Promise.all(items.map(fn))`, but with at most `limit` calls in flight.
 * Results stay in input order.
 *
 * Rejections propagate, same as Promise.all — callers that need per-item
 * failure handling should catch inside `fn`.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  };

  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    worker
  );
  await Promise.all(workers);

  return results;
}
