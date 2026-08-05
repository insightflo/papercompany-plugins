/**
 * Shared in-process per-repository+PR mutex for the structured re-review loop.
 *
 * The Runtime runs exactly ONE worker process per installed plugin
 * (plugin-worker-manager.ts: "One worker process per installed plugin"), while
 * the SDK worker-rpc-host dispatches inbound webhook RPCs fire-and-forget — so
 * deliveries CAN run concurrently inside the worker. The intake
 * (`processRereviewChange`) and the steward review-result path
 * (`acceptStewardReviewResult`) therefore serialize on the SAME
 * repository+PR key so that concurrent webhook deliveries AND concurrent
 * identical steward verdicts cannot double-create a review issue or
 * double-publish a REQUEST_CHANGES comment. After a worker restart the
 * persisted per-SHA revision/publication records dedupe. Deliveries for
 * different PRs never contend.
 */
const prLocks = new Map<string, Promise<unknown>>();

function lockKey(repository: string, prNumber: number): string {
  return `${repository.toLowerCase()}#${prNumber}`;
}

/**
 * Serialize `fn` for one repository+PR across all callers in this worker.
 *
 * The map holds a promise that ALWAYS resolves (the stored "tail" is the run
 * with its rejection swallowed), so the next caller chains onto a settled
 * promise regardless of whether the previous run succeeded or failed. The
 * cleanup compares against the exact stored caught-tail promise, never the
 * raw `run`, so the entry is removed once the tail has fully settled and no
 * further callers are queued behind it.
 */
export async function withPrLock<T>(
  repository: string,
  prNumber: number,
  fn: () => Promise<T>,
): Promise<T> {
  const key = lockKey(repository, prNumber);
  const previous = prLocks.get(key) ?? Promise.resolve();
  const run = previous.then(fn);
  // Store the caught tail: the chain stays alive even when `fn` rejects, so
  // the next caller still waits for this critical section to finish.
  const tail = run.catch(() => undefined);
  prLocks.set(key, tail);
  try {
    return await run;
  } finally {
    // Compare against the exact stored tail promise (the caught variant), not
    // `run` — they are different promise objects.
    if (prLocks.get(key) === tail) {
      prLocks.delete(key);
    }
  }
}

/**
 * Number of repository+PR keys currently locked. Test-only introspection to
 * prove the lock map is cleaned up after concurrent critical sections finish.
 */
export function activeLockCount(): number {
  return prLocks.size;
}
