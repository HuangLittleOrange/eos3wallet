import { Platform } from 'react-native';
import { requireNativeModule } from 'expo';
import { t } from '../i18n';

type AuthorizationModule = {
  start(token: string, title: string, body: string): Promise<void>;
  stop(token: string): Promise<void>;
};

/** Keep the callback online only for the current, user-initiated browser request. */
export async function beginAnchorAuthorization(): Promise<() => void> {
  if (Platform.OS !== 'android') return () => {};
  const native = requireNativeModule<AuthorizationModule>('AnchorAuthorization');
  const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await native.start(token, t('import.viaAnchor'), t('anchorImport.waiting'));
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    void native.stop(token).catch(() => undefined);
  };
}
