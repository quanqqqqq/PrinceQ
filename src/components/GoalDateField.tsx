/**
 * 目标日期选择器：Popover + Calendar，新建与编辑两处共用一套。
 *
 * 为什么不用 `<input type="date">`：原生控件的样式与文案跟着系统语言和浏览器走，
 * 和界面其它控件对不上；更要紧的是它的值是一个**墙钟日历日**，而两处调用方过去都
 * 直接 `new Date(value).toISOString()` 入库、`.slice(0, 10)` 回显——那是按 UTC
 * 午夜解析的，非 UTC 时区会整日偏一天。
 *
 * 所以这个组件对外只认 `'YYYY-MM-DD'` 墙钟日期（或空串），墙钟 ↔ UTC 的换算交给
 * `@shared/datetime` 的 `wallDateToIso` / `isoToWallDate` 在提交与回显的边界上做。
 * 内部构造 Date 一律用 `new Date(y, m - 1, d)` 本地构造，绝不 `new Date(字符串)`，
 * 否则又会把偏移问题带回来。
 *
 * 日历点选之外还留了一个输入框：键盘党直接敲日期比点十几下翻月份快，也方便输入
 * 远期日期。Enter 时校验，非法就什么都不做（不清空用户已选的值）。
 */
import { useState } from 'react';
import { CHINESE_CALENDAR_LABELS } from '@/lib/calendar-labels';
import { zhCN } from 'date-fns/locale';
import { Calendar as CalendarIcon, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

/** 触发器上的展示文案，例如 2026年10月13日。 */
const DISPLAY_FORMAT = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
});

/** 严格的 `YYYY-MM-DD`，组件对外的唯一值格式。 */
const STRICT_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 手输宽松形态：`YYYY/M/D`、`YYYY-M-D` 也接受，补零后归一。 */
const LOOSE_RE = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/;

const pad = (n: number) => String(n).padStart(2, '0');

/** 本地 Date → `YYYY-MM-DD`（取本地年月日，不经 UTC）。 */
const toWallDate = (date: Date): string =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

/**
 * `YYYY-MM-DD` → 本地 Date；格式不符或日子不存在（2 月 30 日）返回 null。
 *
 * 本地构造是关键：`new Date('2026-10-13')` 会被当成 UTC 午夜，在 UTC+8 之外的
 * 时区读回来就是 10-12。
 */
function parseWallDate(value: string): Date | null {
  const match = STRICT_RE.exec(value);
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  const date = new Date(y, m - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return null;
  return date;
}

/** 手输文本 → 归一后的 `YYYY-MM-DD`；认不出来返回 null。 */
function normalizeTyped(text: string): string | null {
  const trimmed = text.trim();
  const loose = LOOSE_RE.exec(trimmed);
  if (!loose) return null;
  const candidate = `${loose[1]}-${pad(Number(loose[2]))}-${pad(Number(loose[3]))}`;
  // 走一遍本地构造，顺带挡掉 13 月、2 月 30 日这类不存在的日子。
  return parseWallDate(candidate) ? candidate : null;
}

export function GoalDateField({
  id,
  value,
  onChange,
  disabled,
  placeholder = '选择目标日期',
  label = '目标日期',
}: {
  id?: string;
  /** `''` 或 `'YYYY-MM-DD'` 墙钟日期。 */
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  /** 输入框的草稿：敲坏了也不会污染已选中的日期。 */
  const [typed, setTyped] = useState(value);

  const selected = parseWallDate(value) ?? undefined;

  const commit = (next: string) => {
    onChange(next);
    setOpen(false);
  };

  const commitTyped = () => {
    const normalized = normalizeTyped(typed);
    // 非法输入不动作：既不清值也不关弹层，用户可以继续改。
    if (normalized) commit(normalized);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        // 展开的那一刻把草稿同步回当前值——上次敲到一半的非法文本不该留到下一次。
        if (next) setTyped(value);
        setOpen(next);
      }}
    >
      <PopoverTrigger asChild>
        <Button
          id={id}
          aria-label={label}
          type="button"
          variant="outline"
          disabled={disabled}
          className="h-9 w-full justify-start bg-card! font-normal"
        >
          <CalendarIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className={value ? undefined : 'text-muted-foreground'}>
            {selected ? DISPLAY_FORMAT.format(selected) : placeholder}
          </span>
          {/* 清除按钮落在触发器内部，必须吞掉点击，否则会顺带把弹层打开。 */}
          {value ? (
            <span
              role="button"
              tabIndex={-1}
              aria-label={label === '目标日期' ? '清除目标日期' : `清除${label}`}
              className="ml-auto inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onChange('');
              }}
            >
              <X className="size-3.5" />
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-0">
        <Calendar
          mode="single"
          locale={zhCN}
          labels={CHINESE_CALENDAR_LABELS}
          selected={selected}
          defaultMonth={selected}
          onSelect={(date) => {
            if (date) commit(toWallDate(date));
          }}
          autoFocus
        />
        {/* 键盘输入通道：点选之外的第二条路，Enter 提交。 */}
        <div className="border-t border-border p-2">
          <Input
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              commitTyped();
            }}
            placeholder="直接输入 2026-10-13"
            aria-label={`输入${label}`}
            className="h-8 text-xs"
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}
