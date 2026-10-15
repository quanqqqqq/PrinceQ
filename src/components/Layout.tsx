/**
 * 应用外壳：左侧固定导航、顶部紧凑栏，助手面板在桌面宽度下停靠右侧、窄屏下
 * 以抽屉打开。
 *
 * 布局要点：主区域不再统一套 `max-w-4xl`——/matrix 需要整幅宽度来容纳二维散点
 * 图和横向四列，所以宽度由各页面自己决定（见 `WIDE_ROUTES`）。
 *
 * 助手默认 **收缩** 成最右侧一条窄栏，把宽度留给矩阵视图：窄栏上有机器人图标、
 * 状态/未读提示和"展开助手"按钮，点开就是原来的完整面板，面板头部带收起按钮。
 * 关键约束——收缩与展开 **都不卸载** `AgentPanel`：它用 `hidden` 切换可见性，
 * 组件始终挂载，消息、`sessionId` 和输入框里没发出去的草稿因此全部保留。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import {
  Activity,
  Bot,
  Grid2x2,
  GripVertical,
  HelpCircle,
  ListOrdered,
  Loader2,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightOpen,
  Settings,
  Target,
} from 'lucide-react';
import { TASK_STATUSES, type TaskStatus } from '@shared/types';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTrigger } from '@/components/ui/sheet';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { AgentPanel, type AgentPanelStatus } from '@/components/AgentPanel';
import { SkillDownloadButton } from '@/components/SkillDownloadButton';
import { Toaster } from '@/components/ui/sonner';
import { WorkspaceProvider } from '@/hooks/use-workspace';
import {AgentConversationProvider} from '@/hooks/agent-conversation-provider';
import { useResource } from '@/hooks/use-resource';
import { api } from '@/lib/api';
import { APP_NAME, APP_TAGLINE, NAV_HINTS, NAV_LABELS, PAGE_TITLES } from '@/lib/i18n';
import { STATUS_LABELS } from '@/lib/format';
import { cn } from '@/lib/utils';
import { OPEN_AGENT_PANEL_EVENT } from '@/lib/goal-draft-request';
import { OnboardingGuide } from '@/pages/HomePage/components/OnboardingGuide';
import { openOnboarding } from '@/lib/onboarding';

/**
 * 一级导航里 /matrix 的本地展示名。
 *
 * 词典 `NAV_LABELS.matrix` / `PAGE_TITLES['/matrix']` 仍是「四象限」/「艾森豪威尔
 * 四象限」，由其它分片负责；这里只在外壳层覆盖显示文案，`i18n.ts` 一个字不改。
 * 路由本身保持 `/matrix`，四个子象限名（重要且紧急等）也完全不动。
 */
const MATRIX_NAV_LABEL = '任务分布视图';
const MATRIX_NAV_HINT = '按重要/紧急查看分布';

/**
 * 一级导航里 /settings 的本地展示名，同 /matrix 的做法：中文文案落在外壳层，
 * 不往共享词典 `i18n.ts` 里加键。页面组件由其它分片实现，这里只占导航位。
 */
const SETTINGS_NAV_LABEL = '个人设置';
const SETTINGS_NAV_HINT = '应用与偏好设置';

const NAV_ITEMS = [
  { to: '/goals', label: NAV_LABELS.goals, icon: Target, hint: NAV_HINTS.goals },
  { to: '/', label: NAV_LABELS.home, icon: ListOrdered, hint: NAV_HINTS.home },
  { to: '/matrix', label: MATRIX_NAV_LABEL, icon: Grid2x2, hint: MATRIX_NAV_HINT },
  { to: '/activity', label: NAV_LABELS.activity, icon: Activity, hint: NAV_HINTS.activity },
  { to: '/settings', label: SETTINGS_NAV_LABEL, icon: Settings, hint: SETTINGS_NAV_HINT },
];

/** 这些路由自己管理宽度，不受阅读宽度上限约束。 */
const WIDE_ROUTES = ['/matrix'];

