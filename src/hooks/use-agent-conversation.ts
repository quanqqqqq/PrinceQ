/** Shared conversation state: one owner for desktop, drawer and all routes. */
import {useCallback,useContext,useEffect,useRef,useState} from 'react';
import type {AgentSession} from '@shared/types';
import {mergeAgentMessages,pendingUserMessage,restoreChatMessages,type ChatMessage} from '@/lib/agent-message-state';
import {api,ApiRequestError} from '@/lib/api';
import {getRuntimeStatus,sendAgentMessage,RUNTIME_CONFIG_CHANGED_EVENT} from '@/lib/agent-runtime-client';
import {deriveEffectiveMode,type AgentRuntimeStatusView,type EffectiveMode} from '@/lib/agent-runtime-contract';
import {useWorkspace} from '@/hooks/use-resource';
import {AgentConversationContext} from './agent-conversation-context';
const STORAGE_KEY = 'pwq.agent-panel.v1';

interface Persisted {
  sessionId?: string;
  messages?: ChatMessage[];
  input?: string;
  drafts?: Record<string,string>;
  /** 已确认/已取消的预览 token：跨刷新保留，旧按钮刷新后仍不可执行。 */
  disabledTokens?: string[];
  /** 每条助手回复来自哪条路（真实 Agent / 本地命令），按消息 id 记。 */
  sources?: Record<string, EffectiveMode>;
}

const FALLBACK_STATUS: AgentRuntimeStatusView = {
  configured: false,
  enabled: false,
  provider: null,
  health: { ok: false, reason: 'health_unknown', checked_at: null },
  effective_mode: 'deterministic-local',
  background: { implemented: false, status: 'not_implemented' },
};

/** 头部健康徽章配色：ok 绿 / muted 灰 / warn 琥珀 / bad 红。 */

