import { TASK_TYPES, type TaskType } from '@shared/types';
import { setTypePeakHours } from '../../../shared/peak-hours.ts';
import { SectionCard } from '@/components/settings/SectionCard';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { TASK_TYPE_LABELS } from '@/lib/i18n';
import type { WeightsDraft } from '@/lib/settings-client';
import type { ReactNode } from 'react';

const PERIODS = [
  { id: 'morning', name: '上午', hint: '9:00–12:00', hours: [9, 10, 11] },
  { id: 'afternoon', name: '下午', hint: '14:00–18:00', hours: [14, 15, 16, 17] },
  { id: 'evening', name: '晚上', hint: '19:00–22:00', hours: [19, 20, 21] },
  { id: 'none', name: '没有固定时段', hint: '不按时间倾斜', hours: [] },
];
function periodFor(hours: number[]) {
  const key = [...new Set(hours)].sort((a,b) => a-b).join(',');
  return PERIODS.find(period => period.hours.join(',') === key);
}
function hoursLabel(hours: number[]) {
  return hours.length ? [...new Set(hours)].sort((a,b) => a-b).map(hour => `${hour}:00–${hour + 1}:00`).join('、') : '没有固定时段';
}

export function WorkPreferencesSection({draft, onChange, status}: {
  draft: WeightsDraft; onChange: (next: WeightsDraft) => void; status: ReactNode;
}) {
  const common = draft.peak_hours ?? [];
  const selected = periodFor(common);
  const overrides = draft.task_type_peak_hours ?? {};
  const preferred = draft.preferred_task_types ?? [];
  return <SectionCard title="工作偏好" description="告诉我你什么时候状态最好，我会优先把合适的任务排到这段时间。" actions={status}>
    <div className="space-y-4">
      <div className="space-y-2">
        <p className="text-sm font-medium">你通常什么时候最有精神？</p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" role="group" aria-label="精力最好的时段">
          {PERIODS.map(period => <button key={period.id} type="button" aria-pressed={selected?.id === period.id}
            onClick={() => onChange({...draft, peak_hours: [...period.hours]})}
            className={'min-h-16 rounded-lg border px-3 py-2 text-left transition-colors ' + (selected?.id === period.id ? 'border-primary bg-primary/10 text-primary' : 'border-input bg-card hover:bg-muted')}>
            <span className="block text-sm font-medium">{period.name}</span><span className="mt-1 block text-[11px] text-muted-foreground">{period.hint}</span>
          </button>)}
        </div>
        {!selected ? <p className="text-xs text-muted-foreground">当前安排：{hoursLabel(common)}。选一个时段可替换。</p> : null}
      </div>

      <details className="rounded-lg border border-border px-3 py-2">
        <summary className="cursor-pointer py-1 text-sm">不同事情想放在不同时间？（可选）</summary>
        <p className="mt-2 text-xs text-muted-foreground">只改需要区分的事情，其余按上面的安排。</p>
        <div className="mt-3 space-y-2">
          {TASK_TYPES.map(type => {
            const own = Object.hasOwn(overrides, type);
            const period = own ? periodFor(overrides[type]!) : undefined;
            const value = !own ? 'common' : period?.id ?? 'custom';
            return <div key={type} className="flex items-center justify-between gap-3">
              <label htmlFor={'time-' + type} className="text-sm">{TASK_TYPE_LABELS[type]}</label>
              <NativeSelect id={'time-' + type} value={value} className="w-48 bg-card!"
                onChange={event => {
                  const choice = event.target.value;
                  if (choice === 'custom') return;
                  onChange({...draft, task_type_peak_hours: setTypePeakHours(overrides, type as TaskType,
                    choice === 'common' ? undefined : PERIODS.find(item => item.id === choice)!.hours)});
                }}>
                <NativeSelectOption value="common">按上面的安排</NativeSelectOption>
                {PERIODS.map(item => <NativeSelectOption key={item.id} value={item.id}>{item.name}</NativeSelectOption>)}
                {value === 'custom' ? <NativeSelectOption value="custom">原有自定义安排</NativeSelectOption> : null}
              </NativeSelect>
              {value === 'custom' ? <span className="max-w-36 text-xs text-muted-foreground">{hoursLabel(overrides[type]!)}</span> : null}
            </div>;
          })}
        </div>
      </details>
      <details className="rounded-lg border border-border px-3 py-2">
        <summary className="cursor-pointer py-1 text-sm">想优先处理的事情（可选）{preferred.length ? ` · 已选 ${preferred.length} 类` : ''}</summary>
        <p className="my-2 text-xs text-muted-foreground">同等条件下优先推荐，可不选。</p>
        <div className="flex flex-wrap gap-2">
          {TASK_TYPES.map(type => <label key={type} className="flex min-h-10 cursor-pointer items-center gap-2 rounded-md border px-3 text-sm">
            <input type="checkbox" checked={preferred.includes(type)} onChange={() => onChange({...draft,
              preferred_task_types: preferred.includes(type) ? preferred.filter(item => item !== type) : [...preferred, type]})} />
            {TASK_TYPE_LABELS[type]}
          </label>)}
        </div>
      </details>
      <p className="text-xs text-muted-foreground">点选后自动保存，无需再找保存按钮。</p>
    </div>
  </SectionCard>;
}
