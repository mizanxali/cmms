// Runs permission dialogs one at a time. React Native's activity delegate holds a single pending permission result
// while a system dialog pauses the activity, so with two requests in flight one result is lost and its promise never
// settles. On a first Android login the mesh's Nearby devices request and the push notification request start
// together, and the mesh would hang on "Bluetooth is starting…".

// A request that never settles must not wedge every later prompt; after a minute the queue moves on without it.
export const PERMISSION_QUEUE_WATCHDOG_MS = 60_000;

let tail: Promise<unknown> = Promise.resolve();

export function serializePermissionRequest<T>(
  run: () => Promise<T>
): Promise<T> {
  const next = tail.then(run, run);
  tail = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, PERMISSION_QUEUE_WATCHDOG_MS);
    next
      .catch(() => undefined)
      .then(() => {
        clearTimeout(timer);
        resolve();
      });
  });
  return next;
}
