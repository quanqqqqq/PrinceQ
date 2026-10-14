import type {ReactNode} from 'react';
import {AgentConversationContext} from './agent-conversation-context';
import {useAgentConversationState} from './use-agent-conversation';
export function AgentConversationProvider({children}:{children:ReactNode}) {const value=useAgentConversationState();return <AgentConversationContext.Provider value={value}>{children}</AgentConversationContext.Provider>;}
