import { AppState } from 'react-native';
import { t } from '../i18n';

let pending = 0;

/** Android credential activities can report background while our system prompt is open. */
export function shouldInvalidateBackground(): boolean {
  return pending === 0;
}

function waitForForeground(): Promise<void> {
  if (AppState.currentState == null || AppState.currentState === 'active') return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let subscription: { remove: () => void } | undefined;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      subscription?.remove();
      if (error) reject(error); else resolve();
    };
    subscription = AppState.addEventListener('change', (state) => { if (state === 'active') finish(); });
    timer = setTimeout(() => finish(new Error(t('dappBrowser.requestChanged'))), 5_000);
    if (AppState.currentState === 'active') finish();
  });
}

/** Callers bound the native operation's timeout. Never release credentials in background. */
export async function withSystemAuthentication<T>(operation: () => Promise<T>): Promise<T> {
  pending++;
  try {
    const result = await operation();
    await waitForForeground();
    return result;
  } finally { pending--; }
}
