import { useEffect, useId, useState } from 'react';
import { Platform } from 'react-native';
import * as ScreenCapture from 'expo-screen-capture';

// Serialize native calls: cleanup may run before an asynchronous acquire finishes.
let queue: Promise<void> = Promise.resolve();
const owners = new Set<string>();
function enqueue(operation: () => Promise<void>): Promise<void> {
  const result = queue.then(operation);
  queue = result.catch(() => {});
  return result;
}

export function acquireScreenProtection(key: string): Promise<void> {
  return enqueue(async () => {
    try {
      await ScreenCapture.preventScreenCaptureAsync(key);
      if (Platform.OS === 'ios' && owners.size === 0) await ScreenCapture.enableAppSwitcherProtectionAsync(1);
      owners.add(key);
    } catch (error) {
      await ScreenCapture.allowScreenCaptureAsync(key).catch(() => {});
      throw error;
    }
  });
}

export function releaseScreenProtection(key: string): Promise<void> {
  return enqueue(async () => {
    const owned = owners.delete(key);
    await ScreenCapture.allowScreenCaptureAsync(key);
    if (owned && Platform.OS === 'ios' && owners.size === 0) await ScreenCapture.disableAppSwitcherProtectionAsync();
  });
}

/** Sensitive content must remain hidden until this returns true. */
export function useScreenCaptureGuard(active: boolean, key: string): boolean {
  const id = useId();
  const owner = key + id;
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let alive = true;
    setReady(false);
    if (!active) return;
    acquireScreenProtection(owner).then(() => { if (alive) setReady(true); }).catch(() => {});
    return () => {
      alive = false;
      void releaseScreenProtection(owner).catch(() => {});
    };
  }, [active, owner]);
  return active && ready;
}
