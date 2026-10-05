import { useSyncExternalStore } from 'react';
import { createReplyStore } from './question-reply.cjs';
export const replyStore = createReplyStore();
export function useQuestionReply(sessionId) {
  return useSyncExternalStore(replyStore.subscribe, () => replyStore.get(sessionId));
}
