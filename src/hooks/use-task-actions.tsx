/**
 * 所有渲染 TaskCard 的视图共用的任务写操作处理器，外加按任务区分的 pending
 * 标记，使只有正在操作的那张卡片显示忙碌状态。
 *
 * 「标记受阻」不再调用浏览器原生 window.prompt：改为站内 BlockReasonDialog，
 * 三个调用方（首页队列 / 四象限 / 目标详情）都通过这里返回的 blockDialog 共用。
 *
 * 「归档」成功后弹出即时撤销（sonner toast）：在合理时限内点「撤销」会调用
 * 显式的 restore 动作，把任务恢复到归档前的状态；即使刷新后，也可以在
 * 「已归档」视图或任务详情抽屉里再次恢复。归档/恢复全程保留同一 task id、
 * 目标关联、领取历史与操作记录。
 *
 * 「移动象限」不再直接写库：`onChangeQuadrant` 从前只是把两轴分数写成目标格子的
 * band（75/25 之类），用户点一下就凭空得到两个看起来像判断的数字。现在它打开
 * `RescoreRequestPanel`，把这次改动变成一次交给**真实外部 Agent** 的复评请求，
 * 分数只有在用户点「确认保存」后才落库。
 *
 * 面板经 `createPortal` 挂到 `document.body`：三个调用方（首页队列 / 四象限 /
 * 目标详情）不用各自加一行渲染，拿到的 `handlers` 原样展开就能弹窗。
 */
import { useCallback, useState } from 'react';
import { createPortal } from 'react-dom';
import { toast } from 'sonner';
import type { Quadrant, Task, TaskAction } from '@shared/types';
import { api } from '@/lib/api';
import {
  rescoringClient,
  type RescoringAxis,
  type RescoringRequestWithContext,
} from '@/lib/rescoring-client';
import { useMutation, useWorkspace } from '@/hooks/use-resource';
import { BlockReasonDialog } from '@/components/BlockReasonDialog';
import { RescoreRequestPanel } from '@/components/RescoreRequestPanel';
import { demoText } from '@/lib/format';

