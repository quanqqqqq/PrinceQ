/**
 * 推断习惯区块：从记录里观察出来的规律。
 *
 * 这里刻意不给编辑控件——这些句子是系统推断的，用户改了就不再是「观察结果」。想
 * 改就先「采纳为明确习惯」，之后在明确习惯区块里编辑那条副本。
 *
 * 「忽略」是 `enabled:false` 的软移除：观察记录留着（它是证据），只是不再参与排序，
 * 之后能在「已忽略的推断」折叠区里恢复。
 *
 * 采纳按钮的置灰判断来自 `data.explicit` 的 `source_relation`，与服务端
 * `findExistingAdoption` 同一判据：已经采纳过的推断，按钮显示「已采纳」并禁用。
 * 真实数据里出现过同一条推断对应三条 explicit——重复点击就是起因，所以这个置灰不是
 * 装饰，而是和后端幂等一起堵住同一个洞。
 */
import {usableObservation,observationEvidence} from '@shared/habit-inference';
import {useHabitInference} from '@/hooks/use-habit-inference';
import {HabitInferenceNotice} from '@/pages/SettingsPage/components/HabitInferenceNotice';
import { demoTitle } from '@/lib/i18n';
import { ChevronDown } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { SectionCard } from '@/components/settings/SectionCard';
import {
  adoptToastMessage,
  confidenceLabel,
  findAdoptedInferredIds,
  splitByEnabled,
} from '@/components/settings/settings-contract';
import { useSettingsWrite } from '@/components/settings/settings-write';
import {
  adoptInferred,
  setInferredEnabled,
  type ExplicitHabitEntry,
  type InferredHabitEntry,
  type SettingsVersions,
} from '@/lib/settings-client';

export function InferredHabitsSection({
  entries,
  explicitEntries,
  versions,
  onDone,
}: {
  entries: InferredHabitEntry[];
  /** 明确习惯列表——只用来判断哪条推断已经被采纳过。 */
  explicitEntries: ExplicitHabitEntry[];
  versions: SettingsVersions;
  onDone: () => void;
}) {
  const write = useSettingsWrite(onDone);
  const observation = useHabitInference(onDone);
  const validEntries = entries.filter(entry => usableObservation(entry));
  const legacyEntries = entries.filter(entry => !usableObservation(entry));
  const { active, removed, removedCount } = splitByEnabled(validEntries);
  const adoptedIds = findAdoptedInferredIds(explicitEntries);

  const setEnabled = (entry: InferredHabitEntry, enabled: boolean) =>
    write.submit(
      () => setInferredEnabled(entry.id, enabled, versions.inferred),
      enabled ? '已恢复这条推断' : '已忽略这条推断',
    );

  return (
    <SectionCard title="推断习惯" description="由已连接的 Agent 每小时观察执行记录，有依据才保存；默认供参考。">
      <div className="space-y-3">
        <HabitInferenceNotice status={observation.data} error={observation.error} />
        {active.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            还没有有充分证据的推断习惯。连接助手后，系统会逐步观察你的真实执行记录。
          </p>
        ) : (
          <ul className="space-y-2">
            {active.map((entry) => {
              const adopted = adoptedIds.has(entry.id);
              const evidence = observationEvidence(entry.source_relation);
              return (
                <li key={entry.id} className="space-y-2 rounded-md border border-border p-3">
                  <div className="min-w-0 space-y-1">
                    <p className="text-sm">{demoTitle(entry.statement)}</p>
                    <p className="text-xs text-muted-foreground">
                      模型可信判断 {confidenceLabel(entry.confidence)} · 来自真实执行记录
                      {observation.data?.connected ? '' : ' · 当前暂停生效'}
                    </p>
                  </div>
                  {evidence ? <div className="text-xs leading-5 text-muted-foreground">
                    <p>{evidence.rationale}</p>
                    <p>依据 {evidence.sample_tasks} 个任务、{evidence.sample_days} 天的记录；
                      来源 {evidence.provider}，{new Date(evidence.analyzed_at).toLocaleDateString('zh-CN')}。
                      可信判断不是统计概率，30 天未更新的观察暂停生效。</p>
                  </div> : null}
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Button
                      size="sm"
                      variant="outline"
                      className="min-h-9"
                      // 已采纳过的再点也只会命中后端幂等——什么都不会发生，
                      // 看起来就是按钮坏了，所以直接禁掉并说明状态。
                      disabled={adopted || write.pending}
                      aria-label={
                        adopted
                          ? `已采纳：${demoTitle(entry.statement)}`
                          : `采纳为明确习惯：${demoTitle(entry.statement)}`
                      }
                      onClick={() => {
                        void write.submit(
                          () => adoptInferred(entry.id, versions.inferred, versions.explicit),
                          adoptToastMessage,
                        );
                      }}
                    >
                      {adopted ? '已采纳' : '采纳为明确习惯'}
                    </Button>
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="min-h-9 text-destructive"
                          disabled={write.pending}
                          aria-label={`忽略推断：${demoTitle(entry.statement)}`}
                        >
                          忽略
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>忽略这条推断？</AlertDialogTitle>
                          <AlertDialogDescription>
                            忽略后它不再参与排序，但观察记录会保留——之后可以在「已忽略的推断」里恢复。
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <p className="text-sm">{demoTitle(entry.statement)}</p>
                        <AlertDialogFooter>
                          <AlertDialogCancel>取消</AlertDialogCancel>
                          <AlertDialogAction onClick={() => void setEnabled(entry, false)}>
                            确认忽略
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {legacyEntries.length ? <Collapsible>
          <CollapsibleTrigger className="flex h-9 w-full items-center justify-between px-1 text-xs text-muted-foreground">
            历史示例或证据不足的记录（{legacyEntries.length}，不生效）<ChevronDown className="size-3.5"/>
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-2 pt-2">
            {legacyEntries.map(entry=><p key={entry.id} className="rounded-md border border-dashed p-2 text-xs text-muted-foreground">{demoTitle(entry.statement)} · 不作为真实习惯依据</p>)}
          </CollapsibleContent>
        </Collapsible> : null}
        {removedCount > 0 ? (
          <Collapsible>
            <CollapsibleTrigger className="flex h-9 w-full items-center justify-between gap-2 rounded-md px-1 text-sm hover:bg-muted">
              <span>已忽略的推断（{removedCount}）</span>
              <ChevronDown className="size-4 text-muted-foreground" />
            </CollapsibleTrigger>
            <CollapsibleContent className="space-y-2 pt-2">
              {removed.map((entry) => (
                <div
                  key={entry.id}
                  className="flex items-start justify-between gap-3 rounded-md border border-dashed border-border p-3"
                >
                  <div className="min-w-0 space-y-1">
                    <p className="text-sm text-muted-foreground">{demoTitle(entry.statement)}</p>
                    <p className="text-xs text-muted-foreground">
                      置信度 {confidenceLabel(entry.confidence)} ·{' '}
                      {adoptedIds.has(entry.id) ? '已采纳为明确习惯' : '不参与排序'}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="min-h-9 shrink-0"
                    disabled={write.pending}
                    aria-label={`恢复推断：${demoTitle(entry.statement)}`}
                    onClick={() => void setEnabled(entry, true)}
                  >
                    恢复
                  </Button>
                </div>
              ))}
            </CollapsibleContent>
          </Collapsible>
        ) : null}
      </div>
    </SectionCard>
  );
}
