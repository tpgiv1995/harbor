import { useSyncExternalStore } from 'react';
import { createDialogStore } from './dialog-state.cjs';

export const dialogStore = createDialogStore();
export function useModelDialogs() {
  return useSyncExternalStore(dialogStore.subscribe, dialogStore.getSnapshot);
}
