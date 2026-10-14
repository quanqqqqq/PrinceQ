/**
 * 设置页六个区块共用的写入流程。
 *
 * 每个写端点的收尾动作都一样：成功 → 提示 + 刷新；409 → 提示「已在别处被改过」
 * 再刷新（本地的 expected_version 过期了，重取快照就能继续）；其余失败 → 把后端
 * 的中文报错直接弹出来。抽成一个 hook 是为了六个区块的这段行为完全一致，而不是
 * 各写一遍慢慢漂移。
 *
 * 仍然走 `useMutation(['habits'])`，所以写完之后别的视图（队列排序用到习惯）也会
 * 跟着失效重取。
 */
import { useCallback } from 'react';
import { toast } from 'sonner';
import { useMutation } from '@/hooks/use-resource';
import { isVersionConflict } from '@/lib/settings-client';

type Outcome = 'ok' | 'conflict' | 'error';

export interface SettingsWrite {
  /**
   * 跑一次写操作；返回是否成功，调用方据此决定要不要关对话框。
   *
   * 成功提示可以给一个函数，由返回体决定文案——采纳推断需要它：后端对重复采纳
   * 什么都不写并回 `already: true`，这时说「已采纳」是在撒谎。
   */
  submit: <T>(
    action: () => Promise<T>,
    successMessage: string | ((result: T) => string),
  ) => Promise<boolean>;
  /** 有写操作在飞行中——用来禁用按钮、改按钮文案。 */
  pending: boolean;
}

export function useSettingsWrite(onDone: () => void): SettingsWrite {
  const mutation = useMutation(['habits']);
  const { run } = mutation;

  const submit = useCallback(
    async <T,>(
      action: () => Promise<T>,
      successMessage: string | ((result: T) => string),
    ): Promise<boolean> => {
      // 文案要等返回体才能定，所以用一个盒子把结果带出闭包。文案在 try 之外再算：
      // 写已经成功了，算文案时出的错不该被归成「写失败」而跳过 refetch。
      const resolved: { result?: T } = {};
      const outcome = await run('settings', async (): Promise<Outcome> => {
        try {
          resolved.result = await action();
          return 'ok';
        } catch (cause) {
          if (isVersionConflict(cause)) return 'conflict';
          toast.error(cause instanceof Error ? cause.message : '这次操作没有生效。');
          return 'error';
        }
      });

      if (outcome === 'ok') {
        const message =
          typeof successMessage === 'function'
            ? successMessage(resolved.result as T)
            : successMessage;
        toast.success(message || '操作已生效');
        onDone();
        return true;
      }
      if (outcome === 'conflict') {
        toast.warning('设置已在别处被修改，已刷新列表。请核对后再操作。');
        onDone();
      }
      return false;
    },
    [run, onDone],
  );

  return { submit, pending: mutation.pending !== null };
}