/** 顶栏/文档标题的本地覆盖，与导航同一套说法；其它路由仍走 PAGE_TITLES。 */
const LOCAL_PAGE_TITLES: Record<string, string> = {
  '/matrix': MATRIX_NAV_LABEL,
  '/settings': SETTINGS_NAV_LABEL,
};

/**
 * 顶栏的任务状态计数。
 *
 * 数据来自 `api.listTasks()`——它返回 **全部** 任务（含已归档），所以总数就是
 * `tasks.length`，六个状态互斥且相加等于总数。`/health` 只给总数，没有分状态
 * 计数，因此这里在前端实时统计，服务端不动。
 *
 * domains 用 `['tasks','queue']`：任意一处写操作（领取、完成、归档、重算…）
 * invalidate 这两个 domain 后，这里会自动重取，不需要手动刷新。
 */
function HealthBadge() {
  const { data, error } = useResource(['tasks', 'queue'], () => api.listTasks());

  const counts = useMemo(() => {
    const tasks = data?.tasks ?? [];
    const byStatus = Object.fromEntries(
      TASK_STATUSES.map((status) => [status, 0]),
    ) as Record<TaskStatus, number>;
    for (const task of tasks) {
      if (task.status in byStatus) byStatus[task.status] += 1;
    }
    return { total: tasks.length, byStatus };
  }, [data]);

  if (error) {
    return (
      <Badge variant="outline" className="gap-1.5 border-destructive/30 bg-destructive/5 font-normal text-destructive">
        本地 API 未连接
      </Badge>
    );
  }
  if (!data) {
    return (
      <Badge variant="outline" className="font-normal text-muted-foreground">
        检查中…
      </Badge>
    );
  }
  return (
    <>
      {/* 窄屏：只留总数，避免挤掉页面标题。 */}
      <span className="text-xs tabular-nums text-muted-foreground sm:hidden">
        共 {counts.total} 任务
      </span>
      {/* sm 起：一行紧凑 token 文本，六个互斥状态（含已归档）全部展开。 */}
      <span className="hidden text-xs tabular-nums text-muted-foreground sm:inline">
        总 {counts.total}
        {TASK_STATUSES.map((status) => (
          <span key={status}> · {STATUS_LABELS[status]} {counts.byStatus[status]}</span>
        ))}
      </span>
    </>
  );
}

function HelpDialog({ compact = false }: { compact?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size={compact ? 'icon' : 'sm'} className={cn('text-muted-foreground', compact ? 'size-8' : 'h-7 px-2 text-xs')} aria-label="帮助">
          <HelpCircle />
          {compact ? <span className="sr-only">帮助</span> : '帮助'}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{APP_NAME} 使用说明</DialogTitle>
          <DialogDescription>
            {APP_NAME} 帮你安排任务、目标与下一步。数据保存在本机；启用助手后，可用 Claude 或 Codex 理解请求。
          </DialogDescription>
        </DialogHeader>
        <Button size="sm" variant="outline" onClick={() => { setOpen(false); requestAnimationFrame(openOnboarding); }}>
          <Bot />重新查看新手指引
        </Button>
        <ul className="space-y-2 text-sm">
          {NAV_ITEMS.map((item) => (
            <li key={item.to} className="flex items-start gap-2">
              <item.icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0">
                <span className="font-medium">{item.label}</span>
                <span className="block text-xs text-muted-foreground">{item.hint}</span>
              </span>
            </li>
          ))}
        </ul>
        <p className="text-xs text-muted-foreground">
          助手未启用时使用本地命令模式；启用后由 Agent 理解消息，写入前会展示待确认预览。
        </p>
      </DialogContent>
    </Dialog>
  );
}

