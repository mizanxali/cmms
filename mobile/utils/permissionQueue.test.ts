import {
  PERMISSION_QUEUE_WATCHDOG_MS,
  serializePermissionRequest
} from './permissionQueue';

// Stands in for React Native's activity delegate: one pending result slot, so a second request in flight
// overwrites the first and the first never settles.
function singleSlotDialogs() {
  let pending: ((v: string) => void) | null = null;
  return {
    request: (name: string) =>
      new Promise<string>((resolve) => {
        pending = () => resolve(name);
      }),
    answer: () => {
      const p = pending;
      pending = null;
      p?.('granted');
    }
  };
}

const flush = () =>
  new Promise((r) => jest.requireActual('timers').setImmediate(r));

test('the Bluetooth and notification prompts both settle when requested together', async () => {
  const dialogs = singleSlotDialogs();
  const settled: string[] = [];
  serializePermissionRequest(() => dialogs.request('bluetooth')).then((n) =>
    settled.push(n)
  );
  serializePermissionRequest(() => dialogs.request('notifications')).then((n) =>
    settled.push(n)
  );
  await flush();
  dialogs.answer();
  await flush();
  dialogs.answer();
  await flush();
  expect(settled).toEqual(['bluetooth', 'notifications']);
});

test('a request that never settles releases the queue after the watchdog', async () => {
  jest.useFakeTimers();
  try {
    serializePermissionRequest(() => new Promise<string>(() => {}));
    const later = jest.fn(() => Promise.resolve('camera'));
    serializePermissionRequest(later);
    await flush();
    expect(later).not.toHaveBeenCalled();
    jest.advanceTimersByTime(PERMISSION_QUEUE_WATCHDOG_MS);
    await flush();
    expect(later).toHaveBeenCalled();
  } finally {
    jest.useRealTimers();
  }
});
