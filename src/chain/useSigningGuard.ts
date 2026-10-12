import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { shouldInvalidateBackground } from '../crypto/systemAuthentication';

/** Bind an asynchronous signing attempt to one reviewed request and wallet/network.
 * Inactive is allowed because biometric/Passkey system prompts can cause it.
 */
export function useSigningGuard(context: string, confirmation: unknown, onContextChanged?: () => void) {
  const state = useRef({ context, confirmation, approvedContext: context,
    generation: 0, mounted: true, pending: false });
  if (state.current.context !== context || state.current.confirmation !== confirmation) {
    if (state.current.confirmation !== confirmation) state.current.approvedContext = context;
    state.current.context = context;
    state.current.confirmation = confirmation;
    state.current.generation++;
  }
  const callback = useRef(onContextChanged);
  callback.current = onContextChanged;
  const previousContext = useRef(context);
  useEffect(() => {
    if (previousContext.current !== context) callback.current?.();
    previousContext.current = context;
  }, [context]);
  useEffect(() => {
    state.current.mounted = true;
    const sub = AppState.addEventListener('change', (status) => {
      if (status === 'background' && shouldInvalidateBackground()) state.current.generation++;
    });
    return () => { state.current.mounted = false; state.current.generation++; sub.remove(); };
  }, []);

  return {
    begin() {
      const current = state.current;
      if (!current.confirmation || !current.mounted || current.pending ||
          current.approvedContext !== current.context || AppState.currentState === 'background') return null;
      current.pending = true;
      const generation = current.generation;
      return {
        isCurrent: () => state.current.mounted && state.current.generation === generation && AppState.currentState !== 'background',
        finish: () => { state.current.pending = false; },
      };
    },
  };
}
