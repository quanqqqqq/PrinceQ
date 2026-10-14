/**
 * 耗时输入：数值 + 单位（分钟 / 天 / 月）+ 一行换算摘要。
 *
 * 受控组件，自己不存状态——数值以字符串形式交给调用方（和其他表单字段一样放在
 * 草稿里，空串就是「没填」），单位是枚举。
 *
 * 摘要里的「几小时/天、几天/月」每次都从 `GET /api/habits` 现取（`useResource`
 * 跟着 habits 域刷新），所以用户刚在别处改完换算配置，这里显示的折算结果立刻
 * 跟上，和服务端落库时用的是同一套数。配置没取到时退回默认的 8 小时/天、
 * 20 天/月，只是摘要略有偏差，不挡输入。
 */
import type { DurationUnit, HabitsResponse } from '@shared/types';
import { DURATION_UNITS } from '@shared/types';
import {
  DEFAULT_DURATION_CONFIG,
  DURATION_UNIT_LABELS_ZH,
  formatDurationSummary,
  type DurationConfig,
} from '@shared/duration';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { useResource } from '@/hooks/use-resource';
import { api } from '@/lib/api';

export function DurationField({
  id,
  value,
  unit,
  onValueChange,
  onUnitChange,
}: {
  /** 数字输入框的 id，供外部 `<Label htmlFor>` 关联。 */
  id: string;
  /** 数字字符串；空串表示未填。 */
  value: string;
  unit: DurationUnit;
  onValueChange: (next: string) => void;
  onUnitChange: (next: DurationUnit) => void;
}) {
  const habits = useResource<HabitsResponse>(['habits'], () => api.habits(), []);
  const config: DurationConfig = habits.data?.weights?.payload
    ? {
        hours_per_day:
          habits.data.weights.payload.hours_per_day ?? DEFAULT_DURATION_CONFIG.hours_per_day,
        days_per_month:
          habits.data.weights.payload.days_per_month ?? DEFAULT_DURATION_CONFIG.days_per_month,
      }
    : DEFAULT_DURATION_CONFIG;

  const parsed = Number(value);
  // minute 单位不出摘要（数值本身就是分钟），非法/空输入也不出。
  const summary =
    value.trim() && Number.isFinite(parsed) && parsed > 0
      ? formatDurationSummary(parsed, unit, config)
      : '';

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <Input
          id={id}
          type="number"
          min={0}
          step="any"
          className="min-w-0 flex-1 bg-card! disabled:bg-muted!"
          value={value}
          onChange={(event) => onValueChange(event.target.value)}
          placeholder={unit === 'minute' ? '45' : '2'}
        />
        <NativeSelect
          aria-label="耗时单位"
          className="w-24 shrink-0 bg-card! disabled:bg-muted!"
          value={unit}
          onChange={(event) => onUnitChange(event.target.value as DurationUnit)}
        >
          {DURATION_UNITS.map((option) => (
            <NativeSelectOption key={option} value={option}>
              {DURATION_UNIT_LABELS_ZH[option]}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>
      {summary ? <p className="text-xs text-muted-foreground">{summary}</p> : null}
    </div>
  );
}
