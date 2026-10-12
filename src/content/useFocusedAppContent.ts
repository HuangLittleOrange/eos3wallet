import { useCallback } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import { useAppContent } from './AppContentContext';

export function useFocusedAppContent(enabled = true) {
  const state = useAppContent();
  useFocusEffect(useCallback(() => {
    if (enabled) return state.activate();
  }, [enabled, state.activate]));
  return state;
}