function Shell() {
  const location = useLocation();
  // /matrix 在外壳层本地改名，其它路由仍取词典里的 PAGE_TITLES。
  const title = LOCAL_PAGE_TITLES[location.pathname] ?? PAGE_TITLES[location.pathname] ?? APP_NAME;
  useEffect(() => {
    document.title = `${title} · ${APP_NAME}`;
  }, [title]);
  const wide = WIDE_ROUTES.includes(location.pathname);
  const [navExpanded, setNavExpanded] = useState(() => {
    try { return localStorage.getItem('princeq.nav-collapsed') !== 'true'; } catch { return true; }
  });
  const [assistantWidth, setAssistantWidth] = useState(() => {
    const available = Math.max(320, window.innerWidth - (navExpanded ? 224 : 64) - 320);
    const max = Math.min(720, available);
    try {
      const stored = Number(localStorage.getItem('princeq.assistant-width'));
      return Number.isFinite(stored) && stored >= 320 && stored <= 720 ? Math.min(stored, max) : Math.min(416, max);
    } catch { return Math.min(416, max); }
  });
  const [resizingAssistant, setResizingAssistant] = useState(false);
  const resizeStartRef = useRef<{clientX:number;width:number}|null>(null);
  useEffect(() => {
    try { localStorage.setItem('princeq.nav-collapsed', String(!navExpanded)); } catch { /* preference is optional */ }
  }, [navExpanded]);
  useEffect(() => {
    try { localStorage.setItem('princeq.assistant-width', String(assistantWidth)); } catch { /* preference is optional */ }
  }, [assistantWidth]);
  useEffect(() => {
    const clampToViewport = () => {
      const sidebarWidth = navExpanded ? 224 : 64;
      const max = Math.min(720, Math.max(320, window.innerWidth - sidebarWidth - 320));
      setAssistantWidth(current => Math.min(current, max));
    };
    window.addEventListener('resize', clampToViewport);
    return () => window.removeEventListener('resize', clampToViewport);
  }, [navExpanded]);
  useEffect(() => {
    if (!resizingAssistant) return;
    const onMove = (event: PointerEvent) => {
      const start = resizeStartRef.current;
      if (!start) return;
      const mainMinimum = 320;
      const sidebarWidth = navExpanded ? 224 : 64;
      const available = Math.max(320, window.innerWidth - sidebarWidth - mainMinimum);
      const max = Math.min(720, available);
      const next = Math.max(320, Math.min(max, start.width + start.clientX - event.clientX));
      setAssistantWidth(next);
    };
    const onEnd = () => { resizeStartRef.current = null; setResizingAssistant(false); };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onEnd);
    window.addEventListener('pointercancel', onEnd);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onEnd);
      window.removeEventListener('pointercancel', onEnd);
    };
  }, [resizingAssistant, navExpanded]);
  // 桌面默认收缩，把宽度留给矩阵视图；面板本身始终挂载。
  const [agentOpen, setAgentOpen] = useState(() => new URLSearchParams(window.location.search).has('agent_session'));
  const [mobileAgentOpen, setMobileAgentOpen] = useState(() => new URLSearchParams(window.location.search).has('agent_session') && window.matchMedia('(max-width: 1023px)').matches);
  const [agentStatus, setAgentStatus] = useState<AgentPanelStatus>({
    messageCount: 0,
    sending: false,
  });
  useEffect(() => {
    const revealAssistant = () => {
      setAgentOpen(true);
      if (window.matchMedia('(max-width: 1023px)').matches) setMobileAgentOpen(true);
    };
    window.addEventListener(OPEN_AGENT_PANEL_EVENT, revealAssistant);
    return () => window.removeEventListener(OPEN_AGENT_PANEL_EVENT, revealAssistant);
  }, []);

  return (
    <div className="princeq-app relative flex h-dvh w-full overflow-hidden bg-background">
      {/* 左侧导航 */}
      <nav className={cn('hidden shrink-0 flex-col border-r border-border bg-sidebar transition-[width] duration-200 md:flex', navExpanded ? 'w-56' : 'w-16')}>
        <div className={cn('flex h-14 shrink-0 items-center border-b border-border', navExpanded ? 'justify-between gap-2 px-3' : 'justify-center px-2')}>
          {navExpanded ? <div className="flex min-w-0 items-center gap-2">
            <img src="/princeq-mark.svg" alt="" aria-hidden="true" className="size-7 shrink-0" />
            <span className="truncate text-sm font-semibold tracking-tight">{APP_NAME}</span>
          </div> : null}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button type="button" size="icon" variant="ghost" className="size-8 shrink-0 text-muted-foreground" aria-label={navExpanded ? '收起左侧导航' : '展开左侧导航'} onClick={() => {
                const next = !navExpanded;
                setNavExpanded(next);
                const sidebarWidth = next ? 224 : 64;
                const max = Math.min(720, Math.max(320, window.innerWidth - sidebarWidth - 320));
                setAssistantWidth(current => Math.min(current, max));
              }}>
                {navExpanded ? <PanelLeftClose /> : <PanelLeftOpen />}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right">{navExpanded ? '收起导航栏' : '展开导航栏'}</TooltipContent>
          </Tooltip>
        </div>
        <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto overscroll-contain p-2">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              title={!navExpanded ? item.label : undefined}
              aria-label={!navExpanded ? item.label : undefined}
              className={({ isActive }) =>
                cn(
                  'flex w-full flex-row items-center rounded-md py-2 text-sm transition-colors hover-elevate active-elevate-2',
                  navExpanded ? 'gap-2.5 px-2.5' : 'justify-center px-2',
                  isActive
                    ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
                    : 'text-sidebar-foreground',
                )
              }
            >
              <item.icon className="size-4 shrink-0" />
              <span className={cn('truncate', navExpanded ? '' : 'sr-only')}>{item.label}</span>
            </NavLink>
          ))}
        </div>
        <div className={cn('shrink-0 border-t border-border', navExpanded ? 'space-y-2 p-3' : 'flex flex-col items-center gap-2 p-2')}>
          {navExpanded ? <p className="text-xs text-muted-foreground">
            {APP_TAGLINE}
          </p> : null}
          <HelpDialog compact={!navExpanded} />
        </div>
      </nav>

      {/* 主列 */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border px-4">
          <div className="flex min-w-0 items-center gap-3">
            <div className="min-w-0">
              <div className="mb-0.5 flex items-center gap-1 text-[10px] font-semibold tracking-wide text-muted-foreground md:hidden">
                <img src="/princeq-mark.svg" alt="" aria-hidden="true" className="size-3" />{APP_NAME}
              </div>
              <h1 className="truncate text-sm font-semibold tracking-tight">{title}</h1>
            </div>
            {/* 计数自己管响应式：窄屏紧凑一个总数，sm 起展开六个状态。 */}
            <div className="min-w-0 shrink-0">
              <HealthBadge />
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <div className="md:hidden"><HelpDialog /></div>
            {/* 窄屏通过抽屉访问助手 */}
            <Sheet open={mobileAgentOpen} onOpenChange={setMobileAgentOpen}>
              <SheetTrigger asChild>
                <Button size="sm" variant="outline" className="lg:hidden">
                  <Bot />
                  助手
                </Button>
              </SheetTrigger>
              <SheetContent side="right" className="w-full p-0 sm:max-w-md">
                <AgentPanel className="h-full" isOpen={mobileAgentOpen} />
              </SheetContent>
            </Sheet>
          </div>
        </header>

        {/* 移动端导航 */}
        <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-border px-2 py-1.5 md:hidden">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) =>
                cn(
                  'flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs hover-elevate active-elevate-2',
                  isActive ? 'bg-accent font-medium text-accent-foreground' : 'text-muted-foreground',
                )
              }
            >
              <item.icon className="size-3.5" />
              {item.label}
            </NavLink>
          ))}
        </div>

        <OnboardingGuide />
        {/* Keep absolute accessibility labels inside this scroll container. */}
        <main className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <div className={cn('p-4 lg:p-6', wide ? 'w-full' : 'mx-auto max-w-4xl')}>
            <Outlet />
          </div>
        </main>
      </div>

      {/* 停靠的助手：收缩成窄栏或展开成完整面板，两种状态下 AgentPanel 都不卸载 */}
      <div
        className={cn(
          'relative hidden shrink-0 border-l border-border lg:flex',
          agentOpen ? '' : 'w-[52px]',
        )}
        style={agentOpen ? {width: `${assistantWidth}px`} : undefined}
      >
        {agentOpen ? <div
          role="separator"
          aria-label="调整助手面板宽度"
          aria-orientation="vertical"
          aria-valuemin={320}
          aria-valuemax={720}
          aria-valuenow={assistantWidth}
          tabIndex={0}
          className={cn('absolute -left-1.5 top-0 z-20 flex h-full w-3 cursor-col-resize touch-none items-center justify-center outline-none focus-visible:ring-2 focus-visible:ring-primary', resizingAssistant ? 'bg-primary/10' : 'hover:bg-primary/10')}
          onPointerDown={event => {
            event.preventDefault();
            resizeStartRef.current = {clientX:event.clientX,width:assistantWidth};
            setResizingAssistant(true);
          }}
          onKeyDown={event => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
            event.preventDefault();
            const delta = event.key === 'ArrowLeft' ? 24 : -24;
            const max = Math.min(720, Math.max(320, window.innerWidth - (navExpanded ? 224 : 64) - 320));
            setAssistantWidth(current => Math.max(320, Math.min(max, current + delta)));
          }}
        >
          <GripVertical className="size-3.5 text-muted-foreground/70" />
        </div> : null}
        {/* 收缩后的窄栏：图标 + 未读/忙碌提示 + 展开按钮 */}
        <div
          className={cn(
            'w-full flex-col items-center gap-2 bg-card py-3',
            agentOpen ? 'hidden' : 'flex',
          )}
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                className="text-muted-foreground"
                onClick={() => setAgentOpen(true)}
              >
                <PanelRightOpen />
                <span className="sr-only">展开助手</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent side="left">展开右侧助手面板</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="flex flex-col items-center gap-1.5 rounded-md px-1 py-1.5 text-muted-foreground hover-elevate active-elevate-2"
                onClick={() => setAgentOpen(true)}
              >
                {agentStatus.sending ? (
                  <Loader2 className="size-4 animate-spin text-primary" />
                ) : (
                  <Bot className="size-4 text-primary" />
                )}
                {agentStatus.messageCount > 0 ? (
                  <span className="text-[11px] font-medium tabular-nums">
                    {agentStatus.messageCount}
                  </span>
                ) : null}
                <span className="[writing-mode:vertical-rl] text-[11px] tracking-wide">助手</span>
              </button>
            </TooltipTrigger>
            <TooltipContent side="left">
              {agentStatus.sending
                ? '助手正在处理请求…'
                : agentStatus.messageCount > 0
                  ? `当前会话有 ${agentStatus.messageCount} 条消息，点开继续`
                  : '点开助手开始对话'}
            </TooltipContent>
          </Tooltip>
          <SkillDownloadButton compact />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="size-7 text-muted-foreground hover:text-primary [&_svg]:size-3.5"
                aria-label="重新打开新手指引"
                onClick={openOnboarding}
              >
                <HelpCircle />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="left">新手指引</TooltipContent>
          </Tooltip>
        </div>

        {/* 完整面板：收缩时只是隐藏，消息、会话和草稿都留着 */}
        <AgentPanel
          className={cn('h-full w-full', agentOpen ? 'flex' : 'hidden')}
          isOpen={agentOpen}
          onCollapse={() => setAgentOpen(false)}
          onStatusChange={setAgentStatus}
        />
      </div>
    </div>
  );
}

export const Layout = () => (
  <WorkspaceProvider>
    <AgentConversationProvider><Shell /></AgentConversationProvider>
    <Toaster />
  </WorkspaceProvider>
);