const CANCEL_PHRASE = /^(取消|取消预览|取消草稿|取消这次|撤销|算了|不要了|算了吧)$/;
function readCache():Persisted {try{const value=JSON.parse(localStorage.getItem(STORAGE_KEY)??'{}');return value && typeof value==='object' && !Array.isArray(value) ? value as Persisted : {};}catch{return {};}}
export function useAgentConversationState() {
  const [initialCache]=useState(readCache);
  const { invalidate } = useWorkspace();
  const [messages, setMessages] = useState<ChatMessage[]>(() => {
    if (new URLSearchParams(window.location.search).has('agent_session')) return [];
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return restoreChatMessages(raw ? (JSON.parse(raw) as Persisted).messages : []);
    } catch { return []; }
  });
  const [sessionId, setSessionId] = useState<string | undefined>(() => {
    const linkedSession = new URLSearchParams(window.location.search).get('agent_session');
    if (linkedSession) return linkedSession;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? (JSON.parse(raw) as Persisted).sessionId : undefined;
    } catch { return undefined; }
  });
  const [input, setInput] = useState(() => {
    try {
      const linked=new URLSearchParams(window.location.search).get('agent_session');
      if(linked && initialCache.sessionId!==linked)return initialCache.drafts?.[linked]??'';
      return initialCache.input??'';
    } catch { return ''; }
  });
  const [sending, setSending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 已确认/已取消的预览 token：旧按钮永久失效；跨刷新从 localStorage 恢复。
  const [disabledTokens, setDisabledTokens] = useState<ReadonlySet<string>>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return new Set(raw ? (JSON.parse(raw) as Persisted).disabledTokens ?? [] : []);
    } catch { return new Set(); }
  });
  // 每条助手回复来自哪条路（真实 Agent / 本地命令），跨刷新保留。
  const [sources, setSources] = useState<Record<string, EffectiveMode>>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? (JSON.parse(raw) as Persisted).sources ?? {} : {};
    } catch { return {}; }
  });
  // Agent 运行时的实时状态：决定这条消息走真实 CLI 还是本地命令。读不到就安全回落。
  const [runtime, setRuntime] = useState<AgentRuntimeStatusView>(FALLBACK_STATUS);
  // 上一次真实 Agent 调用失败、还在等用户决定「重试 / 回落本地命令」的那条。
  const [failedTurn, setFailedTurn] = useState<{
    text: string;
    target?: { task_id?: string; goal_id?: string };
    localId?: string;
    preserveInput?: boolean;
    intent?: 'goal_task_drafts';
  } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const sendingRef = useRef(false);
  const confirmingRef = useRef(false);
  const selectionRef = useRef(0);
  const historyReadRef = useRef(0);
  const loadingRef = useRef(false);
  const draftsRef = useRef<Record<string,string>>({...initialCache.drafts});
  const [sessions,setSessions] = useState<AgentSession[]>([]);
  const [nextCursor,setNextCursor] = useState<string | null>(null);
  const [historyOpen,setHistoryOpen] = useState(false);
  const [historyLoading,setHistoryLoading] = useState(false);
  const [historyError,setHistoryError] = useState<string | null>(null);
  const [sessionLoading,setSessionLoading] = useState(false);
  const [sessionTitle,setSessionTitle] = useState('');
  const interactionRef = useRef(0);
  const runtimeReadRef = useRef(0);

  /** 当前实际走哪条路：agent 不可用时恒为 local-command（输入仍照发，不吞）。 */
  const effectiveMode: EffectiveMode = deriveEffectiveMode(runtime.enabled, runtime.health.ok);

  const refreshRuntime = useCallback(async () => {
    const revision = ++runtimeReadRef.current;
    try {
      const status = await getRuntimeStatus();
      if (revision === runtimeReadRef.current) setRuntime(status);
    } catch { /* Keep the current local status if the API is offline. */ }
  }, []);




  useEffect(() => {
    try {
      draftsRef.current[sessionId ?? 'new'] = input;
      const payload: Persisted = { sessionId, messages, input, drafts: draftsRef.current, disabledTokens: [...disabledTokens], sources };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch { /* storage full / private mode — ignore */ }
  }, [sessionId, messages, input, disabledTokens, sources]);

  useEffect(() => {
    const load = () => { void refreshRuntime(); };
    const cancelReads = () => { runtimeReadRef.current++; };
    load();
    const timer = setInterval(load, 30_000);
    window.addEventListener(RUNTIME_CONFIG_CHANGED_EVENT, load);
    return () => { cancelReads(); clearInterval(timer); window.removeEventListener(RUNTIME_CONFIG_CHANGED_EVENT, load); };
  }, [refreshRuntime]);

  const handle = useCallback(
    async (work: () => Promise<Awaited<ReturnType<typeof api.sendMessage>>>, optimisticId?: string) => {
      setError(null);
      try {
        const reply = await work();
        setSessionId(reply.session.id);
      setSessionTitle(reply.session.title);
      setSessions(previous => [reply.session, ...previous.filter(item => item.id !== reply.session.id)]);
        setMessages((previous) => mergeAgentMessages(previous, reply.messages, optimisticId));
        if (reply.invalidates.length > 0) invalidate(reply.invalidates);
        return true;
      } catch (cause) {
        setError(
          cause instanceof ApiRequestError
            ? cause.message
            : `意外错误：${(cause as Error).message}`,
        );
        return false;
      }
    },
    [invalidate],
  );

  // 取消草稿：让服务端把这份预览注销（不创建任务），再本地标记旧按钮失效。
  // 刷新后服务端注销 + localStorage 双保险，旧 token 不能再执行。
  const cancel = useCallback(
    async (token: string, optimisticId?: string) => {
      if(confirmingRef.current || loadingRef.current || (sendingRef.current && !optimisticId))return false;
      interactionRef.current++;confirmingRef.current=true;setConfirming(true);
      try {
        const ok = await handle(() => api.cancelAction(token, sessionId), optimisticId);
        if (ok) setDisabledTokens((prev) => new Set(prev).add(token));
        return ok;
      } finally {confirmingRef.current=false;setConfirming(false);}
    },
    [handle, sessionId],
  );

  /**
   * 把一次成功往返写进消息流，并给**最后那条助手回复**打上来源标签。
   * 失败不走到这里——失败由调用方留 failedTurn。
   */
  const appendReply = useCallback(
    (reply: Awaited<ReturnType<typeof api.sendMessage>>, mode: EffectiveMode, optimisticId: string) => {
      setSessionId(reply.session.id);
      setSessionTitle(reply.session.title);
      setSessions(previous => [reply.session, ...previous.filter(item => item.id !== reply.session.id)]);
      setMessages((previous) => mergeAgentMessages(previous, reply.messages, optimisticId));
      const last = reply.messages[reply.messages.length - 1];
      if (last) setSources((prev) => ({ ...prev, [last.id]: mode }));
      if (reply.invalidates.length > 0) invalidate(reply.invalidates);
    },
    [invalidate],
  );

  const send = useCallback(
    async (
      text: string,
      target?: { task_id?: string; goal_id?: string },
      /** 重试/回落时显式指定走哪条路；平时按当前 effectiveMode 自动选。 */
      forcedMode?: EffectiveMode,
      retryId?: string,
      options?: { preserveInput?: boolean; fromShortcut?: boolean; onStarted?: () => void; intent?: 'goal_task_drafts' },
    ) => {
      const message = text.trim();
      if (!message || sendingRef.current || confirmingRef.current || loadingRef.current ||
          (historyOpen && !options?.fromShortcut)) return false;

      const existing = retryId ? messages.find(item => item.id === retryId) : [...messages].reverse().find(
        item => item.role === 'user' && item.content === message && (item.delivery === 'failed' || item.delivery === 'cancelled'),
      );
      const optimistic = pendingUserMessage(message, sessionId, existing?.id);
      interactionRef.current++;
      sendingRef.current = true;
      setMessages(previous => existing ? previous.map(item => item.id === existing.id ? optimistic : item) : [...previous, optimistic]);
      if (!options?.preserveInput) setInput('');
      setSending(true);
      setFailedTurn(null);
      setError(null);


      if (!target && CANCEL_PHRASE.test(message)) {
        const pending = [...messages].reverse().find(item => item.role === 'agent' &&
          item.result?.pending_action?.token && !disabledTokens.has(item.result.pending_action.token));
        const token = pending?.result?.pending_action?.token;
        try {
          const ok = token ? await cancel(token, optimistic.id) : false;
          if (!ok) {
            setMessages(previous => previous.map(item => item.id === optimistic.id ? {...item, delivery: 'failed'} : item));
            if (!options?.preserveInput) setInput(current => current || message);
            if (!token) setError('当前没有待确认的预览可以取消');
          }
        } finally { sendingRef.current = false; setSending(false); }
        return;
      }
      const mode = forcedMode ?? effectiveMode;

      try {
        if (options?.fromShortcut) setHistoryOpen(false);
        options?.onStarted?.();
        // 两种模式都走既有 /api/agent/message，靠 processing_mode 显式选路：
        // agent 强制走模型（失败由后端返回 source=agent-error，不静默降级）；
        // command 强制走确定性规则解析器。长请求可取消。
        const controller = new AbortController();
        abortRef.current = controller;
        const reply = await sendAgentMessage(message, {
          sessionId,
          target,
          processingMode: mode === 'agent' ? 'agent' : 'command',
          intent: options?.intent,
          signal: controller.signal,
        });
        abortRef.current = null;

        // 无论成败，先把这一轮（用户消息 + 回复）写进消息流。
        appendReply(reply, mode === 'agent' ? 'agent' : 'local-command', optimistic.id);

        // agent 单次失败（未就绪/超时/CLI 报错）：后端已保留消息与会话，这里弹
        // 「重试 / 回落本地命令」卡，绝不静默换语义。
        if (mode === 'agent' && reply.source === 'agent-error') {
          setFailedTurn({ text: message, target, preserveInput: options?.preserveInput, intent: options?.intent });
          if (!options?.preserveInput) setInput(current => current || message);
        }
        // 发完顺手刷新一次运行时状态：CLI 刚恢复时下一条就自动走回 Agent。
        void refreshRuntime();
      } catch (cause) {
        if (cause instanceof DOMException && cause.name === 'AbortError') {
          // 用户主动取消：不算错，把输入还回去，不留错误卡。
          abortRef.current = null;
          setMessages(previous => previous.map(item => item.id === optimistic.id ? {...item, delivery: 'cancelled'} : item));
          if (!options?.preserveInput) setInput(current => current || message);
        } else if (mode === 'agent') {
          // 网络层失败（非 2xx）：保留输入与会话，弹「重试 / 回落本地命令」。
          abortRef.current = null;
          setMessages(previous => previous.map(item => item.id === optimistic.id ? {...item, delivery: 'failed'} : item));
          setFailedTurn({ text: message, target, localId: optimistic.id, preserveInput: options?.preserveInput, intent: options?.intent });
          if (!options?.preserveInput) setInput(current => current || message);
        } else {
          abortRef.current = null;
          setMessages(previous => previous.map(item => item.id === optimistic.id ? {...item, delivery: 'failed'} : item));
          if (!options?.preserveInput) setInput(current => current || message);
          setError(
            cause instanceof ApiRequestError
              ? cause.message
              : `意外错误：${(cause as Error).message}`,
          );
        }
      } finally {
        sendingRef.current = false;
        setSending(false);
      }
      return true;
    },
    [appendReply, cancel, disabledTokens, effectiveMode, messages, refreshRuntime, sessionId, historyOpen],
  );

  const confirm = useCallback(
    async (token: string, drafts?: { index: number; title: string; description?: string | null }[]) => {
      if (sendingRef.current || confirmingRef.current || loadingRef.current) return;
      interactionRef.current++;
      confirmingRef.current = true;
      setConfirming(true);
      const ok = await handle(() => api.confirmAction(token, sessionId, drafts));
      if (ok) setDisabledTokens((prev) => new Set(prev).add(token));
      confirmingRef.current = false;
      setConfirming(false);
    },
    [handle, sessionId],
  );

  const reset = useCallback(() => {
    if (sendingRef.current || confirmingRef.current || loadingRef.current) return;
    interactionRef.current++;
    draftsRef.current[sessionId ?? 'new'] = input;
    selectionRef.current++;
    setHistoryOpen(false);
    setSessionTitle('新会话');
    setMessages([]);
    setSessionId(undefined);
    setInput('');
    setError(null);
    setFailedTurn(null);
    setSources({});
    // Server history and drafts of other sessions remain available.
  }, [sessionId, input]);

  const refreshSessions = useCallback(async (cursor?:string) => {
    const revision=++historyReadRef.current;
    setHistoryLoading(true); setHistoryError(null);
    try {
      const result=await api.agentSessions(cursor ? {cursor} : undefined);
      if(revision!==historyReadRef.current)return;
      setSessions(previous=>cursor ? [...previous,...result.sessions.filter(item=>!previous.some(old=>old.id===item.id))] : result.sessions);
      setNextCursor(result.next_cursor??null);
    } catch(cause) {if(revision===historyReadRef.current)setHistoryError(cause instanceof Error?cause.message:'读取历史会话失败');}
    finally {if(revision===historyReadRef.current)setHistoryLoading(false);}
  },[]);
  const selectSession = useCallback(async (id:string) => {
    if(sendingRef.current || confirmingRef.current || loadingRef.current) return;
    draftsRef.current[sessionId??'new']=input;
    interactionRef.current++; const revision=++selectionRef.current;
    loadingRef.current=true;setSessionLoading(true);setHistoryError(null);
    try {
      const detail=await api.agentSession(id);
      if(revision!==selectionRef.current)return;
      setSessionId(detail.session.id);setSessionTitle(detail.session.title);setMessages(detail.messages);
      setInput(draftsRef.current[id]??'');setFailedTurn(null);setError(null);
      setDisabledTokens(previous=>new Set([...previous,...(detail.disabled_tokens??[])]));
      setHistoryOpen(false);
    } catch(cause) {setHistoryError(cause instanceof Error?cause.message:'读取会话失败');}
    finally {if(revision===selectionRef.current){loadingRef.current=false;setSessionLoading(false);}}
  },[sessionId,input]);
  // Restore the selected session from the server even when an older local cache exists.
  useEffect(()=>{
    let stopped=false;const interaction=interactionRef.current;
    const cached=initialCache;const linked=new URLSearchParams(window.location.search).get('agent_session');
    const storedId=linked??cached.sessionId;
    (async()=>{
      try {
        const list=await api.agentSessions();
        if(stopped||interaction!==interactionRef.current)return;
        setSessions(list.sessions);setNextCursor(list.next_cursor??null);
        const id=storedId??list.sessions[0]?.id;
        if(!id)return;
        const detail=await api.agentSession(id);
        if(stopped||interaction!==interactionRef.current)return;
        const unsaved=!linked && cached.sessionId===id ? restoreChatMessages(cached.messages).filter(message=>message.delivery) : [];
        setSessionId(id);setSessionTitle(detail.session.title);setMessages([...detail.messages,...unsaved]);
        setDisabledTokens(previous=>new Set([...previous,...(detail.disabled_tokens??[])]));
        if(linked && cached.sessionId!==id)setInput(draftsRef.current[id]??'');
      } catch(cause) {
        if(!stopped)setHistoryError(cause instanceof Error?cause.message:'历史会话暂时不可用');
      }
    })();
    return()=>{stopped=true;};
  },[initialCache]);
  const showHistory = useCallback(()=>{setHistoryOpen(open=>!open);void refreshSessions();},[refreshSessions]);
  return {messages,sessionId,sessionTitle,input,setInput,sending,confirming,error,setError,disabledTokens,sources,
    runtime,effectiveMode,failedTurn,abortRef,send,confirm,cancel,reset,sessions,nextCursor,historyOpen,
    historyLoading,historyError,sessionLoading,showHistory,refreshSessions,selectSession};
}
export function useAgentConversation() {const value=useContext(AgentConversationContext);if(!value)throw new Error('AgentConversationProvider is missing');return value;}
