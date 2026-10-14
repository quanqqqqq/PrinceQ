import {createContext} from 'react';
import type {useAgentConversationState} from './use-agent-conversation';
export const AgentConversationContext=createContext<ReturnType<typeof useAgentConversationState>|null>(null);