export function useTaskActions() {
  const mutation = useMutation(['tasks', 'queue', 'activity', 'goals']);
  const { invalidate } = useWorkspace();
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [blockTarget, setBlockTarget] = useState<Task | null>(null);
  /** 复评面板的目标任务与目标象限；`task` 为 null 表示面板关闭。 */
  const [rescoreTarget, setRescoreTarget] = useState<{
    task: Task;
    quadrant: Quadrant;
  } | null>(null);
  /** 已发起的复评请求；null 表示面板还停在发起态。 */
  const [rescoreRequest, setRescoreRequest] = useState<RescoringRequestWithContext | null>(null);

  const perform = useCallback(
    async (taskId: string, label: string, action: () => Promise<unknown>) => {
      setActiveTaskId(taskId);
      await mutation.run(label, action);
      setActiveTaskId(null);
    },
    [mutation],
  );

  const undoArchive = useCallback(
    (taskId: string) =>
      void perform(taskId, 'restore', () =>
        api.taskAction(taskId, 'restore'),
      ),
    [perform],
  );

  const onAction = useCallback(
    (task: Task, action: TaskAction) => {
      if (action === 'block') {
        // 打开站内弹窗收集原因；不在这里发请求，取消就不会写库。
        setBlockTarget(task);
        return;
      }
      if (action === 'archive') {
        // 归档成功后给一条带「撤销」的即时提示；撤销走显式 restore，恢复归档前状态。
        void perform(task.id, 'archive', () => api.taskAction(task.id, 'archive')).then(() => {
          toast.success(`已归档「${demoText(task.title, task.is_demo)}」`, {
            duration: 8000,
            description: '撤销可在归档前状态恢复它。',
            action: {
              label: '撤销',
              onClick: () => undoArchive(task.id),
            },
          });
        });
        return;
      }
      void perform(task.id, action, () => api.taskAction(task.id, action));
    },
    [perform, undoArchive],
  );

  /** 弹窗里点「确认受阻」：只有成功才关弹窗；失败保持打开、原因保留可重试。 */
  const confirmBlock = useCallback(
    async (reason: string) => {
      if (!blockTarget) return;
      const id = blockTarget.id;
      setActiveTaskId(id);
      const result = await mutation.run('block', () => api.taskAction(id, 'block', { reason }));
      setActiveTaskId(null);
      if (result) setBlockTarget(null);
    },
    [blockTarget, mutation],
  );

  /** 弹窗里点「取消」/ 遮罩 / Esc：不发请求，仅关闭并清掉残留错误。 */
  const cancelBlock = useCallback(() => {
    setBlockTarget(null);
    mutation.clearError();
  }, [mutation]);

  const onConfirmQuadrant = useCallback(
    (task: Task) => void perform(task.id, 'confirm', () => api.confirmQuadrant(task.id)),
    [perform],
  );

  /**
   * 「移动象限」不再直接写库——打开复评面板，交由真实外部 Agent 重新评分。
   *
   * 这里一个请求都不发：面板的发起态还要让用户确认要重评哪几根轴。
   */
  const onChangeQuadrant = useCallback(
    (task: Task, quadrant: Quadrant) => {
      mutation.clearError();
      setRescoreRequest(null);
      setRescoreTarget({ task, quadrant });
    },
    [mutation],
  );

  /** 发起态点按钮：创建请求，面板随即进入等待态。 */
  const createRescoreRequest = useCallback(
    async (axes: RescoringAxis[]) => {
      if (!rescoreTarget) return;
      const { task, quadrant } = rescoreTarget;
      setActiveTaskId(task.id);
      const result = await mutation.run('rescore-create', () =>
        rescoringClient.create(task.id, { target_quadrant: quadrant, changed_axes: axes }),
      );
      setActiveTaskId(null);
      if (result) setRescoreRequest(result.request);
    },
    [mutation, rescoreTarget],
  );

  /** 等待态点「刷新状态」：重新拉这条请求，看看 Agent 有没有提交建议。 */
  const refreshRescoreRequest = useCallback(async () => {
    if (!rescoreRequest) return;
    const result = await mutation.run('rescore-refresh', () => rescoringClient.list());
    if (!result) return;
    const next = result.requests.find((item) => item.id === rescoreRequest.id);
    // 请求已被别处清掉时保留当前视图，不把面板跳回发起态。
    if (next) setRescoreRequest(next);
  }, [mutation, rescoreRequest]);

  /** 待确认态点「确认保存」——整个流程里唯一会写 tasks 的一步。 */
  const confirmRescoreRequest = useCallback(async () => {
    if (!rescoreRequest) return;
    setActiveTaskId(rescoreRequest.task_id);
    const result = await mutation.run('rescore-confirm', () =>
      rescoringClient.confirm(rescoreRequest.id),
    );
    setActiveTaskId(null);
    if (!result) return;
    setRescoreTarget(null);
    setRescoreRequest(null);
    invalidate(['tasks', 'queue', 'activity']);
  }, [invalidate, mutation, rescoreRequest]);

  /** 取消这次复评：请求已创建就标 cancelled，没创建就只关面板。tasks 不动。 */
  const cancelRescoreRequest = useCallback(async () => {
    if (rescoreRequest) {
      const result = await mutation.run('rescore-cancel', () =>
        rescoringClient.cancel(rescoreRequest.id),
      );
      // 取消失败时保持面板打开，让用户看到原因并重试。
      if (!result) return;
    }
    setRescoreTarget(null);
    setRescoreRequest(null);
    mutation.clearError();
  }, [mutation, rescoreRequest]);

  /** 关闭面板：不发任何请求。已创建的请求留在 pending，可在别处继续。 */
  const closeRescorePanel = useCallback(() => {
    setRescoreTarget(null);
    setRescoreRequest(null);
    mutation.clearError();
  }, [mutation]);

  const onResuggestQuadrant = useCallback(
    (task: Task) => void perform(task.id, 'resuggest', () => api.resuggestQuadrant(task.id)),
    [perform],
  );

  /** 仅对当前正在写入的那张卡片返回非 null。 */
  const pendingLabelFor = useCallback(
    (taskId: string) => (activeTaskId === taskId ? mutation.pending : null),
    [activeTaskId, mutation.pending],
  );

  const blockDialog = (
    <BlockReasonDialog
      key={blockTarget ? blockTarget.id : 'closed'}
      task={blockTarget}
      pending={mutation.pending === 'block'}
      error={mutation.error}
      onConfirm={(reason) => void confirmBlock(reason)}
      onCancel={cancelBlock}
    />
  );

  /**
   * 复评面板挂到 `document.body`。
   *
   * 走 portal 而不是让每个调用方自己渲染：Home / 四象限 / 目标详情三处只要展开
   * `handlers` 就能用，不必各加一行，也不受各自容器的 overflow / z-index 影响。
   */
  const rescorePanel = createPortal(
    <RescoreRequestPanel
      // 每个（任务 × 目标象限）组合拿一个新实例：勾选态随之重置，不必在面板里
      // 用 effect 去清理上一次的选择。
      key={rescoreTarget ? `${rescoreTarget.task.id}:${rescoreTarget.quadrant}` : 'closed'}
      open={rescoreTarget !== null}
      task={rescoreTarget?.task ?? null}
      targetQuadrant={rescoreTarget?.quadrant ?? null}
      request={rescoreRequest}
      busy={mutation.pending?.startsWith('rescore-') ?? false}
      error={mutation.error}
      onCreate={(axes) => void createRescoreRequest(axes)}
      onRefresh={() => void refreshRescoreRequest()}
      onConfirm={() => void confirmRescoreRequest()}
      onCancelRequest={() => void cancelRescoreRequest()}
      onClose={closeRescorePanel}
    />,
    document.body,
  );

  /**
   * 三个调用方展开渲染的弹窗集合。
   *
   * 名字沿用 `blockDialog` 是为了让 Home / 四象限 / 目标详情三处**一行都不用改**
   * 就能同时拿到受阻弹窗和复评面板（复评面板本身走 portal，挂在 body 上）。
   * 新代码建议用下面语义更准的 `dialogs` 别名。
   */
  const dialogs = (
    <>
      {blockDialog}
      {rescorePanel}
    </>
  );

  return {
    handlers: { onAction, onConfirmQuadrant, onChangeQuadrant, onResuggestQuadrant },
    pendingLabelFor,
    error: mutation.error,
    clearError: mutation.clearError,
    blockDialog: dialogs,
    dialogs,
    /** 复评面板的当前状态，调用方一般不用管（面板已由 portal 渲染）。 */
    rescoreRequest,
    openRescorePanel: onChangeQuadrant,
    closeRescorePanel,
  };
}
