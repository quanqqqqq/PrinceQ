import type { AgentMessage } from '../../shared/types.ts';

export type ChatMessage = AgentMessage & { delivery?: 'sending' | 'failed' | 'cancelled' };
/** Replace the optimistic user bubble with the server exchange, retaining stable order and IDs. */
export function mergeAgentMessages(previous: ChatMessage[], incoming: AgentMessage[], optimisticId?: string): ChatMessage[] {
  const index = optimisticId ? previous.findIndex(message => message.id === optimisticId) : -1;
  const exchange = index < 0 ? incoming : incoming.map(message => message.role === 'user'
    ? {...message, content: previous[index].content} : message);
  const combined = index < 0 ? [...previous, ...exchange] : [
    ...previous.slice(0, index), ...exchange, ...previous.slice(index+1),
  ];
  const seen = new Set<string>();
  return combined.filter(message => {
    if (seen.has(message.id)) return false;
    seen.add(message.id); return true;
  });
}
export function pendingUserMessage(content: string, sessionId?: string, id = 'local-' + crypto.randomUUID()): ChatMessage {
  return {id, session_id: sessionId ?? '', role: 'user', content, result: null,
    created_at: new Date().toISOString(), delivery: 'sending'};
}
export function restoreChatMessages(messages: unknown): ChatMessage[] {
  if (!Array.isArray(messages)) return [];
  // A pending request cannot be assumed successful after a tab restart.
  return messages.map((message: ChatMessage) => message.delivery === 'sending' ? {...message, delivery: 'failed'} : message);
}
